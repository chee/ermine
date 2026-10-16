// Presence (presence.h), after typescript/presence.ts.
#define _POSIX_C_SOURCE 200809L
#include "presence.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../core/op/c/json.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// an ordered set of strings
typedef struct {
	char **items;
	size_t n, cap;
} strs;

// the member that is x, adding a copy when it is not there
static char *strs_add(strs *s, const char *x) {
	for (size_t i = 0; i < s->n; i++) {
		if (strcmp(s->items[i], x) == 0) return s->items[i];
	}
	if (s->n == s->cap) {
		s->cap = s->cap ? s->cap * 2 : 4;
		s->items = realloc(s->items, s->cap * sizeof *s->items);
		if (s->items == NULL) abort();
	}
	return s->items[s->n++] = xdup(x);
}
// true if it was there
static int strs_del(strs *s, const char *x) {
	for (size_t i = 0; i < s->n; i++) {
		if (strcmp(s->items[i], x) != 0) continue;
		free(s->items[i]);
		memmove(&s->items[i], &s->items[i + 1], (s->n - i - 1) * sizeof *s->items);
		s->n--;
		return 1;
	}
	return 0;
}
static void strs_free(strs *s) {
	for (size_t i = 0; i < s->n; i++) free(s->items[i]);
	free(s->items);
}

typedef struct {
	char *anchor;
	strs whos;
} mine_of;

struct pres_conn {
	pres_world *w;
	chn_channel *channel;
	char *topic;
	char *anchor;
	chn_listener *listener;
	int active;
};

typedef struct {
	strs anchors;
	mine_of *mine;
	size_t nmine, capmine;
	pres_conn **conns;
	size_t nconns, capconns;
} state;

static state *state_of(pres_world *w) {
	if (w->state == NULL) w->state = xalloc(sizeof(state));
	return w->state;
}

static int64_t now_of(const pres_world *w) {
	if (w->now != NULL) return w->now(w->now_ctx);
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static strs *mine_at(state *s, const char *anchor, int make) {
	for (size_t i = 0; i < s->nmine; i++) {
		if (strcmp(s->mine[i].anchor, anchor) == 0) return &s->mine[i].whos;
	}
	if (!make) return NULL;
	if (s->nmine == s->capmine) {
		s->capmine = s->capmine ? s->capmine * 2 : 4;
		s->mine = realloc(s->mine, s->capmine * sizeof *s->mine);
		if (s->mine == NULL) abort();
	}
	s->mine[s->nmine] = (mine_of){xdup(anchor), {0}};
	return &s->mine[s->nmine++].whos;
}

// a write made as the world's scope
static void as(pres_world *w, void (*f)(void *data), void *data) {
	sc_run_with_scope(w->scope, f, data);
}

// the header of a write made now, with the scope open, and its block
static void header_now(pres_world *w, ch_header *h, pl_made **made) {
	char *bad = pl_header(w->places, NULL, 0, CH_HERE, h, made);
	if (bad != NULL) {
		fprintf(stderr, "presence: %s\n", bad);
		abort();
	}
}

// the nodes a write changed hold the header's block too
static void hold_header(pres_world *w, const pl_changed *changed, pl_made *made) {
	for (size_t i = 0; i < changed->n; i++) {
		pl_hold_also(w->places, changed->entries[i], pl_made_ref(made), pl_made_free);
	}
}

static op_value *row_of(const op_value *value, int64_t until) {
	op_value *row = op_map();
	op_set(row, "value", value != NULL ? op_ref((op_value *)value) : op_null());
	op_set(row, "until", op_num((double)until));
	return row;
}

static int64_t until_of(const op_value *row) {
	const op_value *u = row != NULL && row->type == OP_MAP ? op_get(row, "until") : NULL;
	return u != NULL && u->type == OP_NUM ? (int64_t)u->num : 0;
}

// put ---------------------------------------------------------------------------------------------

typedef struct {
	pres_world *w;
	const char *anchor;
	const char *who;
	const op_value *row;
} putting;

static void put_in(void *data) {
	putting *p = data;
	pres_world *w = p->w;
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	const char *path[1] = {p->who};
	pl_changed changed;
	nd_entry *node;
	pl_upsert(w->places, tb_string(PRES_PART), tb_string(p->anchor), path, 1, p->row, h, &changed, &node);
	hold_header(w, &changed, made);
	if (node != NULL) pl_hold(w->places, node, made, pl_made_free);
	else pl_made_free(made);
	pl_commit(w->places, &changed);
}

static void put(pres_world *w, const char *anchor, const char *who, const op_value *row) {
	state *s = state_of(w);
	// the anchor's own copy: the table's key, and what sweeps read
	const char *mine = strs_add(&s->anchors, anchor);
	putting p = {w, mine, who, row};
	as(w, put_in, &p);
}

// take --------------------------------------------------------------------------------------------

// what the removal patches refer to: kept by the node till its next update
typedef struct {
	op_patch *patches;
	op_key *keys;
	char **names;
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) free(k->names[i]);
	free(k->names);
	free(k->keys);
	free(k->patches);
	free(k);
}

typedef struct {
	pres_world *w;
	nd_entry *there;
	const char *const *gone;
	size_t n;
} taking;

static void take_in(void *data) {
	taking *t = data;
	pres_world *w = t->w;
	block *b = xalloc(sizeof *b);
	b->n = t->n;
	b->names = xalloc(t->n * sizeof *b->names);
	b->keys = xalloc(t->n * sizeof *b->keys);
	b->patches = xalloc(t->n * sizeof *b->patches);
	for (size_t i = 0; i < t->n; i++) {
		b->names[i] = xdup(t->gone[i]);
		b->keys[i] = (op_key){.type = OP_STR_KEY, .s = b->names[i]};
		// no value: the place is removed
		b->patches[i] = (op_patch){.place = {.path = &b->keys[i], .length = 1}};
	}
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	size_t failed;
	int code = nd_update(t->there, b->patches, t->n, h, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "presence: remove: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(w->places, t->there, b, block_free);
	pl_changed changed = {1, {t->there}};
	hold_header(w, &changed, made);
	pl_made_free(made);
	pl_commit(w->places, &changed);
}

// the rows of whos that are there, taken out as one write; the names taken (borrowed from whos) in
// out, which has room for n. how many
static size_t take(pres_world *w, const char *anchor, const char *const *whos, size_t n, const char **out) {
	nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(anchor));
	if (there == NULL || there->value == NULL || there->value->type != OP_MAP) return 0;
	size_t gone = 0;
	for (size_t i = 0; i < n; i++) {
		if (op_get(there->value, whos[i]) != NULL) out[gone++] = whos[i];
	}
	if (gone == 0) return 0;
	taking t = {w, there, out, gone};
	as(w, take_in, &t);
	return gone;
}

// tell ----------------------------------------------------------------------------------------------

// what a connection tells: my row (a map of value and until), or none: it is gone
static void send(pres_conn *c, const op_value *row) {
	op_value *m = op_map();
	if (row == NULL) op_set(m, "gone", op_bool(1));
	else {
		op_set(m, "ttl", op_num((double)(until_of(row) - now_of(c->w))));
		const op_value *v = op_get(row, "value");
		op_set(m, "value", v != NULL ? op_ref((op_value *)v) : op_null());
	}
	char *text = op_json_text(m);
	op_free(m);
	c->channel->send(c->channel, c->topic, (const unsigned char *)text, strlen(text));
	free(text);
}

static void tell(pres_world *w, const char *anchor, const op_value *row) {
	state *s = state_of(w);
	size_t n = s->nconns;
	for (size_t i = 0; i < n; i++) {
		pres_conn *c = s->conns[i];
		if (c->active && strcmp(c->anchor, anchor) == 0) send(c, row);
	}
}

// the api -------------------------------------------------------------------------------------------

void pres_set(pres_world *w, const char *anchor, const char *who, const op_value *value, int64_t ttl) {
	op_value *row = row_of(value, now_of(w) + ttl);
	put(w, anchor, who, row);
	strs_add(mine_at(state_of(w), anchor, 1), who);
	tell(w, anchor, row);
	op_free(row);
}

bool pres_renew(pres_world *w, const char *anchor, const char *who, int64_t ttl) {
	const nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(anchor));
	const op_value *row = there != NULL && there->value != NULL && there->value->type == OP_MAP
		? op_get(there->value, who)
		: NULL;
	if (row == NULL) return false;
	// the row may change under the write: the value is held across it
	op_value *value = op_ref(op_get(row, "value") != NULL ? op_get(row, "value") : op_null());
	pres_set(w, anchor, who, value, ttl);
	op_free(value);
	return true;
}

void pres_clear(pres_world *w, const char *anchor, const char *who) {
	strs *mine = mine_at(state_of(w), anchor, 0);
	int was_mine = mine != NULL && strs_del(mine, who);
	const char *gone[1];
	if (take(w, anchor, &who, 1, gone) == 0) return;
	if (was_mine) tell(w, anchor, NULL);
}

static pres_live live_of(const char *who, const op_value *row) {
	const op_value *v = op_get(row, "value");
	return (pres_live){xdup(who), op_ref(v != NULL ? (op_value *)v : op_null()), until_of(row)};
}

void pres_live_free(pres_live *row) {
	free(row->who);
	op_free(row->value);
	*row = (pres_live){0};
}
void pres_lives_free(pres_lives *rows) {
	for (size_t i = 0; i < rows->n; i++) pres_live_free(&rows->items[i]);
	free(rows->items);
	*rows = (pres_lives){0};
}

pres_lives pres_read(pres_world *w, const char *anchor) {
	int64_t t = now_of(w);
	pres_lives out = {0};
	const op_value *all = pl_read(w->places, tb_string(PRES_PART), tb_string(anchor), NULL, 0);
	if (all == NULL || all->type != OP_MAP) return out;
	out.items = xalloc(all->count * sizeof *out.items);
	for (size_t i = 0; i < all->count; i++) {
		if (until_of(all->items[i]) > t) out.items[out.n++] = live_of(all->keys[i], all->items[i]);
	}
	return out;
}

bool pres_read_row(pres_world *w, const char *anchor, const char *who, pres_live *out) {
	op_key path[1] = {{.type = OP_STR_KEY, .s = who}};
	const op_value *row = pl_read(w->places, tb_string(PRES_PART), tb_string(anchor), path, 1);
	if (row == NULL || row->type != OP_MAP || until_of(row) <= now_of(w)) return false;
	*out = live_of(who, row);
	return true;
}

void pres_swept_free(pres_swept *swept) {
	for (size_t i = 0; i < swept->n; i++) {
		free(swept->items[i].anchor);
		free(swept->items[i].who);
	}
	free(swept->items);
	*swept = (pres_swept){0};
}

pres_swept pres_sweep(pres_world *w, int64_t at) {
	state *s = state_of(w);
	pres_swept out = {0};
	size_t cap = 0;
	for (size_t a = 0; a < s->anchors.n; a++) {
		const char *anchor = s->anchors.items[a];
		const nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(anchor));
		if (there == NULL || there->value == NULL || there->value->type != OP_MAP) continue;
		// the names are copied: the removal changes the map they are in
		size_t count = there->value->count, old = 0;
		char **names = xalloc(count * sizeof *names);
		for (size_t i = 0; i < count; i++) {
			if (until_of(there->value->items[i]) <= at) names[old++] = xdup(there->value->keys[i]);
		}
		const char **gone = xalloc((old + 1) * sizeof *gone);
		size_t taken = take(w, anchor, (const char *const *)names, old, gone);
		for (size_t i = 0; i < taken; i++) {
			strs *mine = mine_at(s, anchor, 0);
			if (mine != NULL) strs_del(mine, gone[i]);
			if (out.n == cap) {
				cap = cap ? cap * 2 : 4;
				out.items = realloc(out.items, cap * sizeof *out.items);
				if (out.items == NULL) abort();
			}
			out.items[out.n++] = (pres_gone){xdup(anchor), xdup(gone[i])};
		}
		free(gone);
		for (size_t i = 0; i < old; i++) free(names[i]);
		free(names);
	}
	return out;
}

pres_swept pres_sweep_now(pres_world *w) { return pres_sweep(w, now_of(w)); }

bool pres_keep(const pres_world *w, const char *part) {
	return strcmp(part, PRES_PART) != 0 || w->save;
}

// connect -----------------------------------------------------------------------------------------

// a message received: the sender's row, from outside, or its going
static void heard(void *ctx, const char *from, const unsigned char *bytes, size_t n) {
	pres_conn *c = ctx;
	pres_world *w = c->w;
	char *text = xalloc(n + 1);
	memcpy(text, bytes, n);
	op_value *m = op_json_read(text, NULL);
	free(text);
	if (m == NULL) return;
	if (m->type == OP_MAP) {
		const op_value *gone = op_get(m, "gone");
		if (gone != NULL && gone->type == OP_BOOL && gone->bool_) {
			const char *gone_who[1];
			take(w, c->anchor, &from, 1, gone_who);
		} else {
			const op_value *ttl = op_get(m, "ttl");
			int64_t left = ttl != NULL && ttl->type == OP_NUM ? (int64_t)ttl->num : 0;
			op_value *row = row_of(op_get(m, "value"), now_of(w) + left);
			put(w, c->anchor, from, row);
			op_free(row);
		}
	}
	op_free(m);
}

pres_conn *pres_connect(pres_world *w, chn_channel *channel, const char *topic, const char *anchor) {
	state *s = state_of(w);
	pres_conn *c = xalloc(sizeof *c);
	c->w = w;
	c->channel = channel;
	c->topic = xdup(topic);
	c->anchor = xdup(anchor != NULL ? anchor : topic);
	c->active = 1;
	if (s->nconns == s->capconns) {
		s->capconns = s->capconns ? s->capconns * 2 : 4;
		s->conns = realloc(s->conns, s->capconns * sizeof *s->conns);
		if (s->conns == NULL) abort();
	}
	s->conns[s->nconns++] = c;
	c->listener = channel->on(channel, c->topic, heard, c);
	return c;
}

void pres_stop(pres_conn *c) {
	if (!c->active) return;
	c->channel->off(c->channel, c->listener);
	c->active = 0;
}

void pres_announce(pres_conn *c) {
	pres_world *w = c->w;
	const strs *mine = mine_at(state_of(w), c->anchor, 0);
	if (mine == NULL) return;
	// a row sent may be answered by a write: the names are walked from a copy
	size_t n = mine->n;
	char **whos = xalloc(n * sizeof *whos);
	for (size_t i = 0; i < n; i++) whos[i] = xdup(mine->items[i]);
	for (size_t i = 0; i < n; i++) {
		const nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(c->anchor));
		const op_value *row = there != NULL && there->value != NULL && there->value->type == OP_MAP
			? op_get(there->value, whos[i])
			: NULL;
		if (row != NULL) send(c, row);
		free(whos[i]);
	}
	free(whos);
}

// ensure ------------------------------------------------------------------------------------------

static void ensure_in(void *data) {
	putting *p = data;
	pres_world *w = p->w;
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	op_value *empty = op_map();
	nd_entry *node = nd_make_entry(empty, &h, NULL);
	op_free(empty);
	pl_hold(w->places, node, made, pl_made_free);
	pl_own(w->places, node);
	tb_add(w->table, tb_string(PRES_PART), tb_string(p->anchor), node);
}

void pres_ensure(pres_world *w, const char *anchor) {
	if (tb_get(w->table, tb_string(PRES_PART), tb_string(anchor)) != NULL) return;
	state *s = state_of(w);
	putting p = {w, strs_add(&s->anchors, anchor), NULL, NULL};
	as(w, ensure_in, &p);
}

void pres_free(pres_world *w) {
	state *s = w->state;
	if (s == NULL) return;
	strs_free(&s->anchors);
	for (size_t i = 0; i < s->nmine; i++) {
		free(s->mine[i].anchor);
		strs_free(&s->mine[i].whos);
	}
	free(s->mine);
	for (size_t i = 0; i < s->nconns; i++) {
		free(s->conns[i]->topic);
		free(s->conns[i]->anchor);
		free(s->conns[i]);
	}
	free(s->conns);
	free(s);
	w->state = NULL;
}
