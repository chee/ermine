// The graph (newcore/graph/ts/graph.ts), in C. See graph.h. The order of operations is the reference's: the
// clock ticks wherever graph.ts's does. Comments say what the reference's say, tersely.
//
// notify is told object-level patches: the whole object at ["value"], ["info", name] or
// ["children", name], with a "before" that is a node view with only the keys that matter (the
// facts only look at the object's parent). Every read watched is object-level: deep at the
// object, keys-only at ["children"].
#include "graph.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../trackgraph/c/trackgraph.h"
#include "../../opstreams/c/mutate.h"

// memory (graph.h says the rules): arenas, growing things, and what the graph holds

typedef struct block {
	struct block *next;
	size_t left;
	size_t size;
} block;

typedef struct {
	block *head;
	char *cur;
	size_t left;
} arena;

static void die(const char *why) {
	fprintf(stderr, "graph: %s\n", why);
	abort();
}

static void *aalloc(arena *a, size_t n) {
	n = (n + 15) & ~(size_t)15;
	if (n > a->left) {
		size_t size = n > 65536 ? n : 65536;
		block *b = malloc(sizeof *b + size + 16);
		if (!b) die("out of memory");
		b->next = a->head;
		a->head = b;
		a->cur = (char *)(((size_t)(b + 1) + 15) & ~(size_t)15);
		a->left = size;
	}
	void *p = a->cur;
	a->cur += n;
	a->left -= n;
	memset(p, 0, n);
	return p;
}

// every block given back: what was in it is gone (the sanitizers see a use after)
static void afree(arena *a) {
	while (a->head) {
		block *b = a->head;
		a->head = b->next;
		free(b);
	}
	a->cur = NULL;
	a->left = 0;
}

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (!p) die("out of memory");
	return p;
}
static void *regrow(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	if (!p) die("out of memory");
	return p;
}

// a growing list. vpush grows it on the heap (kept: free v when done); tpush in the scratch of
// the moment (gone with it)
typedef struct {
	void **v;
	size_t n, cap;
} vec;

// ordered maps by string, on the heap: insertion order, deleting and setting again moves to the end
typedef struct {
	const char *key; // NULL: deleted
	void *val;
} ent;
typedef struct {
	ent *e;
	size_t n, cap, live;
	size_t *idx; // entry + 1; 0 empty; SIZE_MAX deleted
	size_t slots;
} omap;

#define TOMB ((size_t)-1)

// containers

static void *tmem(gr_graph *s, size_t n);

static void vpush(vec *v, void *x) {
	if (v->n == v->cap) {
		v->cap = v->cap ? v->cap * 2 : 4;
		v->v = regrow(v->v, v->cap * sizeof *v->v);
	}
	v->v[v->n++] = x;
}
static void tpush(gr_graph *s, vec *v, void *x) {
	if (v->n == v->cap) {
		size_t cap = v->cap ? v->cap * 2 : 4;
		void **nv = tmem(s, cap * sizeof *nv);
		if (v->n) memcpy(nv, v->v, v->n * sizeof *nv);
		v->v = nv;
		v->cap = cap;
	}
	v->v[v->n++] = x;
}
static long sfind(const vec *v, const char *x) {
	for (size_t i = 0; i < v->n; i++)
		if (!strcmp(v->v[i], x)) return (long)i;
	return -1;
}
// a vec of strings as a set, in scratch
static void sadd(gr_graph *s, vec *v, const char *x) {
	if (sfind(v, x) < 0) tpush(s, v, (void *)x);
}

static size_t hashs(const char *k) {
	size_t h = 5381;
	for (; *k; k++) h = h * 33 + (unsigned char)*k;
	return h;
}

static void om_reindex(omap *m) {
	size_t live = 0;
	for (size_t i = 0; i < m->n; i++) {
		if (!m->e[i].key) continue;
		m->e[live++] = m->e[i];
	}
	m->n = live;
	size_t slots = 16;
	while (slots < 4 * (m->cap ? m->cap : 4)) slots *= 2;
	m->slots = slots;
	free(m->idx);
	m->idx = calloc(slots, sizeof *m->idx);
	if (!m->idx) die("out of memory");
	for (size_t i = 0; i < m->n; i++) {
		size_t h = hashs(m->e[i].key) & (slots - 1);
		while (m->idx[h]) h = (h + 1) & (slots - 1);
		m->idx[h] = i + 1;
	}
}
static long om_find(const omap *m, const char *key) {
	if (!m->slots) return -1;
	for (size_t h = hashs(key) & (m->slots - 1); m->idx[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->idx[h];
		if (i == TOMB) continue;
		if (!strcmp(m->e[i - 1].key, key)) return (long)(i - 1);
	}
	return -1;
}
static void *om_get(const omap *m, const char *key) {
	long i = om_find(m, key);
	return i < 0 ? NULL : m->e[i].val;
}
static int om_has(const omap *m, const char *key) { return om_find(m, key) >= 0; }
// key must outlive the map
static void om_set(omap *m, const char *key, void *val) {
	long i = om_find(m, key);
	if (i >= 0) {
		m->e[i].val = val;
		return;
	}
	if (m->n == m->cap) {
		size_t cap = m->live * 2 > 4 ? m->live * 2 : 4;
		size_t k = 0;
		for (size_t j = 0; j < m->n; j++)
			if (m->e[j].key) m->e[k++] = m->e[j];
		m->n = k;
		m->e = regrow(m->e, cap * sizeof *m->e);
		m->cap = cap;
		om_reindex(m);
	}
	m->e[m->n] = (ent){key, val};
	size_t h = hashs(key) & (m->slots - 1);
	while (m->idx[h] && m->idx[h] != TOMB) h = (h + 1) & (m->slots - 1);
	m->idx[h] = ++m->n;
	m->live++;
}
static void om_del(omap *m, const char *key) {
	if (!m->slots) return;
	for (size_t h = hashs(key) & (m->slots - 1); m->idx[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->idx[h];
		if (i == TOMB) continue;
		if (!strcmp(m->e[i - 1].key, key)) {
			m->e[i - 1].key = NULL;
			m->idx[h] = TOMB;
			m->live--;
			return;
		}
	}
}
static void om_free(omap *m) {
	free(m->e);
	free(m->idx);
	*m = (omap){0};
}

// what the graph holds by pointer (graph.h, memory): each made on the heap, with its holds. A
// pointer not here is someone else's, never held or freed here
typedef enum { K_ARRAY, K_ENTRIES, K_LIST, K_CHANGE, K_SYNCED, K_NODE } kind;
typedef struct {
	const void *p; // NULL: empty; TOMBP: was here
	size_t refs;
	kind k;
} held;
typedef struct {
	held *e;
	size_t n, slots; // used (tombs too), slots a power of two
} heldset;
#define TOMBP ((const void *)1)

static size_t hashp(const void *p) {
	size_t h = (size_t)p;
	h ^= h >> 17;
	h *= 0x9e3779b97f4a7c15ull;
	return h ^ (h >> 29);
}
static held *hs_find(const heldset *s, const void *p) {
	if (!s->slots || !p) return NULL;
	for (size_t i = hashp(p) & (s->slots - 1);; i = (i + 1) & (s->slots - 1)) {
		if (!s->e[i].p) return NULL;
		if (s->e[i].p == p) return &s->e[i];
	}
}
static void hs_add(heldset *s, const void *p, kind k) {
	if ((s->n + 1) * 2 > s->slots) {
		// made again, the gone left out: as big as what is here needs, not what came and went
		size_t live = 1;
		for (size_t i = 0; i < s->slots; i++) live += s->e[i].p && s->e[i].p != TOMBP;
		heldset t = {0};
		t.slots = 64;
		while (t.slots < live * 4) t.slots *= 2;
		t.e = calloc(t.slots, sizeof *t.e);
		if (!t.e) die("out of memory");
		for (size_t i = 0; i < s->slots; i++)
			if (s->e[i].p && s->e[i].p != TOMBP) hs_add(&t, s->e[i].p, s->e[i].k), hs_find(&t, s->e[i].p)->refs = s->e[i].refs;
		free(s->e);
		*s = t;
	}
	size_t i = hashp(p) & (s->slots - 1);
	while (s->e[i].p && s->e[i].p != TOMBP) i = (i + 1) & (s->slots - 1);
	if (!s->e[i].p) s->n++;
	s->e[i] = (held){p, 0, k};
}
static void hs_del(held *h) {
	h->p = TOMBP;
	h->refs = 0;
}

// a hold let go at the next sweep: a value's (nt_free) or one of the graph's own
typedef struct {
	const void *p;
	int value;
} later_t;

// the graph

typedef struct gr_spot gr_spot;
// a spot: a part of a node something read
struct gr_spot {
	const char *id;
	pl_kind part;
	const char *name;
	tg_node *track;
	nt_read *watch;
	gr_graph *g;
};
// a node's spots: loaded, value and its names as fields; its lists' and infos' by name; all, each
// as made
typedef struct {
	const char *id;
	gr_spot *loaded, *value, *names, *infonames;
	omap children, info; // gr_spot *
	vec all; // gr_spot *
} gr_spots;

// what a node in the table holds: its arrays, lists, changes, becauses and contents, one hold
// each. made: the graph made the node (gr_make), and frees it when it goes
typedef struct {
	later_t *v;
	size_t n, cap;
	int made;
} ledger;
// a node the graph made, and the change its header borrows from
typedef struct {
	nd_node node;
	const gr_change *made;
} made_node;

struct gr_reader {
	gr_graph *g;
	void *owner;
	tg_node *track;
	pl_depend dep;
};

// the change being told, for the marks it makes
typedef struct {
	const gr_change *by;
	const void *tag;
	void *own;
} telling_t;

// an object a change touched: told after, by the header of the change that made it
typedef struct {
	const char *id;
	gr_where w;
	const char *name;
	size_t old_len;
	size_t hdr; // index among the changes this operation made
	// told patch by patch under its version: the patches and their facts (fine: if any)
	int fine;
	nt_patch *patches;
	nt_facts *facts;
	size_t npatches;
} target;
typedef struct {
	nd_node *n;
	gr_where w;
	const char *name;
	nd_object old;
} snapped;

typedef struct chg {
	gr_acting mine;
	size_t start;
	int hearing; // told by the objects touched; else by snap
	vec targets; // target *
} chg;

struct gr_graph {
	arena a; // kept as long as the graph
	arena req, hosts; // scratch: a request's (until gr_leave), the host's (until gr_sweep)
	pr_arena pra, preq, phost; // the same for protect's values
	int depth; // gr_enter's
	heldset mine;
	omap ledgers; // ledger *, by node id
	omap strings; // the graph's own copies of ids and names, by themselves
	later_t *later;
	size_t nlater, laterroom;
	int64_t own_clock;
	int64_t *clock;
	gr_options o;
	const pr_value *host;
	pr_may may;
	const char *root;

	omap table; // nd_node *
	vec trackers;
	pl_places places;

	gr_acting *acting;
	chg *cur;
	vec made; // gr_change *

	omap ephemeral;
	omap owners; // void *
	omap spots; // gr_spots *
	omap notifies; // nt_notify *
	omap synced; // gr_synced *, by the text of the pointer to it: the becauses gr_versions made

	telling_t *telling;
};

struct gr_api {
	gr_graph *g;
	gr_bind b;
};

static void *amem(gr_graph *s, size_t n) { return aalloc(&s->a, n); }
char *gr_dup(gr_graph *s, const char *str) {
	size_t n = strlen(str) + 1;
	return memcpy(amem(s, n), str, n);
}
void *gr_alloc(gr_graph *s, size_t n) { return amem(s, n); }
pr_arena *gr_pr_arena(gr_graph *s) { return &s->pra; }

// scratch: a request's while one runs (gr_enter), else the host's
static void *tmem(gr_graph *s, size_t n) { return aalloc(s->depth ? &s->req : &s->hosts, n); }
static pr_arena *tpra(gr_graph *s) { return s->depth ? &s->preq : &s->phost; }
static char *tdup(gr_graph *s, const char *str) {
	size_t n = strlen(str) + 1;
	return memcpy(tmem(s, n), str, n);
}
// the graph's own copy of a string, one per text
static const char *intern(gr_graph *g, const char *str) {
	const char *had = om_get(&g->strings, str);
	if (had) return had;
	char *c = gr_dup(g, str);
	om_set(&g->strings, c, c);
	return c;
}

// holds: of what the graph made (mine), and of values (nt_ref)

static void forget(gr_graph *g, const void *p, kind k, int cascade);

static void hold(gr_graph *g, const void *p, int value) {
	if (value) {
		nt_ref((nt_value *)p);
		return;
	}
	held *h = hs_find(&g->mine, p);
	if (h) h->refs++;
}
// a hold let go now: the last frees it
static void drop(gr_graph *g, const void *p, int value) {
	if (value) {
		nt_free((nt_value *)p);
		return;
	}
	held *h = hs_find(&g->mine, p);
	if (!h || --h->refs) return;
	kind k = h->k;
	hs_del(h);
	forget(g, p, k, 1);
}
// a hold let go at the next sweep: what was read until then stays
static void later(gr_graph *g, const void *p, int value) {
	if (!p) return;
	if (g->nlater == g->laterroom) {
		g->laterroom = g->laterroom ? g->laterroom * 2 : 64;
		g->later = regrow(g->later, g->laterroom * sizeof *g->later);
	}
	g->later[g->nlater++] = (later_t){p, value};
}
// made: the graph's, with one hold, let go at the next sweep unless kept
static void mine(gr_graph *g, const void *p, kind k, int kept) {
	hs_add(&g->mine, p, k);
	hs_find(&g->mine, p)->refs = 1;
	if (!kept) later(g, p, 0);
}

static void synced_gone(gr_graph *g, const gr_synced *b);
// what of the graph's goes: freed, and (cascade) what it held let go
static void forget(gr_graph *g, const void *p, kind k, int cascade) {
	if (k == K_SYNCED) synced_gone(g, p);
	if (k == K_NODE && cascade) drop(g, ((const made_node *)p)->made, 0);
	free((void *)p);
}

// sizes and copies, in one block: each piece 16-aligned
static size_t up(size_t n) { return (n + 15) & ~(size_t)15; }
static void *take(char **at, size_t n) {
	void *p = *at;
	*at += up(n);
	return p;
}
static size_t text_room(const char *t) { return t ? up(strlen(t) + 1) : 0; }
static const char *text_copy(const char *t, char **at) {
	if (!t) return NULL;
	size_t n = strlen(t) + 1;
	return memcpy(take(at, n), t, n);
}
static size_t pr_room(const pr_value *v) {
	size_t n = 0;
	if (v->kind == PR_STR) n += up(v->n + 1);
	if (v->kind == PR_LIST || v->kind == PR_MAP) {
		n += up(v->n * sizeof *v->items);
		if (v->kind == PR_MAP) n += up(v->n * sizeof *v->keys);
		for (size_t i = 0; i < v->n; i++) {
			n += pr_room(&v->items[i]);
			if (v->kind == PR_MAP) n += text_room(v->keys[i]);
		}
	}
	return n;
}
static void pr_copy(const pr_value *v, pr_value *out, char **at) {
	*out = *v;
	if (v->kind == PR_STR) {
		char *c = take(at, v->n + 1);
		memcpy(c, v->str, v->n);
		c[v->n] = 0;
		out->str = c;
	}
	if (v->kind != PR_LIST && v->kind != PR_MAP) return;
	out->cap = v->n;
	out->items = take(at, v->n * sizeof *v->items);
	if (v->kind == PR_MAP) out->keys = take(at, v->n * sizeof *v->keys);
	for (size_t i = 0; i < v->n; i++) {
		pr_copy(&v->items[i], &out->items[i], at);
		if (v->kind == PR_MAP) out->keys[i] = text_copy(v->keys[i], at);
	}
}
static size_t value_room(const pr_value *v) { return v ? up(sizeof *v) + pr_room(v) : 0; }
static const pr_value *value_copy(const pr_value *v, char **at) {
	if (!v) return NULL;
	pr_value *c = take(at, sizeof *c);
	pr_copy(v, c, at);
	return c;
}

// a change of the graph's own: c copied whole, actor, cause, site and texts with it. kept: never let
// go of (the host's); else its one hold goes at the next sweep, and what holds it keeps it
static gr_change *change_own(gr_graph *g, const gr_change *c, int kept) {
	size_t room = up(sizeof *c) + value_room(c->actor) + value_room(c->cause) + value_room(c->site) +
		text_room(c->reader) + text_room(c->node) + text_room(c->name);
	char *at = grab(room), *b = at;
	gr_change *x = take(&at, sizeof *x);
	*x = *c;
	x->actor = value_copy(c->actor, &at);
	x->cause = value_copy(c->cause, &at);
	x->site = value_copy(c->site, &at);
	x->reader = text_copy(c->reader, &at);
	x->node = text_copy(c->node, &at);
	x->name = text_copy(c->name, &at);
	mine(g, b, K_CHANGE, kept);
	return x;
}

// a list of the graph's own: its items and their texts in the same block
static const nd_list *list_own(gr_graph *g, const nd_list *l) {
	size_t room = up(sizeof *l) + up(l->length * sizeof *l->items);
	for (size_t i = 0; i < l->length; i++) room += text_room(l->items[i].id) + text_room(l->items[i].symbol);
	char *at = grab(room), *b = at;
	nd_list *x = take(&at, sizeof *x);
	nd_item *its = take(&at, l->length * sizeof *its);
	for (size_t i = 0; i < l->length; i++) {
		its[i].id = text_copy(l->items[i].id, &at);
		its[i].symbol = text_copy(l->items[i].symbol, &at);
	}
	x->items = its;
	x->length = l->length;
	hs_add(&g->mine, b, K_LIST);
	return x;
}

static void ledger_add(ledger *l, const void *p, int value) {
	if (!p) return;
	if (l->n == l->cap) {
		l->cap = l->cap ? l->cap * 2 : 8;
		l->v = regrow(l->v, l->cap * sizeof *l->v);
	}
	l->v[l->n++] = (later_t){p, value};
}

// versions as the graph keeps them: the array its own (a copy if not), each list its own, and
// what each holds put in the ledger
static const nd_version *versions_own(gr_graph *g, const nd_version *vs, size_t len, int children,
	ledger *l) {
	if (!len) return NULL;
	nd_version *arr = (nd_version *)vs;
	if (!hs_find(&g->mine, vs)) {
		arr = grab(len * sizeof *arr);
		memcpy(arr, vs, len * sizeof *arr);
		hs_add(&g->mine, arr, K_ARRAY);
	}
	ledger_add(l, arr, 0);
	for (size_t i = 0; i < len; i++) {
		nd_version *v = &arr[i];
		if (children && v->content) {
			if (!hs_find(&g->mine, v->content)) v->content = list_own(g, v->content);
			ledger_add(l, v->content, 0);
		} else ledger_add(l, v->content, 1);
		if (hs_find(&g->mine, v->change)) ledger_add(l, v->change, 0);
		if (hs_find(&g->mine, v->because)) ledger_add(l, v->because, 0);
	}
	return arr;
}
static nd_entry *entries_own(gr_graph *g, nd_entry *es, size_t n, int children, ledger *l) {
	if (!n) return NULL;
	nd_entry *arr = es;
	if (!hs_find(&g->mine, es)) {
		arr = grab(n * sizeof *arr);
		memcpy(arr, es, n * sizeof *arr);
		hs_add(&g->mine, arr, K_ENTRIES);
	}
	ledger_add(l, arr, 0);
	for (size_t i = 0; i < n; i++) {
		arr[i].name = intern(g, arr[i].name);
		arr[i].object.versions = versions_own(g, arr[i].object.versions, arr[i].object.length, children, l);
	}
	return arr;
}

// a node as the graph keeps it, after anything changed it: what it holds now held, what it held
// before let go at the next sweep
static void own(gr_graph *g, nd_node *n) {
	ledger now = {0};
	n->value.versions = versions_own(g, n->value.versions, n->value.length, 0, &now);
	n->info = entries_own(g, n->info, n->info_length, 0, &now);
	n->children = entries_own(g, n->children, n->children_length, 1, &now);
	for (size_t i = 0; i < now.n; i++) hold(g, now.v[i].p, now.v[i].value);
	ledger *was = om_get(&g->ledgers, n->id);
	if (!was) {
		was = grab(sizeof *was);
		*was = (ledger){0};
		om_set(&g->ledgers, n->id, was);
	} else {
		for (size_t i = 0; i < was->n; i++) later(g, was->v[i].p, was->v[i].value);
		free(was->v);
	}
	now.made = was->made;
	*was = now;
}

void gr_enter(gr_graph *g) { g->depth++; }
void gr_leave(gr_graph *g) {
	if (--g->depth) return;
	afree(&g->req);
	pr_free(&g->preq);
}
void gr_sweep(gr_graph *g) {
	if (g->depth) return;
	// a let go may let go of more (a node, its change): those come now
	for (size_t i = 0; i < g->nlater; i++) drop(g, g->later[i].p, g->later[i].value);
	g->nlater = 0;
	afree(&g->hosts);
	pr_free(&g->phost);
}
void gr_later(gr_graph *g, nt_value *v) { later(g, v, 1); }
const gr_error *gr_error_keep(gr_graph *g, const gr_error *e) {
	if (!e || !e->code || !strcmp(e->code, "stop")) return e;
	size_t room = up(sizeof *e) + text_room(e->code) + text_room(e->message) + value_room(e->why);
	char *at = aalloc(&g->hosts, room);
	gr_error *c = take(&at, sizeof *c);
	c->code = text_copy(e->code, &at);
	c->message = text_copy(e->message, &at);
	c->why = value_copy(e->why, &at);
	return c;
}
const gr_change *gr_change_copy(gr_graph *g, const gr_change *c) { return change_own(g, c, 0); }
void gr_change_hold(gr_graph *g, const gr_change *c) { hold(g, c, 0); }
void gr_change_drop(gr_graph *g, const gr_change *c) { later(g, c, 0); }

// errors

static const gr_error *gerr(gr_graph *g, const char *code, const char *message) {
	gr_error *e = tmem(g, sizeof *e);
	e->code = code;
	e->message = message ? message : code;
	return e;
}
static const gr_error *pl_error(gr_graph *g, int code) {
	return gerr(g, pl_code_name(code), NULL);
}
static const gr_error *mu_error(gr_graph *g, int code) {
	return gerr(g, mu_code_name(code), NULL);
}

// protect's values from ours: null for a live value
static pr_value to_pr(gr_graph *s, const nt_value *v) {
	if (v == NULL || v->type == NT_NULL) return pr_null();
	switch (v->type) {
	case NT_BOOL: return pr_bool(v->bool_);
	case NT_NUM: return pr_num(v->num);
	case NT_STR: return pr_str(tpra(s), v->str, v->bytes);
	case NT_LIST: {
		pr_value l = pr_list();
		for (size_t i = 0; i < v->count; i++) pr_push(tpra(s), &l, to_pr(s, v->items[i]));
		return l;
	}
	default: {
		pr_value m = pr_map();
		for (size_t i = 0; i < v->count; i++) pr_put(tpra(s), &m, v->keys[i], to_pr(s, v->items[i]));
		return m;
	}
	}
}
pr_value *gr_pr(gr_graph *g, const nt_value *v) {
	pr_value *p = pr_alloc(tpra(g), sizeof *p);
	*p = to_pr(g, v);
	return p;
}

// changes

static int64_t tick(gr_graph *g) { return ++*g->clock; }

static gr_change *change_of(gr_graph *g, const gr_acting *who, int64_t time, const char *node) {
	gr_change c = {0};
	c.time = time;
	c.actor = who->actor;
	c.reader = who->reader;
	c.cause = who->cause;
	c.site = who->site;
	c.node = node;
	return change_own(g, &c, 0);
}

const gr_change *gr_change_new(gr_graph *g, int64_t time, const pr_value *actor, const char *node) {
	gr_change c = {0};
	c.time = time;
	c.actor = actor;
	c.node = node;
	return change_own(g, &c, 1);
}

const gr_change *gr_by(gr_graph *g, const char *node) {
	if (!g->acting) return NULL;
	gr_change *c = change_of(g, g->acting, tick(g), node);
	vpush(&g->made, c);
	return c;
}
static const void *places_by(void *ctx, const char *node) { return gr_by(ctx, node); }

const pl_places *gr_places(gr_graph *g) { return &g->places; }

static nd_node *tget(void *ctx, const char *id) {
	gr_graph *g = ctx;
	return om_get(&g->table, id);
}
nd_node *gr_get(gr_graph *g, const char *id) { return om_get(&g->table, id); }
static void *places_alloc(void *ctx, size_t n) { return tmem(ctx, n); }

int gr_ephemeral(gr_graph *g, const char *id) { return om_has(&g->ephemeral, id); }
void *gr_owner(gr_graph *g, const char *id) { return om_get(&g->owners, id); }

static const char *const KINDS[] = {"", "value", "info", "children", "loaded"};

static gr_change *with_where(gr_graph *g, const gr_change *c, const char *node, gr_where w,
	const char *name) {
	gr_change x = *c;
	x.node = node;
	x.where = w;
	x.name = name;
	return change_own(g, &x, 0);
}

// spots and notify: what was read, and the watch on it

static void on_fire(nt_kind kind, void *user);

// notify watches what is read: an object deep, a node's names not
static void watch(gr_graph *g, gr_spot *sp) {
	if (sp->watch || sp->part == PL_LOADED) return;
	nd_node *n = om_get(&g->table, sp->id);
	if (!n) return;
	nt_notify *nf = om_get(&g->notifies, sp->id);
	if (!nf) {
		nf = nt_create(NULL, NULL);
		om_set(&g->notifies, sp->id, nf);
	}
	nt_key path[2];
	size_t len = 1;
	int names = 0;
	if (sp->part == PL_VALUE) path[0] = (nt_key){NT_STR_KEY, 0, "value", 0, 0};
	else if (sp->part == PL_INFO) {
		path[0] = (nt_key){NT_STR_KEY, 0, "info", 0, 0};
		if (sp->name) path[1] = (nt_key){NT_STR_KEY, 0, sp->name, 0, 0}, len = 2;
		else names = 1;
	} else {
		path[0] = (nt_key){NT_STR_KEY, 0, "children", 0, 0};
		if (sp->name) path[1] = (nt_key){NT_STR_KEY, 0, sp->name, 0, 0}, len = 2;
		else names = 1;
	}
	nt_options o = {0};
	o.deep = !names;
	sp->watch = nt_open(nf, path, len, &o);
	nt_on(sp->watch, on_fire, sp);
}

static gr_spot *spot(gr_graph *g, const char *id, pl_part part) {
	gr_spots *n = om_get(&g->spots, id);
	if (!n) {
		n = amem(g, sizeof *n);
		n->id = intern(g, id);
		om_set(&g->spots, n->id, n);
	}
	gr_spot **at = NULL;
	omap *by = NULL;
	if (part.kind == PL_LOADED) at = &n->loaded;
	else if (part.kind == PL_VALUE) at = &n->value;
	else if (!part.name) at = part.kind == PL_INFO ? &n->infonames : &n->names;
	else by = part.kind == PL_CHILDREN ? &n->children : &n->info;
	gr_spot *sp = at ? *at : om_get(by, part.name);
	if (sp) return sp;
	sp = amem(g, sizeof *sp);
	sp->id = n->id;
	sp->part = part.kind;
	sp->name = part.name ? intern(g, part.name) : NULL;
	sp->g = g;
	sp->track = tg_node_new(sp);
	if (!sp->track) die("out of memory");
	vpush(&g->trackers, sp->track);
	if (at) *at = sp;
	else om_set(by, sp->name, sp);
	vpush(&n->all, sp);
	watch(g, sp);
	return sp;
}

// readers of a spot: marked by the change being told
static void fire(gr_graph *g, gr_spot *sp) {
	if (!g->telling) return;
	size_t n;
	tg_link *const *rs = tg_readers(sp->track, &n);
	vec copy = {0};
	for (size_t i = 0; i < n; i++)
		if (rs[i]) tpush(g, &copy, rs[i]->from);
	for (size_t i = 0; i < copy.n; i++) {
		gr_reader *r = ((tg_node *)copy.v[i])->owner;
		if (r->owner == g->telling->own) continue;
		if (g->o.marked) g->o.marked(g->o.ctx, r->owner, g->telling->by, g->telling->tag);
	}
}
static void on_fire(nt_kind kind, void *user) {
	(void)kind;
	gr_spot *sp = user;
	fire(sp->g, sp);
}

static size_t object_len(const nd_node *n, gr_where w, const char *name) {
	if (w == GR_VALUE) return n->value.length;
	size_t cnt = w == GR_INFO ? n->info_length : n->children_length;
	const nd_entry *es = w == GR_INFO ? n->info : n->children;
	for (size_t i = 0; i < cnt; i++)
		if (!strcmp(es[i].name, name)) return es[i].object.length;
	return 0;
}
static nd_object object_of(const nd_node *n, gr_where w, const char *name) {
	if (w == GR_VALUE) return n->value;
	size_t cnt = w == GR_INFO ? n->info_length : n->children_length;
	const nd_entry *es = w == GR_INFO ? n->info : n->children;
	for (size_t i = 0; i < cnt; i++)
		if (!strcmp(es[i].name, name)) return es[i].object;
	return (nd_object){0};
}

static nt_value *nulls(size_t n) {
	nt_value *l = nt_list();
	for (size_t i = 0; i < n; i++) nt_push(l, nt_null());
	return l;
}

// a whole object of a node, from how many versions it had to what it has now
static void tell_whole(gr_graph *g, nd_node *n, gr_where w, const char *name, size_t old_len,
	const gr_change *hdr) {
	g->telling->by = with_where(g, hdr, n->id, w, w == GR_VALUE ? NULL : name);
	size_t now = object_len(n, w, name);
	if (old_len == 0 && now == 0) return;
	nt_notify *nf = om_get(&g->notifies, n->id);
	if (!nf) return;
	nt_value *before = nt_map(), *info = nt_map(), *children = nt_map();
	nt_set(before, "value", nulls(w == GR_VALUE ? old_len : 0));
	if (w == GR_INFO && old_len) nt_set(info, name, nulls(old_len));
	if (w == GR_CHILDREN && old_len) nt_set(children, name, nulls(old_len));
	nt_set(before, "info", info);
	nt_set(before, "children", children);
	nt_key path[2] = {{NT_STR_KEY, 0, KINDS[w], 0, 0}, {NT_STR_KEY, 0, name, 0, 0}};
	nt_patch p = {0};
	p.place.path = path;
	p.place.length = w == GR_VALUE ? 1 : 2;
	nt_value *val = now ? nulls(now) : NULL;
	if (now) p.has_value = 1, p.value = val;
	nt_patched(nf, &p, before);
	nt_free(val);
	nt_free(before);
}

// what mutate told: each patch with its facts, to be told under its version
typedef struct {
	gr_graph *g;
	gr_where w;
	const char *name;
	long slot;
	nt_patch *patches;
	nt_facts *facts;
	size_t n, cap;
} heard_t;

static void prefix(gr_graph *g, const heard_t *h, const nt_place *in, nt_place *out) {
	size_t pre = h->w == GR_VALUE ? 3 : 4;
	nt_key *ks = tmem(g, (in->length + pre + 1) * sizeof *ks);
	size_t k = 0;
	ks[k++] = (nt_key){NT_STR_KEY, 0, KINDS[h->w], 0, 0};
	if (h->w != GR_VALUE) ks[k++] = (nt_key){NT_STR_KEY, 0, h->name, 0, 0};
	ks[k++] = (nt_key){NT_NUM_KEY, h->slot, NULL, 0, 0};
	ks[k++] = (nt_key){NT_STR_KEY, 0, "content", 0, 0};
	for (size_t i = 0; i < in->length; i++) ks[k++] = in->path[i];
	*out = *in;
	out->path = ks;
	out->length = k;
}

static void hear(void *ctx, const nt_patch *patch, const mu_facts *facts, const char *node,
	mu_which which) {
	(void)node;
	(void)which;
	heard_t *h = ctx;
	if (h->n == h->cap) {
		size_t cap = h->cap ? h->cap * 2 : 4;
		nt_patch *np = tmem(h->g, cap * sizeof *np);
		nt_facts *nf = tmem(h->g, cap * sizeof *nf);
		if (h->n) memcpy(np, h->patches, h->n * sizeof *np), memcpy(nf, h->facts, h->n * sizeof *nf);
		h->patches = np;
		h->facts = nf;
		h->cap = cap;
	}
	nt_patch p = *patch;
	prefix(h->g, h, &patch->place, &p.place);
	if (patch->has_move) prefix(h->g, h, &patch->move, &p.move);
	h->patches[h->n] = p;
	h->facts[h->n++] = *facts;
}

static void tell_patches(gr_graph *g, nd_node *n, target *t, const gr_change *hdr) {
	g->telling->by = with_where(g, hdr, n->id, t->w, t->w == GR_VALUE ? NULL : t->name);
	nt_notify *nf = om_get(&g->notifies, n->id);
	if (!nf) return;
	for (size_t i = 0; i < t->npatches; i++) nt_patched_facts(nf, &t->patches[i], &t->facts[i]);
}

// the nodes an operation changed, kept as the graph keeps them (own): those of the changes it made
// and of the objects it touched
static void owned(gr_graph *g, const chg *c) {
	vec ids = {0};
	for (size_t i = c->start; i < g->made.n; i++) sadd(g, &ids, ((const gr_change *)g->made.v[i])->node);
	for (size_t i = 0; i < c->targets.n; i++) sadd(g, &ids, ((const target *)c->targets.v[i])->id);
	for (size_t i = 0; i < ids.n; i++) {
		nd_node *n = om_get(&g->table, ids.v[i]);
		if (n) own(g, n);
	}
}

// an operation making changes: by whom, then notify told, the readers marked
const gr_error *gr_changing(gr_graph *g, const gr_acting *who, const gr_changing_opts *o,
	const gr_error *(*fn)(void *ctx), void *ctx) {
	chg c;
	memset(&c, 0, sizeof c);
	c.mine = *who;
	c.hearing = !o->has_snap;
	// told whole: each object's versions before
	snapped *snaps = o->has_snap ? tmem(g, (o->nsnap + 1) * sizeof *snaps) : NULL;
	for (size_t i = 0; o->has_snap && i < o->nsnap; i++) {
		snaps[i].n = om_get(&g->table, o->snap[i].id);
		snaps[i].w = o->snap[i].where;
		snaps[i].name = o->snap[i].name;
		if (snaps[i].n) {
			nd_object cur = object_of(snaps[i].n, snaps[i].w, snaps[i].name);
			nd_version *copy = tmem(g, (cur.length + 1) * sizeof *copy);
			if (cur.length) memcpy(copy, cur.versions, cur.length * sizeof *copy);
			snaps[i].old = (nd_object){copy, cur.length};
		}
	}
	gr_acting *saved = g->acting;
	chg *saved_cur = g->cur;
	g->acting = &c.mine;
	g->cur = &c;
	c.start = g->made.n;
	const gr_error *e = fn(ctx);
	g->acting = saved;
	g->cur = saved_cur;
	if (e) {
		owned(g, &c);
		g->made.n = c.start;
		return e;
	}
	size_t count = g->made.n - c.start;
	// nothing made: nothing to tell
	if (!count) {
		owned(g, &c);
		return NULL;
	}
	gr_change **ours = (gr_change **)&g->made.v[c.start];
	const gr_change *header = ours[count - 1];
	telling_t t = {header, o->tag, o->own};
	telling_t *was = g->telling;
	g->telling = &t;
	// changed (WIRING.tex, Out): an operation of the api reports its own records; any other change
	// reports them here, told whole as the first version put, or the object removed (children: the
	// api's alone)
	gr_record *recs = NULL;
	nt_patch *puts = NULL;
	size_t nrec = 0;
	if (!o->has_snap) {
		for (size_t i = 0; i < c.targets.n; i++) {
			target *tg = c.targets.v[i];
			nd_node *n = om_get(&g->table, tg->id);
			if (!n) continue;
			const gr_change *h = tg->hdr < count ? ours[tg->hdr] : header;
			if (tg->fine) tell_patches(g, n, tg, h);
			else tell_whole(g, n, tg->w, tg->name, tg->old_len, h);
		}
	} else {
		recs = o->reported || !g->o.changed ? NULL : tmem(g, (o->nsnap + 1) * sizeof *recs);
		puts = recs ? tmem(g, (o->nsnap + 1) * sizeof *puts) : NULL;
		for (size_t i = 0; i < o->nsnap; i++) {
			snapped *s = &snaps[i];
			if (!s->n) continue;
			nd_object now = object_of(s->n, s->w, s->name);
			int same = now.length == s->old.length;
			for (size_t k = 0; same && k < now.length; k++)
				same = now.versions[k].content == s->old.versions[k].content &&
					now.versions[k].change == s->old.versions[k].change;
			if (same) continue;
			// told by the change that touched it, else the last
			const gr_change *h = header;
			for (size_t k = 0; k < c.targets.n; k++) {
				target *tg = c.targets.v[k];
				if (tg->w == s->w && !strcmp(tg->id, s->n->id) &&
					(s->w == GR_VALUE || !strcmp(tg->name, s->name)) && tg->hdr < count)
					h = ours[tg->hdr];
			}
			tell_whole(g, s->n, s->w, s->name, s->old.length, h);
			if (recs && s->w != GR_CHILDREN) {
				puts[nrec] = (nt_patch){0};
				if (now.length && now.versions[0].content) {
					puts[nrec].has_value = 1;
					puts[nrec].value = now.versions[0].content;
				}
				recs[nrec] = (gr_record){s->n->id, s->w, s->name, &puts[nrec], 1, h, GR_AT_VERSION, 0, 1,
					om_has(&g->ephemeral, s->n->id)};
				nrec++;
			}
		}
	}
	g->telling = was;
	for (size_t i = 0; i < nrec; i++) g->o.changed(g->o.ctx, &recs[i]);
	if (o->wrote) {
		for (size_t i = 0; i < count; i++) {
			gr_times *w = o->wrote;
			if (w->n == w->cap) {
				w->cap = w->cap ? w->cap * 2 : 8;
				w->v = realloc(w->v, w->cap * sizeof *w->v);
				if (!w->v) die("out of memory");
			}
			w->v[w->n++] = ours[i]->time;
		}
	}
	owned(g, &c);
	g->made.n = c.start;
	return NULL;
}

// loading: a node in, or out

static void loaded(gr_graph *g, const char *id, const gr_change *change) {
	gr_spots *n = om_get(&g->spots, id);
	gr_spot *sp = n ? n->loaded : NULL;
	if (!sp) return;
	telling_t t = {change, NULL, NULL};
	telling_t *was = g->telling;
	g->telling = &t;
	fire(g, sp);
	g->telling = was;
}

static gr_change *loaded_change(gr_graph *g, const gr_acting *who, int64_t time, const char *node) {
	gr_change c = {0};
	c.time = time;
	c.actor = who->actor;
	c.reader = who->reader;
	c.cause = who->cause;
	c.site = who->site;
	c.node = node;
	c.where = GR_LOADED;
	return change_own(g, &c, 0);
}

// a node made now is loaded by its making's change
static const gr_error *intro_at(gr_graph *g, nd_node *node, const gr_acting *who, int64_t time) {
	nd_node *there = om_get(&g->table, node->id);
	if (there && there != node) return gerr(g, "already-there", NULL);
	om_set(&g->table, node->id, node);
	own(g, node);
	gr_spots *of = om_get(&g->spots, node->id);
	if (of)
		for (size_t i = 0; i < of->all.n; i++) watch(g, of->all.v[i]);
	loaded(g, node->id, loaded_change(g, who, time, node->id));
	return NULL;
}

const gr_error *gr_intro(gr_graph *g, nd_node *node, const gr_acting *who) {
	gr_acting host = {g->host, NULL, NULL, NULL};
	return intro_at(g, node, who ? who : &host, tick(g));
}

// no longer loaded: not ephemeral, owned by none; its loaded readers marked by cause. What it held
// is let go at the next sweep, and a node the graph made goes then too. A node the host introduced
// is the host's: it keeps what it was given, held (it may be read after)
void gr_release(gr_graph *g, const char *id, const gr_change *cause) {
	nd_node *gone = om_get(&g->table, id);
	if (!gone) return;
	ledger *l = om_get(&g->ledgers, gone->id);
	if (l) {
		om_del(&g->ledgers, gone->id);
		if (l->made) {
			for (size_t i = 0; i < l->n; i++) later(g, l->v[i].p, l->v[i].value);
			later(g, gone, 0);
		}
		free(l->v);
		free(l);
	}
	om_del(&g->table, id);
	nt_notify *nf = om_get(&g->notifies, id);
	if (nf) {
		om_del(&g->notifies, id);
		nt_destroy(nf);
	}
	gr_spots *of = om_get(&g->spots, id);
	if (of)
		for (size_t i = 0; i < of->all.n; i++) ((gr_spot *)of->all.v[i])->watch = NULL;
	om_del(&g->ephemeral, id);
	void *owner = om_get(&g->owners, id);
	om_del(&g->owners, id);
	if (g->o.released) g->o.released(g->o.ctx, id, owner);
	loaded(g, id, cause);
}

// a node made, as the acting one: loaded, not yet placed
const gr_error *gr_make(gr_graph *g, const char *id, const nt_value *value, int has_value,
	const gr_acting *who, const char **out) {
	return gr_make_own(g, id, value, has_value, who, 0, NULL, out);
}
const gr_error *gr_make_own(gr_graph *g, const char *id, const nt_value *value, int has_value,
	const gr_acting *who, int own, void *owner, const char **out) {
	int64_t time = *g->clock + 1;
	const char *pid = id;
	if (!pid) {
		const char *base = g->o.id ? g->o.id(g->o.ctx, time) : NULL;
		if (!base) {
			char b[32];
			snprintf(b, sizeof b, "@%lld", (long long)time);
			base = tdup(g, b);
		}
		pid = base;
		for (int k = 1; om_get(&g->table, pid); k++) {
			size_t bn = strlen(base) + 24;
			char *b = tmem(g, bn);
			snprintf(b, bn, "%s-%d", base, k);
			pid = b;
		}
	}
	pid = intern(g, pid);
	int64_t t = tick(g);
	gr_change *change = change_of(g, who, t, pid);
	// the node's header borrows from its making's change, which it holds
	made_node *m = grab(sizeof *m);
	*m = (made_node){0};
	m->made = change;
	hold(g, change, 0);
	nd_node *node = &m->node;
	node->id = pid;
	if (has_value) {
		nd_version *v = tmem(g, sizeof *v);
		*v = (nd_version){value, change, NULL};
		node->value = (nd_object){v, 1};
	}
	node->header.has_time = 1;
	node->header.time = t;
	node->header.actor = change->actor;
	node->header.reader = change->reader;
	node->header.cause = change->cause;
	const gr_error *e = intro_at(g, node, who, t);
	if (e) {
		drop(g, change, 0);
		free(m);
		return e;
	}
	mine(g, m, K_NODE, 1);
	((ledger *)om_get(&g->ledgers, pid))->made = 1;
	*out = pid;
	if (own) gr_own(g, pid, owner);
	// changed: a node made with a value is one record, the value put at []
	if (g->o.changed && has_value && value) {
		nt_patch p = {0};
		p.has_value = 1;
		p.value = value;
		gr_record r = {pid, GR_VALUE, NULL, &p, 1, change, GR_AT_VERSION, 0, 1, om_has(&g->ephemeral, pid)};
		g->o.changed(g->o.ctx, &r);
	}
	return NULL;
}

// an ephemeral node, owned by owner if given
void gr_own(gr_graph *g, const char *id, void *owner) {
	id = intern(g, id);
	om_set(&g->ephemeral, id, (void *)1);
	if (owner == NULL) return;
	om_set(&g->owners, id, owner);
	if (g->o.owned) g->o.owned(g->o.ctx, owner, id);
}

void gr_object_set(gr_graph *g, nd_node *n, gr_where where, const char *name,
	const nd_version *vs, size_t count) {
	nd_version *copy = tmem(g, (count + 1) * sizeof *copy);
	if (count) memcpy(copy, vs, count * sizeof *copy);
	if (where == GR_VALUE) {
		n->value = (nd_object){copy, count};
		if (om_get(&g->table, n->id) == n) own(g, n);
		return;
	}
	nd_entry **es = where == GR_INFO ? &n->info : &n->children;
	size_t *len = where == GR_INFO ? &n->info_length : &n->children_length;
	size_t at = *len;
	for (size_t i = 0; i < *len; i++)
		if (!strcmp((*es)[i].name, name)) at = i;
	nd_entry *ne = tmem(g, (*len + 1) * sizeof *ne);
	size_t m = 0;
	for (size_t i = 0; i < *len; i++) {
		if (i != at) ne[m++] = (*es)[i];
		else if (count) ne[m++] = (nd_entry){(*es)[i].name, {copy, count}};
	}
	if (at == *len && count) ne[m++] = (nd_entry){tdup(g, name), {copy, count}};
	*es = ne;
	*len = m;
	if (om_get(&g->table, n->id) == n) own(g, n);
}

// INTERNAL AND DANGEROUS (WIRING.tex, In; graph.h says why): sync's alone, never the interface's

// a because of the graph's own, its texts and its key in the same block; found by the pointer's text
static gr_synced *synced_own(gr_graph *g, const gr_synced *from) {
	char k[32];
	const char *layer = from->layer ? from->layer : "";
	size_t room = up(sizeof(gr_synced)) + text_room(layer) + text_room(from->name) +
		text_room(from->signer) + up(sizeof k);
	char *at = grab(room);
	gr_synced *b = take(&at, sizeof *b);
	b->layer = text_copy(layer, &at);
	b->lamport = from->lamport;
	b->name = text_copy(from->name, &at);
	b->signer = text_copy(from->signer, &at);
	snprintf(k, sizeof k, "%p", (void *)b);
	om_set(&g->synced, text_copy(k, &at), b);
	mine(g, b, K_SYNCED, 0);
	return b;
}
static void synced_gone(gr_graph *g, const gr_synced *b) {
	char k[32];
	snprintf(k, sizeof k, "%p", (const void *)b);
	om_del(&g->synced, k);
}

// where a version sync made is in the histories: a because gr_versions made, by the pointer
static const char *because_place(gr_graph *g, const void *because) {
	if (!because) return NULL;
	char k[32];
	snprintf(k, sizeof k, "%p", because);
	const gr_synced *b = om_get(&g->synced, k);
	return b ? b->name : NULL;
}

void gr_versions(gr_graph *g, const char *id, gr_where where, const char *name,
	const gr_incoming *list, size_t count, const gr_from *from) {
	nd_node *n = om_get(&g->table, id);
	if (!n) return;
	nd_object old = object_of(n, where, name);
	// the same places, all of them: nothing to change
	if (count == old.length) {
		size_t k = 0;
		for (; k < count; k++) {
			const char *a = list[k].because ? list[k].because->name : NULL;
			const char *b = because_place(g, old.versions[k].because);
			if (!a || !b || strcmp(a, b)) break;
		}
		if (k == count) return;
	}
	int64_t time = tick(g);
	nd_version *now = tmem(g, (count + 1) * sizeof *now);
	mu_alloc al = {places_alloc, g};
	static const nd_list no_ids = {NULL, 0};
	for (size_t i = 0; i < count; i++) {
		const char *p = list[i].because ? list[i].because->name : NULL;
		int kept = 0;
		for (size_t j = 0; p && !kept && j < old.length; j++) {
			const char *q = because_place(g, old.versions[j].because);
			if (q && !strcmp(p, q)) now[i] = old.versions[j], kept = 1;
		}
		if (kept) continue;
		gr_change proto = {0};
		if (list[i].change) proto = *list[i].change;
		proto.time = time;
		proto.where = GR_NOWHERE;
		proto.name = NULL;
		gr_change *c = change_own(g, &proto, 0);
		const void *content = list[i].content;
		if (where == GR_CHILDREN) {
			// no content (a removal among other heads): none, as in the value
			content = !list[i].content ? NULL : list[i].content->type == NT_LIST
				? (const void *)mu_list_to(list[i].content, &al) : &no_ids;
		}
		gr_synced *b = NULL;
		if (list[i].because) b = synced_own(g, list[i].because);
		now[i] = (nd_version){content, c, b};
	}
	gr_object_set(g, n, where, name, now, count);
	// the change this makes, one from elsewhere: the blop's header, its cause wrapped
	const pr_value *actor = g->host, *site = NULL, *cause = NULL;
	const char *reader = NULL, *signer = NULL, *sname = NULL;
	if (from) {
		actor = from->actor, reader = from->reader, site = from->site, cause = from->cause;
		signer = from->signer, sname = from->name;
	} else {
		for (size_t i = 0; i < count; i++) {
			if (!list[i].because) continue;
			const gr_change *c = list[i].change;
			if (c) actor = c->actor, reader = c->reader, site = c->site, cause = c->cause;
			signer = list[i].because->signer, sname = list[i].because->name;
			break;
		}
	}
	if (signer) {
		pr_arena *a = tpra(g);
		pr_value *m = pr_alloc(a, sizeof *m);
		pr_value sync = pr_map();
		pr_put(a, &sync, "signer", pr_str(a, signer, strlen(signer)));
		pr_put(a, &sync, "name", pr_str(a, sname, strlen(sname)));
		*m = pr_map();
		pr_put(a, m, "sync", sync);
		if (cause) pr_put(a, m, "cause", *cause);
		cause = m;
	}
	gr_change by = {0};
	by.time = time;
	by.actor = actor;
	by.reader = reader;
	by.site = site;
	by.cause = cause;
	by.node = id;
	telling_t t = {&by, NULL, NULL};
	telling_t *was = g->telling;
	g->telling = &t;
	tell_whole(g, n, where, name, old.length, &by);
	g->telling = was;
}

// what owner reads tracked through

static void dep_track(void *ctx, const char *id, pl_part part) {
	gr_reader *r = ctx;
	gr_spot *sp = spot(r->g, id, part);
	if (tg_track(r->track, sp->track) != 0) die("out of memory");
}

gr_reader *gr_reader_new(gr_graph *g, void *owner) {
	gr_reader *r = amem(g, sizeof *r);
	r->g = g;
	r->owner = owner;
	r->track = tg_node_new(r);
	if (!r->track) die("out of memory");
	vpush(&g->trackers, r->track);
	r->dep = (pl_depend){dep_track, r};
	return r;
}
const pl_depend *gr_depend(gr_reader *r) { return &r->dep; }
void gr_begin(gr_reader *r) { tg_begin(r->track); }
void gr_end(gr_reader *r) { tg_end(r->track); }
void gr_untrack(gr_reader *r) { tg_untrack(r->track, NULL); }

// protect: asked as the actor, before each operation not the graph's own. the policy's own
// reads are the asker's: tracked when it is

typedef struct {
	gr_graph *g;
	const pl_depend *d;
} policy;

static void depend(const pl_depend *d, const char *id, pl_kind kind, const char *name) {
	if (d) d->fn(d->ctx, id, (pl_part){kind, name});
}

static int policy_get(void *ctx, const char *id, const pr_value **value) {
	policy *p = ctx;
	depend(p->d, id, PL_LOADED, NULL);
	nd_node *n = om_get(&p->g->table, id);
	if (!n) return 0;
	depend(p->d, id, PL_VALUE, NULL);
	*value = NULL;
	if (n->value.length) *value = gr_pr(p->g, n->value.versions[0].content);
	return 1;
}

// fail: a places code met working them out (a write's address), the operation's error after
// stopped and read only, before anything is asked
typedef struct {
	pr_ask *v;
	size_t n, cap;
	int fail;
} asks_t;

static void asks_add(gr_graph *g, asks_t *a, pr_ask x) {
	if (a->n == a->cap) {
		size_t cap = a->cap ? a->cap * 2 : 8;
		pr_ask *nv = pr_alloc(tpra(g), cap * sizeof *nv);
		if (a->n) memcpy(nv, a->v, a->n * sizeof *nv);
		a->v = nv;
		a->cap = cap;
	}
	a->v[a->n++] = x;
}
static void asks_addall(gr_graph *g, asks_t *a, pr_asks x) {
	for (size_t i = 0; i < x.n; i++) asks_add(g, a, x.items[i]);
}

// an object of a node: "value", ["info", name], ["children", name]
typedef struct {
	const char *kind; // NULL: none
	const char *name;
} obj;
static const obj NO_OBJ = {NULL, NULL};
static const obj VALUE_OBJ = {"value", NULL};

static pr_value obj_pr(gr_graph *g, obj o) {
	if (!o.name) return pr_lit(o.kind);
	pr_value l = pr_list();
	pr_push(tpra(g), &l, pr_lit(o.kind));
	pr_push(tpra(g), &l, pr_lit(o.name));
	return l;
}
static pr_ask read_ask(gr_graph *g, const char *node, obj o) {
	pr_value args = pr_map();
	pr_put(tpra(g), &args, "node", pr_lit(node));
	pr_put(tpra(g), &args, "object", obj_pr(g, o));
	return (pr_ask){"read", args};
}
// every object of a node read
static pr_asks node_reads(gr_graph *g, const nd_node *n) {
	const char **info = pr_alloc(tpra(g), (n->info_length + 1) * sizeof *info);
	const char **ch = pr_alloc(tpra(g), (n->children_length + 1) * sizeof *ch);
	for (size_t k = 0; k < n->info_length; k++) info[k] = n->info[k].name;
	for (size_t k = 0; k < n->children_length; k++) ch[k] = n->children[k].name;
	return pr_read_asks(tpra(g), n->id, n->value.length ? 1 : 0, info, n->info_length, ch,
		n->children_length);
}
static pr_asks route_asks(gr_graph *g, const pl_step *route, size_t n) {
	pr_step *st = pr_alloc(tpra(g), (n ? n : 1) * sizeof *st);
	for (size_t i = 0; i < n; i++) st[i] = (pr_step){route[i].node, route[i].name};
	return pr_pass(tpra(g), st, n);
}

static pr_answer ask(gr_graph *g, const pr_value *actor, const pr_ask *asks, size_t n,
	const pl_depend *d) {
	if (g->may.fn == pr_anyone.fn) return (pr_answer){PR_YES, {0}};
	policy p = {g, d};
	pr_read rd = {policy_get, &p};
	return pr_check(&g->may, tpra(g), actor, asks, n, &rd).answer;
}

static const gr_error *allowed(gr_graph *g, pr_answer a, const char *op) {
	if (a.kind == PR_YES) return NULL;
	pr_value *why = pr_alloc(tpra(g), sizeof *why);
	if (a.kind == PR_NO) *why = a.why;
	else {
		*why = pr_map();
		pr_put(tpra(g), why, "code", pr_lit("pending"));
	}
	const pr_value *code = pr_get(why, "code");
	const char *c = code && code->kind == PR_STR ? code->str : "";
	size_t mn = strlen(op) + strlen(c) + 3;
	char *m = tmem(g, mn);
	snprintf(m, mn, "%s: %s", op, c);
	gr_error *e = (gr_error *)gerr(g, "refused", m);
	e->why = why;
	return e;
}

const gr_error *gr_asking(gr_graph *g, const pr_value *actor, const pr_ask *asks, size_t n,
	const char *op) {
	return allowed(g, ask(g, actor, asks, n, NULL), op);
}

// items as the actor may have them: passing each step of its route, and reading the object
// read (none: every object of the node); refused: no node, and why; pending: no node
static void guard(gr_graph *g, const pr_value *actor, const pl_items *in, const pl_depend *d,
	obj object, gr_items *out) {
	out->n = in->n;
	out->items = tmem(g, (in->n ? in->n : 1) * sizeof *out->items);
	for (size_t i = 0; i < in->n; i++) {
		const pl_item *it = &in->items[i];
		gr_item *o = &out->items[i];
		o->it = *it;
		if (g->may.fn == pr_anyone.fn) continue;
		asks_t asks = {0};
		asks_addall(g, &asks, route_asks(g, it->route, it->nroute));
		if (it->node && object.kind) asks_add(g, &asks, read_ask(g, it->id, object));
		else if (it->node) asks_addall(g, &asks, node_reads(g, it->node));
		pr_answer a = ask(g, actor, asks.v, asks.n, d);
		if (a.kind == PR_YES) continue;
		o->it.node = NULL;
		o->it.has_versions = 0;
		o->it.versions = NULL;
		o->it.nversions = 0;
		if (a.kind == PR_NO) {
			pr_value *w = pr_alloc(tpra(g), sizeof *w);
			*w = a.why;
			o->refused = w;
		}
	}
}

static pr_value ids_pr(gr_graph *g, const nd_list *l) {
	pr_value out = pr_list();
	if (l)
		for (size_t i = 0; i < l->length; i++)
			if (l->items[i].id) pr_push(tpra(g), &out, pr_lit(l->items[i].id));
	return out;
}

// the ids at a version of a node's list
static const nd_list *ids_at(gr_graph *g, const char *id, const char *name, const pl_span *slot) {
	nd_node *n = om_get(&g->table, id);
	if (!n) return NULL;
	long at = slot ? slot->from : 0;
	for (size_t i = 0; i < n->children_length; i++)
		if (!strcmp(n->children[i].name, name)) {
			const nd_object *o = &n->children[i].object;
			if (at >= 0 && (size_t)at < o->length) return o->versions[at].content;
		}
	return NULL;
}
// the ids from a up to z of a list, as slice does
static nd_list slice_of(const nd_list *l, long a, long z) {
	nd_list out = {NULL, 0};
	if (!l) return out;
	long len = (long)l->length;
	if (a < 0) a = a + len < 0 ? 0 : a + len;
	if (z < 0) z = z + len < 0 ? 0 : z + len;
	if (a > len) a = len;
	if (z > len) z = len;
	if (a >= z) return out;
	out.items = l->items + a;
	out.length = (size_t)(z - a);
	return out;
}

static pr_value at_pr(gr_graph *g, const pl_span *sp) {
	if (!sp) return pr_num(0);
	if (sp->to == sp->from + 1) return pr_num((double)sp->from);
	pr_value l = pr_list();
	pr_push(tpra(g), &l, pr_num((double)sp->from));
	pr_push(tpra(g), &l, pr_num((double)sp->to));
	return l;
}

// placing an id: and reading it, where its node is loaded (reads: for the ids placed)
static asks_t placing_asks(gr_graph *g, const char *node, const char *name, pr_value before,
	pr_value after, int reads) {
	asks_t out = {0};
	pr_asks placing = pr_placing(tpra(g), node, name, &before, &after);
	asks_addall(g, &out, placing);
	for (size_t i = 0; reads && i < placing.n; i++) {
		if (strcmp(placing.items[i].op, "place")) continue;
		const pr_value *id = pr_get(&placing.items[i].args, "id");
		nd_node *n = id ? om_get(&g->table, id->str) : NULL;
		if (!n) continue;
		asks_addall(g, &out, node_reads(g, n));
	}
	return out;
}

// the interface

static const gr_error *live_check(gr_api *a, const char *op) {
	if (a->b.alive && !*a->b.alive) {
		char m[64];
		snprintf(m, sizeof m, "%s: this interface has stopped", op);
		return gerr(a->g, "stopped", tdup(a->g, m));
	}
	return NULL;
}

enum { R_LOOK, R_LOOKUP, R_LOOKUPS, R_CHILDREN, R_CONTENT, R_INFO, R_NODE, R_NAMES };
static const char *const ROPS[] = {"look", "lookup", "lookups", "children", "content", "info",
	"node", "names"};

static pl_spot place_of(const gr_api *a) {
	return (pl_spot){a->b.place, a->b.nplace, 0, NULL, 0};
}

const gr_error *gr_read_make(gr_read *r, const pl_depend *d) {
	gr_api *a = r->api;
	gr_graph *g = a->g;
	const char *const *address = r->address;
	size_t n = r->n;
	const char *name = r->name;
	pl_spot at = place_of(a);
	pl_items pit = {0};
	int code = PL_OK;
	obj object = NO_OBJ;
	r->is_names = 0;
	memset(&r->items, 0, sizeof r->items);
	switch (r->kind) {
	case R_LOOK: code = pl_look(&g->places, &at, address, n, d, &pit); break;
	case R_LOOKUP: code = pl_lookup(&g->places, &at, address, n, d, &pit); break;
	case R_LOOKUPS: code = pl_lookups(&g->places, &at, address, n, d, &pit); break;
	case R_CONTENT:
		code = pl_content(&g->places, &at, address, n, d, &pit);
		object = VALUE_OBJ;
		break;
	case R_INFO:
		code = pl_info(&g->places, &at, address, n, name, d, &pit);
		object = (obj){"info", name};
		break;
	case R_NODE: {
		// a look by id, read as a list as every read is; the node given: every object of it read
		code = pl_look(&g->places, &at, address, n, d, &pit);
		if (code) return pl_error(g, code);
		guard(g, a->b.agent, &pit, d, NO_OBJ, &r->items);
		const nd_node *node = r->items.n ? r->items.items[0].it.node : NULL;
		if (node == NULL) return NULL;
		depend(d, node->id, PL_VALUE, NULL);
		depend(d, node->id, PL_CHILDREN, NULL);
		for (size_t k = 0; k < node->children_length; k++)
			depend(d, node->id, PL_CHILDREN, node->children[k].name);
		for (size_t k = 0; k < node->info_length; k++)
			depend(d, node->id, PL_INFO, node->info[k].name);
		return NULL;
	}
	default:
		if (name && r->kind == R_CHILDREN) {
			code = pl_children(&g->places, &at, address, n, name, d, &pit);
			break;
		}
		// names: of each node the actor may reach and list (the list ask, for info too)
		if (r->kind == R_NAMES && (!name || (strcmp(name, "info") && strcmp(name, "children"))))
			return pl_error(g, PL_WRONG_FIELD);
		int info = r->kind == R_NAMES && !strcmp(name, "info");
		code = pl_look(&g->places, &at, address, n, d, &pit);
		if (code) return pl_error(g, code);
		gr_items gi;
		guard(g, a->b.agent, &pit, d, NO_OBJ, &gi);
		vec seen = {0};
		for (size_t i = 0; i < gi.n; i++) {
			const pl_item *it = &gi.items[i].it;
			if (!it->node) continue;
			pr_ask la = pr_list_ask(tpra(g), it->id);
			if (ask(g, a->b.agent, &la, 1, d).kind != PR_YES) continue;
			depend(d, it->id, info ? PL_INFO : PL_CHILDREN, NULL);
			size_t len = info ? it->node->info_length : it->node->children_length;
			const nd_entry *es = info ? it->node->info : it->node->children;
			for (size_t k = 0; k < len; k++) sadd(g, &seen, es[k].name);
		}
		r->is_names = 1;
		r->names.n = seen.n;
		r->names.names = (const char *const *)(void *)seen.v;
		return NULL;
	}
	if (code) return pl_error(g, code);
	guard(g, a->b.agent, &pit, d, object, &r->items);
	return NULL;
}

// a read: stopped, then made, through reading if the interface has it
static const gr_error *do_read(gr_api *a, int op, const char *const *address, size_t n,
	const char *name, gr_items *items, pl_namelist *names) {
	const gr_error *e = live_check(a, ROPS[op]);
	if (e) return e;
	static const char *const empty[1] = {NULL};
	gr_read r = {0};
	r.op = ROPS[op];
	r.address = address ? address : empty;
	r.n = n;
	r.name = name;
	r.api = a;
	r.kind = op;
	e = a->b.reading ? a->b.reading(a->b.ctx, &r) : gr_read_make(&r, a->b.depend);
	if (e) return e;
	if (names) *names = r.names;
	else *items = r.items;
	return NULL;
}

const gr_error *gr_look(gr_api *a, const char *const *address, size_t n, gr_items *out) {
	return do_read(a, R_LOOK, address, n, NULL, out, NULL);
}
const gr_error *gr_lookup(gr_api *a, const char *const *path, size_t n, gr_items *out) {
	return do_read(a, R_LOOKUP, path, n, NULL, out, NULL);
}
const gr_error *gr_lookups(gr_api *a, const char *const *path, size_t n, gr_items *out) {
	return do_read(a, R_LOOKUPS, path, n, NULL, out, NULL);
}
const gr_error *gr_names(gr_api *a, const char *const *address, size_t n, pl_namelist *out) {
	return do_read(a, R_CHILDREN, address, n, NULL, NULL, out);
}
const gr_error *gr_names_of(gr_api *a, const char *const *address, size_t n, const char *part,
	pl_namelist *out) {
	return do_read(a, R_NAMES, address, n, part, NULL, out);
}
const gr_error *gr_children(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out) {
	return do_read(a, R_CHILDREN, address, n, name, out, NULL);
}
const gr_error *gr_content(gr_api *a, const char *const *address, size_t n, gr_items *out) {
	return do_read(a, R_CONTENT, address, n, NULL, out, NULL);
}
const gr_error *gr_info(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out) {
	return do_read(a, R_INFO, address, n, name, out, NULL);
}
const gr_error *gr_node(gr_api *a, const char *id, const nd_node **out) {
	gr_items items;
	*out = NULL;
	const gr_error *e = do_read(a, R_NODE, (const char *const[]){pl_id, id}, 2, NULL, &items, NULL);
	if (!e && items.n) *out = items.items[0].it.node;
	return e;
}

// writes

static int never_name(const char *s) { return !strcmp(s, ".") || !strcmp(s, "..") || strchr(s, '/'); }

enum { W_WRITE, W_SET, W_INSERT, W_REMOVE, W_POP, W_RENAME, W_MOVE };
static const char *const WOPS[] = {"write", "set", "insert", "remove", "pop", "rename", "move"};
typedef struct {
	gr_graph *g;
	int op;
	pl_spot at;
	const char *const *address;
	size_t n;
	const char *name;
	const nt_patch *patches;
	size_t np;
	const long *index;
	const pl_span *ispan;
	const pl_span *slot;
	const char *id, *child, *to, *toid, *toname;
	pl_span span;
	int span_slot; // slotindex given as a span
	long mindex;
	const long *toindex;
	int64_t times[2];
	size_t ntimes;
	// for changed: the node a write was made at, the headers of the changes made, and the
	// records planned before the operation (children's: the lists are as they were)
	const char *wnode;
	const gr_change *hdr[2];
	size_t nplan;
	const char *pnode[2], *pname[2];
	nt_patch pat[2];
	size_t npat[2];
	nt_key key[1];
	nt_value *held[2];
} wop;

// patches to the version from of one object of n, by places (pl_edit): one change; what mutate
// tells heard, and the versions made held
static const gr_error *edit_object(gr_graph *g, nd_node *n, gr_where w, const char *name,
	const pl_span *slots, const nt_patch *patches, size_t np, const gr_change **change,
	target *tg, int span_slot) {
	const char *info = w == GR_VALUE ? NULL : name;
	size_t len = object_len(n, w, name);
	long from = slots ? slots->from : 0, to = slots ? slots->to : 1;
	heard_t heard = {g, w, name, from, NULL, NULL, 0, 0};
	mu_patched hook = {hear, &heard};
	pl_mutated mutated;
	const void *ch;
	int code = pl_edit(&g->places, n, info, (pl_span){from, to}, patches, np,
		tg && g->cur->hearing ? &hook : NULL, &ch, &mutated);
	if (code == PL_MUTATE) return mu_error(g, mutated.code);
	if (code) return pl_error(g, code);
	// the versions made: from, up to what was after to
	size_t tail = len > (size_t)to ? len - (size_t)to : 0;
	nd_object now = w == GR_VALUE ? n->value : (nd_object){0};
	for (size_t i = 0; w != GR_VALUE && i < n->info_length; i++)
		if (!strcmp(n->info[i].name, name)) now = n->info[i].object;
	nd_object made = {now.versions + from, now.length - (size_t)from - tail};
	// mutate's new versions hold their contents (mutate.h): the graph holds its own (own), and
	// lets go of mutate's at the next sweep
	for (size_t i = 0; i < made.length; i++) later(g, made.versions[i].content, 1);
	// told by patch where the version made is the one patched and the object was there
	if (tg && g->cur->hearing && heard.n && made.length && to == from + 1 && !span_slot) {
		const nt_patch *p0 = &patches[0];
		const nt_facts *f0 = &heard.facts[0];
		int was = p0->place.length > 0 || p0->place.has_range || f0->place.had;
		if (was) {
			tg->fine = 1;
			tg->patches = heard.patches;
			tg->facts = heard.facts;
			tg->npatches = heard.n;
		}
	}
	*change = ch;
	return NULL;
}

// the item the index-th look gives, default its first loaded
static const gr_error *at_item(wop *o, nd_node **out) {
	int code = pl_at(&o->g->places, &o->at, o->address, o->n, o->index, out);
	return code ? pl_error(o->g, code) : NULL;
}

static target *chg_target(gr_graph *g, const char *id, gr_where w, const char *name, size_t hdr) {
	chg *c = g->cur;
	target *t = tmem(g, sizeof *t);
	t->id = id;
	t->w = w;
	t->name = name;
	t->hdr = hdr;
	nd_node *n = om_get(&g->table, id);
	t->old_len = n ? object_len(n, w, name) : 0;
	tpush(g, &c->targets, t);
	return t;
}

const gr_change *gr_by_at(gr_graph *g, const char *node, gr_where where, const char *name) {
	const gr_change *c = gr_by(g, node);
	// heard: mutate tells; told whole: by what touched it
	if (c && g->cur && !g->cur->hearing)
		chg_target(g, c->node, where, where == GR_VALUE ? NULL : name, g->made.n - 1 - g->cur->start);
	return c;
}

// the changes an operation makes, with the objects they touch
static const gr_error *wop_exec(void *p) {
	wop *o = p;
	gr_graph *g = o->g;
	if (!g->cur) return gerr(g, "thrown", "a change made outside an operation");
	size_t first = g->made.n - g->cur->start;
	const gr_error *e = NULL;
	int code = PL_OK;
	const void *changes[2] = {0};
	size_t nch = 1;
	switch (o->op) {
	case W_WRITE:
	case W_SET: {
		nd_node *n;
		if (o->op == W_SET && never_name(o->name)) return pl_error(g, PL_WRONG_FIELD);
		e = at_item(o, &n);
		if (e) return e;
		gr_where w = o->op == W_WRITE ? GR_VALUE : GR_INFO;
		target *tg = chg_target(g, n->id, w, o->name, first);
		o->wnode = n->id;
		const gr_change *ch;
		e = edit_object(g, n, w, o->name, o->slot, o->patches, o->np, &ch, tg, o->span_slot);
		if (e) return e;
		changes[0] = ch;
		break;
	}
	case W_INSERT:
		chg_target(g, o->id, GR_CHILDREN, o->name, first);
		code = pl_insert(&g->places, o->id, o->name, o->child, o->ispan, o->slot, &changes[0]);
		break;
	case W_REMOVE:
		chg_target(g, o->id, GR_CHILDREN, o->name, first);
		code = pl_remove(&g->places, o->id, o->name, o->span, o->slot, &changes[0]);
		break;
	case W_POP:
		chg_target(g, o->id, GR_CHILDREN, o->name, first);
		code = pl_pop(&g->places, o->id, o->name, o->span, &changes[0]);
		break;
	case W_RENAME:
		chg_target(g, o->id, GR_CHILDREN, o->name, first);
		chg_target(g, o->id, GR_CHILDREN, o->to, first + 1);
		code = pl_rename(&g->places, o->id, o->name, o->to, changes);
		nch = 2;
		break;
	case W_MOVE:
		chg_target(g, o->id, GR_CHILDREN, o->name, first);
		if (strcmp(o->id, o->toid) || strcmp(o->name, o->toname))
			chg_target(g, o->toid, GR_CHILDREN, o->toname, first + 1);
		code = pl_move(&g->places, o->id, o->name, o->mindex, o->toid, o->toname, o->toindex,
			changes, &nch);
		break;
	}
	if (code) return pl_error(g, code);
	o->ntimes = nch;
	for (size_t i = 0; i < nch && i < 2; i++) {
		o->times[i] = ((const gr_change *)changes[i])->time;
		o->hdr[i] = changes[i];
	}
	return NULL;
}

// the strings placing keeps are scratch: the graph keeps its own copies (own)
static wop wop_new(gr_graph *g, int op) {
	wop o = {0};
	o.g = g;
	o.op = op;
	return o;
}

// in a changing, at place [], asked nothing
// changed (WIRING.tex, Out): the gr_do_* report their records themselves, as the api's operations do
static void report(wop *o);
static void plan_free(wop *o);
static void plan_insert(wop *o, const pl_span *index, const pl_span *slotindex);
static void plan_remove(wop *o);
static void plan_pop(wop *o);
static void plan_rename(wop *o);
static void plan_move(wop *o);

const gr_error *gr_do_write(gr_graph *g, const char *const *address, size_t n,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(g, W_WRITE);
	o.address = address, o.n = n, o.patches = patches, o.np = np, o.index = index, o.slot = slotindex, o.span_slot = span;
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_set(gr_graph *g, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(g, W_SET);
	o.address = address, o.n = n, o.name = tdup(g, name), o.patches = patches, o.np = np;
	o.index = index, o.slot = slotindex, o.span_slot = span;
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_insert(gr_graph *g, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time) {
	wop o = wop_new(g, W_INSERT);
	o.id = tdup(g, id), o.name = tdup(g, name), o.child = tdup(g, child);
	o.ispan = index, o.slot = slotindex;
	if (g->o.changed) plan_insert(&o, index, slotindex);
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_remove(gr_graph *g, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	wop o = wop_new(g, W_REMOVE);
	o.id = tdup(g, id), o.name = tdup(g, name), o.span = index, o.slot = slotindex;
	if (g->o.changed) plan_remove(&o);
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_pop(gr_graph *g, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	wop o = wop_new(g, W_POP);
	o.id = tdup(g, id), o.name = tdup(g, name), o.span = slotindex;
	if (g->o.changed) plan_pop(&o);
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_rename(gr_graph *g, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	wop o = wop_new(g, W_RENAME);
	o.id = tdup(g, id), o.name = tdup(g, name), o.to = tdup(g, to);
	if (g->o.changed) plan_rename(&o);
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e) times[0] = o.times[0], times[1] = o.times[1];
	return e;
}
const gr_error *gr_do_move(gr_graph *g, const char *id, const char *name, long index,
	const char *toid, const char *toname, const long *toindex, int64_t times[2], size_t *ntimes) {
	wop o = wop_new(g, W_MOVE);
	o.id = tdup(g, id), o.name = tdup(g, name), o.mindex = index;
	o.toid = tdup(g, toid), o.toname = tdup(g, toname), o.toindex = toindex;
	if (g->o.changed) plan_move(&o);
	const gr_error *e = wop_exec(&o);
	if (!e) report(&o);
	plan_free(&o);
	if (!e) times[0] = o.times[0], times[1] = o.times[1], *ntimes = o.ntimes;
	return e;
}

// changed (WIRING.tex, Out): one record per object a change changed. A children's patches are made
// before the operation, while its lists are as they were; a write's are the ones it was given

// n patches for a children object of node: a range, a value (a value planned is let go after)
static void plan(wop *o, const char *node, const char *name, int has_patch, int has_range, long a,
	long b, nt_value *value) {
	size_t i = o->nplan++;
	nt_patch p = {0};
	if (has_range) p.place.has_range = 1, p.place.from = a, p.place.to = b;
	if (value) p.has_value = 1, p.value = value;
	o->pat[i] = p;
	o->npat[i] = (size_t)has_patch;
	o->held[i] = value;
	o->pnode[i] = node;
	o->pname[i] = name;
}
static void plan_free(wop *o) {
	for (size_t i = 0; i < o->nplan; i++) nt_free(o->held[i]);
	o->nplan = 0;
}
static nt_value *ids_value(const nd_list *l) { return mu_list_of(l); }
static nt_value *one_id(const char *id) {
	nt_value *v = nt_list();
	nt_push(v, id ? nt_str(id) : nt_null());
	return v;
}
// how many ids a list has, first version
static long list_size(gr_graph *g, const char *id, const char *name) {
	const nd_list *l = ids_at(g, id, name, NULL);
	return l ? (long)l->length : 0;
}
// the records of each children operation, planned before it, while the lists are as they were
static void plan_insert(wop *o, const pl_span *index, const pl_span *slotindex) {
	const nd_list *have = ids_at(o->g, o->id, o->name, slotindex);
	long len = have ? (long)have->length : 0;
	plan(o, o->id, o->name, 1, 1, index ? index->from : len, index ? index->to : len, one_id(o->child));
}
static void plan_remove(wop *o) {
	plan(o, o->id, o->name, 1, 1, o->span.from, o->span.to, NULL);
}
static void plan_pop(wop *o) {
	plan(o, o->id, o->name, 0, 0, 0, 0, NULL);
}
static void plan_rename(wop *o) {
	// the old name: its first version removed; the new: its ids put in
	plan(o, o->id, o->name, 1, 0, 0, 0, NULL);
	plan(o, o->id, o->to, 1, 1, 0, 0, ids_value(ids_at(o->g, o->id, o->name, NULL)));
}
static void plan_move(wop *o) {
	gr_graph *g = o->g;
	long index = o->mindex;
	const long *toindex = o->toindex;
	const nd_list *ids = ids_at(g, o->id, o->name, NULL);
	int across = strcmp(o->id, o->toid) || strcmp(o->name, o->toname);
	const char *entry = ids && index >= 0 && (size_t)index < ids->length ? ids->items[index].id : NULL;
	if (!across) {
		// one list: the entry moved to where toindex says, counted after it left
		long at = toindex ? *toindex : list_size(g, o->id, o->name) - 1;
		plan(o, o->id, o->name, 1, 1, at, at, NULL);
		o->key[0] = (nt_key){NT_NUM_KEY, index, NULL, 0, 0};
		o->pat[0].has_move = 1;
		o->pat[0].move = (nt_place){o->key, 1, 0, 0, 0};
	} else {
		long at = toindex ? *toindex : list_size(g, o->toid, o->toname);
		plan(o, o->id, o->name, 1, 1, index, index + 1, NULL);
		plan(o, o->toid, o->toname, 1, 1, at, at, one_id(entry));
	}
}

static void slot_at(const pl_span *slot, int span, gr_record *r) {
	r->at = GR_AT_VERSION;
	r->from = 0, r->to = 1;
	if (!slot) return;
	r->from = slot->from, r->to = slot->to;
	if (span || slot->to != slot->from + 1) r->at = GR_AT_SPAN;
}

// after an operation landed: the records, in the order of its changes
static void report(wop *o) {
	gr_graph *g = o->g;
	if (!g->o.changed) return;
	size_t n = o->nplan;
	int writes = o->op == W_WRITE || o->op == W_SET;
	if (writes) n = 1;
	for (size_t i = 0; i < n; i++) {
		if (!o->hdr[i]) continue;
		gr_record r = {0};
		if (writes) {
			r.node = o->wnode;
			r.where = o->op == W_WRITE ? GR_VALUE : GR_INFO;
			r.name = o->name;
			r.patches = o->patches;
			r.npatches = o->np;
		} else {
			r.node = o->pnode[i];
			r.where = GR_CHILDREN;
			r.name = o->pname[i];
			r.patches = o->npat[i] ? &o->pat[i] : NULL;
			r.npatches = o->npat[i];
		}
		r.header = o->hdr[i];
		switch (o->op) {
		case W_WRITE:
		case W_SET:
		case W_INSERT:
		case W_REMOVE: slot_at(o->slot, o->span_slot, &r); break;
		case W_POP:
			r.at = GR_AT_POP;
			r.from = o->span.from, r.to = o->span.to;
			break;
		default: r.at = GR_AT_VERSION, r.from = 0, r.to = 1;
		}
		r.ephemeral = om_has(&g->ephemeral, r.node);
		g->o.changed(g->o.ctx, &r);
	}
}

// what the interface acts as
static gr_acting who_of(gr_api *a) {
	gr_acting w = {a->b.agent, a->b.reader, a->b.cause, NULL};
	if (a->b.site && a->g->o.site) w.site = a->g->o.site(a->g->o.ctx);
	return w;
}

// a changing, as around runs it
typedef struct {
	gr_graph *g;
	const gr_acting *who;
	const gr_changing_opts *o;
	wop *op;
} changing_t;
static const gr_error *changing_run(void *arg) {
	changing_t *c = arg;
	const gr_error *e = gr_changing(c->g, c->who, c->o, wop_exec, c->op);
	if (!e) report(c->op);
	return e;
}

// a write: stopped, read only, asked, then the changes made and told
static const gr_error *w_go(gr_api *a, wop *o, asks_t *asks, const gr_snap *snap, size_t nsnap) {
	gr_graph *g = a->g;
	const gr_error *e = live_check(a, WOPS[o->op]);
	if (e) return e;
	if (!a->b.writes) {
		char m[64];
		snprintf(m, sizeof m, "%s: a compute only reads", WOPS[o->op]);
		return gerr(g, "read-only", tdup(g, m));
	}
	if (asks && asks->fail) return pl_error(g, asks->fail);
	if (asks) {
		e = allowed(g, ask(g, a->b.agent, asks->v, asks->n, NULL), WOPS[o->op]);
		if (e) return e;
	}
	gr_acting who = who_of(a);
	gr_changing_opts co = {0};
	co.tag = a->b.tag;
	co.wrote = a->b.wrote;
	co.reported = 1;
	if (snap) co.has_snap = 1, co.snap = snap, co.nsnap = nsnap;
	if (!a->b.around) {
		e = gr_changing(g, &who, &co, wop_exec, o);
		if (!e) report(o);
		return e;
	}
	changing_t c = {g, &who, &co, o};
	return a->b.around(a->b.ctx, changing_run, &c);
}
static const gr_error *w_do(gr_api *a, wop *o, asks_t *asks, const gr_snap *snap, size_t nsnap) {
	const gr_error *e = w_go(a, o, asks, snap, nsnap);
	plan_free(o);
	return e;
}

// what reaching a node to write it asks: passing its route, then the edit
static asks_t writing_asks(gr_api *a, const char *const *address, size_t n, const long *index,
	obj object, const pl_span *slot) {
	gr_graph *g = a->g;
	asks_t out = {0};
	pl_spot at = place_of(a);
	pl_items items;
	out.fail = pl_look(&g->places, &at, address, n, NULL, &items);
	if (out.fail) return out;
	const pl_item *it = NULL;
	if (!index) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else if (*index >= 0 && (size_t)*index < items.n) it = &items.items[*index];
	if (!it || !it->node) return out;
	asks_addall(g, &out, route_asks(g, it->route, it->nroute));
	pr_value ov = obj_pr(g, object), av = at_pr(g, slot);
	asks_add(g, &out, pr_edit(tpra(g), "write", it->id, &ov, &av));
	return out;
}

static const gr_error *may_place(gr_api *a, const char *child) {
	if (child && om_has(&a->g->ephemeral, child) && !a->b.owner)
		return gerr(a->g, "not-a-process", "only a process makes, places or moves an ephemeral node");
	return NULL;
}

const gr_error *gr_write(gr_api *a, const char *const *address, size_t n, const nt_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(a->g, W_WRITE);
	o.at = place_of(a);
	o.address = address, o.n = n, o.patches = patches, o.np = np, o.index = index, o.slot = slotindex, o.span_slot = span;
	asks_t as = writing_asks(a, address, n, index, VALUE_OBJ, slotindex);
	const gr_error *e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_set(gr_api *a, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(a->g, W_SET);
	o.at = place_of(a);
	o.address = address, o.n = n, o.name = tdup(a->g, name), o.patches = patches, o.np = np;
	o.index = index, o.slot = slotindex, o.span_slot = span;
	asks_t as = writing_asks(a, address, n, index, (obj){"info", o.name}, slotindex);
	const gr_error *e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_insert(gr_api *a, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time) {
	gr_graph *g = a->g;
	const gr_error *e = may_place(a, child);
	if (e) return e;
	wop o = wop_new(g, W_INSERT);
	o.id = tdup(g, id), o.name = tdup(g, name), o.child = tdup(g, child);
	o.ispan = index, o.slot = slotindex;
	// a number is a gap: nothing replaced; a span: the ids there
	nd_list gone = {NULL, 0};
	if (index && index->from != index->to)
		gone = slice_of(ids_at(g, id, name, slotindex), index->from, index->to);
	nd_item it = {o.child, NULL};
	nd_list after = {&it, 1};
	asks_t as = placing_asks(g, id, name, ids_pr(g, &gone), ids_pr(g, &after), 1);
	if (g->o.changed) plan_insert(&o, index, slotindex);
	e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_remove(gr_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_REMOVE);
	o.id = tdup(g, id), o.name = tdup(g, name), o.span = index, o.slot = slotindex;
	nd_list gone = slice_of(ids_at(g, id, name, slotindex), index.from, index.to);
	asks_t as = placing_asks(g, id, name, ids_pr(g, &gone), pr_list(), 0);
	if (g->o.changed) plan_remove(&o);
	const gr_error *e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_pop(gr_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_POP);
	o.id = tdup(g, id), o.name = tdup(g, name), o.span = slotindex;
	asks_t as = {0};
	pr_value ov = obj_pr(g, (obj){"children", o.name}), av = at_pr(g, &slotindex);
	asks_add(g, &as, pr_edit(tpra(g), "pop", o.id, &ov, &av));
	gr_snap snap[1] = {{o.id, GR_CHILDREN, o.name}};
	if (g->o.changed) plan_pop(&o);
	const gr_error *e = w_do(a, &o, &as, snap, 1);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_rename(gr_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_RENAME);
	o.id = tdup(g, id), o.name = tdup(g, name), o.to = tdup(g, to);
	const nd_list *ids = ids_at(g, id, name, NULL);
	asks_t as = placing_asks(g, id, name, ids_pr(g, ids), pr_list(), 0);
	asks_t b = placing_asks(g, id, o.to, pr_list(), ids_pr(g, ids), 1);
	for (size_t i = 0; i < b.n; i++) asks_add(g, &as, b.v[i]);
	gr_snap snap[2] = {{o.id, GR_CHILDREN, o.name}, {o.id, GR_CHILDREN, o.to}};
	if (g->o.changed) plan_rename(&o);
	const gr_error *e = w_do(a, &o, &as, snap, 2);
	if (!e) times[0] = o.times[0], times[1] = o.times[1];
	return e;
}
const gr_error *gr_move(gr_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t times[2], size_t *ntimes) {
	gr_graph *g = a->g;
	const char *child = NULL;
	const nd_list *ids = ids_at(g, id, name, NULL);
	if (ids && index >= 0 && (size_t)index < ids->length) child = ids->items[index].id;
	const gr_error *e = may_place(a, child);
	if (e) return e;
	int across = strcmp(id, toid) || strcmp(name, toname);
	wop o = wop_new(g, W_MOVE);
	o.id = tdup(g, id), o.name = tdup(g, name), o.mindex = index;
	o.toid = tdup(g, toid), o.toname = tdup(g, toname), o.toindex = toindex;
	asks_t as = {0};
	if (across) {
		nd_item it = {child, NULL};
		nd_list one = {&it, child ? 1 : 0};
		asks_t x = placing_asks(g, id, name, ids_pr(g, &one), pr_list(), 0);
		asks_t y = placing_asks(g, toid, toname, pr_list(), ids_pr(g, &one), 1);
		for (size_t i = 0; i < x.n; i++) asks_add(g, &as, x.v[i]);
		for (size_t i = 0; i < y.n; i++) asks_add(g, &as, y.v[i]);
	}
	if (g->o.changed) plan_move(&o);
	e = w_do(a, &o, &as, NULL, 0);
	if (!e) times[0] = o.times[0], times[1] = o.times[1], *ntimes = o.ntimes;
	return e;
}

// a node made, as around runs it
typedef struct {
	gr_graph *g;
	const char *id;
	const nt_value *value;
	int has_value;
	const gr_acting *who;
	int own;
	void *owner;
	const char **out;
} making_t;
static const gr_error *making_run(void *arg) {
	making_t *m = arg;
	return gr_make_own(m->g, m->id, m->value, m->has_value, m->who, m->own, m->owner, m->out);
}

const gr_error *gr_create(gr_api *a, const nt_value *value, int has_value, const char *id,
	int ephemeral, const char **out) {
	gr_graph *g = a->g;
	const gr_error *e = live_check(a, "create");
	if (e) return e;
	if (!a->b.writes) return gerr(g, "read-only", "create: a compute only reads");
	if (ephemeral && !a->b.owner)
		return gerr(g, "not-a-process", "only a process makes an ephemeral node");
	gr_acting who = who_of(a);
	making_t m = {g, id, value, has_value, &who, ephemeral, a->b.owner, out};
	e = a->b.around ? a->b.around(a->b.ctx, making_run, &m) : making_run(&m);
	return e;
}

gr_api *gr_bound(gr_graph *g, const gr_bind *b) {
	void *(*mem)(gr_graph *, size_t) = b->scratch ? tmem : amem;
	gr_api *a = mem(g, sizeof *a);
	a->g = g;
	a->b = *b;
	const char **place = mem(g, (b->nplace + 1) * sizeof *place);
	for (size_t i = 0; i < b->nplace; i++) place[i] = b->scratch ? tdup(g, b->place[i]) : gr_dup(g, b->place[i]);
	a->b.place = place;
	if (!a->b.agent) a->b.agent = g->host;
	return a;
}

// the graph

gr_api *gr_as(gr_api *a, const pr_value *cause) {
	gr_api *out = tmem(a->g, sizeof *out);
	*out = *a;
	out->b.cause = cause;
	return out;
}

gr_graph *gr_new(const gr_options *o) {
	gr_graph *g = calloc(1, sizeof *g);
	if (!g) die("out of memory");
	g->o = *o;
	g->clock = o->clock ? o->clock : &g->own_clock;
	g->root = gr_dup(g, o->root);
	if (o->actor) g->host = o->actor;
	else {
		pr_value *h = pr_alloc(&g->pra, sizeof *h);
		*h = pr_lit("host");
		g->host = h;
	}
	g->may = o->may ? *o->may : pr_anyone;
	g->places = (pl_places){tget, places_alloc, places_by, g, g->root, NULL};
	if (!om_get(&g->table, g->root)) {
		nd_node *n = amem(g, sizeof *n);
		n->id = g->root;
		om_set(&g->table, g->root, n);
	}
	return g;
}

void gr_free(gr_graph *g) {
	if (!g) return;
	for (size_t i = 0; i < g->trackers.n; i++) tg_untrack(g->trackers.v[i], NULL);
	for (size_t i = 0; i < g->trackers.n; i++) tg_node_free(g->trackers.v[i]);
	for (size_t i = 0; i < g->notifies.n; i++)
		if (g->notifies.e[i].key) nt_destroy(g->notifies.e[i].val);
	// every hold let go: values theirs to free; what is the graph's own freed below, whatever it holds
	for (size_t i = 0; i < g->nlater; i++)
		if (g->later[i].value) nt_free((nt_value *)g->later[i].p);
	for (size_t i = 0; i < g->ledgers.n; i++) {
		if (!g->ledgers.e[i].key) continue;
		ledger *l = g->ledgers.e[i].val;
		for (size_t k = 0; k < l->n; k++)
			if (l->v[k].value) nt_free((nt_value *)l->v[k].p);
		free(l->v);
		free(l);
	}
	for (size_t i = 0; i < g->mine.slots; i++) {
		held *h = &g->mine.e[i];
		if (h->p && h->p != TOMBP) forget(g, h->p, h->k, 0);
	}
	free(g->mine.e);
	free(g->later);
	free(g->trackers.v);
	free(g->made.v);
	for (size_t i = 0; i < g->spots.n; i++) {
		gr_spots *n = g->spots.e[i].key ? g->spots.e[i].val : NULL;
		if (!n) continue;
		free(n->all.v);
		om_free(&n->children);
		om_free(&n->info);
	}
	omap *maps[] = {&g->table, &g->ephemeral, &g->owners, &g->spots, &g->notifies, &g->synced,
		&g->ledgers, &g->strings};
	for (size_t i = 0; i < sizeof maps / sizeof *maps; i++) om_free(maps[i]);
	pr_free(&g->pra);
	pr_free(&g->preq);
	pr_free(&g->phost);
	afree(&g->a);
	afree(&g->req);
	afree(&g->hosts);
	free(g);
}
