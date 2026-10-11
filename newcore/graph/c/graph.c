// The graph (newcore/graph/graph.ts), in C. See graph.h. The order of operations is the reference's: the
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

#include "../../c/trackgraph.h"
#include "../../opstreams/mutate/c/mutate.h"

// memory: an arena, and growing things in it

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

static void afree(arena *a) {
	while (a->head) {
		block *b = a->head;
		a->head = b->next;
		free(b);
	}
	a->cur = NULL;
	a->left = 0;
}

typedef struct {
	void **v;
	size_t n, cap;
} vec;

// ordered maps by string: insertion order, deleting and setting again moves to the end
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

static void *amem(gr_graph *s, size_t n);

static void vpush(gr_graph *s, vec *v, void *x) {
	if (v->n == v->cap) {
		size_t cap = v->cap ? v->cap * 2 : 4;
		void **nv = amem(s, cap * sizeof *nv);
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
// a vec of strings as a set
static void sadd(gr_graph *s, vec *v, const char *x) {
	if (sfind(v, x) < 0) vpush(s, v, (void *)x);
}

static size_t hashs(const char *k) {
	size_t h = 5381;
	for (; *k; k++) h = h * 33 + (unsigned char)*k;
	return h;
}

static void om_reindex(gr_graph *s, omap *m) {
	size_t live = 0;
	for (size_t i = 0; i < m->n; i++) {
		if (!m->e[i].key) continue;
		m->e[live++] = m->e[i];
	}
	m->n = live;
	size_t slots = 16;
	while (slots < 4 * (m->cap ? m->cap : 4)) slots *= 2;
	m->slots = slots;
	m->idx = amem(s, slots * sizeof *m->idx);
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
static void om_set(gr_graph *s, omap *m, const char *key, void *val) {
	long i = om_find(m, key);
	if (i >= 0) {
		m->e[i].val = val;
		return;
	}
	if (m->n == m->cap) {
		size_t cap = m->live * 2 > 4 ? m->live * 2 : 4;
		ent *ne = amem(s, cap * sizeof *ne);
		size_t k = 0;
		for (size_t j = 0; j < m->n; j++)
			if (m->e[j].key) ne[k++] = m->e[j];
		m->e = ne;
		m->n = k;
		m->cap = cap;
		om_reindex(s, m);
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

// the graph

typedef struct gr_spot gr_spot;
// a spot: a part of a node something read
struct gr_spot {
	const char *id;
	pl_kind part;
	const char *name;
	const char *key;
	tg_node *track;
	nt_read *watch;
	gr_graph *g;
};

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
	arena a;
	pr_arena pra;
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
	omap spots;
	omap spots_of; // vec * of gr_spot *
	omap notifies; // nt_notify *

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

// errors

static const gr_error *gerr(gr_graph *g, const char *code, const char *message) {
	gr_error *e = amem(g, sizeof *e);
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
	case NT_STR: return pr_str(&s->pra, v->str, v->bytes);
	case NT_LIST: {
		pr_value l = pr_list();
		for (size_t i = 0; i < v->count; i++) pr_push(&s->pra, &l, to_pr(s, v->items[i]));
		return l;
	}
	default: {
		pr_value m = pr_map();
		for (size_t i = 0; i < v->count; i++) pr_put(&s->pra, &m, v->keys[i], to_pr(s, v->items[i]));
		return m;
	}
	}
}
pr_value *gr_pr(gr_graph *g, const nt_value *v) {
	pr_value *p = pr_alloc(&g->pra, sizeof *p);
	*p = to_pr(g, v);
	return p;
}

// changes

static int64_t tick(gr_graph *g) { return ++*g->clock; }

static gr_change *change_of(gr_graph *g, const gr_acting *who, int64_t time, const char *node) {
	gr_change *c = amem(g, sizeof *c);
	c->time = time;
	c->actor = who->actor;
	c->reader = who->reader;
	c->cause = who->cause;
	c->site = who->site;
	c->node = node;
	return c;
}

const gr_change *gr_change_new(gr_graph *g, int64_t time, const pr_value *actor, const char *node) {
	gr_acting who = {actor, NULL, NULL, NULL};
	return change_of(g, &who, time, gr_dup(g, node));
}

const gr_change *gr_by(gr_graph *g, const char *node) {
	if (!g->acting) return NULL;
	gr_change *c = change_of(g, g->acting, tick(g), node);
	vpush(g, &g->made, c);
	return c;
}
static const void *places_by(void *ctx, const char *node) { return gr_by(ctx, node); }

static nd_node *tget(void *ctx, const char *id) {
	gr_graph *g = ctx;
	return om_get(&g->table, id);
}
nd_node *gr_get(gr_graph *g, const char *id) { return om_get(&g->table, id); }
static void *places_alloc(void *ctx, size_t n) { return amem(ctx, n); }

int gr_ephemeral(gr_graph *g, const char *id) { return om_has(&g->ephemeral, id); }
void *gr_owner(gr_graph *g, const char *id) { return om_get(&g->owners, id); }

static const char *const KINDS[] = {"", "value", "info", "children", "loaded"};

static gr_change *with_where(gr_graph *g, const gr_change *c, const char *node, gr_where w,
	const char *name) {
	gr_change *x = amem(g, sizeof *x);
	*x = *c;
	x->node = node;
	x->where = w;
	x->name = name;
	return x;
}

// spots and notify: what was read, and the watch on it

static const char *spot_key(gr_graph *g, const char *id, pl_part part) {
	// the id, a separator, the kind, the name
	size_t n = strlen(id) + 3 + (part.name ? strlen(part.name) : 0);
	char *k = amem(g, n + 1);
	snprintf(k, n + 1, "%s\x01%c%s", id, 'a' + (int)part.kind, part.name ? part.name : "");
	return k;
}

static void on_fire(nt_kind kind, void *user);

// notify watches what is read: an object deep, a node's names not
static void watch(gr_graph *g, gr_spot *sp) {
	if (sp->watch || sp->part == PL_LOADED) return;
	nd_node *n = om_get(&g->table, sp->id);
	if (!n) return;
	nt_notify *nf = om_get(&g->notifies, sp->id);
	if (!nf) {
		nf = nt_create(NULL, NULL);
		om_set(g, &g->notifies, sp->id, nf);
	}
	nt_key path[2];
	size_t len = 1;
	int names = 0;
	if (sp->part == PL_VALUE) path[0] = (nt_key){NT_STR_KEY, 0, "value", 0, 0};
	else if (sp->part == PL_INFO) {
		path[0] = (nt_key){NT_STR_KEY, 0, "info", 0, 0};
		path[1] = (nt_key){NT_STR_KEY, 0, sp->name, 0, 0};
		len = 2;
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
	const char *key = spot_key(g, id, part);
	gr_spot *sp = om_get(&g->spots, key);
	if (sp) return sp;
	sp = amem(g, sizeof *sp);
	sp->id = gr_dup(g, id);
	sp->part = part.kind;
	sp->name = part.name ? gr_dup(g, part.name) : NULL;
	sp->key = key;
	sp->g = g;
	sp->track = tg_node_new(sp);
	if (!sp->track) die("out of memory");
	vpush(g, &g->trackers, sp->track);
	om_set(g, &g->spots, key, sp);
	vec *of = om_get(&g->spots_of, sp->id);
	if (!of) {
		of = amem(g, sizeof *of);
		om_set(g, &g->spots_of, sp->id, of);
	}
	vpush(g, of, sp);
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
		if (rs[i]) vpush(g, &copy, rs[i]->from);
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
	nt_key *ks = amem(g, (in->length + pre + 1) * sizeof *ks);
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
		nt_patch *np = amem(h->g, cap * sizeof *np);
		nt_facts *nf = amem(h->g, cap * sizeof *nf);
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

// an operation making changes: by whom, then notify told, the readers marked
const gr_error *gr_changing(gr_graph *g, const gr_acting *who, const gr_changing_opts *o,
	const gr_error *(*fn)(void *ctx), void *ctx) {
	chg c;
	memset(&c, 0, sizeof c);
	c.mine = *who;
	c.hearing = !o->has_snap;
	snapped *snaps = amem(g, (o->nsnap + 1) * sizeof *snaps);
	for (size_t i = 0; o->has_snap && i < o->nsnap; i++) {
		snaps[i].n = om_get(&g->table, o->snap[i].id);
		snaps[i].w = o->snap[i].where;
		snaps[i].name = o->snap[i].name;
		if (snaps[i].n) {
			nd_object cur = object_of(snaps[i].n, snaps[i].w, snaps[i].name);
			nd_version *copy = amem(g, (cur.length + 1) * sizeof *copy);
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
		g->made.n = c.start;
		return e;
	}
	size_t count = g->made.n - c.start;
	gr_change **mine = (gr_change **)&g->made.v[c.start];
	const gr_change *header = count ? mine[count - 1] : NULL;
	gr_change none = {0};
	none.time = *g->clock;
	telling_t t = {header ? header : &none, o->tag, o->own};
	telling_t *was = g->telling;
	g->telling = &t;
	if (!o->has_snap) {
		for (size_t i = 0; i < c.targets.n; i++) {
			target *tg = c.targets.v[i];
			nd_node *n = om_get(&g->table, tg->id);
			if (!n || !header) continue;
			const gr_change *h = tg->hdr < count ? mine[tg->hdr] : header;
			if (tg->fine) tell_patches(g, n, tg, h);
			else tell_whole(g, n, tg->w, tg->name, tg->old_len, h);
		}
	} else {
		for (size_t i = 0; i < o->nsnap; i++) {
			snapped *s = &snaps[i];
			if (!s->n || !header) continue;
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
					h = mine[tg->hdr];
			}
			tell_whole(g, s->n, s->w, s->name, s->old.length, h);
		}
	}
	g->telling = was;
	if (o->wrote) {
		for (size_t i = 0; i < count; i++) {
			gr_times *w = o->wrote;
			if (w->n == w->cap) {
				w->cap = w->cap ? w->cap * 2 : 8;
				w->v = realloc(w->v, w->cap * sizeof *w->v);
				if (!w->v) die("out of memory");
			}
			w->v[w->n++] = mine[i]->time;
		}
	}
	g->made.n = c.start;
	return NULL;
}

// loading: a node in, or out

static void loaded(gr_graph *g, const char *id, const gr_change *change) {
	gr_spot *sp = om_get(&g->spots, spot_key(g, id, (pl_part){PL_LOADED, NULL}));
	if (!sp) return;
	telling_t t = {change, NULL, NULL};
	telling_t *was = g->telling;
	g->telling = &t;
	fire(g, sp);
	g->telling = was;
}

static gr_change *loaded_change(gr_graph *g, const gr_acting *who, int64_t time, const char *node) {
	gr_change *c = change_of(g, who, time, node);
	c->where = GR_LOADED;
	return c;
}

// a node made now is loaded by its making's change
static const gr_error *intro_at(gr_graph *g, nd_node *node, const gr_acting *who, int64_t time) {
	nd_node *there = om_get(&g->table, node->id);
	if (there && there != node) return gerr(g, "already-there", NULL);
	om_set(g, &g->table, node->id, node);
	vec *of = om_get(&g->spots_of, node->id);
	if (of)
		for (size_t i = 0; i < of->n; i++) watch(g, of->v[i]);
	loaded(g, node->id, loaded_change(g, who, time, node->id));
	return NULL;
}

const gr_error *gr_intro(gr_graph *g, nd_node *node, const gr_acting *who) {
	gr_acting host = {g->host, NULL, NULL, NULL};
	return intro_at(g, node, who ? who : &host, tick(g));
}

// no longer loaded: not ephemeral, owned by none; its loaded readers marked by cause
void gr_release(gr_graph *g, const char *id, const gr_change *cause) {
	if (!om_get(&g->table, id)) return;
	om_del(&g->table, id);
	nt_notify *nf = om_get(&g->notifies, id);
	if (nf) {
		om_del(&g->notifies, id);
		nt_destroy(nf);
	}
	vec *of = om_get(&g->spots_of, id);
	if (of)
		for (size_t i = 0; i < of->n; i++) ((gr_spot *)of->v[i])->watch = NULL;
	om_del(&g->ephemeral, id);
	void *owner = om_get(&g->owners, id);
	om_del(&g->owners, id);
	if (g->o.released) g->o.released(g->o.ctx, id, owner);
	loaded(g, id, cause);
}

// a node made, as the acting one: loaded, not yet placed
const gr_error *gr_make(gr_graph *g, const char *id, const nt_value *value, int has_value,
	const gr_acting *who, const char **out) {
	int64_t time = *g->clock + 1;
	const char *pid = id;
	if (!pid) {
		const char *base = g->o.id ? g->o.id(g->o.ctx, time) : NULL;
		if (!base) {
			char b[32];
			snprintf(b, sizeof b, "@%lld", (long long)time);
			base = gr_dup(g, b);
		}
		pid = base;
		for (int k = 1; om_get(&g->table, pid); k++) {
			size_t bn = strlen(base) + 24;
			char *b = amem(g, bn);
			snprintf(b, bn, "%s-%d", base, k);
			pid = b;
		}
	} else pid = gr_dup(g, pid);
	int64_t t = tick(g);
	gr_change *change = change_of(g, who, t, pid);
	nd_node *node = amem(g, sizeof *node);
	node->id = pid;
	if (has_value) {
		nd_version *v = amem(g, sizeof *v);
		*v = (nd_version){value, change, NULL};
		node->value = (nd_object){v, 1};
	}
	node->header.has_time = 1;
	node->header.time = t;
	node->header.actor = who->actor;
	node->header.reader = who->reader;
	node->header.cause = who->cause;
	const gr_error *e = intro_at(g, node, who, t);
	if (e) return e;
	*out = pid;
	return NULL;
}

// an ephemeral node, owned by owner if given
void gr_own(gr_graph *g, const char *id, void *owner) {
	id = gr_dup(g, id);
	om_set(g, &g->ephemeral, id, (void *)1);
	if (owner == NULL) return;
	om_set(g, &g->owners, id, owner);
	if (g->o.owned) g->o.owned(g->o.ctx, owner, id);
}

void gr_object_set(gr_graph *g, nd_node *n, gr_where where, const char *name,
	const nd_version *vs, size_t count) {
	nd_version *copy = amem(g, (count + 1) * sizeof *copy);
	if (count) memcpy(copy, vs, count * sizeof *copy);
	if (where == GR_VALUE) {
		n->value = (nd_object){copy, count};
		return;
	}
	nd_entry **es = where == GR_INFO ? &n->info : &n->children;
	size_t *len = where == GR_INFO ? &n->info_length : &n->children_length;
	size_t at = *len;
	for (size_t i = 0; i < *len; i++)
		if (!strcmp((*es)[i].name, name)) at = i;
	nd_entry *ne = amem(g, (*len + 1) * sizeof *ne);
	size_t m = 0;
	for (size_t i = 0; i < *len; i++) {
		if (i != at) ne[m++] = (*es)[i];
		else if (count) ne[m++] = (nd_entry){(*es)[i].name, {copy, count}};
	}
	if (at == *len && count) ne[m++] = (nd_entry){gr_dup(g, name), {copy, count}};
	*es = ne;
	*len = m;
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
	vpush(g, &g->trackers, r->track);
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

typedef struct {
	pr_ask *v;
	size_t n, cap;
} asks_t;

static void asks_add(gr_graph *g, asks_t *a, pr_ask x) {
	if (a->n == a->cap) {
		size_t cap = a->cap ? a->cap * 2 : 8;
		pr_ask *nv = pr_alloc(&g->pra, cap * sizeof *nv);
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
	pr_push(&g->pra, &l, pr_lit(o.kind));
	pr_push(&g->pra, &l, pr_lit(o.name));
	return l;
}
static pr_ask read_ask(gr_graph *g, const char *node, obj o) {
	pr_value args = pr_map();
	pr_put(&g->pra, &args, "node", pr_lit(node));
	pr_put(&g->pra, &args, "object", obj_pr(g, o));
	return (pr_ask){"read", args};
}
// every object of a node read
static pr_asks node_reads(gr_graph *g, const nd_node *n) {
	const char **info = pr_alloc(&g->pra, (n->info_length + 1) * sizeof *info);
	const char **ch = pr_alloc(&g->pra, (n->children_length + 1) * sizeof *ch);
	for (size_t k = 0; k < n->info_length; k++) info[k] = n->info[k].name;
	for (size_t k = 0; k < n->children_length; k++) ch[k] = n->children[k].name;
	return pr_read_asks(&g->pra, n->id, n->value.length ? 1 : 0, info, n->info_length, ch,
		n->children_length);
}
static pr_asks route_asks(gr_graph *g, const pl_step *route, size_t n) {
	pr_step *st = pr_alloc(&g->pra, (n ? n : 1) * sizeof *st);
	for (size_t i = 0; i < n; i++) st[i] = (pr_step){route[i].node, route[i].name};
	return pr_pass(&g->pra, st, n);
}

static pr_answer ask(gr_graph *g, const pr_value *actor, const pr_ask *asks, size_t n,
	const pl_depend *d) {
	if (g->may.fn == pr_anyone.fn) return (pr_answer){PR_YES, {0}};
	policy p = {g, d};
	pr_read rd = {policy_get, &p};
	return pr_check(&g->may, &g->pra, actor, asks, n, &rd).answer;
}

static const gr_error *allowed(gr_graph *g, pr_answer a, const char *op) {
	if (a.kind == PR_YES) return NULL;
	pr_value *why = pr_alloc(&g->pra, sizeof *why);
	if (a.kind == PR_NO) *why = a.why;
	else {
		*why = pr_map();
		pr_put(&g->pra, why, "code", pr_lit("pending"));
	}
	const pr_value *code = pr_get(why, "code");
	const char *c = code && code->kind == PR_STR ? code->str : "";
	size_t mn = strlen(op) + strlen(c) + 3;
	char *m = amem(g, mn);
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
	out->items = amem(g, (in->n ? in->n : 1) * sizeof *out->items);
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
			pr_value *w = pr_alloc(&g->pra, sizeof *w);
			*w = a.why;
			o->refused = w;
		}
	}
}

static pr_value ids_pr(gr_graph *g, const nd_list *l) {
	pr_value out = pr_list();
	if (l)
		for (size_t i = 0; i < l->length; i++)
			if (l->items[i].id) pr_push(&g->pra, &out, pr_lit(l->items[i].id));
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
	pr_push(&g->pra, &l, pr_num((double)sp->from));
	pr_push(&g->pra, &l, pr_num((double)sp->to));
	return l;
}

// placing an id: and reading it, where its node is loaded (reads: for the ids placed)
static asks_t placing_asks(gr_graph *g, const char *node, const char *name, pr_value before,
	pr_value after, int reads) {
	asks_t out = {0};
	pr_asks placing = pr_placing(&g->pra, node, name, &before, &after);
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
		return gerr(a->g, "stopped", gr_dup(a->g, m));
	}
	return NULL;
}

enum { R_LOOK, R_LOOKUP, R_LOOKUPS, R_CHILDREN, R_CONTENT, R_INFO };

static pl_spot place_of(const gr_api *a) {
	return (pl_spot){a->b.place, a->b.nplace, 0, NULL, 0};
}

static const gr_error *do_read(gr_api *a, int op, const char *const *address, size_t n,
	const char *name, gr_items *items, pl_namelist *names) {
	gr_graph *g = a->g;
	const gr_error *e = live_check(a, "read");
	if (e) return e;
	static const char *const empty[1] = {NULL};
	if (!address) address = empty;
	const pl_depend *d = a->b.depend;
	pl_spot at = place_of(a);
	pl_items pit = {0};
	int code = PL_OK;
	obj object = NO_OBJ;
	switch (op) {
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
	default:
		if (name) {
			code = pl_children(&g->places, &at, address, n, name, d, &pit);
			break;
		}
		// names: of each node the actor may reach and list
		code = pl_look(&g->places, &at, address, n, d, &pit);
		if (code) return pl_error(g, code);
		gr_items gi;
		guard(g, a->b.agent, &pit, d, NO_OBJ, &gi);
		vec seen = {0};
		for (size_t i = 0; i < gi.n; i++) {
			const pl_item *it = &gi.items[i].it;
			if (!it->node) continue;
			pr_ask la = pr_list_ask(&g->pra, it->id);
			if (ask(g, a->b.agent, &la, 1, d).kind != PR_YES) continue;
			depend(d, it->id, PL_CHILDREN, NULL);
			for (size_t k = 0; k < it->node->children_length; k++)
				sadd(g, &seen, it->node->children[k].name);
		}
		names->n = seen.n;
		names->names = (const char *const *)(void *)seen.v;
		return NULL;
	}
	if (code) return pl_error(g, code);
	guard(g, a->b.agent, &pit, d, object, items);
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
} wop;

// patches to the version from of one object of n; the versions from to to replaced by what they
// make, at from: one change. no versions: slots 0 makes the first
static const gr_error *edit_object(gr_graph *g, nd_node *n, gr_where w, const char *name,
	const pl_span *slots, const nt_patch *patches, size_t np, const gr_change **change,
	target *tg, int span_slot) {
	const nd_entry *entry = NULL;
	nd_object cur = {0};
	if (w == GR_VALUE) cur = n->value;
	else {
		for (size_t i = 0; i < n->info_length; i++)
			if (!strcmp(n->info[i].name, name)) entry = &n->info[i];
		if (entry) cur = entry->object;
	}
	long from = slots ? slots->from : 0, to = slots ? slots->to : 1;
	size_t len = cur.length;
	int ok = len == 0 ? (from == 0 && to <= 1) : (from < to && (size_t)to <= len);
	if (!ok || from < 0) return pl_error(g, PL_RANGE);
	nd_version base[1];
	size_t nbase = len ? 1 : 0;
	if (nbase) base[0] = cur.versions[from];
	nd_node scratch = {0};
	scratch.id = n->id;
	nd_entry se[1];
	if (w == GR_VALUE) scratch.value = (nd_object){nbase ? base : NULL, nbase};
	else if (nbase) {
		se[0] = (nd_entry){name, {base, 1}};
		scratch.info = se;
		scratch.info_length = 1;
	}
	const gr_change *ch = gr_by(g, n->id);
	mu_alloc al = {places_alloc, g};
	size_t failed = 0;
	heard_t heard = {g, w, name, from, NULL, NULL, 0, 0};
	mu_patched hook = {hear, &heard};
	int code = mu_mutate(&scratch, (mu_which){w == GR_VALUE ? MU_VALUE : MU_INFO, name}, patches, np,
		ch, &al, tg && g->cur->hearing ? &hook : NULL, &failed);
	if (code) return mu_error(g, code);
	nd_object made = {0};
	if (w == GR_VALUE) made = scratch.value;
	else
		for (size_t i = 0; i < scratch.info_length; i++)
			if (!strcmp(scratch.info[i].name, name)) made = scratch.info[i].object;
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
	size_t after = len > (size_t)to ? len - (size_t)to : 0;
	size_t total = (size_t)from + made.length + after;
	nd_version *vs = amem(g, (total ? total : 1) * sizeof *vs);
	if (from) memcpy(vs, cur.versions, (size_t)from * sizeof *vs);
	if (made.length) memcpy(vs + from, made.versions, made.length * sizeof *vs);
	if (after) memcpy(vs + from + made.length, cur.versions + to, after * sizeof *vs);
	if (w == GR_VALUE) n->value = (nd_object){vs, total};
	else {
		// the entry set, or added, or gone
		size_t at = entry ? (size_t)(entry - n->info) : n->info_length;
		size_t cnt = n->info_length + (entry == NULL) - (total == 0);
		nd_entry *es = amem(g, (cnt ? cnt : 1) * sizeof *es);
		size_t m = 0;
		for (size_t j = 0; j < n->info_length; j++) {
			if (j != at) es[m++] = n->info[j];
			else if (total) es[m++] = (nd_entry){n->info[j].name, {vs, total}};
		}
		if (!entry && total) es[m++] = (nd_entry){gr_dup(g, name), {vs, total}};
		n->info = es;
		n->info_length = m;
	}
	*change = ch;
	return NULL;
}

// the item the index-th look gives, default its first loaded
static const gr_error *at_item(wop *o, nd_node **out) {
	gr_graph *g = o->g;
	pl_items items;
	int code = pl_look(&g->places, &o->at, o->address, o->n, NULL, &items);
	if (code) return pl_error(g, code);
	const pl_item *it = NULL;
	if (!o->index) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else {
		if (*o->index < 0 || (size_t)*o->index >= items.n) return pl_error(g, PL_RANGE);
		it = &items.items[*o->index];
	}
	if (!it || !it->node) return pl_error(g, PL_NOTHING_THERE);
	*out = (nd_node *)it->node;
	return NULL;
}

static target *chg_target(gr_graph *g, const char *id, gr_where w, const char *name, size_t hdr) {
	chg *c = g->cur;
	target *t = amem(g, sizeof *t);
	t->id = id;
	t->w = w;
	t->name = name;
	t->hdr = hdr;
	nd_node *n = om_get(&g->table, id);
	t->old_len = n ? object_len(n, w, name) : 0;
	vpush(g, &c->targets, t);
	return t;
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
	for (size_t i = 0; i < nch && i < 2; i++) o->times[i] = ((const gr_change *)changes[i])->time;
	return NULL;
}

// the strings placing keeps are the graph's own
static wop wop_new(gr_graph *g, int op) {
	wop o = {0};
	o.g = g;
	o.op = op;
	return o;
}

// in a changing, at place [], asked nothing
const gr_error *gr_do_write(gr_graph *g, const char *const *address, size_t n,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(g, W_WRITE);
	o.address = address, o.n = n, o.patches = patches, o.np = np, o.index = index, o.slot = slotindex, o.span_slot = span;
	const gr_error *e = wop_exec(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_set(gr_graph *g, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	wop o = wop_new(g, W_SET);
	o.address = address, o.n = n, o.name = gr_dup(g, name), o.patches = patches, o.np = np;
	o.index = index, o.slot = slotindex, o.span_slot = span;
	const gr_error *e = wop_exec(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_insert(gr_graph *g, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time) {
	wop o = wop_new(g, W_INSERT);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.child = gr_dup(g, child);
	o.ispan = index, o.slot = slotindex;
	const gr_error *e = wop_exec(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_remove(gr_graph *g, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	wop o = wop_new(g, W_REMOVE);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.span = index, o.slot = slotindex;
	const gr_error *e = wop_exec(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_pop(gr_graph *g, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	wop o = wop_new(g, W_POP);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.span = slotindex;
	const gr_error *e = wop_exec(&o);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_do_rename(gr_graph *g, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	wop o = wop_new(g, W_RENAME);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.to = gr_dup(g, to);
	const gr_error *e = wop_exec(&o);
	if (!e) times[0] = o.times[0], times[1] = o.times[1];
	return e;
}
const gr_error *gr_do_move(gr_graph *g, const char *id, const char *name, long index,
	const char *toid, const char *toname, const long *toindex, int64_t times[2], size_t *ntimes) {
	wop o = wop_new(g, W_MOVE);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.mindex = index;
	o.toid = gr_dup(g, toid), o.toname = gr_dup(g, toname), o.toindex = toindex;
	const gr_error *e = wop_exec(&o);
	if (!e) times[0] = o.times[0], times[1] = o.times[1], *ntimes = o.ntimes;
	return e;
}

// what the interface acts as
static gr_acting who_of(gr_api *a) {
	gr_acting w = {a->b.agent, a->b.reader, a->b.cause, NULL};
	if (a->b.site && a->g->o.site) w.site = a->g->o.site(a->g->o.ctx);
	return w;
}

// a write: stopped, read only, asked, then the changes made and told
static const gr_error *w_do(gr_api *a, wop *o, asks_t *asks, const gr_snap *snap, size_t nsnap) {
	gr_graph *g = a->g;
	const gr_error *e = live_check(a, WOPS[o->op]);
	if (e) return e;
	if (!a->b.writes) {
		char m[64];
		snprintf(m, sizeof m, "%s: a compute only reads", WOPS[o->op]);
		return gerr(g, "read-only", gr_dup(g, m));
	}
	if (asks) {
		e = allowed(g, ask(g, a->b.agent, asks->v, asks->n, NULL), WOPS[o->op]);
		if (e) return e;
	}
	gr_acting who = who_of(a);
	gr_changing_opts co = {0};
	co.tag = a->b.tag;
	co.wrote = a->b.wrote;
	if (snap) co.has_snap = 1, co.snap = snap, co.nsnap = nsnap;
	return gr_changing(g, &who, &co, wop_exec, o);
}

// what reaching a node to write it asks: passing its route, then the edit
static asks_t writing_asks(gr_api *a, const char *const *address, size_t n, const long *index,
	obj object, const pl_span *slot) {
	gr_graph *g = a->g;
	asks_t out = {0};
	pl_spot at = place_of(a);
	pl_items items;
	if (pl_look(&g->places, &at, address, n, NULL, &items) != PL_OK) return out;
	const pl_item *it = NULL;
	if (!index) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else if (*index >= 0 && (size_t)*index < items.n) it = &items.items[*index];
	if (!it || !it->node) return out;
	asks_addall(g, &out, route_asks(g, it->route, it->nroute));
	pr_value ov = obj_pr(g, object), av = at_pr(g, slot);
	asks_add(g, &out, pr_edit(&g->pra, "write", it->id, &ov, &av));
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
	o.address = address, o.n = n, o.name = gr_dup(a->g, name), o.patches = patches, o.np = np;
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
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.child = gr_dup(g, child);
	o.ispan = index, o.slot = slotindex;
	// a number is a gap: nothing replaced; a span: the ids there
	nd_list gone = {NULL, 0};
	if (index && index->from != index->to)
		gone = slice_of(ids_at(g, id, name, slotindex), index->from, index->to);
	nd_item it = {o.child, NULL};
	nd_list after = {&it, 1};
	asks_t as = placing_asks(g, id, name, ids_pr(g, &gone), ids_pr(g, &after), 1);
	e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_remove(gr_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_REMOVE);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.span = index, o.slot = slotindex;
	nd_list gone = slice_of(ids_at(g, id, name, slotindex), index.from, index.to);
	asks_t as = placing_asks(g, id, name, ids_pr(g, &gone), pr_list(), 0);
	const gr_error *e = w_do(a, &o, &as, NULL, 0);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_pop(gr_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_POP);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.span = slotindex;
	asks_t as = {0};
	pr_value ov = obj_pr(g, (obj){"children", o.name}), av = at_pr(g, &slotindex);
	asks_add(g, &as, pr_edit(&g->pra, "pop", o.id, &ov, &av));
	gr_snap snap[1] = {{o.id, GR_CHILDREN, o.name}};
	const gr_error *e = w_do(a, &o, &as, snap, 1);
	if (!e && time) *time = o.times[0];
	return e;
}
const gr_error *gr_rename(gr_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	gr_graph *g = a->g;
	wop o = wop_new(g, W_RENAME);
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.to = gr_dup(g, to);
	const nd_list *ids = ids_at(g, id, name, NULL);
	asks_t as = placing_asks(g, id, name, ids_pr(g, ids), pr_list(), 0);
	asks_t b = placing_asks(g, id, o.to, pr_list(), ids_pr(g, ids), 1);
	for (size_t i = 0; i < b.n; i++) asks_add(g, &as, b.v[i]);
	gr_snap snap[2] = {{o.id, GR_CHILDREN, o.name}, {o.id, GR_CHILDREN, o.to}};
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
	o.id = gr_dup(g, id), o.name = gr_dup(g, name), o.mindex = index;
	o.toid = gr_dup(g, toid), o.toname = gr_dup(g, toname), o.toindex = toindex;
	asks_t as = {0};
	if (across) {
		nd_item it = {child, NULL};
		nd_list one = {&it, child ? 1 : 0};
		asks_t x = placing_asks(g, id, name, ids_pr(g, &one), pr_list(), 0);
		asks_t y = placing_asks(g, toid, toname, pr_list(), ids_pr(g, &one), 1);
		for (size_t i = 0; i < x.n; i++) asks_add(g, &as, x.v[i]);
		for (size_t i = 0; i < y.n; i++) asks_add(g, &as, y.v[i]);
	}
	e = w_do(a, &o, &as, NULL, 0);
	if (!e) times[0] = o.times[0], times[1] = o.times[1], *ntimes = o.ntimes;
	return e;
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
	e = gr_make(g, id, value, has_value, &who, out);
	if (e) return e;
	if (ephemeral) gr_own(g, *out, a->b.owner);
	return NULL;
}

gr_api *gr_bound(gr_graph *g, const gr_bind *b) {
	gr_api *a = amem(g, sizeof *a);
	a->g = g;
	a->b = *b;
	const char **place = amem(g, (b->nplace + 1) * sizeof *place);
	for (size_t i = 0; i < b->nplace; i++) place[i] = gr_dup(g, b->place[i]);
	a->b.place = place;
	if (!a->b.agent) a->b.agent = g->host;
	return a;
}

// the graph

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
		om_set(g, &g->table, g->root, n);
	}
	return g;
}

void gr_free(gr_graph *g) {
	if (!g) return;
	for (size_t i = 0; i < g->trackers.n; i++) tg_untrack(g->trackers.v[i], NULL);
	for (size_t i = 0; i < g->trackers.n; i++) tg_node_free(g->trackers.v[i]);
	for (size_t i = 0; i < g->notifies.n; i++)
		if (g->notifies.e[i].key) nt_destroy(g->notifies.e[i].val);
	pr_free(&g->pra);
	afree(&g->a);
	free(g);
}
