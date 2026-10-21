// the process api (api.h), in C. the TypeScript (typescript/api.ts) is the spec.
//
// left out, as the suite has none of them: start, stop of a process this one started, openwith, box
// (they need programs' and boxes' C, which the TypeScript tests have), and async (promise) memos
// (a compute may still return SC_AWAIT, but nothing here is tested with it).
#define _POSIX_C_SOURCE 200809L
#include "api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../core/node/c/node.h"
#include "../../../core/node/c/update.h"
#include "../../../filesystem/places/c/guard.h"
#include "../../../filesystem/places/c/status.h"
#include "../../processes/c/runs.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// a path array as the places functions have it
#define CP(x) ((const char *const *)(x))

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

const char *api_code_name(int code) {
	switch (code) {
		case API_OK: return "";
		case API_NOTHING_THERE: return "nothing-there";
		case API_ALREADY_THERE: return "already-there";
		case API_NOT_A_NAME: return "not-a-name";
		case API_REFUSED: return "refused";
		case API_PENDING: return "pending";
		case API_NOT_A_METHOD: return "not-a-method";
		case API_STOP: return "stop";
		default: return "failed";
	}
}

// the world ---------------------------------------------------------------------------------

typedef struct {
	char *id;
	op_value *why;
} stopping;
typedef struct {
	api_method_fn fn;
	void *ctx;
	sc_scope *scope;
} method_rec;

struct api_watching {
	pl_watch *w;
	int stopped;
	void (*fn)(const pl_fact *fact, void *ctx);
	void *ctx;
};

typedef struct {
	char *id;
} memoed;

struct api_context {
	api_setup s;
	cst *statuses;
	// each memo's and effect's latest run, on the runs' own table by its node's id (runs.h)
	crn *runs;
	sc_listener *settle;
	int queued;
	// why a process is stopping, by its id, said by api_stop before its scope goes: kept till its
	// scope has gone (else, a den's, till its api_free)
	stopping *whys;
	size_t nwhys, capwhys;
	op_value *ended, *replaced;
	// the memos' nodes: a read of one pending with no value throws pending
	memoed *memos;
	size_t nmemos, capmemos;
	method_rec *methods;
	size_t nmethods, capmethods;
	struct api_watching **watches;
	size_t nwatches, capwatches;
};

struct computer;

struct api {
	api_context *x;
	api_process process;
	pl *places;
	gd *guard;
	int guarded;
	char *why;
	// the memos and effects it made, till each goes: one at a name per run
	struct computer **made;
	size_t nmade, capmade;
};

void api_drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

static void pulse_now(void *data) {
	api_context *x = data;
	x->queued = 0;
	sc_pulse(x->s.scheduler);
}
// one pulse, soon, however many ask
static void later(api_context *x) {
	if (x->queued) return;
	x->queued = 1;
	if (x->s.schedule) x->s.schedule(x->s.schedule_ctx, pulse_now, x);
	else pulse_now(x);
}
static void settled(void *data) { later(data); }

api_context *api_context_new(const api_setup *setup) {
	api_context *x = xalloc(sizeof *x);
	x->s = *setup;
	x->statuses = cst_new(&(cst_setup){setup->places, setup->table, setup->scheduler});
	x->runs = setup->no_runs ? NULL : crn_new(&(crn_setup){setup->places, setup->table, setup->scheduler});
	x->settle = sc_on_settle(setup->scheduler, settled, x);
	x->ended = op_str("ended");
	x->replaced = op_str("replaced");
	return x;
}

void api_context_free(api_context *x) {
	if (x == NULL) return;
	sc_remove_listener(x->settle);
	cst_stop(x->statuses);
	cst_free(x->statuses);
	crn_stop(x->runs);
	crn_free(x->runs);
	for (size_t i = 0; i < x->nwhys; i++) free(x->whys[i].id), op_free(x->whys[i].why);
	free(x->whys);
	op_free(x->ended);
	op_free(x->replaced);
	for (size_t i = 0; i < x->nmemos; i++) free(x->memos[i].id);
	free(x->memos);
	free(x->methods);
	for (size_t i = 0; i < x->nwatches; i++) free(x->watches[i]);
	free(x->watches);
	free(x);
}

api *api_new(api_context *x, const api_starting *c) {
	api *a = xalloc(sizeof *a);
	a->x = x;
	a->process = c->process;
	a->places = c->places ? c->places : x->s.places;
	a->guarded = x->s.may != NULL;
	if (a->guarded) {
		a->guard = gd_new(&(gd_setup){.places = a->places, .table = x->s.table, .may = x->s.may,
			.from = c->process.at, .nfrom = c->process.nat});
	}
	return a;
}

// a process's whys let go: the newest first, all of them
static void forget(api_context *x, const char *id) {
	for (size_t i = x->nwhys; i-- > 0;) {
		if (strcmp(x->whys[i].id, id) != 0) continue;
		free(x->whys[i].id);
		op_free(x->whys[i].why);
		memmove(&x->whys[i], &x->whys[i + 1], (x->nwhys - i - 1) * sizeof *x->whys);
		x->nwhys--;
	}
}

void api_free(api *a) {
	if (a == NULL) return;
	forget(a->x, a->process.id);
	gd_free(a->guard);
	free(a->why);
	free(a->made);
	free(a);
}

const char *api_why(const api *a) { return a->why ? a->why : ""; }

static int fail(api *a, int code, const char *text) {
	free(a->why);
	a->why = xdup(text ? text : api_code_name(code));
	return code;
}

// ids -----------------------------------------------------------------------------------------

// a uuidv7 (rfc 9562), as the TypeScript's: 48 bits of ms, a 12-bit count within the ms (started
// random), then random. later ones sort after: a clock going back, or 4096 in one ms, borrows the
// next ms
static uint64_t last_ms;
static unsigned last_count;
static char *new_id(api_context *x) {
	if (x->s.id) return xdup(x->s.id(x->s.id_ctx));
	unsigned char b[16] = {0};
	FILE *f = fopen("/dev/urandom", "rb");
	if (f == NULL || fread(b, 1, sizeof b, f) != sizeof b) {
		for (size_t i = 0; i < sizeof b; i++) b[i] = (unsigned char)rand();
	}
	if (f) fclose(f);
	struct timespec t;
	clock_gettime(CLOCK_REALTIME, &t);
	uint64_t now = (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
	if (now > last_ms) {
		last_ms = now;
		last_count = ((unsigned)b[6] << 8 | b[7]) & 0x7ff;
	} else if (++last_count > 0xfff) {
		last_ms++;
		last_count = 0;
	}
	for (int i = 0; i < 6; i++) b[i] = (unsigned char)(last_ms >> (8 * (5 - i)));
	b[6] = (unsigned char)(0x70 | last_count >> 8);
	b[7] = (unsigned char)last_count;
	b[8] = (unsigned char)(0x80 | (b[8] & 0x3f));
	char *s = xalloc(37);
	char *o = s;
	for (size_t i = 0; i < sizeof b; i++) {
		if (i == 4 || i == 6 || i == 8 || i == 10) *o++ = '-';
		snprintf(o, 3, "%02x", b[i]);
		o += 2;
	}
	return s;
}

// names ---------------------------------------------------------------------------------------

typedef struct {
	char **v;
	size_t n, cap;
} names;

static void names_push(names *p, const char *s) {
	if (p->v == NULL) p->cap = 4, p->v = xalloc(p->cap * sizeof *p->v);
	if (p->n == p->cap) {
		p->cap *= 2;
		p->v = realloc(p->v, p->cap * sizeof *p->v);
		if (p->v == NULL) abort();
	}
	p->v[p->n++] = xdup(s);
}
static void names_free(names *p) {
	for (size_t i = 0; i < p->n; i++) free(p->v[i]);
	free(p->v);
	*p = (names){0};
}
static void names_make(names *p) {
	if (p->v == NULL) p->cap = 4, p->v = xalloc(p->cap * sizeof *p->v);
}

// one step of path.ts' plan, from "/": "." skipped, ".." takes back a name (none left: -1),
// "/" starts again
static int plan_step(names *r, const char *step) {
	if (strcmp(step, ".") == 0) return 0;
	if (strcmp(step, "/") == 0) {
		for (size_t i = 0; i < r->n; i++) free(r->v[i]);
		r->n = 0;
		return 0;
	}
	if (strcmp(step, "..") != 0) return names_push(r, step), 0;
	if (r->n == 0) return -1;
	free(r->v[--r->n]);
	return 0;
}

// a string as steps from "/", resolved as the process sees it: a bare name is inside its own node,
// ./ its working folder, ../ above that, / the root
static int resolve(api *a, const char *p, names *out) {
	names steps = {0};
	if (p[0] == '/') names_push(&steps, "/");
	const char *s = p;
	while (*s) {
		const char *e = strchr(s, '/');
		size_t len = e ? (size_t)(e - s) : strlen(s);
		if (len) {
			char *piece = xalloc(len + 1);
			memcpy(piece, s, len);
			names_push(&steps, piece);
			free(piece);
		}
		if (!e) break;
		s = e + 1;
	}
	const char *first = steps.n ? steps.v[0] : NULL;
	const char *const *from = a->process.at;
	size_t nfrom = a->process.nat;
	if (first && strcmp(first, "/") == 0) from = NULL, nfrom = 0;
	else if (first && (strcmp(first, ".") == 0 || strcmp(first, "..") == 0)) {
		from = a->process.cwd, nfrom = a->process.ncwd;
	}
	names r = {0};
	names_make(&r);
	int bad = 0;
	for (size_t i = 0; i < nfrom && !bad; i++) bad = plan_step(&r, from[i]);
	for (size_t i = 0; i < steps.n && !bad; i++) bad = plan_step(&r, steps.v[i]);
	names_free(&steps);
	if (bad) return names_free(&r), fail(a, API_NOTHING_THERE, "..");
	*out = r;
	return 0;
}

// nodes ---------------------------------------------------------------------------------------

void api_node_free(api_node *n) {
	for (size_t i = 0; i < n->npath; i++) free(n->path[i]);
	free(n->path);
	free(n->id);
	*n = (api_node){0};
}

// a node taking the names
static api_node node_of(names *p, const char *part) {
	names_make(p);
	api_node n = {.path = p->v, .npath = p->n, .part = part};
	*p = (names){0};
	return n;
}
static api_node node_copy(const api_node *n, const char *part) {
	api_node c = {.part = part};
	if (n->id) c.id = xdup(n->id);
	if (n->path) {
		c.path = xalloc((n->npath + 1) * sizeof *c.path);
		c.npath = n->npath;
		for (size_t i = 0; i < n->npath; i++) c.path[i] = xdup(n->path[i]);
	}
	return c;
}

// a target as a node: borrowed if it is one, else made (tmp) from its string
typedef struct {
	api_node tmp;
	const api_node *n;
} found;
static int found_of(api *a, api_target x, found *f) {
	*f = (found){0};
	if (x.node) return f->n = x.node, 0;
	names p = {0};
	int code = resolve(a, x.path, &p);
	if (code) return code;
	f->tmp = node_of(&p, API_VALUE);
	f->n = &f->tmp;
	return 0;
}
static void found_free(found *f) { api_node_free(&f->tmp); }

static char *id_at(api *a, char *const *path, size_t n) {
	tb_key key;
	if (!pl_get(a->places, CP(path), n, &key)) return NULL;
	return xdup(key.string);
}
// the id a node is, or NULL
static char *id_of(api *a, const api_node *n) {
	if (n->id) return xdup(n->id);
	if (n->path) return id_at(a, n->path, n->npath);
	return NULL;
}
static int need_id(api *a, const api_node *n, char **id) {
	*id = id_of(a, n);
	if (*id) return 0;
	return fail(a, API_NOTHING_THERE, n->path && n->npath ? n->path[n->npath - 1] : "");
}

// the run the reads told said it must end now
static int alive(api *a) { return pl_status(a->places) == SC_STOP ? API_STOP : 0; }

// protect --------------------------------------------------------------------------------------

static int answered(api *a, gd_answer r, const gd_refusal *why) {
	switch (r) {
		case GD_OK: return 0;
		case GD_REFUSED: return fail(a, API_REFUSED, why->reason);
		case GD_PENDING: return fail(a, API_PENDING, "pending");
		default: return API_STOP;
	}
}
static gd_thing thing_of(const char *id, const api_node *n) {
	gd_thing t = {.id = tb_string(id)};
	if (n && n->path) t.path = CP(n->path), t.npath = n->npath;
	return t;
}
// asked of a write; none unless the host gave a policy
static int ask(api *a, const char *op, gd_target t) {
	if (!a->guarded) return 0;
	gd_refusal why = {0};
	gd_answer r = gd_write(a->guard, op, &t, 1, &why);
	return answered(a, r, &why);
}
static int ask_read(api *a, gd_target t) {
	if (!a->guarded) return 0;
	gd_refusal why = {0};
	gd_answer r = gd_read(a->guard, &t, 1, &why);
	return answered(a, r, &why);
}
// the slot of the name last in path[0, count) in the parent: what placing there changes
static int ask_slot(api *a, const char *parent, char *const *path, size_t count) {
	if (!a->guarded) return 0;
	op_value *field;
	gd_thing t = {.id = tb_string(parent), .path = CP(path), .npath = count - 1};
	gd_target target = gd_slot(t, path[count - 1], &field);
	int code = ask(a, "place", target);
	op_free(field);
	return code;
}
// steps as an op_value list, for a target's field
static op_value *field_of(const op_key *path, size_t n) {
	op_value *l = op_list();
	for (size_t i = 0; i < n; i++) {
		if (path[i].type == OP_STR_KEY) op_push(l, op_str(path[i].s));
		else if (path[i].type == OP_NUM_KEY) op_push(l, op_num((double)path[i].n));
	}
	return l;
}

// writes ---------------------------------------------------------------------------------------

static void commit(api *a, const pl_changed *c) {
	if (a->x->s.commit) a->x->s.commit(a->x->s.commit_ctx, c);
	else pl_commit(a->x->s.places, c);
}

// a header made now, with a scope open; extra (n pairs): its innermost metadata (edits: what it
// replaces)
static int header_with(api *a, const sc_pair *extra, size_t n, ch_header *h, pl_made **made) {
	char *bad = pl_header(a->x->s.places, extra, n, NULL, h, made);
	if (bad == NULL) return 0;
	fail(a, API_FAILED, bad);
	free(bad);
	return API_FAILED;
}
static int header(api *a, ch_header *h, pl_made **made) { return header_with(a, NULL, 0, h, made); }
// each entry changed told the header too, which the caller's hold is let go of
static void hold_changed(api *a, const pl_changed *c, pl_made *made) {
	for (size_t i = 0; i < c->n; i++) {
		pl_hold_also(a->x->s.places, c->entries[i], pl_made_ref(made), pl_made_free);
	}
	pl_made_free(made);
}
static int places_code(api *a, int code) {
	switch (code) {
		case 0: return 0;
		case PL_NOT_A_NAME: return fail(a, API_NOT_A_NAME, NULL);
		case PL_NOTHING_THERE: return fail(a, API_NOTHING_THERE, NULL);
		default: return fail(a, API_ALREADY_THERE, NULL);
	}
}

// patches a node's change refers to: copied, held till the node's next update
typedef struct {
	op_patch *patches;
	size_t n;
	op_key *keys;
	char **strs;
	size_t nstrs;
	op_value **vals;
} block;

static void block_free(void *p) {
	block *b = p;
	for (size_t i = 0; i < b->nstrs; i++) free(b->strs[i]);
	for (size_t i = 0; i < b->n; i++) op_free(b->vals[i]);
	free(b->patches), free(b->keys), free(b->strs), free(b->vals);
	free(b);
}
static op_key *copy_keys(block *b, size_t *at, const op_key *src, size_t n) {
	op_key *out = b->keys + *at;
	for (size_t i = 0; i < n; i++) {
		out[i] = src[i];
		if (src[i].type == OP_STR_KEY) out[i].s = b->strs[b->nstrs++] = xdup(src[i].s);
	}
	*at += n;
	return out;
}
static block *block_new(const op_patch *src, size_t n) {
	size_t total = 0;
	for (size_t i = 0; i < n; i++) {
		total += src[i].place.length + (src[i].has_move ? src[i].move.length : 0);
	}
	block *b = xalloc(sizeof *b);
	b->n = n;
	b->patches = xalloc(n * sizeof *b->patches);
	b->keys = xalloc(total * sizeof *b->keys);
	b->strs = xalloc(total * sizeof *b->strs);
	b->vals = xalloc(n * sizeof *b->vals);
	size_t at = 0;
	for (size_t i = 0; i < n; i++) {
		b->patches[i] = src[i];
		b->patches[i].place.path = copy_keys(b, &at, src[i].place.path, src[i].place.length);
		if (src[i].has_move) {
			b->patches[i].move.path = copy_keys(b, &at, src[i].move.path, src[i].move.length);
		}
		b->vals[i] = src[i].has_value ? op_ref((op_value *)src[i].value) : NULL;
		b->patches[i].value = b->vals[i];
	}
	return b;
}

// patches on (part, id): the entry made when there is none (the table event tells its readers),
// else updated and committed. extra: the change's innermost metadata
static int write_with(api *a, const char *part, const char *id, const op_patch *patches, size_t n,
	const sc_pair *extra, size_t nextra) {
	api_context *x = a->x;
	ch_header h;
	pl_made *made;
	int code = header_with(a, extra, nextra, &h, &made);
	if (code) return code;
	block *b = block_new(patches, n);
	nd_entry *e = tb_get(x->s.table, tb_string(part), tb_string(id));
	size_t failed = 0;
	if (e == NULL) {
		op_value *base = strcmp(part, API_ATTRIBUTES) == 0 ? op_map() : NULL;
		e = nd_make_entry(base, &h);
		op_free(base);
		int bad = nd_update(e, b->patches, n, h, &failed);
		if (bad == OP_OK && e->value != NULL) {
			tb_add(x->s.table, tb_string(part), tb_string(id), e);
			pl_own(x->s.places, e);
			pl_hold(x->s.places, e, made, pl_made_free);
			pl_hold_also(x->s.places, e, b, block_free);
			return 0;
		}
		nd_free_entry(e);
		block_free(b);
		pl_made_free(made);
		return bad == OP_OK ? 0 : fail(a, API_FAILED, op_code_name(bad));
	}
	int bad = nd_update(e, b->patches, n, h, &failed);
	if (bad != OP_OK) {
		block_free(b);
		pl_made_free(made);
		return fail(a, API_FAILED, op_code_name(bad));
	}
	pl_changed changed = {1, {e}};
	commit(a, &changed);
	pl_hold(x->s.places, e, made, pl_made_free);
	pl_hold_also(x->s.places, e, b, block_free);
	return 0;
}
static int write(api *a, const char *part, const char *id, const op_patch *patches, size_t n) {
	return write_with(a, part, id, patches, n, NULL, 0);
}
// a whole value as one patch; NULL: taken out
static int write_whole(api *a, const char *part, const char *id, const op_value *v) {
	op_patch p = {0};
	if (v) p.has_value = 1, p.value = v;
	return write(a, part, id, &p, 1);
}
// a new entry holding the value
static int add_entry(api *a, const char *part, const char *id, const op_value *value) {
	ch_header h;
	pl_made *made;
	int code = header(a, &h, &made);
	if (code) return code;
	nd_entry *e = nd_make_entry((op_value *)value, &h);
	tb_add(a->x->s.table, tb_string(part), tb_string(id), e);
	pl_own(a->x->s.places, e);
	pl_hold(a->x->s.places, e, made, pl_made_free);
	return 0;
}

// f with a scope open: the one open, else the process's own
typedef struct {
	api *a;
	int (*f)(api *a, void *data);
	void *data;
	int code;
} thunk;
static void thunk_run(void *data) {
	thunk *t = data;
	t->code = t->f(t->a, t->data);
}
static int within(api *a, int (*f)(api *a, void *data), void *data) {
	if (sc_get_current_scope(a->x->s.scheduler) != NULL) return f(a, data);
	thunk t = {a, f, data, 0};
	const char *bad = sc_run_with_scope(a->process.scope, thunk_run, &t);
	if (bad) return fail(a, API_FAILED, bad);
	return t.code;
}
static sc_scope *owner(api *a) {
	sc_scope *o = sc_get_current_scope(a->x->s.scheduler);
	return o ? o : a->process.scope;
}

// id placed under name in the folder parent (asked as path[0, count) when given): its children
// entry made when it has none
static int place_under(api *a, const char *parent, const char *name, const char *id,
	char *const *path, size_t count) {
	if (path) {
		int code = ask_slot(a, parent, path, count);
		if (code) return code;
	}
	api_context *x = a->x;
	nd_entry *children = tb_get(x->s.table, tb_string("children"), tb_string(parent));
	ch_header h;
	pl_made *made;
	int code = header(a, &h, &made);
	if (code) return code;
	if (children == NULL) {
		op_value *m = op_map();
		op_set(m, name, op_str(id));
		nd_entry *e = nd_make_entry(m, &h);
		op_free(m);
		tb_add(x->s.table, tb_string("children"), tb_string(parent), e);
		pl_own(x->s.places, e);
		pl_hold(x->s.places, e, made, pl_made_free);
		return 0;
	}
	pl_changed changed = {0};
	code = pl_place(x->s.places, children, name, tb_string(id), h, &changed);
	if (code) return pl_made_free(made), places_code(a, code);
	commit(a, &changed);
	hold_changed(a, &changed, made);
	return 0;
}

// a node at path holding value (none: a folder), folders made on the way; given, its id
static int make(api *a, const names *path, const op_value *value, const char *given) {
	char *id = given ? xdup(given) : new_id(a->x);
	if (path->n == 0) return free(id), fail(a, API_ALREADY_THERE, "/");
	char *parent = xdup(pl_root(a->places).string);
	int code = 0;
	for (size_t i = 0; i + 1 < path->n && !code; i++) {
		char *there = id_at(a, path->v, i + 1);
		if (there) {
			free(parent);
			parent = there;
			continue;
		}
		char *folder = new_id(a->x);
		code = place_under(a, parent, path->v[i], folder, path->v, i + 1);
		free(parent);
		parent = folder;
	}
	if (!code) code = ask_slot(a, parent, path->v, path->n);
	if (!code && value) code = add_entry(a, API_VALUE, id, value);
	if (!code) code = place_under(a, parent, path->v[path->n - 1], id, NULL, 0);
	free(parent), free(id);
	return code;
}

// the children entry of the folder a path is in, and the name; nothing there: a code
static int slot(api *a, char *const *path, size_t n, nd_entry **children, const char **name) {
	char *parent = n ? id_at(a, path, n - 1) : NULL;
	nd_entry *c = parent ? tb_get(a->x->s.table, tb_string("children"), tb_string(parent)) : NULL;
	free(parent);
	if (c == NULL || n == 0) return fail(a, API_NOTHING_THERE, NULL);
	*children = c, *name = path[n - 1];
	return 0;
}

// every entry of an id taken out of the table, and its run record out
static void del_all(api *a, const char *id) {
	size_t n;
	const tb_entry *at = tb_at(a->x->s.table, tb_string(id), &n);
	char **parts = xalloc((n + 1) * sizeof *parts);
	for (size_t i = 0; i < n; i++) parts[i] = xdup(at[i].part.string);
	for (size_t i = 0; i < n; i++) tb_del(a->x->s.table, tb_string(parts[i]), tb_string(id)), free(parts[i]);
	free(parts);
	if (a->x->runs) crn_drop(a->x->runs, tb_string(id));
}

// open, create ---------------------------------------------------------------------------------

typedef struct {
	const names *path;
	const op_value *value;
	const char *id;
} making;

static int do_open(api *a, void *data) {
	making *m = data;
	char *there = id_at(a, m->path->v, m->path->n);
	if (there) return free(there), 0;
	return make(a, m->path, m->value, NULL);
}
int api_open(api *a, const char *at, const op_value *value, api_node *out) {
	names p = {0};
	int code = resolve(a, at, &p);
	if (code) return code;
	if (value) {
		making m = {&p, value, NULL};
		code = within(a, do_open, &m);
		if (code) return names_free(&p), code;
		later(a->x);
	}
	*out = node_of(&p, API_VALUE);
	return 0;
}

static int do_create(api *a, void *data) {
	making *m = data;
	return make(a, m->path, m->value, m->id);
}
int api_create(api *a, const char *folder, const op_value *value, api_node *out) {
	names p = {0};
	int code = resolve(a, folder, &p);
	if (code) return code;
	char *id = new_id(a->x);
	names_push(&p, id);
	making m = {&p, value, id};
	code = within(a, do_create, &m);
	free(id);
	if (code) return names_free(&p), code;
	later(a->x);
	*out = node_of(&p, API_VALUE);
	return 0;
}

// reads ----------------------------------------------------------------------------------------

static const memoed *memo_of(api_context *x, const char *id) {
	for (size_t i = 0; i < x->nmemos; i++) {
		if (strcmp(x->memos[i].id, id) == 0) return &x->memos[i];
	}
	return NULL;
}

int api_read(api *a, api_target x, const op_key *path, size_t n, const op_value **out) {
	*out = NULL;
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	char *id = id_of(a, f.n);
	if (id == NULL) return found_free(&f), alive(a);
	if (a->guarded) {
		op_value *field = field_of(path, n);
		code = ask_read(a, gd_target_of(thing_of(id, f.n), f.n->part, n ? field : NULL));
		op_free(field);
	}
	const memoed *memo = strcmp(f.n->part, API_VALUE) == 0 ? memo_of(a->x, id) : NULL;
	if (!code) {
		const op_value *v = pl_read(a->places, tb_string(f.n->part), tb_string(id), path, n);
		code = alive(a);
		if (!code && v == NULL && memo && cst_pending(a->places, tb_string(id))) {
			code = alive(a) ? API_STOP : fail(a, API_PENDING, "pending");
		}
		if (!code) *out = v;
	}
	free(id);
	found_free(&f);
	return code;
}

typedef struct {
	api *a;
	api_target x;
	const op_key *path;
	size_t n;
	const op_value **out;
	int code;
} peeped;

static void peep_run(void *ctx) {
	peeped *p = ctx;
	p->code = api_read(p->a, p->x, p->path, p->n, p->out);
}

int api_peep(api *a, api_target x, const op_key *path, size_t n, const op_value **out) {
	peeped p = {a, x, path, n, out, 0};
	pl_peep(a->places, peep_run, &p);
	if (p.code == API_PENDING) {
		free(a->why);
		a->why = NULL;
		*out = NULL;
		return 0;
	}
	return p.code;
}

// a map's field; not a map: NULL
static const op_value *field(const op_value *m, const char *key) {
	return m && m->type == OP_MAP ? op_get(m, key) : NULL;
}
static int yes(const op_value *m, const char *key) {
	const op_value *v = field(m, key);
	return v && v->type == OP_BOOL && v->bool_;
}
// a number field of a map; none, or not a number: 0
static int number_of(const op_value *m, const char *key, int64_t *out) {
	const op_value *v = field(m, key);
	if (v == NULL || v->type != OP_NUM) return 0;
	*out = (int64_t)v->num;
	return 1;
}
static char *text_of(const op_value *m, const char *key) {
	const op_value *v = field(m, key);
	return v && v->type == OP_STR ? xdup(v->str) : NULL;
}
// sites as values, as sync tells them (playground/together's head_from)
static op_value *sites_of(const ch_site *external, size_t n) {
	op_value *sites = op_list();
	for (size_t i = 0; i < n; i++) {
		const ch_site *x = &external[i];
		op_value *site = op_map();
		op_set(site, "file", op_str(x->file ? x->file : ""));
		op_set(site, "line", op_num((double)x->line));
		if (x->has_column) op_set(site, "column", op_num((double)x->column));
		if (x->function != NULL) op_set(site, "function", op_str(x->function));
		op_push(sites, site);
	}
	return sites;
}

// a commit as sync tells it ({head, lamport, actor, signer, time, external?}): the first item's
// from, or else a conflict's
static api_from from_of(const op_value *h, const char *part, int conflict) {
	api_from f = {.conflict = conflict, .head = text_of(h, "head"),
		.who = op_ref((op_value *)field(h, "actor")),
		.where = op_ref((op_value *)field(h, "external"))};
	f.has_when = number_of(h, "time", &f.when);
	if (conflict) {
		f.signer = text_of(h, "signer");
		number_of(h, "lamport", &f.lamport);
		f.differs = xalloc(sizeof *f.differs);
		f.differs[0] = xdup(part);
		f.ndiffers = 1;
	}
	return f;
}
static void from_free(api_from *f) {
	free(f->head), free(f->by), free(f->signer);
	op_free(f->who), op_free(f->where);
	for (size_t i = 0; i < f->ndiffers; i++) free(f->differs[i]);
	free(f->differs);
}
void api_versions_free(api_versions *versions) {
	for (size_t i = 0; i < versions->n; i++) {
		op_free(versions->items[i].value);
		from_free(&versions->items[i].from);
	}
	free(versions->items);
	*versions = (api_versions){0};
}

// sync's row at path, as its "values" at id has them, tracked: the path's own, or the nearest
// open path's above it ({path, items}); *depth its path's length. none listed: NULL
static const op_value *listed(api *a, const char *part, const char *id, const op_key *path, size_t n,
	size_t *depth) {
	op_key at = {.type = OP_STR_KEY, .s = part};
	const op_value *rows = pl_read(a->places, tb_string("values"), tb_string(id), &at, 1);
	const op_value *near = NULL;
	for (size_t r = 0; rows && rows->type == OP_LIST && r < rows->count; r++) {
		const op_value *steps = field(rows->items[r], "path");
		if (steps == NULL || steps->type != OP_LIST || steps->count > n) continue;
		size_t k = 0;
		for (; k < steps->count; k++) {
			const op_value *s = steps->items[k];
			if (s->type != OP_STR || path[k].type != OP_STR_KEY) break;
			if (strcmp(s->str, path[k].s) != 0) break;
		}
		if (k < steps->count) continue;
		if (near == NULL || steps->count > *depth) near = rows->items[r], *depth = steps->count;
	}
	return near;
}

int api_reads(api *a, api_target x, const op_key *path, size_t n, api_versions *out) {
	*out = (api_versions){0};
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	const op_value *shown;
	code = api_read(a, api_of(f.n), path, n, &shown);
	char *id = code ? NULL : id_of(a, f.n);
	if (id == NULL) return found_free(&f), code;
	const char *part = f.n->part;
	op_value *value = op_ref((op_value *)shown);
	size_t depth = 0;
	const op_value *row = listed(a, part, id, path, n, &depth);
	const op_value *items = field(row, "items");
	code = alive(a);
	if (!code && (items == NULL || items->type != OP_LIST || items->count == 0)) {
		// nothing open there: what read gives, from its entry's change
		const nd_entry *e = tb_get(a->x->s.table, tb_string(part), tb_string(id));
		if (value) {
			api_from from = {0};
			if (e && e->change.actor) from.who = op_ref((op_value *)e->change.actor);
			if (e && e->change.has_time) from.has_when = 1, from.when = e->change.time;
			if (e && e->change.external) {
				from.where = sites_of(e->change.external, e->change.external_length);
			}
			out->items = xalloc(sizeof *out->items);
			out->items[0] = (api_version){.value = value, .from = from};
			out->n = 1;
			value = NULL;
		}
	} else if (!code) {
		out->items = xalloc(items->count * sizeof *out->items);
		op_value scratch = {0};
		for (size_t i = 0; i < items->count; i++) {
			const op_value *it = items->items[i];
			// each value at path (none there: gone)
			const op_value *v = yes(it, "gone") ? NULL
				: pl_at(field(it, "value"), path + depth, n - depth, &scratch);
			api_version version = {
				.value = i == 0 ? value : v == &scratch ? op_num(scratch.num) : op_ref((op_value *)v),
				.from = from_of(field(it, "from"), part, i > 0),
				.gone = v == NULL,
				.inside = yes(it, "inside"),
			};
			out->items[out->n++] = version;
		}
		value = NULL;
	}
	op_free(value);
	free(id);
	found_free(&f);
	return code;
}

void api_items_free(api_items *items) {
	for (size_t i = 0; i < items->n; i++) {
		op_free(items->items[i].value);
		free(items->items[i].from);
		free(items->items[i].id);
	}
	free(items->items);
	*items = (api_items){0};
}
static void items_push(api_items *l, const op_value *v, const char *from, const char *id,
	int refused) {
	api_item it = {.value = op_ref((op_value *)v), .from = xdup(from), .id = id ? xdup(id) : NULL,
		.refused = refused};
	l->items = realloc(l->items, (l->n + 1) * sizeof *l->items);
	if (l->items == NULL) abort();
	l->items[l->n++] = it;
}

int api_entries(api *a, api_target x, api_items *out) {
	*out = (api_items){0};
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	const api_node *n = f.n;
	const char *part = n->part;
	if (n->path == NULL) {
		if (n->id) {
			const op_value *v = pl_read(a->places, tb_string(part), tb_string(n->id), NULL, 0);
			if (v) items_push(out, v, "id", n->id, 0);
			code = alive(a);
		}
		found_free(&f);
		if (code) api_items_free(out);
		return code;
	}
	pl_answers all = pl_gets(a->places, CP(n->path), n->npath);
	if (!a->guarded || n->npath == 0) {
		for (size_t i = 0; i < all.n; i++) {
			items_push(out, pl_read(a->places, tb_string(part), all.items[i].id, NULL, 0),
				all.items[i].from, all.items[i].id.string, 0);
		}
	} else {
		pl_member *in = xalloc((all.n + 1) * sizeof *in);
		for (size_t i = 0; i < all.n; i++) {
			in[i] = (pl_member){n->path[n->npath - 1], all.items[i].id, all.items[i].from};
		}
		pl_members list = {all.n, in}, asked;
		gd_answer r = gd_members(a->guard, &list, CP(n->path), n->npath - 1, &asked);
		free(in);
		code = answered(a, r, &(gd_refusal){"read", "refused"});
		if (!code) {
			for (size_t i = 0; i < all.n; i++) {
				if (gd_is_refused(asked.items[i].id)) {
					items_push(out, NULL, all.items[i].from, NULL, 1);
				} else {
					items_push(out, pl_read(a->places, tb_string(part), all.items[i].id, NULL, 0),
						all.items[i].from, all.items[i].id.string, 0);
				}
			}
			pl_members_free(&asked);
		}
	}
	pl_answers_free(&all);
	if (!code) code = alive(a);
	found_free(&f);
	if (code) api_items_free(out);
	return code;
}

void api_names_free(api_names *names_) {
	for (size_t i = 0; i < names_->n; i++) free(names_->items[i]);
	free(names_->items);
	*names_ = (api_names){0};
}
int api_list(api *a, api_target x, api_names *out) {
	*out = (api_names){0};
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	const api_node *n = f.n;
	if (a->guarded) {
		char *id = id_of(a, n);
		if (id) {
			code = ask_read(a, gd_target_of(thing_of(id, n), "children", NULL));
			free(id);
		}
	}
	if (!code) {
		names got = {0};
		if (n->path) {
			pl_members m = pl_list(a->places, CP(n->path), n->npath);
			for (size_t i = 0; i < m.n; i++) names_push(&got, m.items[i].name);
			pl_members_free(&m);
		} else if (n->id) {
			pl_namelist nl = {0};
			pl_keys(a->places, tb_string("children"), tb_string(n->id), NULL, 0, 0, &nl);
			for (size_t i = 0; i < nl.n; i++) names_push(&got, nl.items[i]);
			pl_namelist_free(&nl);
		}
		out->items = got.v, out->n = got.n;
		code = alive(a);
		if (code) api_names_free(out);
	}
	found_free(&f);
	return code;
}

int api_info(api *a, api_target x, api_node *out) {
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	*out = node_copy(f.n, API_ATTRIBUTES);
	found_free(&f);
	return 0;
}

// edit, watch --------------------------------------------------------------------------------

typedef struct {
	api_target x;
	const op_patch *patches;
	size_t n;
	// edits: what it replaces
	const sc_pair *extra;
	size_t nextra;
} editing;
static int do_edit(api *a, void *data) {
	editing *e = data;
	found f;
	int code = found_of(a, e->x, &f);
	if (code) return code;
	char *id;
	code = need_id(a, f.n, &id);
	if (!code) {
		code = ask(a, "edit", gd_target_of(thing_of(id, f.n), f.n->part, NULL));
		if (!code && e->n) code = write_with(a, f.n->part, id, e->patches, e->n, e->extra, e->nextra);
		free(id);
	}
	found_free(&f);
	return code;
}
int api_edit(api *a, api_target x, const op_patch *patches, size_t n) {
	editing e = {x, patches, n, NULL, 0};
	int code = within(a, do_edit, &e);
	if (!code) later(a->x);
	return code;
}

// the metadata key a write says what it replaces by, for sync: "all", or commit names (hex)
// (playground/together's REPLACES)
#define REPLACES "replaces"

// api_edit's, telling sync what it replaces: every value at each path written, or the ones given
// (by their heads)
int api_edits(api *a, api_target x, const op_patch *patches, size_t n, const api_version *which,
	size_t nwhich) {
	op_value *said = which == NULL ? op_str("all") : op_list();
	for (size_t i = 0; which != NULL && i < nwhich; i++) {
		if (which[i].from.head) op_push(said, op_str(which[i].from.head));
	}
	sc_pair extra = {REPLACES, said};
	editing e = {x, patches, n, &extra, 1};
	int code = within(a, do_edit, &e);
	op_free(said);
	if (!code) later(a->x);
	return code;
}

static void watch_told(const pl_fact *fact, void *ctx) {
	struct api_watching *w = ctx;
	w->fn(fact, w->ctx);
}
static void api_unwatch(api_watching *w) {
	if (w->stopped) return;
	w->stopped = 1;
	pl_stop(w->w);
}
static char *watch_teardown(void *data) {
	api_unwatch(data);
	return NULL;
}
int api_watch(api *a, api_target x, void (*fn)(const pl_fact *fact, void *ctx), void *ctx,
	api_watching **out) {
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	if (f.n->path == NULL) {
		found_free(&f);
		return fail(a, API_NOTHING_THERE, "a node with no place");
	}
	struct api_watching *w = xalloc(sizeof *w);
	w->fn = fn, w->ctx = ctx;
	pl_watching options = {.has_part = 1, .part = tb_string(f.n->part)};
	w->w = pl_watch_path(a->places, CP(f.n->path), f.n->npath, watch_told, w, &options);
	PUSH(a->x->watches, a->x->nwatches, a->x->capwatches, w);
	free(sc_register_teardown(a->x->s.scheduler, owner(a), watch_teardown, w));
	found_free(&f);
	*out = w;
	return 0;
}

// the tree -------------------------------------------------------------------------------------

typedef struct {
	const char *p;
	api_target x;
	const char *to;
} treeing;

static int do_place(api *a, void *data) {
	treeing *t = data;
	names path = {0};
	int code = resolve(a, t->p, &path);
	if (code) return code;
	found f;
	char *id = NULL, *parent = NULL;
	code = found_of(a, t->x, &f);
	if (!code) code = need_id(a, f.n, &id);
	if (!code) {
		parent = path.n ? id_at(a, path.v, path.n - 1) : NULL;
		if (parent == NULL || path.n == 0) code = fail(a, API_NOTHING_THERE, t->p);
	}
	if (!code) code = place_under(a, parent, path.v[path.n - 1], id, path.v, path.n);
	free(id), free(parent);
	found_free(&f);
	names_free(&path);
	return code;
}
int api_place(api *a, const char *at, api_target x) {
	treeing t = {at, x, NULL};
	int code = within(a, do_place, &t);
	if (!code) later(a->x);
	return code;
}

// the name taken out of its folder's children
static int unplace_in(api *a, nd_entry *children, const char *name) {
	ch_header h;
	pl_made *made;
	int code = header(a, &h, &made);
	if (code) return code;
	pl_changed changed = {0};
	code = pl_unplace(a->x->s.places, children, name, h, &changed);
	if (code) return pl_made_free(made), places_code(a, code);
	commit(a, &changed);
	hold_changed(a, &changed, made);
	return 0;
}

static int do_unplace(api *a, void *data) {
	treeing *t = data;
	names path = {0};
	int code = resolve(a, t->p, &path);
	if (code) return code;
	nd_entry *children;
	const char *name;
	code = slot(a, path.v, path.n, &children, &name);
	if (!code) {
		char *parent = id_at(a, path.v, path.n - 1);
		code = ask_slot(a, parent, path.v, path.n);
		free(parent);
	}
	if (!code) code = unplace_in(a, children, name);
	names_free(&path);
	return code;
}
int api_unplace(api *a, const char *at) {
	treeing t = {at, {0}, NULL};
	int code = within(a, do_unplace, &t);
	if (!code) later(a->x);
	return code;
}

static int do_move(api *a, void *data) {
	treeing *t = data;
	names from = {0}, to = {0};
	char *parent = NULL, *into_id = NULL;
	int code = resolve(a, t->p, &from);
	if (!code) code = resolve(a, t->to, &to);
	nd_entry *source = NULL;
	const char *name = NULL;
	if (!code) code = slot(a, from.v, from.n, &source, &name);
	if (!code) {
		gd_refusal why = {0};
		code = answered(a, gd_move(CP(from.v), from.n, CP(to.v), to.n, &why), &why);
	}
	if (!code) {
		parent = id_at(a, from.v, from.n - 1);
		code = ask_slot(a, parent, from.v, from.n);
	}
	if (!code) {
		into_id = to.n ? id_at(a, to.v, to.n - 1) : NULL;
		if (into_id == NULL || to.n == 0) code = fail(a, API_NOTHING_THERE, t->to);
	}
	nd_entry *into = NULL;
	if (!code) {
		into = tb_get(a->x->s.table, tb_string("children"), tb_string(into_id));
		if (into == NULL) {
			op_value *empty = op_map();
			code = add_entry(a, "children", into_id, empty);
			op_free(empty);
			into = tb_get(a->x->s.table, tb_string("children"), tb_string(into_id));
		}
	}
	if (!code) code = ask_slot(a, into_id, to.v, to.n);
	if (!code) {
		ch_header h;
		pl_made *made;
		code = header(a, &h, &made);
		if (!code) {
			pl_changed changed = {0};
			int bad = pl_move(a->x->s.places, source, name, into, to.v[to.n - 1], h, &changed);
			if (bad) pl_made_free(made), code = places_code(a, bad);
			else commit(a, &changed), hold_changed(a, &changed, made);
		}
	}
	free(parent), free(into_id);
	names_free(&from), names_free(&to);
	return code;
}
int api_move(api *a, const char *from, const char *to) {
	treeing t = {from, {0}, to};
	int code = within(a, do_move, &t);
	if (!code) later(a->x);
	return code;
}

static int do_remove(api *a, void *data) {
	treeing *t = data;
	found f;
	int code = found_of(a, t->x, &f);
	if (code) return code;
	char *id;
	code = need_id(a, f.n, &id);
	if (!code) code = ask(a, "remove", gd_target_of(thing_of(id, f.n), NULL, NULL));
	if (!code && f.n->path && f.n->npath) {
		nd_entry *children;
		const char *name;
		if (slot(a, f.n->path, f.n->npath, &children, &name) == 0) {
			const op_value *v = children->value ? op_get(children->value, name) : NULL;
			if (v && v->type == OP_STR && strcmp(v->str, id) == 0) code = unplace_in(a, children, name);
		}
	}
	if (!code) del_all(a, id);
	free(id);
	found_free(&f);
	return code;
}
int api_remove(api *a, api_target x) {
	treeing t = {NULL, x, NULL};
	int code = within(a, do_remove, &t);
	if (!code) later(a->x);
	return code;
}

// computers ------------------------------------------------------------------------------------

typedef struct computer {
	api *a;
	api_context *x;
	char *id;
	names path;
	int memo, early;
	// the scope it was made in
	sc_scope *own;
	// its status and run record given to its node (an early one's first run is before it is made)
	int given;
	// its id as its PL_NODE pair's value, alive as long as it
	op_value *id_value;
	// its code, in place: a run of its owner making it again gives it new code
	api_compute f;
	api_act act;
	void *ctx;
	api_options o;
	sc_computer *c;
	// the cleanups on own asking after it (one per run that made it); its node gone once
	unsigned holds;
	int gone;
} computer;

static sc_out computer_f(void *previous, void *data) {
	computer *c = data;
	if (c->early && !c->given) {
		c->given = 1;
		sc_computer *self = sc_run_computer(sc_get_run(c->x->s.scheduler));
		cst_give(c->x->statuses, self, tb_string(c->id));
		if (c->x->runs) crn_give(c->x->runs, self, tb_string(c->id));
	}
	return c->f(c->a, previous, c->ctx);
}
// equal as a script's Object.is has it: scalars by content, anything else by identity; or the host's
static bool computer_equal(const void *p, const void *q, void *data) {
	computer *c = data;
	if (c->o.equal) return c->o.equal(p, q, c->o.equal_ctx);
	if (p == q) return true;
	const op_value *a = p, *b = q;
	if (a == NULL || b == NULL || a->type != b->type) return false;
	switch (a->type) {
		case OP_NULL: return true;
		case OP_BOOL: return a->bool_ == b->bool_;
		case OP_NUM: return op_same_num(a, b);
		case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
		default: return false;
	}
}
// the result written to the computer's node, when there is one to say
static char *computer_write(computer *c, const op_value *v) {
	if (v == NULL && tb_get(c->x->s.table, tb_string(API_VALUE), tb_string(c->id)) == NULL) {
		return NULL;
	}
	int code = write_whole(c->a, API_VALUE, c->id, v);
	return code ? xdup(api_why(c->a)) : NULL;
}
static char *computer_set(void *value, void *data) { return computer_write(data, value); }
static char *computer_act(void *value, void *previous, void *data) {
	computer *c = data;
	char *bad = computer_write(c, value);
	if (bad) return bad;
	if (c->act) c->act(c->a, value, previous, c->ctx);
	return NULL;
}

// a computer's node gone: unplaced from its name (if it is still there), its entries deleted
static void computer_drop(computer *c) {
	api *a = c->a;
	if (c->memo) {
		for (size_t i = 0; i < c->x->nmemos; i++) {
			if (strcmp(c->x->memos[i].id, c->id) == 0) {
				free(c->x->memos[i].id);
				c->x->memos[i] = c->x->memos[--c->x->nmemos];
				break;
			}
		}
	}
	for (size_t i = 0; i < a->nmade; i++) {
		if (a->made[i] == c) {
			a->made[i] = a->made[--a->nmade];
			break;
		}
	}
	nd_entry *children;
	const char *name;
	if (slot(a, c->path.v, c->path.n, &children, &name) == 0) {
		const op_value *v = children->value ? op_get(children->value, name) : NULL;
		if (v && v->type == OP_STR && strcmp(v->str, c->id) == 0) unplace_in(a, children, name);
	}
	del_all(a, c->id);
}

// a computer's node gone once its computer has. asked again in each run of its owner that makes
// it (a cleanup of that run, run once the next run is done: it finds the computer claimed, alive,
// and leaves it), and as the owner goes (what is under it first). the last one asking frees it
static char *computer_cleanup(void *data) {
	computer *c = data;
	if (c->c != NULL && sc_scope_alive(c->c)) {
		c->holds--;
		return NULL;
	}
	if (!c->gone) {
		c->gone = 1;
		computer_drop(c);
	}
	if (--c->holds == 0) {
		op_free(c->id_value);
		free(c->id);
		names_free(&c->path);
		free(c);
	}
	return NULL;
}
// one more cleanup on its owner asking after it
static void computer_hold(computer *c) {
	c->holds++;
	free(sc_register_teardown(c->x->s.scheduler, c->own, computer_cleanup, c));
}

typedef struct {
	computer *c;
	sc_def def;
	int effect;
} creating;
static void create_in(void *data) {
	creating *m = data;
	sc_pair info = {PL_NODE, m->c->id_value};
	m->c->c = m->effect ? sc_create_effect(m->c->x->s.scheduler, m->def, &info, 1)
	                    : sc_create_computer(m->c->x->s.scheduler, m->def, &info, 1);
}
// the PL_NODE key's id of o or the nearest scope above it with one; none: NULL
static const char *node_above(const sc_scope *o) {
	for (; o != NULL; o = sc_scope_parent(o)) {
		const sc_info *info = sc_scope_info(o);
		for (size_t i = 0; info != NULL && i < info->n; i++) {
			if (strcmp(info->pairs[i].key, PL_NODE) != 0) continue;
			const op_value *v = info->pairs[i].value;
			return v != NULL && v->type == OP_STR ? v->str : NULL;
		}
	}
	return NULL;
}
// a computer's node placed at its path, its scope written (own's PL_NODE key, or the nearest
// above with one; none: not written)
static int place_computer(api *a, void *data) {
	computer *c = data;
	const char *above = node_above(c->own);
	char *parent = c->path.n ? id_at(a, c->path.v, c->path.n - 1) : NULL;
	if (parent == NULL) return free(parent), fail(a, API_NOTHING_THERE, c->path.n ? c->path.v[0] : "");
	int code = place_under(a, parent, c->path.v[c->path.n - 1], c->id, NULL, 0);
	free(parent);
	if (code || above == NULL) return code;
	op_value *scope = op_map();
	op_set(scope, API_SCOPE, op_str(above));
	code = add_entry(a, API_ATTRIBUTES, c->id, scope);
	op_free(scope);
	return code;
}

// the one made at path under own, alive; NULL: none
static computer *made_at(api *a, sc_scope *own, const names *path) {
	for (size_t i = 0; i < a->nmade; i++) {
		computer *o = a->made[i];
		if (o->own != own || o->c == NULL || !sc_scope_alive(o->c) || o->path.n != path->n) continue;
		size_t k = 0;
		while (k < path->n && strcmp(o->path.v[k], path->v[k]) == 0) k++;
		if (k == path->n) return o;
	}
	return NULL;
}

static api_node node_at(const names *path) {
	names copy = {0};
	for (size_t i = 0; i < path->n; i++) names_push(&copy, path->v[i]);
	return node_of(&copy, API_VALUE);
}

static int make_computer(api *a, int memo, int early, const char *name, api_compute f, api_act act,
	void *ctx, const api_options *options, api_node *out, const char *file, int line, const char *func) {
	api_context *x = a->x;
	sc_scope *own = owner(a);
	if (!sc_scope_alive(own)) return fail(a, API_FAILED, SC_DISPOSED);
	if (name == NULL) return fail(a, API_NOT_A_NAME, "a memo or effect with no name");
	names path = {0};
	int code = resolve(a, name, &path);
	if (code) return names_free(&path), code;
	// made at path under own before: claimed, given the new code (a parent's rerun does
	// not destroy its children). as own's run starts, what its earlier runs made is old (the
	// scheduler's): one not old was made in this run, or own has had no run since: already-there
	// (two of a name in one run are refused)
	computer *old = made_at(a, own, &path);
	if (old != NULL) {
		if (!sc_claim(old->c)) {
			names_free(&path);
			return fail(a, API_ALREADY_THERE, name);
		}
		old->f = f, old->act = act, old->ctx = ctx;
		old->o = options ? *options : (api_options){0};
		computer_hold(old);
		*out = node_at(&path);
		names_free(&path);
		later(x);
		return 0;
	}
	computer *c = xalloc(sizeof *c);
	c->a = a, c->x = x, c->memo = memo, c->early = early, c->own = own;
	c->f = f, c->act = act, c->ctx = ctx;
	c->path = path;
	if (options) c->o = *options;
	// its id a new one, flat and opaque: the name only places it
	c->id = new_id(x);
	c->id_value = op_str(c->id);
	code = within(a, place_computer, c);
	if (code) {
		op_free(c->id_value), free(c->id), names_free(&c->path), free(c);
		return code;
	}
	PUSH(a->made, a->nmade, a->capmade, c);
	if (memo) PUSH(x->memos, x->nmemos, x->capmemos, ((memoed){xdup(c->id)}));
	creating m = {.c = c, .effect = !memo};
	m.def = (sc_def){.f = computer_f, .equal = computer_equal, .data = c, .early = early};
	if (memo) m.def.set = computer_set;
	else m.def.effect = computer_act;
	const char *bad = sc_run_with_scope(own, create_in, &m);
	if (bad || c->c == NULL) {
		c->holds = 1;
		computer_cleanup(c);
		return fail(a, API_FAILED, bad ? bad : SC_UNSCOPED);
	}
	if (x->s.sites != NULL) st_note(x->s.sites, c->c, file, line, func);
	cst_give(x->statuses, c->c, tb_string(c->id));
	if (x->runs) crn_give(x->runs, c->c, tb_string(c->id));
	*out = node_at(&c->path);
	computer_hold(c);
	later(x);
	return 0;
}
int api_memo_at(api *a, const char *name, api_compute f, void *ctx, const api_options *options,
	api_node *out, const char *file, int line, const char *func) {
	return make_computer(a, 1, 0, name, f, NULL, ctx, options, out, file, line, func);
}
int api_effect_at(api *a, const char *name, api_compute f, api_act act, void *ctx,
	const api_options *options, api_node *out, const char *file, int line, const char *func) {
	return make_computer(a, 0, 0, name, f, act, ctx, options, out, file, line, func);
}
int api_early_at(api *a, const char *name, api_compute f, api_act act, void *ctx,
	const api_options *options, api_node *out, const char *file, int line, const char *func) {
	return make_computer(a, 0, 1, name, f, act, ctx, options, out, file, line, func);
}

// methods --------------------------------------------------------------------------------------

// a function as a value: a stand-in of {name: "Function", method: its number}
static op_value *method_value(size_t index) {
	op_value *m = op_map();
	op_set(m, "name", op_str("Function"));
	op_set(m, "method", op_num((double)index));
	return op_stand(m);
}
static int method_index(const op_value *v, size_t *index) {
	if (v == NULL || v->type != OP_STAND || v->count != 1 || v->items[0]->type != OP_MAP) return 0;
	const op_value *i = op_get(v->items[0], "method");
	if (i == NULL || i->type != OP_NUM) return 0;
	*index = (size_t)i->num;
	return 1;
}

typedef struct {
	const names *path;
	op_value *fn;
} methoding;
static int do_method(api *a, void *data) {
	methoding *m = data;
	char *id = id_at(a, m->path->v, m->path->n);
	if (id == NULL) return make(a, m->path, m->fn, NULL);
	api_node n = {.path = m->path->v, .npath = m->path->n, .part = API_VALUE};
	int code = ask(a, "edit", gd_target_of(thing_of(id, &n), API_VALUE, NULL));
	if (!code) code = write_whole(a, API_VALUE, id, m->fn);
	free(id);
	return code;
}
int api_method(api *a, const char *at, api_method_fn fn, void *ctx, api_node *out) {
	api_context *x = a->x;
	method_rec rec = {fn, ctx, owner(a)};
	PUSH(x->methods, x->nmethods, x->capmethods, rec);
	names p = {0};
	int code = resolve(a, at, &p);
	if (code) return code;
	methoding m = {&p, method_value(x->nmethods - 1)};
	code = within(a, do_method, &m);
	op_free(m.fn);
	if (code) return names_free(&p), code;
	later(x);
	*out = node_of(&p, API_VALUE);
	return 0;
}

typedef struct {
	const char *id;
	const api_node *n;
	method_rec rec;
	const op_value *const *args;
	size_t nargs;
	op_value *out;
	int code;
} sending;
static void send_ask_in(sending *s, api *a) {
	s->code = ask(a, "execute", gd_target_of(thing_of(s->id, s->n), API_VALUE, NULL));
}
// the two steps run in the call's scope, one thunk each
typedef struct {
	sending *s;
	api *a;
} sendcall;
static void send_do_ask(void *data) {
	sendcall *c = data;
	send_ask_in(c->s, c->a);
}
static void send_do_call(void *data) {
	sendcall *c = data;
	sending *s = c->s;
	s->code = s->rec.fn(c->a, s->args, s->nargs, &s->out, s->rec.ctx);
}

int api_send_at(api *a, api_target x, const op_value *const *args, size_t nargs, op_value **out,
	const char *file, int line, const char *func) {
	*out = NULL;
	api_context *ap = a->x;
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	char *id = id_of(a, f.n);
	const nd_entry *e = id ? tb_get(ap->s.table, tb_string(API_VALUE), tb_string(id)) : NULL;
	size_t index;
	if (e == NULL || !method_index(e->value, &index) || index >= ap->nmethods) {
		const char *where = f.n->path && f.n->npath ? f.n->path[f.n->npath - 1] : f.n->id;
		code = fail(a, API_NOT_A_METHOD, where ? where : "");
		free(id);
		found_free(&f);
		return code;
	}
	sending s = {.id = id, .n = f.n, .rec = ap->methods[index], .args = args, .nargs = nargs};
	size_t nhost = 0;
	const sc_pair *host = ap->s.info ? ap->s.info(ap->s.info_ctx, &nhost) : NULL;
	sc_pair *pairs = xalloc((1 + nhost) * sizeof *pairs);
	op_value *caller = op_str(a->process.id);
	// the caller over the host's: keys unique
	size_t npairs = 0;
	pairs[npairs++] = (sc_pair){"caller", caller};
	for (size_t i = 0; i < nhost; i++)
		if (strcmp(host[i].key, "caller") != 0) pairs[npairs++] = host[i];
	sc_scope *call = sc_create_scope(ap->s.scheduler, pairs, npairs, s.rec.scope);
	if (call != NULL && ap->s.sites != NULL) st_note(ap->s.sites, call, file, line, func);
	if (call == NULL) code = fail(a, API_FAILED, SC_DISPOSED);
	else {
		sendcall c = {&s, a};
		const char *bad = sc_run_with_scope(call, send_do_ask, &c);
		code = bad ? fail(a, API_FAILED, bad) : s.code;
		if (!code) {
			bad = sc_run_with_scope(call, send_do_call, &c);
			code = bad ? fail(a, API_FAILED, bad) : s.code;
		}
		free(sc_teardown(call));
	}
	later(ap);
	free(pairs);
	op_free(caller);
	free(id);
	found_free(&f);
	if (code) op_free(s.out);
	else *out = s.out;
	return code;
}

// teardown, ref ------------------------------------------------------------------------------

static const op_value *why_of(api *a) {
	for (size_t i = a->x->nwhys; i-- > 0;) {
		if (strcmp(a->x->whys[i].id, a->process.id) == 0) return a->x->whys[i].why;
	}
	return sc_scope_alive(a->process.scope) ? a->x->replaced : a->x->ended;
}
typedef struct {
	api *a;
	api_teardown_fn fn;
	void *ctx;
} told;
static char *told_run(void *data) {
	told *t = data;
	t->fn(why_of(t->a), t->ctx);
	free(t);
	return NULL;
}
int api_teardown(api *a, api_teardown_fn fn, void *ctx) {
	told *t = xalloc(sizeof *t);
	*t = (told){a, fn, ctx};
	free(sc_register_teardown(a->x->s.scheduler, owner(a), told_run, t));
	return 0;
}

static int told_before(const api_context *x, const char *id) {
	for (size_t i = 0; i < x->nwhys; i++) {
		if (strcmp(x->whys[i].id, id) == 0) return 1;
	}
	return 0;
}

void api_stop(api_context *x, const api_process *p, const op_value *why) {
	if (why != NULL || !told_before(x, p->id)) {
		stopping s = {xdup(p->id), why ? op_ref((op_value *)why) : op_ref(x->ended)};
		PUSH(x->whys, x->nwhys, x->capwhys, s);
	}
	if (x->s.stop) x->s.stop(x->s.stop_ctx, p);
	if (!sc_scope_alive(p->scope)) forget(x, p->id);
}

typedef struct {
	const names *path;
	op_value *(*make)(void *ctx);
	void *ctx;
} reffing;
static int do_ref(api *a, void *data) {
	reffing *r = data;
	char *id = id_at(a, r->path->v, r->path->n);
	if (id) return free(id), 0;
	op_value *v = r->make(r->ctx);
	int code = make(a, r->path, v, NULL);
	op_free(v);
	return code;
}
int api_ref(api *a, const char *at, op_value *(*make_)(void *ctx), void *ctx, api_node *out) {
	names p = {0};
	int code = resolve(a, at, &p);
	if (code) return code;
	reffing r = {&p, make_, ctx};
	code = within(a, do_ref, &r);
	if (code) return names_free(&p), code;
	later(a->x);
	*out = node_of(&p, API_VALUE);
	return 0;
}

// patch nodes ------------------------------------------------------------------------------------

typedef struct {
	const names *path;
	api_target over;
	const op_value *patches;
} patching;
static int do_patch(api *a, void *data) {
	patching *p = data;
	found f;
	int code = found_of(a, p->over, &f);
	if (code) return code;
	char *on;
	code = need_id(a, f.n, &on);
	if (!code) {
		const nd_entry *base = tb_get(a->x->s.table, tb_string(f.n->part), tb_string(on));
		op_value *v = op_map();
		op_set(v, "on", op_str(on));
		op_set(v, "part", op_str(f.n->part));
		op_set(v, "at", op_num(base && base->change.has_time ? (double)base->change.time : 0));
		op_set(v, "patches", op_ref((op_value *)p->patches));
		char *id = id_at(a, p->path->v, p->path->n);
		if (id == NULL) {
			char *fresh = new_id(a->x);
			code = make(a, p->path, NULL, fresh);
			free(fresh);
			if (!code) id = id_at(a, p->path->v, p->path->n);
		}
		if (!code) code = write_whole(a, "patch", id, v);
		free(id);
		op_free(v);
		free(on);
	}
	found_free(&f);
	return code;
}
int api_patch(api *a, const char *at, api_target over, const op_value *patches, api_node *out) {
	names p = {0};
	int code = resolve(a, at, &p);
	if (code) return code;
	patching m = {&p, over, patches};
	code = within(a, do_patch, &m);
	if (code) return names_free(&p), code;
	later(a->x);
	*out = node_of(&p, API_VALUE);
	return 0;
}

static int do_land(api *a, void *data) {
	api_target *x = data;
	found f;
	int code = found_of(a, *x, &f);
	if (code) return code;
	char *id;
	code = need_id(a, f.n, &id);
	if (code) return found_free(&f), code;
	api_context *ap = a->x;
	if (ap->s.overlay == NULL) code = fail(a, API_FAILED, "no overlay here: the host gave none");
	const nd_entry *e = code ? NULL : tb_get(ap->s.table, tb_string("patch"), tb_string(id));
	if (e && e->value && e->value->type == OP_MAP) {
		const op_value *on = op_get(e->value, "on"), *part = op_get(e->value, "part");
		if (on && on->type == OP_STR && part && part->type == OP_STR) {
			code = ask(a, "edit", gd_target_of(thing_of(on->str, NULL), part->str, NULL));
		}
	}
	if (!code) {
		ch_header h;
		pl_made *made;
		code = header(a, &h, &made);
		if (!code) {
			pl_changed changed = {0};
			nd_entry *fresh = NULL;
			size_t failed = 0;
			int bad = pn_land(ap->s.overlay, tb_string(id), h, &changed, &fresh, &failed);
			if (bad == PN_NOTHING_THERE) pl_made_free(made), code = fail(a, API_NOTHING_THERE, NULL);
			else if (bad) pl_made_free(made), code = fail(a, API_FAILED, op_code_name(bad));
			else if (fresh) {
				pl_own(ap->s.places, fresh);
				pl_hold(ap->s.places, fresh, made, pl_made_free);
			} else {
				commit(a, &changed);
				if (changed.n) pl_hold(ap->s.places, changed.entries[0], made, pl_made_free);
				else pl_made_free(made);
			}
		}
	}
	free(id);
	found_free(&f);
	return code;
}
int api_land(api *a, api_target x) {
	int code = within(a, do_land, &x);
	if (!code) later(a->x);
	return code;
}

void api_layers_free(api_layers *layers) {
	for (size_t i = 0; i < layers->n; i++) {
		op_free(layers->items[i].value);
		free(layers->items[i].from);
		free(layers->items[i].error);
	}
	free(layers->items);
	*layers = (api_layers){0};
}
int api_layers_of(api *a, api_target x, const op_key *path, size_t n, api_layers *out) {
	*out = (api_layers){0};
	found f;
	int code = found_of(a, x, &f);
	if (code) return code;
	char *id = id_of(a, f.n);
	if (id) {
		if (a->guarded) {
			op_value *field = field_of(path, n);
			code = ask_read(a, gd_target_of(thing_of(id, f.n), f.n->part, n ? field : NULL));
			op_free(field);
		}
		if (!code && a->x->s.overlay) {
			pn_items items = pn_entries(a->x->s.overlay, tb_string(f.n->part), tb_string(id), path, n);
			out->items = xalloc((items.n + 1) * sizeof *out->items);
			for (size_t i = 0; i < items.n; i++) {
				out->items[i] = (api_layer){.value = op_ref((op_value *)items.items[i].value),
					.from = xdup(items.items[i].from), .stale = items.items[i].stale,
					.error = items.items[i].error ? xdup(items.items[i].error) : NULL};
			}
			out->n = items.n;
			pn_items_free(&items);
			code = alive(a);
		} else if (!code) {
			const op_value *v = pl_read(a->places, tb_string(f.n->part), tb_string(id), path, n);
			code = alive(a);
			if (!code && v) {
				out->items = xalloc(sizeof *out->items);
				out->items[0] = (api_layer){.value = op_ref((op_value *)v), .from = xdup(PN_TABLE)};
				out->n = 1;
			}
		}
		if (code) api_layers_free(out);
		free(id);
	}
	found_free(&f);
	return code;
}

void api_pulse(api *a) { sc_pulse(a->x->s.scheduler); }
