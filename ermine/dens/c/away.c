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

// a lookup of strings to pointers: open addressing, linear probing, a key taken out leaving a
// tombstone. keys borrowed: each lives while its entry does
typedef struct {
	const char **keys;
	void **values;
	size_t cap, used, n;
} lookup;

static const char tombstone[1] = "";

static uint64_t hash_n(const char *s, size_t n) {
	uint64_t h = 1469598103934665603u;
	for (size_t i = 0; i < n; i++) h = (h ^ (unsigned char)s[i]) * 1099511628211u;
	return h;
}

// the slot of key (its n bytes): its entry's (*found 1), or the one it would go in
static size_t slot_of(const lookup *x, const char *key, size_t n, int *found) {
	size_t mask = x->cap - 1, i = (size_t)hash_n(key, n) & mask, open = SIZE_MAX;
	for (;; i = (i + 1) & mask) {
		const char *k = x->keys[i];
		if (k == NULL) {
			*found = 0;
			return open != SIZE_MAX ? open : i;
		}
		if (k == tombstone) {
			if (open == SIZE_MAX) open = i;
		} else if (strncmp(k, key, n) == 0 && k[n] == '\0') {
			*found = 1;
			return i;
		}
	}
}

// the value at key's first n bytes; NULL: none
static void *lookup_get_n(const lookup *x, const char *key, size_t n) {
	if (x->cap == 0) return NULL;
	int found;
	size_t i = slot_of(x, key, n, &found);
	return found ? x->values[i] : NULL;
}
static void *lookup_get(const lookup *x, const char *key) { return lookup_get_n(x, key, strlen(key)); }

// key (borrowed) to value (not NULL), in place of any there
static void lookup_put(lookup *x, const char *key, void *value) {
	if ((x->used + 1) * 4 > x->cap * 3) {
		lookup was = *x;
		size_t cap = 16;
		while (cap * 3 < (was.n + 1) * 8) cap *= 2;
		*x = (lookup){xalloc(cap * sizeof *x->keys), xalloc(cap * sizeof *x->values), cap, 0, 0};
		for (size_t i = 0; i < was.cap; i++) {
			if (was.keys[i] != NULL && was.keys[i] != tombstone) lookup_put(x, was.keys[i], was.values[i]);
		}
		free(was.keys);
		free(was.values);
	}
	int found;
	size_t i = slot_of(x, key, strlen(key), &found);
	if (!found) {
		if (x->keys[i] == NULL) x->used++;
		x->n++;
	}
	x->keys[i] = key;
	x->values[i] = value;
}

static void lookup_del(lookup *x, const char *key) {
	if (x->cap == 0) return;
	int found;
	size_t i = slot_of(x, key, strlen(key), &found);
	if (!found) return;
	x->keys[i] = tombstone;
	x->values[i] = NULL;
	x->n--;
}

static void lookup_free(lookup *x) {
	free(x->keys);
	free(x->values);
	*x = (lookup){0};
}

// whether id is a key of x, or under one (a step at a "/")
static int among(const lookup *x, const char *id) {
	if (lookup_get(x, id) != NULL) return 1;
	for (const char *slash = strchr(id, '/'); slash != NULL; slash = strchr(slash + 1, '/')) {
		if (lookup_get_n(x, id, (size_t)(slash - id)) != NULL) return 1;
	}
	return 0;
}

// a path's key: each name's length, ":", the name
static char *path_key(char *const *path, size_t n) {
	size_t length = 1;
	for (size_t i = 0; i < n; i++) length += strlen(path[i]) + 21;
	char *key = xalloc(length), *at = key;
	for (size_t i = 0; i < n; i++) at += sprintf(at, "%zu:%s", strlen(path[i]), path[i]);
	return key;
}

// a leaf this link put in the away trie: its path (under + at) and the path's key, the id there
typedef struct {
	char **path;
	size_t n;
	char *key;
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

// an id one row may write here: the who it is, each part as last written (NULL: not written), its
// place in the link's owned
typedef struct {
	char *id;
	char *who;
	op_value *last[2];
	size_t at;
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
	// the ids rows wrote (by id: owned_ix), and the den's own as a row is mirrored (its node and its
	// processes': no row writes them, or under them)
	owned **owned;
	size_t nowned, capowned;
	lookup owned_ix, mine;
	// what the den's close stops it by: [["dens", "link"]] under the den's owner, torn down at its
	// stop; NULL: the den closed at connect
	sc_scope *tie;
	sc_pair tie_info;
	op_value *tie_value;
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

static void leaf_free(leaf *x) {
	pr_names_free(x->path, x->n);
	free(x->key);
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

static owned *owned_of(const dn_link *l, const char *id) { return lookup_get(&l->owned_ix, id); }

// whether who may write id here: not the den's own; it wrote it, or nothing is there and no other
// who wrote it
static int writable(dn_link *l, const char *who, const char *id) {
	if (among(&l->mine, id)) return 0;
	const owned *o = owned_of(l, id);
	if (o != NULL) return strcmp(o->who, who) == 0;
	size_t n = 0;
	tb_at(l->world.table, tb_string(id), &n);
	return n == 0;
}

// the den's own ids, as a row is mirrored: its node and its processes' (borrowed for the mirror)
static void own(dn_link *l) {
	lookup_free(&l->mine);
	lookup_put(&l->mine, dn_node(l->den), l);
	dn_process *const *ps;
	size_t n = dn_processes(l->den, &ps);
	for (size_t i = 0; i < n; i++) lookup_put(&l->mine, dn_process_id(ps[i]), l);
}

// whether a leaf at path is in a local process's way: at or under its leaf, or on a level of the
// process trie (pr_add's rule, on the process part)
static int shadowed(dn_link *l, char *const *path, size_t n) {
	const nd_entry *e = tb_get(l->world.table, tb_string(PR_PART), pl_root(l->world.places));
	const op_value *v = e != NULL ? e->value : NULL;
	for (size_t i = 0; i < n && is_map(v); i++) {
		v = op_get(v, path[i]);
		if (is_str(v)) return 1;
	}
	return is_map(v) && v->count > 0;
}

// a mirrored node's children: each name to an id (a string) who may write, new
static op_value *kids(dn_link *l, const char *who, const op_value *v) {
	op_value *out = op_map();
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		if (is_str(x) && writable(l, who, x->str)) op_set_name(out, v->keys[i], op_ref((op_value *)x));
	}
	return out;
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
	lookup_del(&l->owned_ix, o->id);
	l->owned[o->at] = l->owned[--l->nowned];
	l->owned[o->at]->at = o->at;
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

// the leaves a row wants, by path (a later one at a path in place of an earlier): their places in
// v + 1, by the path's key
typedef struct {
	leaf *v;
	size_t n, cap;
	lookup at;
} leaves;

// id (one of the row's own, bases) at under + at, unless in a local process's way
static void want(dn_link *l, leaves *w, const lookup *bases, const char *const *at, size_t nat,
	const op_value *id) {
	if (!is_str(id) || lookup_get(bases, id->str) == NULL) return;
	size_t n = l->nunder + nat;
	char **path = xalloc((n + 1) * sizeof *path);
	for (size_t i = 0; i < l->nunder; i++) path[i] = xdup(l->under[i]);
	for (size_t i = 0; i < nat; i++) path[l->nunder + i] = xdup(at[i]);
	if (shadowed(l, path, n)) {
		pr_names_free(path, n);
		return;
	}
	char *key = path_key(path, n);
	uintptr_t there = (uintptr_t)lookup_get(&w->at, key);
	if (there != 0) {
		pr_names_free(path, n);
		free(key);
		free(w->v[there - 1].id);
		w->v[there - 1].id = xdup(id->str);
		return;
	}
	PUSH(w->v, w->n, w->cap, ((leaf){path, n, key, xdup(id->str)}));
	lookup_put(&w->at, key, (void *)(uintptr_t)w->n);
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

// who's row as it is now: what it no longer names out, then what it names in
static void mirror_row(dn_link *l, const char *who, const op_value *value) {
	mirror *m = mirror_of(l, who, 1);
	const op_value *row = is_map(value) ? value : NULL;
	const op_value *nodes = get(row, "nodes");
	if (!is_map(nodes)) nodes = NULL;
	own(l);
	// the row's own ids: its den's and its processes' (each one who may write)
	lookup bases = {0};
	const op_value *den = get(row, "den"), *processes = get(row, "processes");
	if (processes != NULL && processes->type != OP_LIST) processes = NULL;
	if (is_str(den) && writable(l, who, den->str)) lookup_put(&bases, den->str, l);
	for (size_t i = 0; processes != NULL && i < processes->count; i++) {
		const op_value *id = get(processes->items[i], "id");
		if (is_str(id) && writable(l, who, id->str)) lookup_put(&bases, id->str, l);
	}
	// the nodes it names that are its own and who may write, by id
	size_t count = nodes != NULL ? nodes->count : 0, nwanted = 0;
	const char **ids = xalloc((count + 1) * sizeof *ids);
	const op_value **seen = xalloc((count + 1) * sizeof *seen);
	lookup named = {0};
	for (size_t i = 0; i < count; i++) {
		const char *id = nodes->keys[i];
		if (!is_map(nodes->items[i]) || !among(&bases, id) || !writable(l, who, id)) continue;
		ids[nwanted] = id;
		seen[nwanted++] = nodes->items[i];
		lookup_put(&named, id, l);
	}
	leaves w = {0};
	const char *den_at[3] = {dn_dens[0], dn_dens[1], who};
	want(l, &w, &bases, den_at, 3, den);
	for (size_t i = 0; processes != NULL && i < processes->count; i++) {
		const op_value *p = processes->items[i];
		const char **at;
		size_t nat;
		if (!is_map(p) || !at_of(get(p, "at"), &at, &nat)) continue;
		want(l, &w, &bases, at, nat, get(p, "id"));
		free(at);
	}
	// the leaves it no longer wants (or wants another id at), out
	size_t kept = 0;
	for (size_t i = 0; i < m->nleaves; i++) {
		leaf *x = &m->leaves[i];
		uintptr_t still = (uintptr_t)lookup_get(&w.at, x->key);
		if (still != 0 && strcmp(w.v[still - 1].id, x->id) == 0) {
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
		if (lookup_get(&named, m->ids[i]) != NULL) {
			m->ids[kept++] = m->ids[i];
			continue;
		}
		unwrite(l, m->ids[i]);
		free(m->ids[i]);
	}
	m->nids = kept;
	// what it names, in (an id not owned yet: not in m's ids yet either)
	for (size_t i = 0; i < nwanted; i++) {
		owned *o = owned_of(l, ids[i]);
		if (o == NULL) {
			o = xalloc(sizeof *o);
			o->id = xdup(ids[i]);
			o->who = xdup(who);
			o->at = l->nowned;
			PUSH(l->owned, l->nowned, l->capowned, o);
			lookup_put(&l->owned_ix, o->id, o);
			PUSH(m->ids, m->nids, m->capids, xdup(ids[i]));
		}
		const op_value *a = get(seen[i], "attributes"), *c = get(seen[i], "children");
		op_value *named_kids = is_map(c) ? kids(l, who, c) : NULL;
		write_part(l, o, 0, is_map(a) ? a : NULL);
		write_part(l, o, 1, named_kids);
		op_free(named_kids);
	}
	// the leaves it wants that are not in, in
	lookup in = {0};
	for (size_t i = 0; i < m->nleaves; i++) lookup_put(&in, m->leaves[i].key, l);
	for (size_t i = 0; i < w.n; i++) {
		if (lookup_get(&in, w.v[i].key) == NULL && put_leaf(l, &w.v[i]) == 0) {
			PUSH(m->leaves, m->nleaves, m->capleaves, w.v[i]);
		} else leaf_free(&w.v[i]);
	}
	lookup_free(&in);
	lookup_free(&w.at);
	free(w.v);
	lookup_free(&named);
	lookup_free(&bases);
	lookup_free(&l->mine);
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
		if (!is_address(get(m, "runner")) || !is_map(get(m, "program")) ||
			!is_str(get(get(m, "program"), "id")) || !is_address(get(m, "at"))) {
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
	if (l->tie != NULL) free(sc_teardown(l->tie));
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
	// the den's close stops it, by a scope of the link's under the den's owner, torn down at its stop
	// (so a link stopped leaves nothing on the owner). the den closed: stopped now
	l->tie_value = op_str("link");
	l->tie_info = (sc_pair){"dens", l->tie_value};
	l->tie = sc_create_scope(s, &l->tie_info, 1, dn_scope(d));
	free(sc_register_teardown(s, l->tie != NULL ? l->tie : dn_scope(d), stop_teardown, l));
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
	lookup_free(&l->owned_ix);
	lookup_free(&l->mine);
	op_free(l->tie_value);
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
