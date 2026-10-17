// Patch nodes (patch.h).
#include "patch.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static void *alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *copy(const char *s) { return strcpy(alloc(strlen(s) + 1), s); }

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// patches from a patch node's list -------------------------------------------------------------

// op's patches, read from a list of {path, range?, value?, move?}; anything malformed is a place no
// patch can be (a negative key: not-a-patch, as apply says). They point into the list
typedef struct {
	op_patch *patches;
	size_t n;
	void **mem;
	size_t nmem, capmem;
} parsed;

static const op_key bad_key = {.type = OP_NUM_KEY, .n = -1};

static int whole(const op_value *x, int64_t *out) {
	if (x->type != OP_NUM || !isfinite(x->num) || x->num != floor(x->num) || x->num < -1e15) return 0;
	*out = x->num > 1e15 ? INT64_MAX : (int64_t)x->num;
	return 1;
}
// a key's number: past what a long holds, the largest (or the smallest)
static int index_of(const op_value *x, long *out) {
	int64_t n;
	if (!whole(x, &n)) return 0;
	*out = n > LONG_MAX ? LONG_MAX : n < LONG_MIN ? LONG_MIN : (long)n;
	return 1;
}

static void place_of(parsed *ps, const op_value *m, op_target *p) {
	memset(p, 0, sizeof *p);
	const op_value *path = m && m->type == OP_MAP ? op_get(m, "path") : NULL;
	if (path == NULL || path->type != OP_LIST) goto bad;
	op_key *ks = alloc((path->count + 1) * sizeof *ks);
	PUSH(ps->mem, ps->nmem, ps->capmem, ks);
	for (size_t i = 0; i < path->count; i++) {
		const op_value *x = path->items[i];
		if (x->type == OP_STR) ks[i] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_NUM && index_of(x, &ks[i].n)) ks[i].type = OP_NUM_KEY;
		else goto bad;
	}
	p->path = ks;
	p->length = path->count;
	const op_value *r = op_get(m, "range");
	if (r != NULL) {
		if (r->type != OP_LIST || r->count != 2 || !whole(r->items[0], &p->from) ||
			!whole(r->items[1], &p->to)) goto bad;
		p->has_range = 1;
	}
	return;
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key;
	p->length = 1;
}

static parsed parse(const op_value *list) {
	parsed ps = {0};
	ps.n = list->count;
	ps.patches = alloc((ps.n + 1) * sizeof *ps.patches);
	for (size_t i = 0; i < ps.n; i++) {
		const op_value *m = list->items[i];
		op_patch *out = &ps.patches[i];
		place_of(&ps, m, &out->place);
		if (m->type != OP_MAP) continue;
		out->value = op_get(m, "value");
		out->has_value = out->value != NULL;
		const op_value *mv = op_get(m, "move");
		if (mv != NULL) {
			out->has_move = 1;
			place_of(&ps, mv, &out->move);
		}
	}
	return ps;
}

static void parsed_free(parsed *ps) {
	for (size_t i = 0; i < ps->nmem; i++) free(ps->mem[i]);
	free(ps->mem);
	free(ps->patches);
}

// what a patch node's value is over ----------------------------------------------------------------

typedef struct {
	const char *on, *part;
	const op_value *patches;
	const op_value *at;
} aim;

// what a value is over; not a patch node: 0
static int aim_of(const op_value *v, aim *out) {
	if (v == NULL || v->type != OP_MAP) return 0;
	const op_value *on = op_get(v, "on"), *part = op_get(v, "part"), *patches = op_get(v, "patches");
	if (on == NULL || on->type != OP_STR || part == NULL || part->type != OP_STR ||
		patches == NULL || patches->type != OP_LIST) return 0;
	*out = (aim){on->str, part->str, patches, op_get(v, "at")};
	return 1;
}

// spots: the paths a key's patch nodes aim at ----------------------------------------------------

// a path, copied: its string keys too
typedef struct {
	op_key *keys;
	size_t n;
	char **strs;
} spot;

typedef struct {
	spot *v;
	size_t n, cap;
} spots;

static spot spot_copy(const op_key *k, size_t n) {
	spot s = {alloc((n + 1) * sizeof *s.keys), n, alloc((n + 1) * sizeof *s.strs)};
	for (size_t i = 0; i < n; i++) {
		s.keys[i] = k[i];
		if (k[i].type == OP_STR_KEY) s.keys[i].s = s.strs[i] = copy(k[i].s);
	}
	return s;
}

static void spot_free(spot *s) {
	for (size_t i = 0; i < s->n; i++) free(s->strs[i]);
	free(s->keys), free(s->strs);
}

static void spots_free(spots *v) {
	for (size_t i = 0; i < v->n; i++) spot_free(&v->v[i]);
	free(v->v);
	*v = (spots){0};
}

static int key_eq(const op_key *a, const op_key *b) {
	if (a->type != b->type) return 0;
	switch (a->type) {
	case OP_NUM_KEY: return a->n == b->n;
	case OP_STR_KEY: return strcmp(a->s, b->s) == 0;
	default: return a->a == b->a && a->b == b->b;
	}
}

// a is b, or a step above it
static int above(const op_key *a, size_t an, const op_key *b, size_t bn) {
	if (an > bn) return 0;
	for (size_t i = 0; i < an; i++) {
		if (!key_eq(&a[i], &b[i])) return 0;
	}
	return 1;
}

static int spot_same(const spot *a, const op_key *b, size_t bn) {
	return a->n == bn && above(a->keys, a->n, b, bn);
}

// each once
static void spots_add(spots *v, const op_key *k, size_t n) {
	for (size_t i = 0; i < v->n; i++) {
		if (spot_same(&v->v[i], k, n)) return;
	}
	PUSH(v->v, v->n, v->cap, spot_copy(k, n));
}

// where a patch's place changes things: its path; a taking out at a list's number with no range (or
// a move from there) shifts the rest of the list, so the list's
static size_t spot_len(const op_target *t, int put) {
	size_t n = t->length;
	if (!t->has_range && !put && n > 0 && t->path[n - 1].type == OP_NUM_KEY) n--;
	return n;
}

// the spots of some patches: their paths and the paths they move from
static void spots_of(spots *out, const parsed *p) {
	for (size_t i = 0; i < p->n; i++) {
		const op_patch *pa = &p->patches[i];
		if (pa->place.path == &bad_key) continue;
		spots_add(out, pa->place.path, spot_len(&pa->place, pa->has_move || pa->has_value));
		if (pa->has_move && pa->move.path != &bad_key) {
			spots_add(out, pa->move.path, spot_len(&pa->move, 0));
		}
	}
}

// telling: what changed at the spots ---------------------------------------------------------------

// the same value, as ===: a number, string, bool or null by what it is, anything else by identity
static int ident(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return !a->bool_ == !b->bool_;
	case OP_NUM: return a->num == b->num;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	default: return 0;
	}
}

// how many steps of s: s, or the step above it nearest, where a patch putting what now has there
// applies to before: a name into a map both have (one taken out: before has it), a number into a list
// both have it in. 0: none (the whole value)
static size_t fit(const op_value *before, const op_value *now, const op_key *s, size_t n) {
	op_value sa, sb;
	for (size_t k = n; k > 0; k--) {
		const op_value *a = pl_at(before, s, k - 1, &sa), *b = pl_at(now, s, k - 1, &sb);
		const op_key *key = &s[k - 1];
		if (a == NULL || b == NULL) continue;
		if (key->type == OP_STR_KEY) {
			if (a->type == OP_MAP && b->type == OP_MAP && (op_get(b, key->s) || op_get(a, key->s))) return k;
		} else if (key->type == OP_NUM_KEY) {
			if (a->type == OP_LIST && b->type == OP_LIST && key->n < (long)a->count &&
				key->n < (long)b->count) return k;
		}
	}
	return 0;
}

// s with one more step, or just its first n
static void out_add(spots *out, const op_key *s, size_t n, const op_key *more) {
	op_key *k = alloc((n + 1) * sizeof *k);
	memcpy(k, s, n * sizeof *k);
	if (more) k[n] = *more;
	PUSH(out->v, out->n, out->cap, spot_copy(k, n + (more != NULL)));
	free(k);
}

// a list of the same length, or a map of the same names: what differs in it, one step down; else
// what is there put at fit's spot
static void diff(spots *out, const op_value *before, const op_value *now, const op_value *a,
	const op_value *b, const op_key *s, size_t n) {
	if (ident(a, b)) return;
	if (a && b && a->type == OP_LIST && b->type == OP_LIST && a->count == b->count) {
		for (size_t i = 0; i < a->count; i++) {
			if (!ident(a->items[i], b->items[i])) {
				op_key k = {.type = OP_NUM_KEY, .n = (long)i};
				out_add(out, s, n, &k);
			}
		}
		return;
	}
	if (a && b && a->type == OP_MAP && b->type == OP_MAP && a->count == b->count) {
		int names = 1;
		for (size_t i = 0; i < a->count && names; i++) names = op_get(b, a->keys[i]) != NULL;
		if (names) {
			for (size_t i = 0; i < a->count; i++) {
				if (ident(a->items[i], op_get(b, a->keys[i]))) continue;
				op_key k = {.type = OP_STR_KEY, .s = a->keys[i]};
				out_add(out, s, n, &k);
			}
			return;
		}
	}
	out_add(out, s, fit(before, now, s, n), NULL);
}

static int touched(const spot *s, const op_patch *written, size_t nw) {
	for (size_t i = 0; i < nw; i++) {
		const op_patch *w = &written[i];
		if (above(w->place.path, w->place.length, s->keys, s->n) ||
			above(s->keys, s->n, w->place.path, w->place.length)) return 1;
		if (w->has_move && (above(w->move.path, w->move.length, s->keys, s->n) ||
			above(s->keys, s->n, w->move.path, w->move.length))) return 1;
	}
	return 0;
}

// the places turning before into now where they can differ: at each spot, where what is there is
// not the same (at fit's spot), or a written patch touched it (at the spot itself, both having it:
// the write, in the table's coordinates, is put right for a watch); one under another left out. The
// caller's, spots_free
static spots fixes(const op_value *before, const op_value *now, const spot *at, size_t nat,
	const op_patch *written, size_t nw) {
	spots out = {0};
	op_value sa, sb;
	for (size_t i = 0; i < nat; i++) {
		const spot *s = &at[i];
		if (touched(s, written, nw) && fit(before, now, s->keys, s->n) == s->n) {
			out_add(&out, s->keys, s->n, NULL);
		} else {
			diff(&out, before, now, pl_at(before, s->keys, s->n, &sa), pl_at(now, s->keys, s->n, &sb),
				s->keys, s->n);
		}
	}
	// shortest first, then each one not under a kept one
	for (size_t i = 1; i < out.n; i++) {
		spot x = out.v[i];
		size_t j = i;
		for (; j > 0 && out.v[j - 1].n > x.n; j--) out.v[j] = out.v[j - 1];
		out.v[j] = x;
	}
	size_t kept = 0;
	for (size_t i = 0; i < out.n; i++) {
		int under = 0;
		for (size_t k = 0; k < kept && !under; k++) {
			under = above(out.v[k].keys, out.v[k].n, out.v[i].keys, out.v[i].n);
		}
		if (under) spot_free(&out.v[i]);
		else out.v[kept++] = out.v[i];
	}
	out.n = kept;
	return out;
}

// the overlay ------------------------------------------------------------------------------------

// a patch node, and what it is over, as indexed; in the order they came
typedef struct {
	char *id, *on, *part;
} target;

// an entry made for (part, id), and what it holds
typedef struct {
	char *part, *id;
	nd_entry *entry;
	ch_entry *meta;
	op_value *pair;
	pn_item *items;
	size_t nitems;
	// the ids the items name, and the values they were made with (one hold each)
	char **names;
	size_t nnames;
	op_value **held;
	size_t nheld;
	// the paths its patch nodes' patches aim at and move from
	spot *spots;
	size_t nspots;
} made;

// what was last said to places of a key: its entry, with the fixes as its change's op; the values
// they hold are held here, good until the key's next change
typedef struct {
	char *part, *id;
	nd_entry *entry;
	op_patch *patches, *undo;
	spot *spots;
	size_t nspots;
	op_value **held;
	size_t nheld, capheld;
} told;

static void told_free(told *t) {
	nd_free_entry(t->entry);
	free(t->patches), free(t->undo);
	for (size_t i = 0; i < t->nspots; i++) spot_free(&t->spots[i]);
	free(t->spots);
	for (size_t i = 0; i < t->nheld; i++) op_free(t->held[i]);
	free(t->held);
	free(t->part), free(t->id);
}

typedef struct {
	parsed ps;
	op_value *hold;
} landed;

struct pn {
	tb_table *table, *view;
	pl *places;
	target *targets;
	size_t ntargets, captargets;
	made **mades;
	size_t nmades, capmades;
	pn_item base_item;
	landed *lands;
	size_t nlands, caplands;
	told *tolds;
	size_t ntolds, captolds;
	// the view's entry is being swapped by the overlay: places is told nothing of it
	int quiet;
};

pn *pn_new(void) { return alloc(sizeof(pn)); }

void pn_connect(pn *o, tb_table *table, tb_table *view, pl *places) {
	o->table = table;
	o->view = view;
	o->places = places;
}

static void made_free(made *m) {
	nd_free_entry(m->entry);
	op_free(m->pair);
	free(m->meta);
	free(m->items);
	for (size_t i = 0; i < m->nnames; i++) free(m->names[i]);
	free(m->names);
	for (size_t i = 0; i < m->nheld; i++) op_free(m->held[i]);
	free(m->held);
	for (size_t i = 0; i < m->nspots; i++) spot_free(&m->spots[i]);
	free(m->spots);
	free(m->part);
	free(m->id);
	free(m);
}

void pn_free(pn *o) {
	for (size_t i = 0; i < o->nmades; i++) made_free(o->mades[i]);
	for (size_t i = 0; i < o->ntargets; i++) {
		free(o->targets[i].id), free(o->targets[i].on), free(o->targets[i].part);
	}
	for (size_t i = 0; i < o->nlands; i++) {
		parsed_free(&o->lands[i].ps);
		op_free(o->lands[i].hold);
	}
	for (size_t i = 0; i < o->ntolds; i++) told_free(&o->tolds[i]);
	free(o->tolds);
	free(o->mades), free(o->targets), free(o->lands);
	free(o);
}

static long find_made(const pn *o, const char *part, const char *id) {
	for (size_t i = 0; i < o->nmades; i++) {
		if (strcmp(o->mades[i]->part, part) == 0 && strcmp(o->mades[i]->id, id) == 0) return (long)i;
	}
	return -1;
}

// the patch nodes over part of id, in the order they came; the caller frees the array (ids borrowed)
static const char **over(const pn *o, const char *id, const char *part, size_t *n) {
	const char **out = alloc((o->ntargets + 1) * sizeof *out);
	*n = 0;
	for (size_t i = 0; i < o->ntargets; i++) {
		const target *t = &o->targets[i];
		if (strcmp(t->on, id) == 0 && strcmp(t->part, part) == 0) out[(*n)++] = t->id;
	}
	return out;
}

// the table's entry under (part, id), each patch node in ps applied over it in order
static made *make(pn *o, const char *part, const char *id, const char *const *ps, size_t nps) {
	nd_entry *base = tb_get(o->table, tb_string(part), tb_string(id));
	made *m = alloc(sizeof *m);
	m->part = copy(part);
	m->id = copy(id);
	m->items = alloc((nps + 1) * sizeof *m->items);
	m->names = alloc((nps + 1) * sizeof *m->names);
	m->held = alloc((nps + 1) * sizeof *m->held);
	op_value *list = op_list();
	const op_value *value = base ? base->value : NULL;
	spots at = {0};
	for (size_t i = 0; i < nps; i++) {
		nd_entry *node = tb_get(o->table, tb_string("patch"), tb_string(ps[i]));
		aim a;
		if (node == NULL || !aim_of(node->value, &a)) continue;
		int stale = base != NULL && a.at != NULL && a.at->type == OP_NUM &&
			(double)base->change.time > a.at->num;
		parsed p = parse(a.patches);
		spots_of(&at, &p);
		op_value *out = NULL;
		size_t failed;
		int code = op_apply(value, p.patches, p.n, NULL, &out, &failed);
		parsed_free(&p);
		char *name = copy(ps[i]);
		m->names[m->nnames++] = name;
		if (code == OP_OK) {
			value = out;
			if (out != NULL) m->held[m->nheld++] = out;
			op_push(list, op_str(ps[i]));
			m->items[m->nitems++] = (pn_item){value, name, stale, NULL};
		} else {
			m->items[m->nitems++] = (pn_item){value, name, stale, op_code_name(code)};
		}
	}
	// front first
	for (size_t i = 0, j = m->nitems; i + 1 < j; i++, j--) {
		pn_item t = m->items[i];
		m->items[i] = m->items[j - 1];
		m->items[j - 1] = t;
	}
	if (base != NULL) m->items[m->nitems++] = (pn_item){base->value, PN_TABLE, 0, NULL};
	m->pair = list;
	m->spots = at.v, m->nspots = at.n;
	// the change: the table's, its op left out, ["overlay", the patch nodes applied] after its metadata
	ch_header h = {0};
	size_t nmeta = 0;
	if (base == NULL) {
		h.has_time = 1;
	} else {
		h = base->change;
		h.has_op = 0, h.patches = NULL, h.patches_length = 0, h.undo = NULL, h.undo_length = 0;
		nmeta = h.metadata_length;
	}
	m->meta = alloc((nmeta + 1) * sizeof *m->meta);
	for (size_t i = 0; i < nmeta; i++) m->meta[i] = h.metadata[i];
	m->meta[nmeta] = (ch_entry){"overlay", m->pair};
	h.metadata = m->meta;
	h.metadata_length = nmeta + 1;
	m->entry = nd_make_entry((op_value *)value, &h, NULL);
	return m;
}

void pn_view_event(void *ctx, tb_key part, tb_key id) {
	pn *o = ctx;
	if (!o->quiet) pl_event(o->places, part, id);
}

// the view's entry under (part, id) set; quiet: places is told nothing of it
static void put_view(pn *o, const char *part, const char *id, nd_entry *e, int quiet) {
	o->quiet = quiet;
	if (e == NULL) tb_del(o->view, tb_string(part), tb_string(id));
	else tb_sub(o->view, tb_string(part), tb_string(id), e);
	o->quiet = 0;
}

static told *find_told(pn *o, const char *part, const char *id) {
	for (size_t i = 0; i < o->ntolds; i++) {
		if (strcmp(o->tolds[i].part, part) == 0 && strcmp(o->tolds[i].id, id) == 0) return &o->tolds[i];
	}
	return NULL;
}

// a value held by t: one more hold of v (a typed array's element, a number made)
static const op_value *hold(told *t, const op_value *v, const op_value *scratch) {
	if (v == NULL) return NULL;
	op_value *h = v == scratch ? op_num(v->num) : op_ref((op_value *)v);
	PUSH(t->held, t->nheld, t->capheld, h);
	return h;
}

// what places is told of (part, id): one change of it, its op the fixes (turning what was there
// before into now), undone by what was there before at each. The entry is under the key in the view
// for the call, as places' commit finds keys by it
static void tell(pn *o, const char *part, const char *id, const op_value *before, nd_entry *now,
	spots *fix) {
	told *t = find_told(o, part, id);
	if (t != NULL) {
		told_free(t);
		*t = (told){0};
	} else {
		PUSH(o->tolds, o->ntolds, o->captolds, (told){0});
		t = &o->tolds[o->ntolds - 1];
	}
	t->part = copy(part), t->id = copy(id);
	t->patches = alloc((fix->n + 1) * sizeof *t->patches);
	t->undo = alloc((fix->n + 1) * sizeof *t->undo);
	op_value sa, sb;
	for (size_t i = 0; i < fix->n; i++) {
		const spot *s = &fix->v[i];
		const op_value *put = hold(t, pl_at(now ? now->value : NULL, s->keys, s->n, &sa), &sa);
		const op_value *was = hold(t, pl_at(before, s->keys, s->n, &sb), &sb);
		op_target place = {.path = s->keys, .length = s->n};
		t->patches[i] = (op_patch){.place = place, .has_value = put != NULL, .value = put};
		t->undo[i] = (op_patch){.place = place, .has_value = was != NULL, .value = was};
	}
	t->spots = fix->v, t->nspots = fix->n;
	*fix = (spots){0};
	ch_header h = {.has_time = 1};
	if (now != NULL) h = now->change;
	h.has_op = 1;
	h.patches = t->patches, h.patches_length = t->nspots;
	h.undo = t->undo, h.undo_length = t->nspots;
	t->entry = nd_make_entry(now ? now->value : NULL, &h, NULL);
	nd_entry *real = tb_get(o->view, tb_string(part), tb_string(id));
	put_view(o, part, id, t->entry, 1);
	pl_changed changed = {1, {t->entry}};
	pl_commit(o->places, &changed);
	put_view(o, part, id, real, 1);
}

// the view's entry under (part, id) made as it should be now: the table's, or made from it and
// the patch nodes over it. whole: a change of the view is an event of places' own, the whole key.
// else it is made again quietly, and places told what changed from what readers had (the value in
// the view, and the old made's spots, with the new made's), at those spots; written: the patches of
// a write to the table's entry, said already (places' commit), so one with nothing to fix tells
// nothing more
static void sync(pn *o, const char *part, const char *id, int whole, const op_patch *written,
	size_t nwritten) {
	size_t nps;
	const char **ps = over(o, id, part, &nps);
	long at = find_made(o, part, id);
	made *old = at >= 0 ? o->mades[at] : NULL;
	nd_entry *want;
	made *now = NULL;
	if (nps == 0) {
		want = tb_get(o->table, tb_string(part), tb_string(id));
	} else {
		now = make(o, part, id, ps, nps);
		want = now->entry;
	}
	free(ps);
	nd_entry *have = tb_get(o->view, tb_string(part), tb_string(id));
	spots fix = {0};
	const op_value *before = have ? have->value : NULL;
	int say = 0;
	if (whole) {
		if (want != have) put_view(o, part, id, want, 0);
	} else {
		size_t n = (old ? old->nspots : 0) + (now ? now->nspots : 0);
		spot *all = alloc((n + 1) * sizeof *all);
		n = 0;
		for (size_t i = 0; old && i < old->nspots; i++) all[n++] = old->spots[i];
		for (size_t i = 0; now && i < now->nspots; i++) all[n++] = now->spots[i];
		fix = fixes(before, want ? want->value : NULL, all, n, written, nwritten);
		free(all);
		say = fix.n || !nwritten;
		if (want != have) put_view(o, part, id, want, 1);
	}
	if (old != NULL) {
		if (now != NULL) o->mades[at] = now;
		else o->mades[at] = o->mades[--o->nmades];
	} else if (now != NULL) {
		PUSH(o->mades, o->nmades, o->capmades, now);
	}
	// the new made is what was seen: the values the fixes name stay held by the told entry
	if (!whole && say) tell(o, part, id, before, want, &fix);
	spots_free(&fix);
	if (old != NULL) made_free(old);
}

// a patch node's entry came, changed or went: indexed again, and the keys it was and is over told
static void reindex(pn *o, const char *p) {
	long at = -1;
	for (size_t i = 0; i < o->ntargets; i++) {
		if (strcmp(o->targets[i].id, p) == 0) at = (long)i;
	}
	nd_entry *node = tb_get(o->table, tb_string("patch"), tb_string(p));
	aim now;
	int is = node != NULL && aim_of(node->value, &now);
	int same = at >= 0 && is && strcmp(o->targets[at].on, now.on) == 0 &&
		strcmp(o->targets[at].part, now.part) == 0;
	char *won = NULL, *wpart = NULL;
	if (at >= 0) {
		won = copy(o->targets[at].on), wpart = copy(o->targets[at].part);
	}
	if (at >= 0 && !same) {
		free(o->targets[at].id), free(o->targets[at].on), free(o->targets[at].part);
		memmove(&o->targets[at], &o->targets[at + 1], (o->ntargets - (size_t)at - 1) * sizeof *o->targets);
		o->ntargets--;
	}
	char *non = NULL, *npart = NULL;
	if (is && !same) {
		non = copy(now.on), npart = copy(now.part);
		target t = {copy(p), copy(non), copy(npart)};
		PUSH(o->targets, o->ntargets, o->captargets, t);
	}
	if (won != NULL) sync(o, wpart, won, 0, NULL, 0);
	if (non != NULL) sync(o, npart, non, 0, NULL, 0);
	free(won), free(wpart), free(non), free(npart);
}

void pn_event(void *ctx, tb_key part, tb_key id) {
	pn *o = ctx;
	if (strcmp(part.string, "patch") == 0) reindex(o, id.string);
	sync(o, part.string, id.string, 1, NULL, 0);
}

void pn_commit(pn *o, const pl_changed *changed) {
	// places' commit finds an entry's keys by the view: where patch nodes are over a key, the view
	// holds what was made, so the written entry stands in its place for the call
	struct {
		const char *part, *id;
		nd_entry *held;
	} swapped[16];
	size_t nswap = 0;
	for (size_t i = 0; i < changed->n; i++) {
		nd_entry *e = changed->entries[i];
		if (!e->change.has_op) continue;
		size_t n;
		const tb_where *who = tb_who(o->table, e, &n);
		for (size_t k = 0; k < n && nswap < 16; k++) {
			const char *part = who[k].part.string, *id = who[k].id.string;
			if (strcmp(part, "patch") == 0) continue;
			size_t nps;
			free((void *)over(o, id, part, &nps));
			nd_entry *held = nps ? tb_get(o->view, who[k].part, who[k].id) : NULL;
			if (held == NULL || held == e) continue;
			swapped[nswap].part = part, swapped[nswap].id = id, swapped[nswap++].held = held;
			put_view(o, part, id, e, 1);
		}
	}
	pl_commit(o->places, changed);
	for (size_t i = 0; i < nswap; i++) put_view(o, swapped[i].part, swapped[i].id, swapped[i].held, 1);
	for (size_t i = 0; i < changed->n; i++) {
		const nd_entry *e = changed->entries[i];
		if (!e->change.has_op) continue;
		size_t n;
		const tb_where *who = tb_who(o->table, e, &n);
		// the table's scratch is good until its next change: nothing below changes it
		for (size_t k = 0; k < n; k++) {
			const char *part = who[k].part.string, *id = who[k].id.string;
			if (strcmp(part, "patch") == 0) {
				reindex(o, id);
			} else {
				size_t nps;
				free((void *)over(o, id, part, &nps));
				if (nps) sync(o, part, id, 0, e->change.patches, e->change.patches_length);
			}
		}
	}
}

// the layers of the entry under (part, id), front first, *n of them; none there: none. Untold
// (pn_entries tells)
static const pn_item *pn_layers(pn *o, tb_key part, tb_key id, size_t *n) {
	long at = find_made(o, part.string, id.string);
	if (at >= 0) return *n = o->mades[at]->nitems, o->mades[at]->items;
	nd_entry *base = tb_get(o->table, part, id);
	if (base == NULL) return *n = 0, NULL;
	o->base_item = (pn_item){base->value, PN_TABLE, 0, NULL};
	return *n = 1, &o->base_item;
}

pn_items pn_entries(pn *o, tb_key part, tb_key id, const op_key *path, size_t n) {
	pl_read(o->places, part, id, path, n);
	size_t count;
	const pn_item *layers = pn_layers(o, part, id, &count);
	pn_items out = {count, alloc((count + 1) * sizeof(pn_item))};
	for (size_t i = 0; i < count; i++) {
		out.items[i] = layers[i];
		out.items[i].value = layers[i].value ? pl_at(layers[i].value, path, n, NULL) : NULL;
	}
	return out;
}

void pn_items_free(pn_items *list) {
	free(list->items);
	list->items = NULL;
	list->n = 0;
}

const char **pn_index(const pn *o, const char *on, size_t *n) {
	const char **out = alloc((o->ntargets + 1) * sizeof *out);
	*n = 0;
	for (size_t i = 0; i < o->ntargets; i++) {
		if (strcmp(o->targets[i].on, on) == 0) out[(*n)++] = o->targets[i].id;
	}
	return out;
}

size_t pn_targets(const pn *o) {
	size_t count = 0;
	for (size_t i = 0; i < o->ntargets; i++) {
		int seen = 0;
		for (size_t j = 0; j < i; j++) seen |= strcmp(o->targets[j].on, o->targets[i].on) == 0;
		count += !seen;
	}
	return count;
}

int pn_land(pn *o, tb_key id, ch_header header, pl_changed *changed, nd_entry **made_out,
	size_t *failed) {
	changed->n = 0;
	*made_out = NULL;
	nd_entry *node = tb_get(o->table, tb_string("patch"), id);
	aim a;
	if (node == NULL || !aim_of(node->value, &a)) return PN_NOTHING_THERE;
	// the patches, and what they point into, stay held: the change refers to them
	landed l = {parse(a.patches), op_ref(node->value)};
	nd_entry *base = tb_get(o->table, tb_string(a.part), tb_string(a.on));
	nd_entry *target_entry = base;
	if (base == NULL) target_entry = nd_make_entry(NULL, &header, NULL);
	int code = nd_update(target_entry, l.ps.patches, l.ps.n, header, failed);
	if (code != OP_OK) {
		if (base == NULL) nd_free_entry(target_entry);
		parsed_free(&l.ps);
		op_free(l.hold);
		return code;
	}
	PUSH(o->lands, o->nlands, o->caplands, l);
	char *part = copy(a.part), *on = copy(a.on);
	tb_del(o->table, tb_string("patch"), id);
	if (base == NULL) {
		tb_add(o->table, tb_string(part), tb_string(on), target_entry);
		*made_out = target_entry;
	} else {
		changed->entries[changed->n++] = base;
	}
	free(part), free(on);
	return OP_OK;
}
