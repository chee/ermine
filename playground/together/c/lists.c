// What each path of a node holds (lists.h), in C
#include "lists.h"
#include "ids.h"

#include <stdlib.h>
#include <string.h>

typedef struct node {
	char *key;
	ls_write **writes;
	size_t nw, cw;
	struct node **kids;
	size_t nk, ck;
	// the shallow writes over it not owning one of its writes, as last looked
	const ls_write **over;
	size_t no, co;
} node_t;

struct ls_lists {
	const hy_history *h;
	ls_after after;
	void *context;
	node_t root;
	size_t size;
	// one line of commits, each on the one before: ancestry is lamport
	bool forked;
	const hy_kept *tip;
	// every write and commit made, the lists' own
	ls_write **all;
	size_t na, ca;
	cm_commit **commits;
	size_t nc, cc;
	bool seen;
};

#define GROW(list, n, room)                                                                        \
	do {                                                                                       \
		if ((n) == (room)) {                                                               \
			(room) = (room) ? (room) * 2 : 4;                                          \
			(list) = realloc((list), (room) * sizeof *(list));                         \
			if ((list) == NULL) abort();                                               \
		}                                                                                  \
	} while (0)

// ---- values

bool ls_whole(const op_patch *p) {
	if (p->place.has_range || p->has_move) return true;
	for (size_t i = 0; i < p->place.length; i++)
		if (p->place.path[i].type != OP_STR_KEY) return true;
	return false;
}

size_t ls_keyed(const op_patch *p) {
	size_t i = 0;
	while (i < p->place.length && p->place.path[i].type == OP_STR_KEY) i++;
	return i;
}

static size_t keyed_target(const op_target *t) {
	size_t i = 0;
	while (i < t->length && t->path[i].type == OP_STR_KEY) i++;
	return i;
}

const op_value *ls_dig(const op_value *v, const char *const *keys, size_t n) {
	for (size_t i = 0; i < n && v != NULL; i++) v = v->type == OP_MAP ? op_get(v, keys[i]) : NULL;
	return v;
}

// a map of the keys, nested, v at the end (held)
static op_value *nested(const op_key *keys, size_t n, const op_value *v) {
	op_value *out = op_ref((op_value *)v);
	for (size_t i = n; i-- > 0;) {
		op_value *m = op_map();
		op_set(m, keys[i].s, out);
		out = m;
	}
	return out;
}

int ls_applies(const op_value *value, const op_patch *patches, size_t n, int in_place, op_value **out,
	size_t *failed) {
	op_value *cur = op_ref((op_value *)value);
	op_apply_options o = {.in_place = in_place};
	for (size_t i = 0; i < n; i++) {
		const op_patch *p = &patches[i];
		op_patch q = *p;
		op_value *made = NULL;
		if (!ls_whole(p) && p->place.length > 0) {
			size_t len = p->place.length;
			const op_key *keys = p->place.path;
			if (cur == NULL) {
				if (!p->has_value) continue;
				made = nested(keys, len, p->value);
				q.place.length = 0;
				q.value = made;
			} else {
				if (cur->type != OP_MAP) continue;
				const op_value *at = cur;
				bool skip = false;
				size_t j = 0;
				for (; j + 1 < len; j++) {
					const op_value *next = op_get(at, keys[j].s);
					if (next == NULL) {
						if (!p->has_value) skip = true;
						else {
							made = nested(keys + j + 1, len - j - 1, p->value);
							q.place.length = j + 1;
							q.value = made;
						}
						break;
					}
					if (next->type != OP_MAP) {
						skip = true;
						break;
					}
					at = next;
				}
				if (skip) continue;
				if (made == NULL && !p->has_value && op_get(at, keys[len - 1].s) == NULL) continue;
			}
		}
		op_value *next;
		int code = op_apply(cur, &q, 1, &o, &next, NULL);
		op_free(made);
		if (code != OP_OK) {
			op_free(cur);
			if (failed != NULL) *failed = i;
			return code;
		}
		op_free(cur);
		cur = next;
	}
	*out = cur;
	return OP_OK;
}

// a map's shallow copy, its items held; without: a key left out (NULL: none)
static op_value *map_copy(const op_value *m, const char *without) {
	op_value *c = op_map();
	for (size_t i = 0; i < m->count; i++)
		if (without == NULL || strcmp(m->keys[i], without) != 0) op_set_name(c, m->keys[i], op_ref(m->items[i]));
	return c;
}

// root (a map) with v (borrowed) at keys, or taken out (gone): new, the containers on the way copied
static op_value *with(const op_value *root, const char *const *keys, size_t n, const op_value *v, bool gone) {
	if (n == 1) {
		if (gone) return map_copy(root, keys[0]);
		op_value *c = map_copy(root, NULL);
		op_set(c, keys[0], op_ref((op_value *)v));
		return c;
	}
	const op_value *child = op_get(root, keys[0]);
	op_value *c = map_copy(root, NULL), *next;
	if (child != NULL) next = with(child, keys + 1, n - 1, v, gone);
	else {
		next = op_ref((op_value *)v);
		for (size_t i = n; i-- > 1;) {
			op_value *m = op_map();
			op_set(m, keys[i], next);
			next = m;
		}
	}
	op_set(c, keys[0], next);
	return c;
}

// v at keys in root (gone: taken out): missing parents made as maps; under a value not a map,
// nothing. takes root's hold; the root after, a hold
static op_value *put(op_value *root, const char *const *keys, size_t n, const op_value *v, bool gone) {
	if (n == 0) {
		op_free(root);
		return gone ? NULL : op_ref((op_value *)v);
	}
	if (root == NULL) {
		if (gone) return NULL;
		root = op_map();
	}
	if (root->type != OP_MAP) return root;
	const op_value *at = root;
	for (size_t i = 0; i + 1 < n; i++) {
		const op_value *next = op_get(at, keys[i]);
		if (next == NULL) {
			if (gone) return root;
			break;
		}
		if (next->type != OP_MAP) return root;
		at = next;
	}
	op_value *out = with(root, keys, n, v, gone);
	op_free(root);
	return out;
}

// ---- ancestry

// a an ancestor of c
static bool anc(const ls_lists *l, const hy_kept *a, const hy_kept *c) {
	if (a->lamport >= c->lamport) return false;
	if (!l->forked) return true;
	const hy_kept **todo = NULL;
	size_t n = 0, room = 0;
	im_map seen = {.width = CM_NAME};
	GROW(todo, n, room);
	todo[n++] = c;
	bool found = false;
	while (n > 0 && !found) {
		const hy_kept *k = todo[--n];
		for (size_t i = 0; i < k->parents_length; i++) {
			const hy_kept *q = hy_get(l->h, k->parents[i]);
			if (q == NULL || im_has(&seen, q->name) || q->lamport < a->lamport) continue;
			if (q == a) {
				found = true;
				break;
			}
			im_set(&seen, q->name, (void *)1);
			GROW(todo, n, room);
			todo[n++] = q;
		}
	}
	free(todo);
	im_free(&seen);
	return found;
}

// what w names, clamped to its own ancestors, covers s: named, or an ancestor of one named
static bool covers(const ls_lists *l, const ls_write *w, const ls_write *s) {
	if (s->kept == w->kept) return false;
	if (w->replaces == NULL || !w->replaces->has) return anc(l, s->kept, w->kept);
	for (size_t i = 0; i < w->replaces->length; i++) {
		const hy_kept *x = hy_get(l->h, w->replaces->names[i]);
		if (x == NULL || !anc(l, x, w->kept)) continue;
		if (s->kept == x || anc(l, s->kept, x)) return true;
	}
	return false;
}

static bool owns(const ls_lists *l, const ls_write *c, const ls_write *d) {
	return c->kept == d->kept || anc(l, c->kept, d->kept);
}

static int by(const ls_write *a, const ls_write *b) { return hy_agreed(a->kept, b->kept); }

// ---- the tree

static node_t *reach(ls_lists *l, const char *const *path, size_t n, bool make) {
	node_t *at = &l->root;
	for (size_t i = 0; i < n; i++) {
		node_t *next = NULL;
		for (size_t k = 0; k < at->nk && next == NULL; k++)
			if (strcmp(at->kids[k]->key, path[i]) == 0) next = at->kids[k];
		if (next == NULL) {
			if (!make) return NULL;
			next = calloc(1, sizeof *next);
			if (next == NULL) abort();
			next->key = copyString(path[i]);
			GROW(at->kids, at->nk, at->ck);
			at->kids[at->nk++] = next;
		}
		at = next;
	}
	return at;
}

typedef struct {
	node_t **list;
	size_t n, room;
} nodes_t;

static void below(node_t *n, nodes_t *out) {
	GROW(out->list, out->n, out->room);
	out->list[out->n++] = n;
	for (size_t k = 0; k < n->nk; k++) below(n->kids[k], out);
}

static void node_free(node_t *n) {
	for (size_t k = 0; k < n->nk; k++) node_free(n->kids[k]), free(n->kids[k]);
	free(n->kids);
	free(n->writes);
	free(n->over);
	free(n->key);
}

ls_lists *ls_create(const hy_history *h, ls_after after, void *context) {
	ls_lists *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->h = h;
	l->after = after;
	l->context = context;
	return l;
}

void ls_free(ls_lists *l) {
	if (l == NULL) return;
	node_free(&l->root);
	for (size_t i = 0; i < l->na; i++) {
		op_free(l->all[i]->value);
		free(l->all[i]->path);
		free(l->all[i]);
	}
	free(l->all);
	for (size_t i = 0; i < l->nc; i++) cm_free(l->commits[i]), free(l->commits[i]);
	free(l->commits);
	free(l);
}

size_t ls_size(const ls_lists *l) { return l->size; }

static ls_write *write_new(ls_lists *l, const hy_kept *kept, const cm_commit *c, size_t keys) {
	ls_write *w = calloc(1, sizeof *w);
	if (w == NULL) abort();
	w->kept = kept;
	w->commit = c;
	w->path = calloc(keys + 2, sizeof *w->path);
	if (w->path == NULL) abort();
	w->path[0] = c->table;
	w->length = keys + 1;
	GROW(l->all, l->na, l->ca);
	l->all[l->na++] = w;
	return w;
}

static bool prefix(const ls_write *a, const ls_write *b) {
	if (a->length > b->length) return false;
	for (size_t i = 0; i < a->length; i++)
		if (strcmp(a->path[i], b->path[i]) != 0) return false;
	return true;
}

typedef struct {
	ls_write **list;
	size_t n, room;
} writes_t;

// a commit's writes, in its patches' order, as written; one a later one at a prefix of its path
// overwrote, left out
static void writes_of(ls_lists *l, const hy_kept *kept, const cm_commit *c, writes_t *out) {
	writes_t all = {0};
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		size_t keys = ls_keyed(p);
		ls_write *w = write_new(l, kept, c, keys);
		for (size_t k = 0; k < keys; k++) w->path[k + 1] = p->place.path[k].s;
		if (c->replaces != NULL && c->replaces[i].has) w->replaces = &c->replaces[i];
		if (ls_whole(p)) w->whole = true;
		else if (p->has_value) w->has_value = true, w->value = op_ref((op_value *)p->value);
		else w->gone = true;
		GROW(all.list, all.n, all.room);
		all.list[all.n++] = w;
		if (p->has_move) {
			size_t mk = keyed_target(&p->move);
			ls_write *m = write_new(l, kept, c, mk);
			for (size_t k = 0; k < mk; k++) m->path[k + 1] = p->move.path[k].s;
			m->replaces = w->replaces;
			m->whole = true;
			GROW(all.list, all.n, all.room);
			all.list[all.n++] = m;
		}
	}
	for (size_t i = 0; i < all.n; i++) {
		bool over = false;
		for (size_t j = i + 1; j < all.n && !over; j++) over = prefix(all.list[j], all.list[i]);
		if (over) continue;
		GROW(out->list, out->n, out->room);
		out->list[out->n++] = all.list[i];
	}
	free(all.list);
}

static bool table_in(const rp_tables *t, const char *table) { return rp_find(t, table) != NULL; }

// a merge by a rule: a whole write of each table it holds, or one an ancestor wrote
static void merged(ls_lists *l, const hy_kept *kept, const cm_commit *c, writes_t *out) {
	rp_tables tables;
	rp_init(&tables);
	l->after(l->context, kept, &tables);
	for (size_t k = 0; k < l->root.nk; k++) {
		node_t *t = l->root.kids[k];
		bool want = table_in(&tables, t->key);
		if (!want) {
			nodes_t ns = {0};
			below(t, &ns);
			for (size_t i = 0; i < ns.n && !want; i++)
				for (size_t j = 0; j < ns.list[i]->nw && !want; j++) want = anc(l, ns.list[i]->writes[j]->kept, kept);
			free(ns.list);
		}
		if (!want) continue;
		ls_write *w = write_new(l, kept, c, 0);
		w->path[0] = t->key;
		w->whole = true;
		GROW(out->list, out->n, out->room);
		out->list[out->n++] = w;
	}
	for (size_t i = 0; i < tables.length; i++) {
		if (reach(l, &tables.slots[i].table, 1, false) != NULL) continue;
		// the table's name kept with the lists: its node, made now (as the write would make it)
		ls_write *w = write_new(l, kept, c, 0);
		w->path[0] = reach(l, &tables.slots[i].table, 1, true)->key;
		w->whole = true;
		GROW(out->list, out->n, out->room);
		out->list[out->n++] = w;
	}
	rp_free(&tables);
}

void ls_add(ls_lists *l, const hy_kept *kept) {
	l->size++;
	if (!l->forked) {
		bool on = l->tip == NULL ? kept->parents_length == 0
					 : kept->parents_length == 1 && memcmp(kept->parents[0], l->tip->name, CM_NAME) == 0;
		if (on) l->tip = kept;
		else l->forked = true;
	}
	l->seen = false;
	cm_commit *c = calloc(1, sizeof *c);
	if (c == NULL) abort();
	if (cm_decode(kept->bytes, kept->length, c, NULL) != CM_OK) {
		free(c);
		return;
	}
	GROW(l->commits, l->nc, l->cc);
	l->commits[l->nc++] = c;
	writes_t ws = {0};
	if (c->merge == NULL) writes_of(l, kept, c, &ws);
	else merged(l, kept, c, &ws);
	for (size_t i = 0; i < ws.n; i++) {
		nodes_t ns = {0};
		below(reach(l, ws.list[i]->path, ws.list[i]->length, true), &ns);
		for (size_t j = 0; j < ns.n; j++) {
			node_t *n = ns.list[j];
			size_t kept_n = 0;
			for (size_t k = 0; k < n->nw; k++)
				if (!covers(l, ws.list[i], n->writes[k])) n->writes[kept_n++] = n->writes[k];
			n->nw = kept_n;
		}
		free(ns.list);
	}
	for (size_t i = 0; i < ws.n; i++) {
		node_t *n = reach(l, ws.list[i]->path, ws.list[i]->length, true);
		GROW(n->writes, n->nw, n->cw);
		n->writes[n->nw++] = ws.list[i];
	}
	free(ws.list);
}

// a write's value: as written, or its commit's tables at its path
static void value_of(ls_lists *l, ls_write *w) {
	if (!w->whole || w->asked || w->gone) return;
	w->asked = true;
	rp_tables t;
	rp_init(&t);
	l->after(l->context, w->kept, &t);
	const nd_entry *e = rp_find(&t, w->path[0]);
	const op_value *v = ls_dig(e != NULL ? e->value : NULL, w->path + 1, w->length - 1);
	if (v == NULL) w->gone = true;
	else w->has_value = true, w->value = op_ref((op_value *)v);
	rp_free(&t);
}

// ---- looking: each node's writes sorted, the inside marks, the shallow writes over each

static void insertion_sort(ls_write **ws, size_t n) {
	for (size_t i = 1; i < n; i++) {
		ls_write *x = ws[i];
		size_t j = i;
		while (j > 0 && by(ws[j - 1], x) > 0) ws[j] = ws[j - 1], j--;
		ws[j] = x;
	}
}

static void walk_look(ls_lists *l, node_t *n, const ls_write **above, size_t na) {
	insertion_sort(n->writes, n->nw);
	n->no = 0;
	for (size_t i = 0; i < n->nw; i++) {
		for (size_t k = 0; k < na; k++) {
			const ls_write *c = above[k];
			if (owns(l, c, n->writes[i])) continue;
			((ls_write *)c)->inside = true;
			bool has = false;
			for (size_t j = 0; j < n->no && !has; j++) has = n->over[j] == c;
			if (!has) {
				GROW(n->over, n->no, n->co);
				n->over[n->no++] = c;
			}
		}
	}
	// over, in the agreed order
	for (size_t i = 1; i < n->no; i++) {
		const ls_write *x = n->over[i];
		size_t j = i;
		while (j > 0 && by(n->over[j - 1], x) > 0) n->over[j] = n->over[j - 1], j--;
		n->over[j] = x;
	}
	const ls_write **next = (const ls_write **)above;
	size_t nn = na;
	if (n->nw) {
		next = malloc((na + n->nw + 1) * sizeof *next);
		if (next == NULL) abort();
		memcpy(next, above, na * sizeof *next);
		memcpy(next + na, n->writes, n->nw * sizeof *next);
		nn = na + n->nw;
	}
	for (size_t k = 0; k < n->nk; k++) walk_look(l, n->kids[k], next, nn);
	if (next != above) free(next);
}

static void look(ls_lists *l) {
	if (l->seen) return;
	for (size_t i = 0; i < l->na; i++) l->all[i]->inside = false;
	walk_look(l, &l->root, NULL, 0);
	l->seen = true;
}

static size_t items_of(ls_lists *l, node_t *n, const char *const *path, size_t length, ls_item **out) {
	look(l);
	ls_item *items = calloc(n->nw + n->no + 1, sizeof *items);
	if (items == NULL) abort();
	size_t k = 0;
	for (size_t i = 0; i < n->nw; i++) {
		ls_write *w = n->writes[i];
		value_of(l, w);
		items[k++] = (ls_item){.write = w, .value = w->gone ? NULL : w->value, .gone = w->gone, .inside = w->inside};
	}
	for (size_t i = 0; i < n->no; i++) {
		ls_write *c = (ls_write *)n->over[i];
		value_of(l, c);
		const op_value *at = c->gone ? NULL : ls_dig(c->value, path + c->length, length - c->length);
		items[k++] = (ls_item){.write = c, .value = at, .gone = at == NULL, .inside = c->inside, .at = c->path,
			.at_length = c->length};
	}
	*out = items;
	return k;
}

size_t ls_items(ls_lists *l, const char *const *path, size_t n, ls_item **out) {
	node_t *at = reach(l, path, n, false);
	*out = NULL;
	if (at == NULL) return 0;
	return items_of(l, at, path, n, out);
}

size_t ls_standing(ls_lists *l, const char *const *path, size_t n, ls_group **out) {
	*out = NULL;
	node_t *at = reach(l, path, n, false);
	if (at == NULL) return 0;
	look(l);
	nodes_t ns = {0};
	below(at, &ns);
	ls_group *gs = calloc(ns.n + 1, sizeof *gs);
	if (gs == NULL) abort();
	size_t k = 0;
	for (size_t i = 0; i < ns.n; i++) {
		node_t *m = ns.list[i];
		if (m->nw == 0) continue;
		gs[k].writes = malloc(m->nw * sizeof *gs[k].writes);
		if (gs[k].writes == NULL) abort();
		memcpy(gs[k].writes, m->writes, m->nw * sizeof *gs[k].writes);
		gs[k++].length = m->nw;
	}
	free(ns.list);
	*out = gs;
	return k;
}

void ls_groups_free(ls_group *groups, size_t n) {
	for (size_t i = 0; i < n; i++) free(groups[i].writes);
	free(groups);
}

typedef struct {
	ls_open *list;
	size_t n, room;
} opens_t;

static void walk_open(ls_lists *l, node_t *n, const char **path, size_t length, opens_t *out) {
	bool inside = false;
	for (size_t i = 0; i < n->nw && !inside; i++) inside = n->writes[i]->inside;
	if (n->nw > 1 || inside || n->no > 0) {
		GROW(out->list, out->n, out->room);
		ls_open *o = &out->list[out->n++];
		o->path = malloc((length + 1) * sizeof *o->path);
		if (o->path == NULL) abort();
		memcpy(o->path, path, length * sizeof *path);
		o->length = length;
		o->count = items_of(l, n, path, length, &o->items);
	}
	const char **next = malloc((length + 2) * sizeof *next);
	if (next == NULL) abort();
	memcpy(next, path, length * sizeof *path);
	for (size_t k = 0; k < n->nk; k++) {
		next[length] = n->kids[k]->key;
		walk_open(l, n->kids[k], next, length + 1, out);
	}
	free(next);
}

size_t ls_opens(ls_lists *l, ls_open **out) {
	look(l);
	opens_t o = {0};
	walk_open(l, &l->root, NULL, 0, &o);
	*out = o.list;
	return o.n;
}

void ls_opens_free(ls_open *opens, size_t n) {
	for (size_t i = 0; i < n; i++) free(opens[i].path), free(opens[i].items);
	free(opens);
}

typedef struct {
	ls_lists *l;
	const hy_kept *choose;
	op_value *value;
	const ls_write *last;
} composing_t;

static void walk_compose(composing_t *c, node_t *n, const char **keys, size_t length, const ls_write *owner) {
	const ls_write *w = NULL, *first = NULL;
	for (size_t i = 0; i < n->nw; i++) {
		ls_write *d = n->writes[i];
		if (owner != NULL && !owns(c->l, owner, d)) continue;
		if (first == NULL) first = d;
		if (c->choose != NULL && d->kept == c->choose && w == NULL) w = d;
	}
	if (w == NULL) w = first;
	if (w != NULL) {
		if (c->last == NULL || by(w, c->last) < 0) c->last = w;
		value_of(c->l, (ls_write *)w);
		c->value = put(c->value, keys, length, w->gone ? NULL : w->value, w->gone);
		if (c->choose != NULL && w->kept == c->choose && owner == NULL) owner = w;
	}
	const char **next = malloc((length + 2) * sizeof *next);
	if (next == NULL) abort();
	memcpy(next, keys, length * sizeof *keys);
	for (size_t k = 0; k < n->nk; k++) {
		next[length] = n->kids[k]->key;
		walk_compose(c, n->kids[k], next, length + 1, owner);
	}
	free(next);
}

void ls_compose(ls_lists *l, const hy_kept *choose, rp_tables *out) {
	look(l);
	rp_init(out);
	for (size_t k = 0; k < l->root.nk; k++) {
		node_t *top = l->root.kids[k];
		composing_t c = {l, choose, NULL, NULL};
		walk_compose(&c, top, NULL, 0, NULL);
		if (c.value != NULL && c.last != NULL) {
			const cm_commit *cm = c.last->commit;
			const ch_header *h = rp_signed(out, &cm->change, cm->signer, cm->signer_length, c.last->kept->name);
			rp_put_copy(out, top->key, c.value, h);
		}
		op_free(c.value);
	}
}

void ls_state(const hy_history *h, const hy_kept *const *heads, size_t n, ls_after after, void *context,
	rp_tables *out) {
	im_map mine = {.width = CM_NAME};
	const hy_kept **todo = NULL;
	size_t nt = 0, room = 0;
	for (size_t i = 0; i < n; i++) {
		im_set(&mine, heads[i]->name, (void *)1);
		GROW(todo, nt, room);
		todo[nt++] = heads[i];
	}
	while (nt > 0) {
		const hy_kept *k = todo[--nt];
		for (size_t i = 0; i < k->parents_length; i++) {
			const hy_kept *q = hy_get(h, k->parents[i]);
			if (q == NULL || im_has(&mine, q->name)) continue;
			im_set(&mine, q->name, (void *)1);
			GROW(todo, nt, room);
			todo[nt++] = q;
		}
	}
	free(todo);
	ls_lists *l = ls_create(h, after, context);
	const hy_kept **all;
	size_t na = hy_all(h, &all);
	for (size_t i = 0; i < na; i++)
		if (im_has(&mine, all[i]->name)) ls_add(l, all[i]);
	free(all);
	im_free(&mine);
	ls_compose(l, NULL, out);
	ls_free(l);
}
