// Presence (presence.h), after typescript/presence.ts.
#define _POSIX_C_SOURCE 200809L
#include "presence.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/pack.h"

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

// a count by name: the n last sent to a channel for a who, or the last taken from a sender
typedef struct {
	char *who;
	int64_t n;
} counted;

struct pres_conn {
	int patches;
	counted *sent;
	size_t nsent, capsent;
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
	// the last n taken from each sender, by anchor
	struct taken {
		char *anchor;
		char *from;
		int64_t n;
	} *taken;
	size_t ntaken, captaken;
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

// edit --------------------------------------------------------------------------------------------

// what an edit's patches refer to: kept by the node till its next update
typedef struct {
	op_value *list;
	op_value *until;
	op_patch *patches;
	op_key **keys;
	size_t n, nkeys;
	char *who;
} edit_block;

static void edit_block_free(void *b) {
	edit_block *k = b;
	for (size_t i = 0; i < k->nkeys; i++) free(k->keys[i]);
	free(k->keys);
	free(k->patches);
	free(k->who);
	op_free(k->list);
	op_free(k->until);
	free(k);
}

static int whole_num(const op_value *x, int64_t *out) {
	if (x->type != OP_NUM || !(x->num >= -1e15 && x->num <= 1e15) || x->num != (double)(int64_t)x->num) return 0;
	*out = (int64_t)x->num;
	return 1;
}
// a key's number: one a long holds
static int index_num(const op_value *x, long *out) {
	int64_t n;
	if (!whole_num(x, &n) || n < LONG_MIN || n > LONG_MAX) return 0;
	*out = (long)n;
	return 1;
}

// a target of a wire patch, its path put under [who, "value"]. 0: malformed
static int target_of(edit_block *b, const op_value *m, const char *who, op_target *t) {
	const op_value *path = m != NULL && m->type == OP_MAP ? op_get(m, "path") : NULL;
	if (path == NULL || path->type != OP_LIST) return 0;
	op_key *ks = xalloc((path->count + 2) * sizeof *ks);
	b->keys[b->nkeys++] = ks;
	ks[0] = (op_key){.type = OP_STR_KEY, .s = who};
	ks[1] = (op_key){.type = OP_STR_KEY, .s = "value"};
	for (size_t i = 0; i < path->count; i++) {
		const op_value *x = path->items[i];
		if (x->type == OP_STR) ks[i + 2] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_NUM && index_num(x, &ks[i + 2].n)) ks[i + 2].type = OP_NUM_KEY;
		else return 0;
	}
	*t = (op_target){.path = ks, .length = path->count + 2};
	const op_value *r = op_get(m, "range");
	if (r != NULL) {
		if (r->type != OP_LIST || r->count != 2 || !whole_num(r->items[0], &t->from) ||
			!whole_num(r->items[1], &t->to)) return 0;
		t->has_range = 1;
	}
	return 1;
}

typedef struct {
	pres_world *w;
	nd_entry *there;
	const op_value *list;
	const char *who;
	int64_t until;
	int code;
} editing;

static void edit_in(void *data) {
	editing *e = data;
	pres_world *w = e->w;
	size_t count = e->list->count;
	edit_block *b = xalloc(sizeof *b);
	b->list = op_ref((op_value *)e->list);
	b->until = op_num((double)e->until);
	b->who = xdup(e->who);
	b->n = count + 1;
	b->patches = xalloc(b->n * sizeof *b->patches);
	b->keys = xalloc((2 * count + 1) * sizeof *b->keys);
	for (size_t i = 0; i < count; i++) {
		const op_value *m = e->list->items[i];
		op_patch *p = &b->patches[i];
		if (!target_of(b, m, b->who, &p->place)) {
			e->code = OP_NOT_A_PATCH;
			edit_block_free(b);
			return;
		}
		p->value = op_get(m, "value");
		p->has_value = p->value != NULL;
		const op_value *mv = op_get(m, "move");
		if (mv != NULL) {
			p->has_move = 1;
			if (!target_of(b, mv, b->who, &p->move)) {
				e->code = OP_NOT_A_PATCH;
				edit_block_free(b);
				return;
			}
		}
	}
	op_key *uk = xalloc(2 * sizeof *uk);
	b->keys[b->nkeys++] = uk;
	uk[0] = (op_key){.type = OP_STR_KEY, .s = b->who};
	uk[1] = (op_key){.type = OP_STR_KEY, .s = "until"};
	b->patches[count] = (op_patch){.place = {.path = uk, .length = 2}, .has_value = 1, .value = b->until};
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	size_t failed;
	e->code = nd_update(e->there, b->patches, b->n, h, &failed);
	if (e->code != OP_OK) {
		edit_block_free(b);
		pl_made_free(made);
		return;
	}
	pl_hold(w->places, e->there, b, edit_block_free);
	pl_changed changed = {1, {e->there}};
	hold_header(w, &changed, made);
	pl_made_free(made);
	pl_commit(w->places, &changed);
}

// patches (a list, wire shape: path, range?, value?, move?, paths relative to the row's value) applied
// to the value of the row who has at the anchor, with until, as one write. false: no such row, or a
// patch that is invalid (nothing changes)
static bool edit(pres_world *w, const char *anchor, const char *who, const op_value *list, int64_t until) {
	nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(anchor));
	if (there == NULL || there->value == NULL || there->value->type != OP_MAP) return false;
	if (op_get(there->value, who) == NULL) return false;
	if (list == NULL || list->type != OP_LIST) return false;
	editing e = {w, there, list, who, until, OP_OK};
	as(w, edit_in, &e);
	return e.code == OP_OK;
}

// tell ----------------------------------------------------------------------------------------------

static counted *count_of(counted **list, size_t *n, size_t *cap, const char *who) {
	for (size_t i = 0; i < *n; i++) {
		if (strcmp((*list)[i].who, who) == 0) return &(*list)[i];
	}
	if (*n == *cap) {
		*cap = *cap ? *cap * 2 : 4;
		*list = realloc(*list, *cap * sizeof **list);
		if (*list == NULL) abort();
	}
	(*list)[*n] = (counted){xdup(who), 0};
	return &(*list)[(*n)++];
}

// what a connection tells: my row (a map of value and until), or none: it is gone. patches: the
// edit that made the row, sent instead of the row when the connection sends patches. a connection
// that sends patches numbers what it sends, by who
static void send(pres_conn *c, const char *who, const op_value *row, const op_value *patches) {
	op_value *m = op_map();
	if (row == NULL) op_set(m, "gone", op_bool(1));
	else {
		op_set(m, "ttl", op_num((double)(until_of(row) - now_of(c->w))));
		const op_value *v = op_get(row, "value");
		if (c->patches && patches != NULL) op_set(m, "patches", op_ref((op_value *)patches));
		else op_set(m, "value", v != NULL ? op_ref((op_value *)v) : op_null());
		if (c->patches) {
			counted *k = count_of(&c->sent, &c->nsent, &c->capsent, who);
			op_set(m, "n", op_num((double)++k->n));
		}
	}
	CborOut o = {NULL, 0, 0, true};
	if (!pk_put(&o, m)) abort();
	op_free(m);
	c->channel->send(c->channel, c->topic, o.data, o.length);
	free(o.data);
}

static void tell(pres_world *w, const char *anchor, const char *who, const op_value *row,
	const op_value *patches) {
	state *s = state_of(w);
	size_t n = s->nconns;
	for (size_t i = 0; i < n; i++) {
		pres_conn *c = s->conns[i];
		if (c->active && strcmp(c->anchor, anchor) == 0) send(c, who, row, patches);
	}
}

// the api -------------------------------------------------------------------------------------------

void pres_set(pres_world *w, const char *anchor, const char *who, const op_value *value, int64_t ttl) {
	op_value *row = row_of(value, now_of(w) + ttl);
	put(w, anchor, who, row);
	strs_add(mine_at(state_of(w), anchor, 1), who);
	tell(w, anchor, who, row, NULL);
	op_free(row);
}

bool pres_edit(pres_world *w, const char *anchor, const char *who, const op_value *patches, int64_t ttl) {
	if (!edit(w, anchor, who, patches, now_of(w) + ttl)) return false;
	strs_add(mine_at(state_of(w), anchor, 1), who);
	const nd_entry *there = tb_get(w->table, tb_string(PRES_PART), tb_string(anchor));
	tell(w, anchor, who, op_get(there->value, who), patches);
	return true;
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
	if (was_mine) tell(w, anchor, who, NULL, NULL);
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
	op_value *m = pk_get(bytes, n, NULL, NULL);
	if (m == NULL) return;
	if (m->type == OP_MAP) {
		const op_value *gone = op_get(m, "gone");
		if (gone != NULL && gone->type == OP_BOOL && gone->bool_) {
			const char *gone_who[1];
			take(w, c->anchor, &from, 1, gone_who);
			op_free(m);
			return;
		}
		const op_value *ttl = op_get(m, "ttl"), *n = op_get(m, "n"), *patches = op_get(m, "patches");
		int64_t left = ttl != NULL && ttl->type == OP_NUM ? (int64_t)ttl->num : 0;
		int has_n = n != NULL && n->type == OP_NUM;
		state *s = state_of(w);
		struct taken *last = NULL;
		for (size_t i = 0; i < s->ntaken; i++) {
			if (strcmp(s->taken[i].anchor, c->anchor) == 0 && strcmp(s->taken[i].from, from) == 0) {
				last = &s->taken[i];
			}
		}
		if (patches != NULL) {
			// only the next patch message, and only onto the row that is there
			if (has_n && (last == NULL || (int64_t)n->num != last->n + 1)) {
				op_free(m);
				return;
			}
			if (!edit(w, c->anchor, from, patches, now_of(w) + left)) {
				op_free(m);
				return;
			}
		} else {
			op_value *row = row_of(op_get(m, "value"), now_of(w) + left);
			put(w, c->anchor, from, row);
			op_free(row);
		}
		if (has_n) {
			if (last == NULL) {
				if (s->ntaken == s->captaken) {
					s->captaken = s->captaken ? s->captaken * 2 : 4;
					s->taken = realloc(s->taken, s->captaken * sizeof *s->taken);
					if (s->taken == NULL) abort();
				}
				last = &s->taken[s->ntaken++];
				*last = (struct taken){xdup(c->anchor), xdup(from), 0};
			}
			last->n = (int64_t)n->num;
		}
	}
	op_free(m);
}

pres_conn *pres_connect_patches(pres_world *w, chn_channel *channel, const char *topic,
	const char *anchor, bool patches) {
	state *s = state_of(w);
	pres_conn *c = xalloc(sizeof *c);
	c->w = w;
	c->channel = channel;
	c->topic = xdup(topic);
	c->anchor = xdup(anchor != NULL ? anchor : topic);
	c->active = 1;
	c->patches = patches;
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
		if (row != NULL) send(c, whos[i], row, NULL);
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
	nd_entry *node = nd_make_entry(empty, &h);
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
		for (size_t k = 0; k < s->conns[i]->nsent; k++) free(s->conns[i]->sent[k].who);
		free(s->conns[i]->sent);
		free(s->conns[i]);
	}
	free(s->conns);
	for (size_t i = 0; i < s->ntaken; i++) {
		free(s->taken[i].anchor);
		free(s->taken[i].from);
	}
	free(s->taken);
	free(s);
	w->state = NULL;
}
