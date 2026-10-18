// away (away.h), after typescript/away.ts.
#include "away.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/status.h"
#include "../../encoding/c/cbor.h"
#include "../../encoding/c/pack.h"
#include "../../processes/c/start.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("away: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a, b and c, one after the other: a topic
static char *cat3(const char *a, const char *b, const char *c) {
	size_t na = strlen(a), nb = strlen(b), nc = strlen(c);
	char *s = xalloc(na + nb + nc + 1);
	memcpy(s, a, na);
	memcpy(s + na, b, nb);
	memcpy(s + na + nb, c, nc + 1);
	return s;
}

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static const char *const parts[2] = {"attributes", "children"};

// a leaf this link put in the away trie: its path (under + at), the id there
typedef struct {
	char **path;
	size_t n;
	char *id;
} leaf;

// what one other den's row put here: its leaves, the ids it names (in the order first named)
typedef struct {
	char *who;
	leaf *leaves;
	size_t nleaves, capleaves;
	char **ids;
	size_t nids, capids;
} mirror;

// an id one row may write here: the who it is, each part as last written (NULL: not written)
typedef struct {
	char *id;
	char *who;
	op_value *last[2];
} owned;

// an ask by n: to whom it went (NULL: none sent), its answer once it lands, the key it is told by
typedef struct {
	unsigned n;
	char *to;
	op_value *answer;
	char key;
} asked;

struct dn_link {
	dn *den;
	chn_channel *channel;
	char *topic, *anchor, *ask_topic, *answer_topic;
	char **under;
	size_t nunder;
	int publish, hide;
	int64_t ttl;
	pres_world world;
	pres_conn *conn;
	// its scope: [["dens", "away"], ["topic", topic]]
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	chn_listener *on_ask, *on_answer;
	// its row as last set (a beat sets it again)
	op_value *last;
	mirror **mirrors;
	size_t nmirrors, capmirrors;
	owned **owned;
	size_t nowned, capowned;
	asked **asks;
	size_t nasks, capasks;
	unsigned count;
	int stopped;
};

// small pieces ---------------------------------------------------------------------------------

static int is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }
static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }
static int is_address(const op_value *v) { return v != NULL && (v->type == OP_STR || v->type == OP_LIST); }
static const op_value *get(const op_value *map, const char *key) {
	return is_map(map) ? op_get(map, key) : NULL;
}
static const char *str_at(const op_value *map, const char *key) {
	const op_value *v = get(map, key);
	return is_str(v) ? v->str : NULL;
}

static int same_path(char *const *a, size_t na, char *const *b, size_t nb) {
	if (na != nb) return 0;
	for (size_t i = 0; i < na; i++) {
		if (strcmp(a[i], b[i]) != 0) return 0;
	}
	return 1;
}

static void leaf_free(leaf *x) {
	pr_names_free(x->path, x->n);
	free(x->id);
	*x = (leaf){0};
}

// f with the scope open; torn down (its own teardown): with what is open, as it is
static void within(sc_scope *o, void (*f)(void *data), void *data) {
	if (o != NULL && sc_scope_alive(o)) sc_run_with_scope(o, f, data);
	else f(data);
}

// a value's encoding, fresh, and its length; NULL: none (a function hf holds, a stand-in of no kind)
static unsigned char *encoded(const op_value *v, size_t *length) {
	if (v == NULL || hf_holds(v)) return NULL;
	Json *j = pk_to_json(v);
	if (j == NULL) return NULL;
	const char *why = NULL;
	if (!cborEncode(j, NULL, 0, length, &why)) {
		jsonFree(j);
		return NULL;
	}
	unsigned char *bytes = xalloc(*length);
	cborEncode(j, bytes, *length, length, &why);
	jsonFree(j);
	return bytes;
}

// a message sent on the topic; 0: it has no encoding, nothing sent
static int send_on(dn_link *l, const char *topic, const op_value *m) {
	size_t length = 0;
	unsigned char *bytes = encoded(m, &length);
	if (bytes == NULL) return 0;
	l->channel->send(l->channel, topic, bytes, length);
	free(bytes);
	return 1;
}

// a message as sent: a map with a number n, new; NULL: it does not decode, or is none
static op_value *message_of(const unsigned char *bytes, size_t n) {
	Json *j = cborDecode(bytes, n, NULL, NULL);
	if (j == NULL) return NULL;
	op_value *m = pk_of_json(j);
	jsonFree(j);
	const op_value *k = get(m, "n");
	if (k == NULL || k->type != OP_NUM) {
		op_free(m);
		return NULL;
	}
	return m;
}

// n as an ask's number: a whole one from 1
static int whole(const op_value *v, unsigned *out) {
	if (v == NULL || v->type != OP_NUM || !(v->num >= 1 && v->num <= (double)UINT32_MAX)) return 0;
	if (v->num != (double)(unsigned)v->num) return 0;
	*out = (unsigned)v->num;
	return 1;
}

// writes, with the link's scope open ----------------------------------------------------------------

// a header made now, with the scope open; 0: none open
static int header_now(dn_link *l, ch_header *h, pl_made **made) {
	char *bad = pl_header(l->world.places, NULL, 0, CH_HERE, h, made);
	if (bad == NULL) return 1;
	free(bad);
	return 0;
}

// the entries a write changed: said written, each holding the header's block
static void settle(dn_link *l, const pl_changed *changed, pl_made *made) {
	pl *p = l->world.places;
	if (changed->n > 0) pl_commit(p, changed);
	for (size_t i = 0; i < changed->n; i++) {
		pl_hold_also(p, changed->entries[i], pl_made_ref(made), pl_made_free);
	}
}

// a leaf put in: 0, or places' code
static int put_leaf(dn_link *l, const leaf *x) {
	ch_header h;
	pl_made *made;
	if (!header_now(l, &h, &made)) return -1;
	pl *p = l->world.places;
	pl_changed changed = {0};
	nd_entry *born = NULL;
	int code = pr_add_in(p, l->world.table, DN_AWAY, pl_root(p), (const char *const *)x->path, x->n,
		tb_string(x->id), h, &changed, &born);
	if (code == 0) {
		settle(l, &changed, made);
		if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	}
	pl_made_free(made);
	return code;
}

// a leaf taken out; none there: nothing
static void take_leaf(dn_link *l, const leaf *x) {
	ch_header h;
	pl_made *made;
	if (!header_now(l, &h, &made)) return;
	pl *p = l->world.places;
	pl_changed changed = {0};
	if (pr_remove_in(p, l->world.table, DN_AWAY, pl_root(p), (const char *const *)x->path, x->n, h,
			&changed) == 0)
		settle(l, &changed, made);
	pl_made_free(made);
}

// a mirrored node's attributes: the status as this side holds it ("pending": pending, { failed }:
// an error, status.h's; anything else left out), new
static op_value *attributes_of(const op_value *v) {
	op_value *out = op_map();
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		if (strcmp(v->keys[i], CST_ATTRIBUTE) != 0) {
			op_set_name(out, v->keys[i], op_ref((op_value *)x));
		} else if (is_str(x) && strcmp(x->str, "pending") == 0) {
			op_set(out, CST_ATTRIBUTE, op_stand(op_str("ermine.pending")));
		} else if (str_at(x, "failed") != NULL) {
			op_value *e = op_map();
			op_set(e, "name", op_str("Error"));
			op_set(e, "message", op_str(str_at(x, "failed")));
			op_set(out, CST_ATTRIBUTE, op_stand(e));
		}
	}
	return out;
}

static owned *owned_of(const dn_link *l, const char *id) {
	for (size_t i = 0; i < l->nowned; i++) {
		if (strcmp(l->owned[i]->id, id) == 0) return l->owned[i];
	}
	return NULL;
}

// whether who may write id here: it wrote it, or nothing is there and no other who wrote it
static int writable(dn_link *l, const char *who, const char *id) {
	const owned *o = owned_of(l, id);
	if (o != NULL) return strcmp(o->who, who) == 0;
	size_t n = 0;
	tb_at(l->world.table, tb_string(id), &n);
	return n == 0;
}

// one part of a mirrored node as wanted (NULL: taken out), written only when it changed
static void write_part(dn_link *l, owned *o, int k, const op_value *v) {
	tb_table *t = l->world.table;
	if (v == NULL) {
		if (o->last[k] == NULL) return;
		op_free(o->last[k]);
		o->last[k] = NULL;
		if (tb_get(t, tb_string(parts[k]), tb_string(o->id)) != NULL) {
			tb_del(t, tb_string(parts[k]), tb_string(o->id));
		}
		return;
	}
	if (o->last[k] != NULL && pr_same(o->last[k], v)) return;
	ch_header h;
	pl_made *made;
	if (!header_now(l, &h, &made)) return;
	pl *p = l->world.places;
	op_value *value = k == 0 ? attributes_of(v) : op_ref((op_value *)v);
	nd_entry *e = nd_make_entry(value, &h, NULL);
	op_free(value);
	pl_own(p, e);
	pl_hold(p, e, made, pl_made_free);
	tb_sub(t, tb_string(parts[k]), tb_string(o->id), e);
	op_free(o->last[k]);
	o->last[k] = op_ref((op_value *)v);
}

// an id a row wrote, out
static void unwrite(dn_link *l, const char *id) {
	owned *o = owned_of(l, id);
	if (o == NULL) return;
	write_part(l, o, 0, NULL);
	write_part(l, o, 1, NULL);
	for (size_t i = 0; i < l->nowned; i++) {
		if (l->owned[i] != o) continue;
		memmove(&l->owned[i], &l->owned[i + 1], (l->nowned - i - 1) * sizeof *l->owned);
		l->nowned--;
		break;
	}
	free(o->id);
	free(o->who);
	free(o);
}

// mirrors -----------------------------------------------------------------------------------------

static mirror *mirror_of(dn_link *l, const char *who, int make) {
	for (size_t i = 0; i < l->nmirrors; i++) {
		if (strcmp(l->mirrors[i]->who, who) == 0) return l->mirrors[i];
	}
	if (!make) return NULL;
	mirror *m = xalloc(sizeof *m);
	m->who = xdup(who);
	PUSH(l->mirrors, l->nmirrors, l->capmirrors, m);
	return m;
}

static void mirror_free(mirror *m) {
	for (size_t i = 0; i < m->nleaves; i++) leaf_free(&m->leaves[i]);
	free(m->leaves);
	for (size_t i = 0; i < m->nids; i++) free(m->ids[i]);
	free(m->ids);
	free(m->who);
	free(m);
}

// who's row gone: its leaves and entries out
static void drop(dn_link *l, const char *who) {
	mirror *m = mirror_of(l, who, 0);
	if (m == NULL) return;
	for (size_t i = 0; i < l->nmirrors; i++) {
		if (l->mirrors[i] != m) continue;
		memmove(&l->mirrors[i], &l->mirrors[i + 1], (l->nmirrors - i - 1) * sizeof *l->mirrors);
		l->nmirrors--;
		break;
	}
	for (size_t i = 0; i < m->nleaves; i++) take_leaf(l, &m->leaves[i]);
	for (size_t i = 0; i < m->nids; i++) unwrite(l, m->ids[i]);
	mirror_free(m);
}

// the leaves a row wants, by path (a later one at a path in place of an earlier)
typedef struct {
	leaf *v;
	size_t n, cap;
} leaves;

static leaf *leaf_at(leaf *v, size_t n, char *const *path, size_t npath) {
	for (size_t i = 0; i < n; i++) {
		if (same_path(v[i].path, v[i].n, path, npath)) return &v[i];
	}
	return NULL;
}

// id at under + at, if who may write it
static void want(dn_link *l, leaves *w, const char *who, const char *const *at, size_t nat,
	const op_value *id) {
	if (!is_str(id) || !writable(l, who, id->str)) return;
	size_t n = l->nunder + nat;
	char **path = xalloc((n + 1) * sizeof *path);
	for (size_t i = 0; i < l->nunder; i++) path[i] = xdup(l->under[i]);
	for (size_t i = 0; i < nat; i++) path[l->nunder + i] = xdup(at[i]);
	leaf *there = leaf_at(w->v, w->n, path, n);
	if (there != NULL) {
		pr_names_free(path, n);
		free(there->id);
		there->id = xdup(id->str);
		return;
	}
	PUSH(w->v, w->n, w->cap, ((leaf){path, n, xdup(id->str)}));
}

// a process's at: a list of strings; else 0
static int at_of(const op_value *at, const char ***out, size_t *n) {
	if (at == NULL || at->type != OP_LIST) return 0;
	const char **names = xalloc((at->count + 1) * sizeof *names);
	for (size_t i = 0; i < at->count; i++) {
		if (!is_str(at->items[i])) {
			free(names);
			return 0;
		}
		names[i] = at->items[i]->str;
	}
	*out = names;
	*n = at->count;
	return 1;
}

static int has_id(const mirror *m, const char *id) {
	for (size_t i = 0; i < m->nids; i++) {
		if (strcmp(m->ids[i], id) == 0) return 1;
	}
	return 0;
}

// who's row as it is now: what it no longer names out, then what it names in
static void mirror_row(dn_link *l, const char *who, const op_value *value) {
	mirror *m = mirror_of(l, who, 1);
	const op_value *row = is_map(value) ? value : NULL;
	const op_value *nodes = get(row, "nodes");
	if (!is_map(nodes)) nodes = NULL;
	size_t count = nodes != NULL ? nodes->count : 0, nwanted = 0;
	const char **ids = xalloc((count + 1) * sizeof *ids);
	const op_value **seen = xalloc((count + 1) * sizeof *seen);
	for (size_t i = 0; i < count; i++) {
		if (!is_map(nodes->items[i]) || !writable(l, who, nodes->keys[i])) continue;
		ids[nwanted] = nodes->keys[i];
		seen[nwanted++] = nodes->items[i];
	}
	leaves w = {0};
	const char *den_at[3] = {dn_dens[0], dn_dens[1], who};
	want(l, &w, who, den_at, 3, get(row, "den"));
	const op_value *processes = get(row, "processes");
	for (size_t i = 0; processes != NULL && processes->type == OP_LIST && i < processes->count; i++) {
		const op_value *p = processes->items[i];
		const char **at;
		size_t nat;
		if (!is_map(p) || !at_of(get(p, "at"), &at, &nat)) continue;
		want(l, &w, who, at, nat, get(p, "id"));
		free(at);
	}
	// the leaves it no longer wants (or wants another id at), out
	size_t kept = 0;
	for (size_t i = 0; i < m->nleaves; i++) {
		leaf *x = &m->leaves[i];
		const leaf *still = leaf_at(w.v, w.n, x->path, x->n);
		if (still != NULL && strcmp(still->id, x->id) == 0) {
			m->leaves[kept++] = *x;
			continue;
		}
		take_leaf(l, x);
		leaf_free(x);
	}
	m->nleaves = kept;
	// the ids it no longer names, out
	kept = 0;
	for (size_t i = 0; i < m->nids; i++) {
		int still = 0;
		for (size_t k = 0; k < nwanted && !still; k++) still = strcmp(ids[k], m->ids[i]) == 0;
		if (still) {
			m->ids[kept++] = m->ids[i];
			continue;
		}
		unwrite(l, m->ids[i]);
		free(m->ids[i]);
	}
	m->nids = kept;
	// what it names, in
	for (size_t i = 0; i < nwanted; i++) {
		owned *o = owned_of(l, ids[i]);
		if (o == NULL) {
			o = xalloc(sizeof *o);
			o->id = xdup(ids[i]);
			o->who = xdup(who);
			PUSH(l->owned, l->nowned, l->capowned, o);
		}
		if (!has_id(m, ids[i])) PUSH(m->ids, m->nids, m->capids, xdup(ids[i]));
		const op_value *a = get(seen[i], "attributes"), *c = get(seen[i], "children");
		write_part(l, o, 0, is_map(a) ? a : NULL);
		write_part(l, o, 1, is_map(c) ? c : NULL);
	}
	for (size_t i = 0; i < w.n; i++) {
		if (leaf_at(m->leaves, m->nleaves, w.v[i].path, w.v[i].n) == NULL && put_leaf(l, &w.v[i]) == 0) {
			PUSH(m->leaves, m->nleaves, m->capleaves, w.v[i]);
		} else leaf_free(&w.v[i]);
	}
	free(w.v);
	free(ids);
	free(seen);
}

typedef struct {
	dn_link *l;
	const op_value *rows;
} reconciling;

// the rows (a map, who: value) as they are now: those gone dropped, each other mirrored
static void reconcile(void *data) {
	reconciling *r = data;
	dn_link *l = r->l;
	size_t n = l->nmirrors, gone = 0;
	char **whos = xalloc((n + 1) * sizeof *whos);
	for (size_t i = 0; i < n; i++) {
		if (op_get(r->rows, l->mirrors[i]->who) == NULL) whos[gone++] = xdup(l->mirrors[i]->who);
	}
	for (size_t i = 0; i < gone; i++) drop(l, whos[i]), free(whos[i]);
	free(whos);
	for (size_t i = 0; i < r->rows->count; i++) mirror_row(l, r->rows->keys[i], r->rows->items[i]);
}

static void drop_all(void *data) {
	dn_link *l = data;
	while (l->nmirrors > 0) {
		char *who = xdup(l->mirrors[0]->who);
		drop(l, who);
		free(who);
	}
}

// the effects ---------------------------------------------------------------------------------------

// my row: the den's nodes, the reads told
static sc_out publish_f(void *previous, void *data) {
	(void)previous;
	dn_link *l = data;
	op_value *v = dn_nodes(l->den, !l->hide);
	if (pl_status(l->world.places) == SC_STOP) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

static bool publish_equal(const void *a, const void *b, void *data) {
	(void)data;
	return a != NULL && b != NULL && pr_same(a, b);
}

static char *publish_act(void *value, void *previous, void *data) {
	(void)previous;
	dn_link *l = data;
	if (value == NULL) return NULL;
	op_value *was = l->last;
	l->last = op_ref(value);
	op_free(was);
	pres_set(&l->world, l->anchor, l->channel->name, l->last, l->ttl);
	return NULL;
}

// the other rows, a map who: value, the reads told
static sc_out mirror_f(void *previous, void *data) {
	(void)previous;
	dn_link *l = data;
	pres_lives rows = pres_read(&l->world, l->anchor);
	op_value *m = op_map();
	for (size_t i = 0; i < rows.n; i++) {
		if (strcmp(rows.items[i].who, l->channel->name) != 0) {
			op_set(m, rows.items[i].who, op_ref(rows.items[i].value));
		}
	}
	pres_lives_free(&rows);
	if (pl_status(l->world.places) == SC_STOP) {
		op_free(m);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = m};
}

static char *mirror_act(void *value, void *previous, void *data) {
	(void)previous;
	dn_link *l = data;
	if (!is_map(value)) return NULL;
	reconciling r = {l, value};
	within(l->scope, reconcile, &r);
	return NULL;
}

static void make_effects(void *data) {
	dn_link *l = data;
	sc_scheduler *s = dn_scheduler(l->den);
	if (l->publish) {
		sc_create_effect(s, (sc_def){.f = publish_f, .effect = publish_act, .equal = publish_equal,
			.data = l}, NULL, 0);
	}
	sc_create_effect(s, (sc_def){.f = mirror_f, .effect = mirror_act, .data = l}, NULL, 0);
}

// asks --------------------------------------------------------------------------------------------

// the ask an ask message says (its who apart); NULL: not one
static op_value *ask_of(const op_value *m) {
	const char *op = str_at(m, "op");
	if (op == NULL) return NULL;
	static const char *const starts[5] = {"runner", "program", "at", "args", "cwd"};
	static const char *const stops[2] = {"process", "reason"};
	const char *const *keys;
	size_t n;
	if (strcmp(op, "start") == 0) {
		if (!is_address(get(m, "runner")) || !is_map(get(m, "program")) || !is_address(get(m, "at"))) {
			return NULL;
		}
		keys = starts, n = 5;
	} else if (strcmp(op, "stop") == 0) {
		if (!is_str(get(m, "process"))) return NULL;
		keys = stops, n = 2;
	} else return NULL;
	op_value *a = op_map();
	op_set(a, "op", op_str(op));
	for (size_t i = 0; i < n; i++) {
		const op_value *x = get(m, keys[i]);
		if (x != NULL) op_set(a, keys[i], op_ref((op_value *)x));
	}
	return a;
}

typedef struct {
	dn_link *l;
	const op_value *who, *ask;
	op_value *out;
} answering;

// the den asked, the link's scope open: its answer, a places code as { error }
static void answer_now(void *data) {
	answering *x = data;
	op_value *got = dn_ask(x->l->den, x->who, x->ask);
	const char *refused = str_at(got, "refused");
	if (got == NULL || (refused != NULL && (strcmp(refused, "not-a-name") == 0 ||
		strcmp(refused, "nothing-there") == 0 || strcmp(refused, "already-there") == 0))) {
		x->out = op_map();
		op_set(x->out, "error", op_str(got != NULL ? refused : "not an ask"));
		op_free(got);
		return;
	}
	x->out = got;
}

// an ask to this den: answered on the asker's answer topic
static void heard_ask(void *ctx, const char *from, const unsigned char *bytes, size_t n) {
	dn_link *l = ctx;
	op_value *m = message_of(bytes, n);
	if (m == NULL) return;
	op_value *a = ask_of(m);
	if (a == NULL) {
		op_free(m);
		return;
	}
	const op_value *given = get(m, "who");
	const op_value *actor = get(given, "actor"), *reader = get(given, "reader");
	op_value *who = op_map();
	if (actor != NULL) op_set(who, "actor", op_ref((op_value *)actor));
	if (is_str(reader)) op_set(who, "reader", op_ref((op_value *)reader));
	op_set(who, "device", op_str(from));
	answering x = {l, who, a, NULL};
	within(l->scope, answer_now, &x);
	op_value *reply = op_map();
	op_set(reply, "n", op_ref(op_get(m, "n")));
	op_set(reply, "answer", x.out);
	char *topic = cat3(l->anchor, "/answer/", from);
	send_on(l, topic, reply);
	free(topic);
	op_free(reply);
	op_free(who);
	op_free(a);
	op_free(m);
}

static asked *asked_of(dn_link *l, unsigned n, int make) {
	for (size_t i = 0; i < l->nasks; i++) {
		if (l->asks[i]->n == n) return l->asks[i];
	}
	if (!make) return NULL;
	asked *a = xalloc(sizeof *a);
	a->n = n;
	PUSH(l->asks, l->nasks, l->capasks, a);
	return a;
}

// an answer to an ask of this den's: kept from the den it was sent to, the first
static void heard_answer(void *ctx, const char *from, const unsigned char *bytes, size_t n) {
	dn_link *l = ctx;
	op_value *m = message_of(bytes, n);
	if (m == NULL) return;
	unsigned k;
	asked *a = whole(op_get(m, "n"), &k) ? asked_of(l, k, 0) : NULL;
	const op_value *answer = op_get(m, "answer");
	if (a != NULL && a->to != NULL && strcmp(a->to, from) == 0 && a->answer == NULL && is_map(answer)) {
		a->answer = op_ref((op_value *)answer);
		const void *keys[1] = {&a->key};
		sc_mark(dn_scheduler(l->den), keys, 1, NULL);
	}
	op_free(m);
}

unsigned dn_remote(dn_link *l, const char *to, const op_value *ask) {
	if (l->stopped || to == NULL || !is_map(ask)) return 0;
	op_value *base = pl_change_base(l->world.places, NULL, 0);
	op_value *who = op_map();
	const op_value *actor = get(base, "actor"), *reader = get(base, "reader");
	if (actor != NULL) op_set(who, "actor", op_ref((op_value *)actor));
	if (reader != NULL) op_set(who, "reader", op_ref((op_value *)reader));
	op_free(base);
	unsigned n = l->count + 1;
	op_value *m = op_map();
	op_set(m, "n", op_num((double)n));
	for (size_t i = 0; i < ask->count; i++) {
		if (strcmp(ask->keys[i], "n") == 0 || strcmp(ask->keys[i], "who") == 0) continue;
		op_set_name(m, ask->keys[i], op_ref(ask->items[i]));
	}
	op_set(m, "who", who);
	size_t length = 0;
	unsigned char *bytes = encoded(m, &length);
	op_free(m);
	if (bytes == NULL) return 0;
	l->count = n;
	asked *a = asked_of(l, n, 1);
	free(a->to);
	a->to = xdup(to);
	char *topic = cat3(l->anchor, "/ask/", to);
	l->channel->send(l->channel, topic, bytes, length);
	free(topic);
	free(bytes);
	return n;
}

const op_value *dn_answer(dn_link *l, unsigned n) {
	asked *a = asked_of(l, n, 1);
	sc_track(dn_scheduler(l->den), &a->key);
	return a->answer;
}

typedef struct {
	pl *places;
	const char *const *path;
	size_t n;
	char *id;
} getting;

static void get_now(void *data) {
	getting *g = data;
	tb_key id;
	if (pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL) g->id = xdup(id.string);
}

op_value *dn_carry(dn_link *l, const char *const *at, size_t nat, int code) {
	size_t n;
	char **names = pr_names(at, nat, &n);
	getting g = {l->world.places, (const char *const *)names, n, NULL};
	pl_peep(l->world.places, get_now, &g);
	pr_names_free(names, n);
	const nd_entry *e = g.id != NULL ? tb_get(l->world.table, tb_string("value"), tb_string(g.id)) : NULL;
	if (e == NULL) {
		free(g.id);
		return NULL;
	}
	const nd_entry *ae = tb_get(l->world.table, tb_string("attributes"), tb_string(g.id));
	const op_value *attrs = ae != NULL ? ae->value : NULL;
	op_value *out = op_map();
	op_set(out, "id", op_str(g.id));
	char hex[65];
	if (e->value != NULL && dn_hash_hex(e->value, hex)) op_set(out, "hash", op_str(hex));
	if (str_at(attrs, DN_ATTRIBUTE) != NULL) op_set(out, "type", op_str(str_at(attrs, DN_ATTRIBUTE)));
	if (str_at(attrs, DN_PROGRAM_API) != NULL) op_set(out, "api", op_str(str_at(attrs, DN_PROGRAM_API)));
	if (code) op_set(out, "code", e->value != NULL ? op_ref(e->value) : op_null());
	free(g.id);
	return out;
}

// the link ------------------------------------------------------------------------------------------

void dn_away_init(pr_processes *rows, tb_key root) { pr_trie_init(rows, DN_AWAY, root, "away"); }

// every step runs: its row cleared (when it published, its scope alive), mirrors out, listeners
// off, its scope torn down
static void stop(dn_link *l) {
	if (l->stopped) return;
	l->stopped = 1;
	if (l->publish && sc_scope_alive(l->scope)) pres_clear(&l->world, l->anchor, l->channel->name);
	within(l->scope, drop_all, l);
	pres_stop(l->conn);
	l->channel->off(l->channel, l->on_ask);
	l->channel->off(l->channel, l->on_answer);
	free(sc_teardown(l->scope));
}

static char *stop_teardown(void *data) {
	stop(data);
	return NULL;
}

dn_link *dn_connect(dn *d, chn_channel *channel, const dn_link_setup *setup) {
	if (channel == NULL || channel->name == NULL || strcmp(channel->name, dn_id(d)) != 0) return NULL;
	dn_link_setup none = {0};
	const dn_link_setup *o = setup != NULL ? setup : &none;
	pl *p = dn_places(d);
	sc_scheduler *s = dn_scheduler(d);
	const char *root = pl_root(p).string;
	const char *topic = o->topic != NULL ? o->topic : root;
	if (topic == NULL) return NULL;
	dn_link *l = xalloc(sizeof *l);
	l->den = d;
	l->channel = channel;
	l->topic = xdup(topic);
	l->anchor = cat3(DN_ANCHOR, topic, "");
	l->under = xalloc((o->nunder + 1) * sizeof *l->under);
	for (size_t i = 0; i < o->nunder; i++) l->under[i] = xdup(o->under[i]);
	l->nunder = o->nunder;
	l->publish = o->publish == DN_PUBLISH_DEFAULT ? root != NULL && strcmp(topic, root) == 0
	                                              : o->publish == DN_PUBLISH_YES;
	l->hide = o->hide_processes;
	l->ttl = o->ttl > 0 ? o->ttl : 10000;
	l->values[0] = op_str("away");
	l->values[1] = op_str(topic);
	l->info[0] = (sc_pair){"dens", l->values[0]};
	l->info[1] = (sc_pair){"topic", l->values[1]};
	l->scope = sc_create_scope(s, l->info, 2, NULL);
	if (l->scope == NULL) {
		l->stopped = 1;
		dn_link_free(l);
		return NULL;
	}
	l->world = (pres_world){.table = dn_table(d), .places = p, .scheduler = s, .scope = l->scope,
		.now = o->now, .now_ctx = o->now_ctx};
	sc_run_with_scope(l->scope, make_effects, l);
	l->conn = pres_connect_patches(&l->world, channel, l->anchor, NULL, false);
	l->ask_topic = cat3(l->anchor, "/ask/", channel->name);
	l->answer_topic = cat3(l->anchor, "/answer/", channel->name);
	l->on_ask = channel->on(channel, l->ask_topic, heard_ask, l);
	l->on_answer = channel->on(channel, l->answer_topic, heard_answer, l);
	pres_announce(l->conn);
	free(sc_register_teardown(s, l->scope, stop_teardown, l));
	free(sc_register_teardown(s, dn_scope(d), stop_teardown, l));
	return l;
}

void dn_announce(dn_link *l) {
	if (!l->stopped) pres_announce(l->conn);
}

void dn_beat(dn_link *l) {
	if (!l->stopped && l->last != NULL) pres_set(&l->world, l->anchor, l->channel->name, l->last, l->ttl);
}

pres_swept dn_sweep(dn_link *l) {
	if (l->stopped) return (pres_swept){0};
	return pres_sweep_now(&l->world);
}

pres_world *dn_link_world(dn_link *l) { return &l->world; }
const char *dn_link_anchor(const dn_link *l) { return l->anchor; }

void dn_disconnect(dn_link *l) { stop(l); }

void dn_link_free(dn_link *l) {
	if (l == NULL) return;
	pres_free(&l->world);
	for (size_t i = 0; i < l->nmirrors; i++) mirror_free(l->mirrors[i]);
	free(l->mirrors);
	for (size_t i = 0; i < l->nowned; i++) {
		owned *o = l->owned[i];
		op_free(o->last[0]);
		op_free(o->last[1]);
		free(o->id);
		free(o->who);
		free(o);
	}
	free(l->owned);
	for (size_t i = 0; i < l->nasks; i++) {
		free(l->asks[i]->to);
		op_free(l->asks[i]->answer);
		free(l->asks[i]);
	}
	free(l->asks);
	for (size_t i = 0; i < l->nunder; i++) free(l->under[i]);
	free(l->under);
	op_free(l->last);
	op_free(l->values[0]);
	op_free(l->values[1]);
	free(l->topic);
	free(l->anchor);
	free(l->ask_topic);
	free(l->answer_topic);
	free(l);
}
