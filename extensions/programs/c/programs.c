// Programs (programs.h), in C.
#include "programs.h"

#include <string.h>

#include "../../../ermine/programs/c/host.h"
#include "../../../ermine/programs/c/mem.h"

// copies and frees -----------------------------------------------------------------------------

static char **strs_copy(char *const *from, size_t n) {
	char **to = pg_alloc((n + 1) * sizeof *to);
	for (size_t i = 0; i < n; i++) to[i] = pg_dup(from[i]);
	return to;
}
static void strs_free(char **v, size_t n) {
	for (size_t i = 0; i < n; i++) free(v[i]);
	free(v);
}

void pg_place_copy(pg_place *to, const pg_place *from) {
	to->id = pg_dup(from->id);
	to->at = strs_copy(from->at, from->n);
	to->n = from->n;
}
void pg_place_free(pg_place *p) {
	free(p->id);
	strs_free(p->at, p->n);
	*p = (pg_place){0};
}

void pg_chain_copy(pg_chain *to, const pg_chain *from) {
	to->n = from->n;
	to->steps = pg_alloc((from->n + 1) * sizeof *to->steps);
	for (size_t i = 0; i < from->n; i++) {
		pg_place_copy(&to->steps[i].place, &from->steps[i].place);
		pg_chain_copy(&to->steps[i].by, &from->steps[i].by);
	}
}
void pg_chain_free(pg_chain *c) {
	for (size_t i = 0; i < c->n; i++) {
		pg_place_free(&c->steps[i].place);
		pg_chain_free(&c->steps[i].by);
	}
	free(c->steps);
	*c = (pg_chain){0};
}

static void chains_free(pg_chains *c) {
	for (size_t i = 0; i < c->n; i++) pg_chain_free(&c->items[i]);
	free(c->items);
	*c = (pg_chains){0};
}

static void whys_free(pg_whys *w) {
	for (size_t i = 0; i < w->n; i++) {
		pg_place_free(&w->items[i].place);
		free(w->items[i].for_);
		free(w->items[i].type);
		strs_free(w->items[i].missing, w->items[i].nmissing);
	}
	free(w->items);
	*w = (pg_whys){0};
}

static const char *const reasons[] = {"wrong-type", "unknown-type", "needs", "no-chain", "no-type",
	"in-the-chain"};
const char *pg_reason_name(pg_reason why) { return reasons[why]; }

void pg_found_free(pg_found *f) {
	if (f == NULL) return;
	if (f->program.id != NULL) pg_place_free(&f->program);
	free(f->path);
	strs_free(f->at, f->nat);
	chains_free(&f->chains);
	whys_free(&f->why);
	free(f);
}

void pg_opened_free(pg_opened *o) {
	if (o == NULL) return;
	free(o->id);
	for (size_t i = 0; i < o->ways.n; i++) {
		pg_place_free(&o->ways.items[i].program);
		pg_chain_free(&o->ways.items[i].chain);
	}
	free(o->ways.items);
	whys_free(&o->why);
	free(o);
}

// a search ---------------------------------------------------------------------------------------

// an attribute read: the id a copy, the name one of PG_*
typedef struct {
	char *id;
	const char *name;
	const op_value *v;
} attr_at;
typedef struct {
	char *uti;
	ty_conformance c;
} conformed;
typedef struct walk_t walk_t;
// how a node is itself run, as far as looked for: state 1, found (chain, its level); 2, none (why);
// 0, its search (walk) paused before a level past the one asked
typedef struct {
	char *key;
	int state;
	pg_reason why;
	pg_chain chain;
	size_t level;
	walk_t *walk;
} ran;

typedef struct {
	pl *places;
	// every candidate, and its level (0: the nearest); the loaders among them (indices); per level,
	// how many loaders are of it or nearer; top: the farthest level ("/")
	pg_place *list;
	size_t nlist, caplist;
	size_t *lv;
	size_t *loaders;
	size_t nloaders;
	size_t *bounds;
	size_t top;
	ty_folder types;
	int has_types;
	// the extensions its types claim, read when first needed
	ty_extensions ext;
	int has_ext;
	pg_whys why;
	size_t capwhy;
	char **noted;
	size_t nnoted, capnoted;
	attr_at *attrs;
	size_t nattrs, capattrs;
	conformed *confs;
	size_t nconfs, capconfs;
	ran *runs;
	size_t nruns, capruns;
} search_t;

// a set of ids, in the order added, the ids borrowed
typedef struct {
	const char **v;
	size_t n;
} idset;
static int has(const idset *s, const char *id) {
	for (size_t i = 0; i < s->n; i++) {
		if (strcmp(s->v[i], id) == 0) return 1;
	}
	return 0;
}
static idset plus(const idset *s, const char *id) {
	idset out = {pg_alloc((s->n + 2) * sizeof *out.v), s->n};
	for (size_t i = 0; i < s->n; i++) out.v[i] = s->v[i];
	out.v[out.n++] = id;
	return out;
}

// an attribute of a node, read once a search
static const op_value *attr(search_t *s, const char *id, const char *name) {
	for (size_t i = 0; i < s->nattrs; i++) {
		if (strcmp(s->attrs[i].id, id) == 0 && strcmp(s->attrs[i].name, name) == 0) return s->attrs[i].v;
	}
	op_key key = {.type = OP_STR_KEY, .s = name};
	const op_value *v = pl_read(s->places, tb_string("attributes"), tb_string(id), &key, 1);
	attr_at a = {pg_dup(id), name, v};
	PG_PUSH(s->attrs, s->nattrs, s->capattrs, a);
	return v;
}

// the strings in a list: borrowed from it, n of them; a value that is no list: none
static const char **strings(const op_value *v, size_t *n) {
	const char **out = pg_alloc(((v != NULL && v->type == OP_LIST ? v->count : 0) + 1) * sizeof *out);
	*n = 0;
	if (v != NULL && v->type == OP_LIST) {
		for (size_t i = 0; i < v->count; i++) {
			if (v->items[i]->type == OP_STR) out[(*n)++] = v->items[i]->str;
		}
	}
	return out;
}

static int includes(const char *const *list, size_t n, const char *s) {
	for (size_t i = 0; i < n; i++) {
		if (strcmp(list[i], s) == 0) return 1;
	}
	return 0;
}

// a node's type at the place the search met it: its attribute, else its name's (types' rule, said
// once in types.ts); the extensions read once a search, only for a node with no attribute. Borrowed
// from the search. NULL: none
static const char *type_of(search_t *s, const pg_place *at) {
	const op_value *t = attr(s, at->id, PG_TYPE);
	if (t != NULL && t->type == OP_STR) return t->str;
	if (at->n == 0) return NULL;
	if (!s->has_ext) {
		s->ext = ty_extensions_of(s->places, s->has_types ? &s->types : NULL);
		s->has_ext = 1;
	}
	return ty_by_name(&s->ext, at->at[at->n - 1]);
}

// a host runner's mark: its value a live function. read only for a node with no type
static int hosted(search_t *s, const char *id) {
	return hf_name(pl_read(s->places, tb_string("value"), tb_string(id), NULL, 0)) != NULL;
}

// whether a type fits a list of UTIs: 0, or the reason not
static int fits(search_t *s, const char *uti, const char *const *to, size_t n, pg_reason *why) {
	if (includes(to, n, uti)) return 0;
	conformed *c = NULL;
	for (size_t i = 0; i < s->nconfs; i++) {
		if (strcmp(s->confs[i].uti, uti) == 0) c = &s->confs[i];
	}
	if (c == NULL) {
		conformed made = {pg_dup(uti), ty_conform(s->places, s->has_types ? &s->types : NULL, uti)};
		PG_PUSH(s->confs, s->nconfs, s->capconfs, made);
		c = &s->confs[s->nconfs - 1];
	}
	for (size_t i = 0; i < c->c.n; i++) {
		if (includes(to, n, c->c.all[i])) return 0;
	}
	*why = c->c.known ? PG_WRONG_TYPE : PG_UNKNOWN_TYPE;
	return 1;
}

// s and a separator written at p; p after them
static char *put(char *p, const char *s, char sep) {
	size_t n = strlen(s);
	memcpy(p, s, n);
	p[n] = sep;
	p[n + 1] = 0;
	return p + n + 1;
}

// a candidate not taken, each once
static void note(search_t *s, const pg_place *c, const char *for_, const char *type, pg_reason why,
	const char *const *missing, size_t nmissing) {
	size_t len = strlen(c->id) + strlen(for_) + strlen(type) + 64;
	for (size_t i = 0; i < c->n; i++) len += strlen(c->at[i]) + 1;
	for (size_t i = 0; i < nmissing; i++) len += strlen(missing[i]) + 1;
	char *key = pg_alloc(len), *p = key;
	p = put(p, c->id, '\x1f');
	for (size_t i = 0; i < c->n; i++) p = put(p, c->at[i], '\x1e');
	p = put(p, for_, '\x1f');
	p = put(p, type, '\x1f');
	*p++ = (char)('0' + why);
	for (size_t i = 0; i < nmissing; i++) p = put(p, missing[i], '\x1e');
	*p = 0;
	for (size_t i = 0; i < s->nnoted; i++) {
		if (strcmp(s->noted[i], key) == 0) {
			free(key);
			return;
		}
	}
	PG_PUSH(s->noted, s->nnoted, s->capnoted, key);
	pg_why w = {.for_ = pg_dup(for_), .type = pg_dup(type), .why = why};
	pg_place_copy(&w.place, c);
	w.missing = pg_alloc((nmissing + 1) * sizeof *w.missing);
	for (size_t i = 0; i < nmissing; i++) w.missing[i] = pg_dup(missing[i]);
	w.nmissing = nmissing;
	PG_PUSH(s->why.items, s->why.n, s->capwhy, w);
}

// the order of a folder's names: canonical CBOR's key order, by their encodings bytewise (shorter
// first, then by UTF-8)
typedef struct {
	const char *name;
	tb_key id;
} member;
static int key_order(const void *a, const void *b) {
	const char *x = ((const member *)a)->name, *y = ((const member *)b)->name;
	size_t lx = strlen(x), ly = strlen(y);
	if (lx != ly) return lx < ly ? -1 : 1;
	return memcmp(x, y, lx);
}

static void candidate(search_t *s, const char *id, const char *const *at, size_t n, const char *name) {
	pg_place c = {pg_dup(id), pg_alloc((n + 2) * sizeof(char *)), n + 1};
	for (size_t i = 0; i < n; i++) c.at[i] = pg_dup(at[i]);
	c.at[n] = pg_dup(name);
	PG_PUSH(s->list, s->nlist, s->caplist, c);
}

static int met(char **seen, size_t n, const char *id) {
	for (size_t i = 0; i < n; i++) {
		if (strcmp(seen[i], id) == 0) return 1;
	}
	return 0;
}

// every member of the level at, a loaders folder's children in its place, each node once
static void into(search_t *s, const char *const *at, size_t n, char ***seen, size_t *nseen, size_t *capseen) {
	pl_members here = pl_members_at(s->places, at, n);
	member *sorted = pg_alloc((here.n + 1) * sizeof *sorted);
	size_t count = 0;
	for (size_t i = 0; i < here.n; i++) {
		if (here.items[i].id.symbol != NULL) continue;
		sorted[count++] = (member){here.items[i].name, here.items[i].id};
	}
	pl_members_free(&here);
	qsort(sorted, count, sizeof *sorted, key_order);
	for (size_t i = 0; i < count; i++) {
		if (met(*seen, *nseen, sorted[i].id.string)) continue;
		char *id = pg_dup(sorted[i].id.string);
		PG_PUSH(*seen, *nseen, *capseen, id);
		op_key key = {.type = OP_STR_KEY, .s = PG_LOADERS};
		const op_value *loaders = pl_read(s->places, tb_string("attributes"), tb_string(id), &key, 1);
		if (loaders != NULL && loaders->type == OP_BOOL && loaders->bool_) {
			const char **path = pg_alloc((n + 2) * sizeof *path);
			for (size_t j = 0; j < n; j++) path[j] = at[j];
			path[n] = sorted[i].name;
			into(s, path, n + 1, seen, nseen, capseen);
			free(path);
		} else {
			candidate(s, id, at, n, sorted[i].name);
		}
	}
	free(sorted);
}

// every member of each level from the place up to "/", nearest first, each one's level kept
static void candidates(search_t *s, const char *const *from, size_t nfrom) {
	char **seen = NULL;
	size_t nseen = 0, capseen = 0, *ends = pg_alloc((nfrom + 1) * sizeof *ends);
	for (size_t k = nfrom + 1; k > 0; k--) {
		into(s, from, k - 1, &seen, &nseen, &capseen);
		ends[nfrom + 1 - k] = s->nlist;
	}
	strs_free(seen, nseen);
	s->top = nfrom;
	s->lv = pg_alloc((s->nlist + 1) * sizeof *s->lv);
	for (size_t i = 0, k = 0; i < s->nlist; i++) {
		while (i >= ends[k]) k++;
		s->lv[i] = k;
	}
	free(ends);
}

static search_t *searching(pl *places, const char *const *from, size_t nfrom) {
	search_t *s = pg_alloc(sizeof *s);
	s->places = places;
	candidates(s, from, nfrom);
	s->has_types = ty_at(places, from, nfrom, &s->types);
	s->loaders = pg_alloc((s->nlist + 1) * sizeof *s->loaders);
	for (size_t i = 0; i < s->nlist; i++) {
		size_t n;
		const char **takes = strings(attr(s, s->list[i].id, PG_TAKES), &n);
		free(takes);
		if (n) s->loaders[s->nloaders++] = i;
	}
	s->bounds = pg_alloc((s->top + 1) * sizeof *s->bounds);
	for (size_t k = 0, j = 0; k <= s->top; k++) {
		while (j < s->nloaders && s->lv[s->loaders[j]] <= k) j++;
		s->bounds[k] = j;
	}
	return s;
}

static void walk_free(walk_t *w);

static void search_free(search_t *s) {
	for (size_t i = 0; i < s->nlist; i++) pg_place_free(&s->list[i]);
	free(s->list);
	free(s->lv);
	free(s->loaders);
	free(s->bounds);
	if (s->has_types) ty_folder_free(&s->types);
	if (s->has_ext) ty_extensions_free(&s->ext);
	whys_free(&s->why);
	strs_free(s->noted, s->nnoted);
	for (size_t i = 0; i < s->nattrs; i++) free(s->attrs[i].id);
	free(s->attrs);
	for (size_t i = 0; i < s->nconfs; i++) {
		free(s->confs[i].uti);
		ty_conformance_free(&s->confs[i].c);
	}
	free(s->confs);
	for (size_t i = 0; i < s->nruns; i++) {
		free(s->runs[i].key);
		pg_chain_free(&s->runs[i].chain);
		if (s->runs[i].walk != NULL) walk_free(s->runs[i].walk);
	}
	free(s->runs);
	free(s);
}

static void chains_push(pg_chains *out, size_t *cap, pg_chain c) { PG_PUSH(out->items, out->n, *cap, c); }

// what runs one node x (a copy): above, x and the nodes it runs for (its v owned, the ids borrowed:
// above's, and x); per type looked for, its candidates (scan)
typedef struct scan_t scan_t;
typedef struct {
	char *x;
	const char **needs;
	size_t nneeds;
	idset above;
	scan_t **scans;
	size_t nscans, capscans;
} run_t;

// a candidate taken for a type: its step (the place copied; by, once its own run is found), the type
// it gives (NULL: a runner; borrowed), its own level, its serial (its place in the candidates; a pin
// that is none: after them); state 0: its run not found yet, 1: a step, level its own or its by's
// (the farther), 2: dead (none, noted); the scan of what it gives once needed
typedef struct {
	pg_step step;
	const char *gives;
	size_t at, serial, level;
	int state;
	scan_t *below;
} taken_t;

// a type's candidates as far as looked at: those taken, in order; next, the next of the loaders to
// look at (-1: the pin, the program's first step only)
struct scan_t {
	char *uti;
	taken_t **taken;
	size_t n, cap;
	long next;
	const pg_place *pin;
};

static scan_t *scan_new(const char *uti, const pg_place *pin) {
	scan_t *scan = pg_alloc(sizeof *scan);
	scan->uti = pg_dup(uti);
	scan->pin = pin;
	scan->next = pin != NULL ? -1 : 0;
	return scan;
}
static void scan_free(scan_t *scan) {
	for (size_t i = 0; i < scan->n; i++) {
		pg_place_free(&scan->taken[i]->step.place);
		pg_chain_free(&scan->taken[i]->step.by);
		free(scan->taken[i]);
	}
	free(scan->taken);
	free(scan->uti);
	free(scan);
}

static scan_t *scan_of(run_t *r, const char *uti) {
	for (size_t i = 0; i < r->nscans; i++) {
		if (strcmp(r->scans[i]->uti, uti) == 0) return r->scans[i];
	}
	scan_t *scan = scan_new(uti, NULL);
	PG_PUSH(r->scans, r->nscans, r->capscans, scan);
	return scan;
}

static void running(search_t *s, const char *x, const idset *above, run_t *r) {
	*r = (run_t){.x = pg_dup(x)};
	r->needs = strings(attr(s, x, PG_NEEDS), &r->nneeds);
	r->above = plus(above, r->x);
}
static void run_free(run_t *r) {
	free(r->x);
	free(r->needs);
	free(r->above.v);
	for (size_t i = 0; i < r->nscans; i++) scan_free(r->scans[i]);
	free(r->scans);
}

// a candidate's serial: its place in the candidates, by id; none (a pin from elsewhere): after them
static size_t serial_of(search_t *s, const pg_place *c) {
	if (c >= s->list && c < s->list + s->nlist) return (size_t)(c - s->list);
	for (size_t i = 0; i < s->nlist; i++) {
		if (strcmp(s->list[i].id, c->id) == 0) return i;
	}
	return s->nlist;
}

// a candidate at level at looked at for x and a scan's type: taken (pushed) when it fits, is not
// above and meets the needs (a runner); else noted why not. its own run: looked for when first
// stepped on (ready)
static void look(search_t *s, run_t *r, const pg_place *c, scan_t *scan, size_t at) {
	const char *uti = scan->uti;
	size_t ntakes;
	const char **takes = strings(attr(s, c->id, PG_TAKES), &ntakes);
	pg_reason why;
	int fit = fits(s, uti, takes, ntakes, &why);
	free(takes);
	if (fit) {
		note(s, c, r->x, uti, why, NULL, 0);
		return;
	}
	if (has(&r->above, c->id)) {
		note(s, c, r->x, uti, PG_IN_THE_CHAIN, NULL, 0);
		return;
	}
	const op_value *gives = attr(s, c->id, PG_GIVES);
	int compiler = gives != NULL && gives->type == OP_STR;
	if (!compiler) {
		size_t nprovides, nmissing = 0;
		const char **provides = strings(attr(s, c->id, PG_PROVIDES), &nprovides);
		const char **missing = pg_alloc((r->nneeds + 1) * sizeof *missing);
		for (size_t j = 0; j < r->nneeds; j++) {
			if (!includes(provides, nprovides, r->needs[j])) missing[nmissing++] = r->needs[j];
		}
		if (nmissing) note(s, c, r->x, uti, PG_NEEDS_UNMET, missing, nmissing);
		free(provides), free(missing);
		if (nmissing) return;
	}
	taken_t *t = pg_alloc(sizeof *t);
	pg_place_copy(&t->step.place, c);
	t->gives = compiler ? gives->str : NULL;
	t->at = at;
	t->serial = serial_of(s, c);
	PG_PUSH(scan->taken, scan->n, scan->cap, t);
}

// the i-th taken of a scan, the loaders up to level k looked at up to it; none: NULL
static taken_t *nth_taken(search_t *s, run_t *r, scan_t *scan, size_t i, size_t k) {
	while (i >= scan->n) {
		const pg_place *c;
		size_t at = 0;
		if (scan->next < 0) c = scan->pin;
		else {
			if ((size_t)scan->next >= s->bounds[k]) return NULL;
			size_t li = s->loaders[scan->next];
			c = &s->list[li];
			at = s->lv[li];
			if (scan->pin != NULL && strcmp(c->id, scan->pin->id) == 0) c = NULL;
		}
		scan->next++;
		if (c != NULL) look(s, r, c, scan, at);
	}
	return scan->taken[i];
}

static int run_of(search_t *s, const pg_place *c, const idset *above, size_t k, pg_chain *out,
	size_t *level, pg_reason *why);

// whether a candidate taken for a type is a step at level k or nearer: its own run looked for up to
// level k (none at all: noted, dead)
static int ready(search_t *s, run_t *r, taken_t *t, const char *uti, size_t k) {
	if (t->state == 2) return 0;
	if (t->state == 0) {
		size_t level = 0;
		pg_reason why;
		int got = run_of(s, &t->step.place, &r->above, k, &t->step.by, &level, &why);
		if (got < 0) return 0;
		if (got == 0) {
			t->state = 2;
			note(s, &t->step.place, r->x, uti, why, NULL, 0);
			return 0;
		}
		t->state = 1;
		t->level = level > t->at ? level : t->at;
	}
	return t->level <= k;
}

// the chains running a node, nearest, then shortest, one at a time (walk_next). per level k, nearest
// first: rounds L = 1, 2, …, depth first over the levels up to k, at most L steps, giving the chains
// of L steps whose level is k; another round only when a compiler was passed over at the round's
// last step. per depth: its scan, the next taken to try, whether a chain was found below it, whether
// a compiler was passed over at the last step, the farthest level above it, the compiler taken there;
// by serial, whether one is in the chain
enum { W_LEVEL, W_ROUND, W_WALK, W_DONE };
struct walk_t {
	run_t run;
	scan_t *first;
	int pinned, phase;
	size_t k, L, d;
	scan_t **scans;
	size_t *next, *far;
	char *found, *cut, *on;
	taken_t **taken;
};

// a walk for x of type uti, from its pin's scan (the program's first step) or its type's
static walk_t *walk_new(search_t *s, const char *x, const char *uti, const idset *above, const pg_place *pin) {
	walk_t *w = pg_alloc(sizeof *w);
	running(s, x, above, &w->run);
	w->pinned = pin != NULL;
	w->first = pin != NULL ? scan_new(uti, pin) : scan_of(&w->run, uti);
	size_t depth = s->nlist + 3;
	w->scans = pg_alloc(depth * sizeof *w->scans);
	w->next = pg_alloc(depth * sizeof *w->next);
	w->far = pg_alloc(depth * sizeof *w->far);
	w->found = pg_alloc(depth);
	w->cut = pg_alloc(depth);
	w->on = pg_alloc(s->nlist + 1);
	w->taken = pg_alloc(depth * sizeof *w->taken);
	w->phase = W_LEVEL;
	return w;
}

static void walk_free(walk_t *w) {
	run_free(&w->run);
	if (w->pinned) scan_free(w->first);
	free(w->scans), free(w->next), free(w->far), free(w->found), free(w->cut), free(w->on), free(w->taken);
	free(w);
}

// the walk's next chain: 1 and *out, its level in *level; 0: no more; -1: paused before a level past
// limit (called again, it goes on from there)
static int walk_next(search_t *s, walk_t *w, size_t limit, pg_chain *out, size_t *level) {
	for (;;) {
		if (w->phase == W_DONE) return 0;
		if (w->phase == W_LEVEL) {
			if (w->k > s->top) {
				w->phase = W_DONE;
				return 0;
			}
			if (w->k > limit) return -1;
			// no loaders added: no way of this level (the last walked for its whys)
			if (w->k > 0 && w->k < s->top && s->bounds[w->k] == s->bounds[w->k - 1]) {
				w->k++;
				continue;
			}
			w->L = 1;
			w->phase = W_ROUND;
		}
		if (w->phase == W_ROUND) {
			w->d = 0;
			w->scans[0] = w->first, w->next[0] = 0, w->found[0] = 0, w->cut[0] = 0, w->far[0] = 0;
			w->phase = W_WALK;
		}
		size_t d = w->d;
		taken_t *t = nth_taken(s, &w->run, w->scans[d], w->next[d]++, w->k);
		if (t == NULL) {
			if (d == 0) {
				if (w->cut[0]) w->L++, w->phase = W_ROUND;
				else w->k++, w->phase = W_LEVEL;
				continue;
			}
			taken_t *up = w->taken[d - 1];
			w->on[up->serial] = 0;
			w->d = --d;
			if (w->found[d + 1]) w->found[d] = 1;
			// all below it walked, every level read, nothing found: noted once
			if (w->cut[d + 1]) w->cut[d] = 1;
			else if (!w->found[d + 1] && w->k == s->top) {
				note(s, &up->step.place, w->run.x, w->scans[d]->uti, PG_NO_CHAIN, NULL, 0);
			}
			continue;
		}
		if (!ready(s, &w->run, t, w->scans[d]->uti, w->k)) continue;
		if (w->on[t->serial]) {
			note(s, &t->step.place, w->run.x, w->scans[d]->uti, PG_IN_THE_CHAIN, NULL, 0);
			continue;
		}
		size_t lv = t->level > w->far[d] ? t->level : w->far[d];
		int last = d + 1 == w->L;
		if (t->gives == NULL) {
			w->found[d] = 1;
			if (!last || lv != w->k) continue;
			pg_chain c = {pg_alloc((d + 2) * sizeof(pg_step)), d + 1};
			for (size_t j = 0; j < d; j++) {
				pg_place_copy(&c.steps[j].place, &w->taken[j]->step.place);
				pg_chain_copy(&c.steps[j].by, &w->taken[j]->step.by);
			}
			pg_place_copy(&c.steps[d].place, &t->step.place);
			pg_chain_copy(&c.steps[d].by, &t->step.by);
			*out = c;
			*level = lv;
			return 1;
		}
		if (last) {
			w->cut[d] = 1;
			continue;
		}
		w->taken[d] = t;
		w->on[t->serial] = 1;
		if (t->below == NULL) t->below = scan_of(&w->run, t->gives);
		w->d = ++d;
		w->scans[d] = t->below, w->next[d] = 0, w->found[d] = 0, w->cut[d] = 0, w->far[d] = lv;
	}
}

// how a step c is itself run, the first chain in the same order, its level k or nearer looked for:
// 1, *out and *level (a chain, empty: the host runs it); 0 and *why, none; -1: none up to level k
// yet (its walk paused, kept)
static int run_of(search_t *s, const pg_place *c, const idset *above, size_t k, pg_chain *out,
	size_t *level, pg_reason *why) {
	size_t len = strlen(c->id) + 32;
	for (size_t i = 0; i < above->n; i++) len += strlen(above->v[i]) + 1;
	char *key = pg_alloc(len), *p = key;
	p = put(p, c->id, '\x1f');
	for (size_t i = 0; i < above->n; i++) p = put(p, above->v[i], '\x1e');
	size_t i = 0;
	while (i < s->nruns && strcmp(s->runs[i].key, key) != 0) i++;
	if (i < s->nruns) free(key);
	else {
		ran r = {.key = key};
		const char *uti = type_of(s, c);
		if (uti != NULL) r.walk = walk_new(s, c->id, uti, above, NULL);
		else if (hosted(s, c->id)) r.state = 1, r.chain = (pg_chain){pg_alloc(sizeof(pg_step)), 0};
		else r.state = 2, r.why = PG_NO_TYPE;
		PG_PUSH(s->runs, s->nruns, s->capruns, r);
	}
	if (s->runs[i].state == 0) {
		walk_t *w = s->runs[i].walk;
		pg_chain found = {0};
		size_t lv = 0;
		int got = walk_next(s, w, k, &found, &lv);
		if (got < 0) return -1;
		// s->runs may have moved: by index
		walk_free(w);
		s->runs[i].walk = NULL;
		if (got > 0) s->runs[i].state = 1, s->runs[i].chain = found, s->runs[i].level = lv;
		else s->runs[i].state = 2, s->runs[i].why = PG_NO_CHAIN;
	}
	if (s->runs[i].state == 2) return *why = s->runs[i].why, 0;
	pg_chain_copy(out, &s->runs[i].chain);
	*level = s->runs[i].level;
	return 1;
}

// every chain running a program, nearest, then shortest, its pin tried first: one empty chain for a
// program with no type and a live function; else the reason it has none
static int chains_of(search_t *s, const pg_place *p, const pg_place *pin, pg_chains *out, pg_reason *why) {
	const char *uti = type_of(s, p);
	if (uti == NULL) {
		if (!hosted(s, p->id)) return *why = PG_NO_TYPE, 1;
		out->items = pg_alloc(sizeof(pg_chain));
		out->items[0] = (pg_chain){pg_alloc(sizeof(pg_step)), 0};
		out->n = 1;
		return 0;
	}
	idset none = {0};
	walk_t *w = walk_new(s, p->id, uti, &none, pin);
	size_t capout = 0, level;
	pg_chain c;
	while (walk_next(s, w, (size_t)-1, &c, &level) > 0) chains_push(out, &capout, c);
	walk_free(w);
	if (out->n == 0) return free(out->items), *out = (pg_chains){0}, *why = PG_NO_CHAIN, 1;
	return 0;
}

// a path -------------------------------------------------------------------------------------------

// a string's steps: "/" first when it starts with one, each non-empty piece. n of them, copies
static char **parse(const char *text, size_t *n) {
	char **out = NULL;
	size_t cap = 0;
	*n = 0;
	if (text[0] == '/') {
		char *slash = pg_dup("/");
		PG_PUSH(out, *n, cap, slash);
	}
	const char *p = text;
	while (*p) {
		const char *end = strchr(p, '/');
		size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
		if (len > 0) {
			char *piece = pg_alloc(len + 1);
			memcpy(piece, p, len);
			PG_PUSH(out, *n, cap, piece);
		}
		p += len;
		if (*p == '/') p++;
	}
	if (out == NULL) out = pg_alloc(sizeof *out);
	return out;
}

// the names steps come to from "/", plain: "." skipped, ".." takes back a name (none left: -1, above "/"),
// "/" starts again. the names are borrowed from steps
static int plan(const char *const *steps, size_t n, const char **names, size_t *count) {
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		if (strcmp(steps[i], ".") == 0) continue;
		if (strcmp(steps[i], "/") == 0) k = 0;
		else if (strcmp(steps[i], "..") != 0) names[k++] = steps[i];
		else if (k) k--;
		else return -1;
	}
	*count = k;
	return 0;
}

// the path a path finds from a place, and the node there; 1 and *out, nothing: 0
static int find(pl *places, const char *path, const char *const *from, size_t nfrom, pg_place *out) {
	size_t n;
	char **steps = parse(path, &n);
	int direct = n > 0 && (strcmp(steps[0], "/") == 0 || strcmp(steps[0], ".") == 0 ||
		strcmp(steps[0], "..") == 0);
	const char **names = pg_alloc((nfrom + n + 2) * sizeof *names);
	size_t count = 0;
	int found = 0;
	char **at = NULL;
	size_t nat = 0;
	if (direct) {
		const char **all = pg_alloc((nfrom + n + 2) * sizeof *all);
		size_t k = 0;
		all[k++] = "/";
		for (size_t i = 0; i < nfrom; i++) all[k++] = from[i];
		for (size_t i = 0; i < n; i++) all[k++] = steps[i];
		if (plan(all, k, names, &count) == 0) {
			found = 1;
			at = strs_copy((char *const *)names, count);
			nat = count;
		}
		free(all);
	} else if (plan((const char *const *)steps, n, names, &count) == 0 && count > 0) {
		size_t *depths = pg_alloc((nfrom + 1) * sizeof *depths);
		if (pl_lookup(places, names, count, from, nfrom, 0, depths) > 0) {
			found = 1;
			nat = depths[0] + count;
			at = pg_alloc((nat + 1) * sizeof *at);
			for (size_t i = 0; i < depths[0]; i++) at[i] = pg_dup(from[i]);
			for (size_t i = 0; i < count; i++) at[depths[0] + i] = pg_dup(names[i]);
		}
		free(depths);
	}
	free(names);
	strs_free(steps, n);
	if (!found) return 0;
	tb_key id;
	if (!pl_get(places, (const char *const *)at, nat, &id) || id.symbol != NULL) {
		strs_free(at, nat);
		return 0;
	}
	out->id = pg_dup(id.string);
	out->at = at;
	out->n = nat;
	return 1;
}

// the answers ----------------------------------------------------------------------------------------

// String(v) for the pin's path, as the reference writes it into a refusal
static char *show(const op_value *v) {
	if (v->type == OP_STR) return pg_dup(v->str);
	if (v->type == OP_BOOL) return pg_dup(v->bool_ ? "true" : "false");
	if (v->type == OP_NUM) {
		char buf[32];
		snprintf(buf, sizeof buf, "%.17g", v->num);
		return pg_dup(buf);
	}
	if (v->type == OP_NULL) return pg_dup("null");
	return pg_dup("[object Object]");
}

pg_found *pg_satisfy(pl *places, const char *name, const char *const *from, size_t nfrom) {
	pg_found *f = pg_alloc(sizeof *f);
	pg_place program;
	if (!find(places, name, from, nfrom, &program)) {
		f->refused = "nothing-there";
		f->path = pg_dup(name);
		f->at = strs_copy((char *const *)from, nfrom);
		f->nat = nfrom;
		return f;
	}
	const char *const *folder = (const char *const *)program.at;
	size_t nfolder = program.n > 0 ? program.n - 1 : 0;
	search_t *s = searching(places, folder, nfolder);
	pg_place pin = {0};
	int pinned = 0;
	if (type_of(s, &program) != NULL) {
		const op_value *want = attr(s, program.id, PG_LOADER);
		if (want != NULL) {
			if (want->type == OP_STR) pinned = find(places, want->str, folder, nfolder, &pin);
			if (!pinned) {
				f->refused = "nothing-there";
				f->path = show(want);
				f->at = strs_copy((char *const *)folder, nfolder);
				f->nat = nfolder;
				pg_place_free(&program);
				search_free(s);
				return f;
			}
		}
	}
	pg_reason why;
	if (chains_of(s, &program, pinned ? &pin : NULL, &f->chains, &why)) {
		f->refused = why == PG_NO_TYPE ? "no-type" : "no-chain";
		f->program = program;
		if (why == PG_NO_CHAIN) {
			f->why = s->why;
			s->why = (pg_whys){0};
		}
	} else {
		f->program = program;
		f->why = s->why;
		s->why = (pg_whys){0};
	}
	if (pinned) pg_place_free(&pin);
	search_free(s);
	return f;
}

pg_opened *pg_open_with_at(pl *places, const char *file, const char *const *at, size_t nat,
	const char *const *from, size_t nfrom) {
	pg_opened *o = pg_alloc(sizeof *o);
	search_t *s = searching(places, from, nfrom);
	// the file's place: borrowed names, never freed
	pg_place place = {(char *)file, (char **)at, nat};
	const char *uti = type_of(s, &place);
	if (uti == NULL) {
		o->refused = "no-type";
		o->id = pg_dup(file);
		search_free(s);
		return o;
	}
	size_t capways = 0;
	for (size_t i = 0; i < s->nlist; i++) {
		const pg_place *c = &s->list[i];
		size_t nopens;
		const char **opens = strings(attr(s, c->id, PG_OPENS), &nopens);
		if (nopens == 0) {
			free(opens);
			continue;
		}
		pg_reason why;
		int fit = fits(s, uti, opens, nopens, &why);
		free(opens);
		if (fit) {
			note(s, c, file, uti, why, NULL, 0);
			continue;
		}
		pg_chains chains = {0};
		if (chains_of(s, c, NULL, &chains, &why)) {
			note(s, c, file, uti, why, NULL, 0);
			continue;
		}
		for (size_t j = 0; j < chains.n; j++) {
			pg_way w;
			pg_place_copy(&w.program, c);
			w.chain = chains.items[j];
			PG_PUSH(o->ways.items, o->ways.n, capways, w);
		}
		free(chains.items);
	}
	o->why = s->why;
	s->why = (pg_whys){0};
	search_free(s);
	return o;
}

pg_opened *pg_open_with(pl *places, const char *file, const char *const *from, size_t nfrom) {
	return pg_open_with_at(places, file, NULL, 0, from, nfrom);
}
