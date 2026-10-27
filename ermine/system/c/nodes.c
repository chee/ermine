// nodes (system.ts, context.ts, handles.ts), in C: contexts, handles, paths and seen, reads and writes
// of nodes, the placement asks. A's job, function by function (ermine.h says each):
//   contexts: es_context_new, es_context_free, es_resolve, es_within, es_inside, es_owner,
//     es_context_write_at, es_context_remove_at, es_context_ask, es_context_put, es_context_writer.
//     context.ts' createProcessContext: land, headerOf, the guard
//   handles: es_mint, es_handle_lookup, es_handle_in, es_handle_make, es_handle_by_id,
//     es_node_data_copy, es_node_data_free (handles.ts: opaque, data in the ermine's table)
//   paths and seen: es_nodes_new, es_nodes_free, es_running_set, es_running_clear, es_seen_in,
//     es_names_free (system.ts' up, seenIn: up through the names, then a process's path)
//   shared: es_node_of, es_id_of, es_id_through, es_ask_placing, es_place_under,
//     es_build, es_folder_slot
//   reads: es_get_node, es_has_node, es_read, es_read_attributes, es_read_children, es_read_all,
//     es_read_all_attributes, es_read_all_children, es_read_entries, es_peep, es_list, es_get_args,
//     es_children_free, es_versions_free, es_items_free
//   writes: es_ensure_node_at, es_create_node_at, es_ref_at, es_patch_at, es_patch_attributes_at,
//     es_patch_children_at, es_place_at, es_unplace_at, es_rename_at, es_remove_at
//   pipes (system.ts' pipe, listen, told, pipeStatus, gonePipe): es_pipe_at, es_pipes_told,
//     es_pipe_looped. a pipe is a node of its own in its own scope, told the writes at its from
//   the placement asks: place, then read and edit of the node (es_ask_placing)
// a failure is a code and es_thrown(): a PlacesError's message is "code" or "code (at)", an
// ErmineError's "code: message", a Refusal's "op refused: reason"
#include "ermine.h"

#include <stdio.h>

// the arrays places' functions take
#define CP(x) ((const char *const *)(x))

// 0, or the code of an ermine closed
#define ALIVE(c) \
	do { \
		int alive_ = es_alive((c)->ermine); \
		if (alive_) return alive_; \
	} while (0)
#define TRY(call) \
	do { \
		int code_ = (call); \
		if (code_) return code_; \
	} while (0)

// failures -------------------------------------------------------------------------------------------

// a PlacesError: "nothing-there", or "nothing-there (n7)" with the name asked about
static int places_fail(int code, const char *at) {
	const char *name = es_code_name(code);
	return at == NULL ? es_fail(code, "%s", name) : es_fail(code, "%s (%s)", name, at);
}
static int not_a_handle(void) {
	return es_fail(ES_NOT_A_HANDLE,
		"not-a-handle: a node is given by @ermine/system's functions (getNode, ensureNode, createMemo "
		"…) or a path, never written as an object");
}
static int not_patches(void) {
	return es_fail(ES_NOT_PATCHES,
		"not-patches: patchChildren: one name a patch, { path: [name], value: node } or { path: [name] }");
}

// the reads told since the last ask said the run must end now
static int check(es_context *c) {
	return pl_status(c->places) == SC_OK ? 0 : es_fail(ES_STOP, "%s", "");
}

// names ------------------------------------------------------------------------------------------------

static void names_init(es_names *p) {
	p->names = es_alloc(sizeof(char *));
	p->n = 0;
}
static void names_add(es_names *p, const char *s) {
	p->names = realloc(p->names, (p->n + 2) * sizeof *p->names);
	if (p->names == NULL) abort();
	p->names[p->n++] = es_dup(s);
	p->names[p->n] = NULL;
}
static void names_pop(es_names *p) {
	free(p->names[--p->n]);
	p->names[p->n] = NULL;
}
static es_names names_of(const char *const *src, size_t n) {
	es_names out;
	names_init(&out);
	for (size_t i = 0; i < n; i++) names_add(&out, src[i]);
	return out;
}
// the names joined by "/": the message's at
static char *names_join(const char *const *names, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(names[i]) + 1;
	char *s = es_alloc(len), *o = s;
	for (size_t i = 0; i < n; i++) {
		if (i) *o++ = '/';
		size_t k = strlen(names[i]);
		memcpy(o, names[i], k);
		o += k;
	}
	*o = 0;
	return s;
}
static int places_fail_path(int code, const char *const *path, size_t n) {
	char *at = names_join(path, n);
	places_fail(code, at);
	free(at);
	return code;
}

void es_names_free(es_names *names) {
	for (size_t i = 0; i < names->n; i++) free(names->names[i]);
	free(names->names);
	*names = (es_names){0};
}

// a string's steps (path.ts' parse): a leading "/" is the root, empty pieces are skipped
static void parse(const char *s, es_names *out) {
	if (s[0] == '/') names_add(out, "/");
	while (*s) {
		const char *e = strchr(s, '/');
		size_t len = e ? (size_t)(e - s) : strlen(s);
		if (len) {
			char *piece = es_alloc(len + 1);
			memcpy(piece, s, len);
			names_add(out, piece);
			free(piece);
		}
		if (!e) break;
		s = e + 1;
	}
}
// one step of path.ts' plan: "." skipped, ".." takes back a name (none left: 1), "/" starts again
static int plan_step(es_names *r, const char *step) {
	if (strcmp(step, ".") == 0) return 0;
	if (strcmp(step, "/") == 0) {
		while (r->n) names_pop(r);
		return 0;
	}
	if (strcmp(step, "..") != 0) return names_add(r, step), 0;
	if (r->n == 0) return 1;
	names_pop(r);
	return 0;
}

int es_resolve(es_context *c, es_at p, es_names *out) {
	*out = (es_names){0};
	ALIVE(c);
	es_names steps;
	names_init(&steps);
	if (p.text != NULL) parse(p.text, &steps);
	else for (size_t i = 0; i < p.nsteps; i++) names_add(&steps, p.steps[i]);
	const char *first = steps.n ? steps.names[0] : NULL;
	char **from = c->at;
	size_t nfrom = c->nat;
	if (first != NULL && strcmp(first, "/") == 0) from = NULL, nfrom = 0;
	else if (first != NULL && (strcmp(first, ".") == 0 || strcmp(first, "..") == 0)) {
		from = c->folder, nfrom = c->nfolder;
	}
	es_names r;
	names_init(&r);
	int bad = 0;
	for (size_t i = 0; i < nfrom && !bad; i++) bad = plan_step(&r, from[i]);
	for (size_t i = 0; i < steps.n && !bad; i++) bad = plan_step(&r, steps.names[i]);
	es_names_free(&steps);
	if (bad) return es_names_free(&r), places_fail(ES_NOTHING_THERE, "..");
	*out = r;
	return 0;
}

// node data ---------------------------------------------------------------------------------------------

es_node_data es_node_data_copy(const es_node_data *n) {
	es_node_data c = {0};
	c.has_path = n->has_path;
	if (n->has_path) {
		c.path = es_alloc((n->npath + 1) * sizeof *c.path);
		c.npath = n->npath;
		for (size_t i = 0; i < n->npath; i++) c.path[i] = es_dup(n->path[i]);
	}
	if (n->id != NULL) c.id = es_dup(n->id);
	if (n->part != NULL) c.part = es_dup(n->part);
	return c;
}

void es_node_data_free(es_node_data *n) {
	for (size_t i = 0; i < n->npath; i++) free(n->path[i]);
	free(n->path);
	free(n->id);
	free(n->part);
	*n = (es_node_data){0};
}

// a node at a path (the names taken), or at an id
static es_node_data node_at_path(es_names *names, const char *part) {
	es_node_data d = {0};
	d.has_path = 1;
	d.path = names->names;
	d.npath = names->n;
	d.part = es_dup(part);
	*names = (es_names){0};
	return d;
}
static es_node_data node_at_id(const char *id, const char *part) {
	es_node_data d = {0};
	d.id = es_dup(id);
	d.part = es_dup(part);
	return d;
}

// the state ------------------------------------------------------------------------------------------------

// a process's node, where it runs: its path from the root
typedef struct {
	es_names at;
} running_rec;

struct es_handle {
	es_handle_data d;
};

// pipes (see the section) ------------------------------------------------------------------------------
typedef struct pipe pipe_t;
// a write heard at a node a pipe listens to
typedef struct {
	pipe_t *p;
	// the way back: a write at the pipe's to
	int back;
	pl_watch *watch;
	int stopped;
	es_names path;
	char *part;
} listening;
struct pipe {
	es_ermine *e;
	// the context that made it: the writes it makes are asked as this one
	es_context *cx;
	char *id;
	// its scope's info: the node, and that it is a pipe (a scope borrows its info)
	op_value *id_value, *flag;
	sc_scope *scope;
	// who made it: the computer whose run made it, else the scope open then; and the run (n 0: none)
	const void *owner;
	sc_computer *run_computer;
	unsigned run_n;
	char *key;
	es_names path;
	const es_handle *from, *to;
	es_pipe_tell tell;
	es_pipe_map there, back;
	void *ctx;
	int write;
	// told no more
	int looping;
	// its status says so
	int looped;
	// how many writes in a row it was told were pipes'
	unsigned chain;
	listening **listens;
	size_t nlistens, caplistens;
	// what it listens at (from's path and part, and to's with a way back): made again, listened at again
	// only when this changes
	char *watching;
	int gone;
	// where it is in all_pipes
	size_t at;
};
// a write a pipe heard, to be told at the next pulse; its patches copied (block, below)
typedef struct block block;
typedef struct {
	pipe_t *p;
	int back, by_pipe, refused;
	block *patches;
	op_value *value;
	// the view, and its change held (a view lasts while its change does)
	const es_change_view *change;
	op_value *held;
} heard_t;
// how many pipes an owner's run has made, by the owner (a computer, with its run's n; else a scope)
typedef struct {
	const void *owner;
	unsigned run_n, count;
} order_t;
// a teardown registered on a pipe's scope: freed as it runs. at: where it is in regs
typedef struct {
	es_ermine *e;
	pipe_t *p;
	sc_scope *scope;
	size_t at;
} pipe_reg;

struct es_nodes {
	es_ermine *ermine;
	es_map running;
	// what each reader waits on, a node it read that was not there: es_missing, by reader. only a
	// computer's, for its latest run, and a process's while its setup runs (setting)
	es_map missing;
	// the processes whose setup is running now, by node
	es_map setting;
	es_context **contexts;
	size_t ncontexts, capcontexts;
	// the pipes: by their node's path (a key), by their id; every one not freed. a pipe holds its
	// scope (the maker's hold): made again, the old one let go. gone (its scope torn down, not
	// made again): freed as no telling is going on (telling: how deep), what it heard dropped
	es_map pipes, pipe_ids;
	pipe_t **all_pipes;
	size_t nall_pipes, capall_pipes;
	pipe_t **gone_pipes;
	size_t ngone_pipes, capgone_pipes;
	unsigned telling;
	heard_t *piped;
	size_t npiped, cappiped;
	order_t **orders;
	size_t norders, caporders;
	pipe_reg **regs;
	size_t nregs, capregs;
	// how deep pipes told as writes land are now (a pipe's write telling a pipe)
	unsigned pipe_depth;
	// every handle by what it names (handle_name): one a name
	es_map named;
};

static struct es_nodes *state(es_ermine *e) { return es_nodes_new(e); }

struct es_nodes *es_nodes_new(es_ermine *e) {
	if (e->nodes != NULL) return e->nodes;
	e->nodes = es_alloc(sizeof *e->nodes);
	e->nodes->ermine = e;
	return e->nodes;
}


static void running_free(running_rec *r) {
	es_names_free(&r->at);
	free(r);
}

static void missing_free(es_missing *m) {
	for (size_t i = 0; i < m->npaths; i++) es_names_free(&m->paths[i]);
	free(m->paths);
	es_map_free(&m->keys);
	free(m);
}

static void pipes_free(struct es_nodes *x);
void es_nodes_free(struct es_nodes *x) {
	if (x == NULL) return;
	for (size_t i = 0; i < x->running.n; i++) running_free(x->running.vals[i]);
	es_map_free(&x->running);
	for (size_t i = 0; i < x->missing.n; i++) missing_free(x->missing.vals[i]);
	es_map_free(&x->missing);
	es_map_free(&x->setting);
	pipes_free(x);
	// every handle, with the ermine
	es_map_free(&x->named);
	es_ermine *e = x->ermine;
	for (size_t i = 0; i < e->handles.cap; i++) {
		es_handle *h = (es_handle *)e->handles.keys[i];
		if (h == NULL) continue;
		es_node_data_free(&h->d.node);
		free(h);
	}
	pm_clear(&e->handles);
	// contexts not let go yet (es_context_free took the rest out)
	e->nodes = NULL;
	while (x->ncontexts) es_context_free(x->contexts[--x->ncontexts]);
	free(x->contexts);
	free(x);
}

// handles ------------------------------------------------------------------------------------------------

// what a handle names, as one string: its part, then its path's names or its id, each its length
// first (a name may hold any byte but NUL)
static char *handle_name(const es_node_data *n) {
	const char *part = n->part != NULL ? n->part : "";
	size_t len = strlen(part) + 32;
	if (n->has_path)
		for (size_t i = 0; i < n->npath; i++) len += strlen(n->path[i]) + 24;
	if (n->id != NULL) len += strlen(n->id) + 24;
	char *s = es_alloc(len), *o = s;
	o += snprintf(o, len, "%zu:%s%c", strlen(part), part, n->has_path ? 'p' : 'i');
	if (n->has_path)
		for (size_t i = 0; i < n->npath; i++) o += snprintf(o, len - (size_t)(o - s), "%zu:%s", strlen(n->path[i]), n->path[i]);
	if (n->id != NULL) snprintf(o, len - (size_t)(o - s), "%zu:%s", strlen(n->id), n->id);
	return s;
}

// one handle a name: a handle is what it names and nothing else (a name, not power), so the same
// name is the same handle, made once and kept till close. the reference's are new each time, kept
// while referenced (a WeakMap); in C a program's pointer is not seen, so they are never let go, and
// steady use names the same nodes, not more [builder's pick, 10-26]
es_handle *es_mint(es_ermine *e, const es_node_data *node) {
	struct es_nodes *x = state(e);
	char *name = handle_name(node);
	es_handle *h = es_map_get(&x->named, name);
	if (h == NULL) {
		h = es_alloc(sizeof *h);
		h->d.node = es_node_data_copy(node);
		pm_set(&e->handles, h, h);
		es_map_set(&x->named, name, h);
	}
	free(name);
	return h;
}

const es_handle_data *es_handle_lookup(es_ermine *e, const void *h) {
	if (h == NULL) return NULL;
	const es_handle *found = pm_get(&e->handles, h);
	return found == NULL ? NULL : &found->d;
}

es_handle *es_handle_in(es_ermine *e, const op_value *v) {
	es_handle *h = es_live_of(v, "handle");
	return h != NULL && pm_has(&e->handles, h) ? h : NULL;
}

// a handle for n: a place (its path from the root) or a node by id. no maker: a handle names a
// place, whoever made it
es_handle *es_handle_make(es_context *c, const es_node_data *n) { return es_mint(c->ermine, n); }

es_handle *es_handle_by_id(es_context *c, const char *id, const char *part) {
	es_node_data n = node_at_id(id, part);
	es_handle *h = es_mint(c->ermine, &n);
	es_node_data_free(&n);
	return h;
}

// a handle for the names (taken), made by c
static es_handle *handle_at(es_context *c, es_names *names, const char *part) {
	es_node_data n = node_at_path(names, part);
	es_handle *h = es_handle_make(c, &n);
	es_node_data_free(&n);
	return h;
}

// contexts ------------------------------------------------------------------------------------------------

static char **dup_names(const char *const *src, size_t n) {
	char **out = es_alloc((n + 1) * sizeof *out);
	for (size_t i = 0; i < n; i++) out[i] = es_dup(src[i]);
	return out;
}
static void free_names(char **names, size_t n) {
	for (size_t i = 0; i < n; i++) free(names[i]);
	free(names);
}

es_context *es_context_new(es_ermine *e, const es_context_options *o) {
	es_context *c = es_alloc(sizeof *c);
	c->ermine = e;
	c->scope = o->scope;
	c->folder = dup_names(o->folder, o->nfolder);
	c->nfolder = o->nfolder;
	c->at = dup_names(o->at, o->nat);
	c->nat = o->nat;
	c->args = dup_names(o->args, o->nargs);
	c->nargs = o->nargs;
	c->process = o->process;
	c->places = o->places;
	c->node = es_dup(o->node);
	c->guarded = e->may != NULL;
	if (c->guarded) {
		c->guard = gd_new(&(gd_setup){.places = c->places, .table = e->table, .may = e->may,
			.from = CP(c->at), .nfrom = c->nat, .caller = es_caller_place, .caller_ctx = c});
	}
	struct es_nodes *x = state(e);
	ES_PUSH(x->contexts, x->ncontexts, x->capcontexts, c);
	return c;
}

void es_context_free(es_context *c) {
	if (c == NULL) return;
	es_ermine *e = c->ermine;
	struct es_nodes *x = e->nodes;
	if (x != NULL) {
		for (size_t i = 0; i < x->ncontexts; i++) {
			if (x->contexts[i] != c) continue;
			x->contexts[i] = x->contexts[--x->ncontexts];
			break;
		}
	}
	es_computer_forget(c);
	gd_free(c->guard);
	free_names(c->folder, c->nfolder);
	free_names(c->at, c->nat);
	free_names(c->args, c->nargs);
	free(c->node);
	free(c);
}

// f with a scope open ----------------------------------------------------------------------------------

typedef struct {
	es_thunk f;
	void *ctx;
	int code;
} thunk;
static void thunk_run(void *data) {
	thunk *t = data;
	t->code = t->f(t->ctx);
}

int es_within(es_context *c, es_thunk f, void *ctx) {
	ALIVE(c);
	thunk t = {f, ctx, 0};
	const char *bad = sc_run_with_scope(c->scope, thunk_run, &t);
	if (bad != NULL) return es_fail_text(bad);
	return t.code;
}

// nothing open: a process's is nothing-open (its functions are called from its setup, runs, acts and
// calls; after an await, a timer, a listener: nothing is open); the host's falls back to its own scope
int es_inside(es_context *c, es_thunk f, void *ctx) {
	ALIVE(c);
	if (sc_get_current_scope(c->ermine->scheduler) != NULL) return f(ctx);
	if (c->process != NULL) {
		return es_fail(ES_NOTHING_OPEN,
			"nothing-open: nothing is open here (after an await, a timer, a listener): write from a "
			"setup, a memo, an effect or an action, or open the process (within)");
	}
	return es_within(c, f, ctx);
}

sc_scope *es_owner(es_context *c) {
	sc_scope *o = sc_get_current_scope(c->ermine->scheduler);
	return o != NULL ? o : c->scope;
}

// asking ---------------------------------------------------------------------------------------------------

static int answered(gd_answer a, const gd_refusal *why) {
	switch (a) {
	case GD_OK: return 0;
	case GD_REFUSED: return es_fail_refusal(why, NULL, NULL);
	case GD_PENDING: return es_fail(ES_PENDING, "%s", "");
	default: return es_fail(ES_STOP, "%s", "");
	}
}

int es_context_ask(es_context *c, const char *op, const gd_target *targets, size_t n) {
	if (!c->guarded) return 0;
	gd_refusal why = {0};
	return answered(gd_write(c->guard, op, targets, n, &why), &why);
}
static int ask(es_context *c, const char *op, gd_target t) { return es_context_ask(c, op, &t, 1); }
static int ask_read(es_context *c, gd_target t) {
	if (!c->guarded) return 0;
	gd_refusal why = {0};
	return answered(gd_read(c->guard, &t, 1, &why), &why);
}
// whether the policy refuses reading t (asked as read asks: a pending answer is PENDING)
static int refused(es_context *c, gd_target t, int *no) {
	*no = 0;
	if (!c->guarded) return 0;
	gd_refusal why = {0};
	gd_answer a = gd_read(c->guard, &t, 1, &why);
	if (a == GD_REFUSED) return *no = 1, 0;
	return answered(a, &why);
}

static gd_thing thing_of(const char *id, const es_node_data *n) {
	gd_thing t = {.id = tb_string(id)};
	if (n != NULL && n->has_path) t.path = CP(n->path), t.npath = n->npath;
	return t;
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
// the slot of the name last in path, in the folder parent: what placing there changes. *field: the
// caller's, op_free
static gd_target slot_at(const char *parent, const char *const *path, size_t npath,
	op_value **field) {
	gd_thing t = {.id = tb_string(parent), .path = path, .npath = npath - 1};
	return gd_slot(t, path[npath - 1], field);
}
static int ask_slot(es_context *c, const char *parent, const char *const *path, size_t npath) {
	if (!c->guarded) return 0;
	op_value *field;
	gd_target slot = slot_at(parent, path, npath, &field);
	int code = ask(c, "place", slot);
	op_free(field);
	return code;
}

static int up_go(es_ermine *e, const pl *places, const char *root, const char *at, es_map *visited,
	es_names *out);

// ids and nodes ----------------------------------------------------------------------------------------------

// the id at a path, tracked; *out NULL: nothing there. borrowed from the table
static int get_id(es_context *c, const char *const *path, size_t n, const char **out) {
	tb_key k;
	*out = pl_get(c->places, path, n, &k) ? k.string : NULL;
	return check(c);
}

int es_id_of(es_context *c, const es_node_data *n, const char **out) {
	if (n->id != NULL) return *out = n->id, 1;
	if (n->has_path) {
		tb_key k;
		if (pl_get(c->places, CP(n->path), n->npath, &k)) return *out = k.string, 1;
	}
	return *out = NULL, 0;
}

static int need_id(es_context *c, const es_node_data *n, const char **out) {
	if (es_id_of(c, n, out)) return 0;
	if (check(c)) return ES_STOP;
	if (!n->has_path) return places_fail(ES_NOTHING_THERE, NULL);
	return places_fail_path(ES_NOTHING_THERE, CP(n->path), n->npath);
}

int es_handle_id(es_ermine *e, const es_node_data *n, const char **out) {
	if (n->id != NULL) return *out = n->id, 1;
	tb_key k;
	return (*out = pl_get(e->places, CP(n->path), n->npath, &k) ? k.string : NULL) != NULL;
}

int es_node_of(es_context *c, es_target x, es_node_data *out) {
	es_ermine *e = c->ermine;
	*out = (es_node_data){0};
	ALIVE(c);
	if (x.node == NULL) {
		es_names path;
		TRY(es_resolve(c, x.at, &path));
		*out = node_at_path(&path, "value");
		return 0;
	}
	const es_handle_data *d = es_handle_lookup(e, x.node);
	if (d == NULL) return not_a_handle();
	return *out = es_node_data_copy(&d->node), 0;
}

int es_id_through(es_context *c, es_target x, char **out) {
	*out = NULL;
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	const char *id;
	int code = need_id(c, &n, &id);
	if (!code) *out = es_dup(id);
	es_node_data_free(&n);
	return code;
}

// the placement asks ---------------------------------------------------------------------------------------

int es_ask_placing(es_context *c, const gd_target *slot, es_target x, const char *id) {
	if (!c->guarded) return 0;
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	gd_thing thing = thing_of(id, &n);
	gd_target node = gd_target_of(thing, "value", NULL);
	static const char *const plain[] = {"read", "edit"};
	static const char *const action[] = {"read", "edit", "execute"};
	int is_action = es_is_action(c->ermine, id);
	gd_refusal why = {0};
	gd_answer a = gd_place(c->guard, slot, &node, is_action ? action : plain, is_action ? 3 : 2,
		&why);
	es_node_data_free(&n);
	return answered(a, &why);
}

// patches ------------------------------------------------------------------------------------------------------

// the patches placing, unplacing and moving make, in stack room: built here, borrowed for the write
typedef struct {
	op_patch p[2];
	op_key key[4];
	op_value *own[2];
	size_t n;
} pset;
static void pset_free(pset *s) {
	for (size_t i = 0; i < 2; i++) op_free(s->own[i]);
	*s = (pset){0};
}
// a patch at the path [name] (key k), with a value, or taking the name out
static void pset_name(pset *s, size_t k, const char *name, op_value *value) {
	s->key[k] = (op_key){.type = OP_STR_KEY, .s = name};
	op_patch *p = &s->p[s->n++];
	*p = (op_patch){.place = {.path = &s->key[k], .length = 1}};
	if (value != NULL) {
		p->has_value = 1;
		p->value = value;
		s->own[s->n - 1] = value;
	}
}

// the entry's value is a map; a name in it
static int is_map(const nd_entry *e) { return e != NULL && e->value != NULL && e->value->type == OP_MAP; }
static const char *child_of(const nd_entry *children, const char *name) {
	if (!is_map(children)) return NULL;
	const op_value *v = op_get(children->value, name);
	return v != NULL && v->type == OP_STR ? v->str : NULL;
}

// place's patches, checked as place checks: children may be none (made by them)
static int placing(const nd_entry *children, const char *name, const char *id, pset *s) {
	*s = (pset){0};
	if (!pl_is_name(name)) return places_fail(ES_NOT_A_NAME, name);
	if (is_map(children) && op_get(children->value, name) != NULL) {
		return places_fail(ES_ALREADY_THERE, name);
	}
	if (!is_map(children)) {
		s->p[0] = (op_patch){.has_value = 1, .value = s->own[0] = op_map()};
		s->n = 1;
	}
	pset_name(s, 0, name, op_str(id));
	return 0;
}
// unplace's patches, checked as unplace checks
static int unplacing(const nd_entry *children, const char *name, pset *s) {
	*s = (pset){0};
	if (child_of(children, name) == NULL) return places_fail(ES_NOTHING_THERE, name);
	pset_name(s, 0, name, NULL);
	return 0;
}

// whole value as one patch
static op_patch whole(const op_value *v) {
	op_patch p = {0};
	if (v != NULL) p.has_value = 1, p.value = v;
	return p;
}

// writing ---------------------------------------------------------------------------------------------------------

// patches a node's change refers to: copied, held till the node's next update
struct block {
	op_patch *patches;
	size_t n;
	op_key *keys;
	char **strs;
	size_t nstrs;
	op_value **vals;
};

static void block_free(void *p) {
	block *b = p;
	for (size_t i = 0; i < b->nstrs; i++) free(b->strs[i]);
	for (size_t i = 0; i < b->n; i++) op_free(b->vals[i]);
	free(b->patches);
	free(b->keys);
	free(b->strs);
	free(b->vals);
	free(b);
}
static op_key *copy_keys(block *b, size_t *at, const op_key *src, size_t n) {
	op_key *out = b->keys + *at;
	for (size_t i = 0; i < n; i++) {
		out[i] = src[i];
		if (src[i].type == OP_STR_KEY) out[i].s = b->strs[b->nstrs++] = es_dup(src[i].s);
	}
	*at += n;
	return out;
}
static block *block_new(const op_patch *src, size_t n) {
	size_t total = 0;
	for (size_t i = 0; i < n; i++) {
		total += src[i].place.length + (src[i].has_move ? src[i].move.length : 0);
	}
	block *b = es_alloc(sizeof *b);
	b->n = n;
	b->patches = es_alloc(n * sizeof *b->patches);
	b->keys = es_alloc(total * sizeof *b->keys);
	b->strs = es_alloc(total * sizeof *b->strs);
	b->vals = es_alloc(n * sizeof *b->vals);
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

// a write a hook changed: the metadata with its hooks added (the header's own, with FEATURES put)
typedef struct {
	ch_entry *meta;
	op_value *list;
} featured;
static void featured_free(void *p) {
	featured *f = p;
	free(f->meta);
	op_free(f->list);
	free(f);
}

// the change a write lands with: its writer's, or made now; a write a hook changed, that one's copy
// naming the hooks. *made: the block of a header made now; *fx: the metadata made
static int header_of(es_ermine *e, const es_write *w, ch_header *h, pl_made **made,
	featured **fx) {
	*made = NULL;
	*fx = NULL;
	if (w->header != NULL) *h = *w->header;
	else TRY(es_header(e, h, made));
	if (w->nfeatures == 0) return 0;
	featured *f = es_alloc(sizeof *f);
	f->meta = es_alloc((h->metadata_length + 1) * sizeof *f->meta);
	size_t k = 0;
	for (size_t i = 0; i < h->metadata_length; i++) {
		if (strcmp(h->metadata[i].key, ES_FEATURES) != 0) f->meta[k++] = h->metadata[i];
	}
	f->list = op_list();
	for (size_t i = 0; i < w->nfeatures; i++) op_push(f->list, op_str(w->features[i]));
	f->meta[k++] = (ch_entry){ES_FEATURES, f->list};
	h->metadata = f->meta;
	h->metadata_length = k;
	*fx = f;
	return 0;
}

// holds on a node's change: the first replaces the node's last, the rest are added
static void hold(es_ermine *e, const nd_entry *entry, int *first, void *blk,
	void (*release)(void *)) {
	if (blk == NULL) return;
	if (*first) pl_hold(e->places, entry, blk, release), *first = 0;
	else pl_hold_also(e->places, entry, blk, release);
}

// what a part holds when nothing is there: attributes and a status are maps, so {}; a value, nothing
static op_value *empty(const char *part) {
	return strcmp(part, "attributes") == 0 || strcmp(part, CST_TABLE) == 0 ? op_map() : NULL;
}

static int apply_failed(int code, size_t failed) {
	return es_fail(ES_FAILED, "%s (patch %zu)", op_code_name(code), failed);
}

// the write landed: the entry made when there is none (the table event tells its readers), else
// updated and said. gone: the entry taken out
static int land(void *ctx, const es_write *w) {
	es_ermine *e = ctx;
	tb_key part = tb_string(w->part), id = tb_string(w->id);
	nd_entry *entry = tb_get(e->table, part, id);
	// an action's node going, or written over: its record let go
	void *held = entry != NULL && strcmp(w->part, "value") == 0
		? es_action_held(e, entry->value) : NULL;
	if (w->gone) {
		if (entry != NULL) tb_del(e->table, part, id);
		es_action_let_go(e, held, NULL);
		return 0;
	}
	ch_header h;
	pl_made *made;
	featured *fx;
	TRY(header_of(e, w, &h, &made, &fx));
	int first = 1;
	if (entry == NULL) {
		op_value *base = empty(w->part), *v;
		size_t failed = 0;
		int bad = op_apply(base, w->patches, w->npatches, NULL, &v, &failed);
		op_free(base);
		if (bad != OP_OK) {
			if (made != NULL) pl_made_free(made);
			if (fx != NULL) featured_free(fx);
			return apply_failed(bad, failed);
		}
		if (v == NULL) {
			if (made != NULL) pl_made_free(made);
			if (fx != NULL) featured_free(fx);
			return 0;
		}
		nd_entry *fresh = nd_make_entry(v, &h);
		op_free(v);
		tb_add(e->table, part, id, fresh);
		// the places' till it is out of the table (taken out, or written over whole): then let go
		// of after a pulse (pl_sweep)
		pl_own_in(e->places, fresh, e->table);
		hold(e, fresh, &first, made, pl_made_free);
		hold(e, fresh, &first, fx, featured_free);
		return 0;
	}
	block *b = block_new(w->patches, w->npatches);
	size_t failed = 0;
	// children and process rows change as places changes them (readers keep what they read)
	int bad = strcmp(w->part, "children") == 0 || strcmp(w->part, PR_PART) == 0
		? un_update(pl_unread(e->places), entry, b->patches, b->n, h, &failed)
		: nd_update(entry, b->patches, b->n, h, &failed);
	if (bad != OP_OK) {
		block_free(b);
		if (made != NULL) pl_made_free(made);
		if (fx != NULL) featured_free(fx);
		return apply_failed(bad, failed);
	}
	pl_changed changed = {1, {entry}};
	es_commit_changed(e, &changed);
	es_action_let_go(e, held, entry->value);
	hold(e, entry, &first, made, pl_made_free);
	hold(e, entry, &first, b, block_free);
	hold(e, entry, &first, fx, featured_free);
	return 0;
}

typedef struct {
	es_context *c;
	const es_write *w;
} putting;
// a write that changes nothing is not landed
static int put_land(void *ctx, const es_write *x) {
	if (!x->gone && x->npatches == 0) return 0;
	return land(ctx, x);
}
static int put_in(void *p) {
	putting *s = p;
	return es_hook_write(s->c->ermine, s->c, s->w, put_land, s->c->ermine);
}
int es_context_put(es_context *c, const es_write *w) {
	putting s = {c, w};
	return es_inside(c, put_in, &s);
}

void es_context_writer(es_context *c, const char *part, tb_key id, const op_patch *patches,
	size_t n, const ch_header *header) {
	es_write w = {.part = part, .id = id.string, .patches = patches, .npatches = n, .header = header};
	es_context_put(c, &w);
}

// one write at a node, asked "edit" first; remove: the entry taken out
typedef struct {
	es_context *c;
	const char *part;
	const es_aim *at;
	const op_patch *patches;
	size_t n;
	int gone;
} writing;
static int write_in(void *p) {
	writing *s = p;
	gd_thing thing = {.id = tb_string(s->at->id)};
	if (s->at->has_path) thing.path = s->at->path, thing.npath = s->at->npath;
	TRY(ask(s->c, "edit", gd_target_of(thing, s->part, NULL)));
	es_write w = {.part = s->part, .id = s->at->id, .has_path = s->at->has_path,
		.path = s->at->path, .npath = s->at->npath, .patches = s->patches, .npatches = s->n,
		.gone = s->gone};
	return es_context_put(s->c, &w);
}
static int write_run(es_context *c, const char *part, const es_aim *at, const op_patch *patches,
	size_t n, int gone, const ch_site *site) {
	writing s = {c, part, at, patches, n, gone};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, write_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}
int es_context_write_at(es_context *c, const char *part, const es_aim *at, const op_patch *patches,
	size_t n, const ch_site *site) {
	return write_run(c, part, at, patches, n, 0, site);
}
int es_context_remove_at(es_context *c, const char *part, const es_aim *at, const ch_site *site) {
	return write_run(c, part, at, NULL, 0, 1, site);
}

// placing and building ----------------------------------------------------------------------------------------

int es_place_under(es_context *c, const char *parent, const char *name, const char *id,
	const char *const *path, size_t npath) {
	es_ermine *e = c->ermine;
	if (path != NULL) TRY(ask_slot(c, parent, path, npath));
	nd_entry *children = tb_get(e->table, tb_string("children"), tb_string(parent));
	pset ps;
	TRY(placing(children, name, id, &ps));
	es_write w = {.part = "children", .id = parent, .patches = ps.p, .npatches = ps.n};
	int code = es_context_put(c, &w);
	pset_free(&ps);
	return code;
}

int es_build(es_context *c, const char *const *path, size_t npath, const op_value *value,
	const char *given, char **out) {
	es_ermine *e = c->ermine;
	*out = NULL;
	char *id = given != NULL ? es_dup(given) : es_new_id(e);
	if (npath == 0) return free(id), places_fail(ES_ALREADY_THERE, "/");
	char *parent = es_dup(pl_root(c->places).string);
	int code = 0;
	for (size_t i = 0; i + 1 < npath && !code; i++) {
		const char *there;
		code = get_id(c, path, i + 1, &there);
		if (code) break;
		if (there != NULL) {
			free(parent);
			parent = es_dup(there);
			continue;
		}
		char *folder = es_new_id(e);
		code = es_place_under(c, parent, path[i], folder, path, i + 1);
		free(parent);
		parent = folder;
	}
	if (!code) code = ask_slot(c, parent, path, npath);
	if (!code && value != NULL) {
		op_patch p = whole(value);
		es_write w = {.part = "value", .id = id, .has_path = 1, .path = path, .npath = npath,
			.patches = &p, .npatches = 1};
		code = es_context_put(c, &w);
	}
	if (!code) code = es_place_under(c, parent, path[npath - 1], id, NULL, 0);
	free(parent);
	if (code) return free(id), code;
	*out = id;
	return 0;
}

int es_folder_slot(es_context *c, const char *const *path, size_t npath, nd_entry **children,
	const char **name) {
	if (npath == 0) return places_fail(ES_NOTHING_THERE, "");
	const char *parent;
	TRY(get_id(c, path, npath - 1, &parent));
	nd_entry *entry = parent == NULL ? NULL
		: tb_get(c->ermine->table, tb_string("children"), tb_string(parent));
	if (entry == NULL) return places_fail_path(ES_NOTHING_THERE, path, npath);
	*children = entry;
	*name = path[npath - 1];
	return 0;
}

// seen --------------------------------------------------------------------------------------------------------------

void es_running_set(es_ermine *e, const char *process, const char *const *at, size_t nat) {
	struct es_nodes *x = state(e);
	running_rec *r = es_map_get(&x->running, process);
	if (r != NULL) {
		es_names_free(&r->at);
	} else {
		r = es_alloc(sizeof *r);
		es_map_set(&x->running, process, r);
	}
	r->at = names_of(at, nat);
}

void es_running_clear(es_ermine *e, const char *process) {
	struct es_nodes *x = state(e);
	running_rec *r = es_map_get(&x->running, process);
	if (r == NULL) return;
	es_map_del(&x->running, process);
	running_free(r);
}

// the names from root down to id, up id's names now (places' names, the latest placed first at each
// step; a process's node, named by its row: where it runs). 1 and
// *out; 0: nothing reaches it from root. read untracked
static int up_go(es_ermine *e, const pl *places, const char *root, const char *at, es_map *visited,
	es_names *out) {
	if (strcmp(at, root) == 0) return names_init(out), 1;
	es_map_set(visited, at, NULL);
	const running_rec *r = es_map_get(&state(e)->running, at);
	if (r != NULL) return *out = names_of(CP(r->at.names), r->at.n), 1;
	size_t n;
	const pl_slot *slots = pl_names_of(places, tb_string(at), &n);
	for (size_t i = n; i-- > 0;) {
		const char *folder = slots[i].folder.string;
		if (folder == NULL || es_map_has(visited, folder)) continue;
		es_names above;
		if (up_go(e, places, root, folder, visited, &above)) {
			names_add(&above, slots[i].name);
			return *out = above, 1;
		}
	}
	return 0;
}

int es_seen_in(es_ermine *e, es_context *reader, const char *id, es_names *out) {
	es_map visited = {0};
	es_names p;
	int found = up_go(e, reader->places, e->root, id, &visited, &p);
	es_map_free(&visited);
	if (!found) return 0;
	tb_key k;
	if (pl_get(reader->places, CP(p.names), p.n, &k) && strcmp(k.string, id) == 0) {
		return *out = p, 1;
	}
	es_names_free(&p);
	return 0;
}

// getNode, ensureNode, createNode, ref --------------------------------------------------------------------------

int es_get_node(es_context *c, es_at p, es_handle **out) {
	es_names path;
	TRY(es_resolve(c, p, &path));
	*out = handle_at(c, &path, "value");
	es_names_free(&path);
	return 0;
}

typedef struct {
	es_context *c;
	es_names path;
	const op_value *value;
	es_make make;
	void *ctx;
	int built;
} ensuring;
// the node at the path, made (with the folders on the way) if missing
static int ensure_in(void *p) {
	ensuring *s = p;
	const char *there;
	TRY(get_id(s->c, CP(s->path.names), s->path.n, &there));
	if (there != NULL) return 0;
	op_value *made = NULL;
	const op_value *value = s->value;
	if (s->make != NULL) value = made = s->make(s->ctx);
	char *id;
	int code = es_build(s->c, CP(s->path.names), s->path.n, value, NULL, &id);
	op_free(made);
	if (!code) free(id);
	return code;
}
static int ensuring_at(es_context *c, es_at p, const op_value *value, es_make make, void *ctx,
	es_handle **out, const ch_site *site) {
	if (out != NULL) *out = NULL;
	ensuring s = {.c = c, .value = value, .make = make, .ctx = ctx};
	TRY(es_resolve(c, p, &s.path));
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, ensure_in, &s);
	es_enter(c->ermine, was);
	if (code) return es_names_free(&s.path), code;
	es_queue_pulse(c->ermine);
	if (out != NULL) *out = handle_at(c, &s.path, "value");
	es_names_free(&s.path);
	return 0;
}

int es_ensure_node_at(es_context *c, es_at p, const op_value *value, es_handle **out,
	const ch_site *site) {
	return ensuring_at(c, p, value, NULL, NULL, out, site);
}

int es_ref_at(es_context *c, es_at p, es_make make, void *ctx, es_handle **out,
	const ch_site *site) {
	return ensuring_at(c, p, NULL, make, ctx, out, site);
}

typedef struct {
	es_context *c;
	es_names path;
	const op_value *value;
	const char *id;
} creating;
static int create_in(void *p) {
	creating *s = p;
	char *id;
	int code = es_build(s->c, CP(s->path.names), s->path.n, s->value, s->id, &id);
	if (!code) free(id);
	return code;
}
// a new node under folder, named by a fresh name of its own: drawn as an id is, but never its id
// (a name is what list gives, and a process holds no ids)
int es_create_node_at(es_context *c, es_at folder, const op_value *value, es_handle **out,
	const ch_site *site) {
	es_ermine *e = c->ermine;
	if (out != NULL) *out = NULL;
	char *id = es_new_id(e);
	creating s = {.c = c, .value = value, .id = id};
	int code = es_resolve(c, folder, &s.path);
	if (code) return free(id), code;
	char *name = es_new_id(e);
	names_add(&s.path, name);
	free(name);
	const ch_site *was = es_enter(e, site);
	code = es_inside(c, create_in, &s);
	es_enter(e, was);
	free(id);
	if (code) return es_names_free(&s.path), code;
	es_queue_pulse(e);
	if (out != NULL) *out = handle_at(c, &s.path, "value");
	es_names_free(&s.path);
	return 0;
}

// reads ----------------------------------------------------------------------------------------------------------------

// x's node as t resolves it, its part as given (NULL: its own)
static int node_part(es_context *t, es_target x, const char *part, es_node_data *n) {
	TRY(es_node_of(t, x, n));
	if (part != NULL) {
		free(n->part);
		n->part = es_dup(part);
	}
	return 0;
}

// the computer's node whose run is open, else NULL
static const char *computer_node(sc_computer *computer) {
	const sc_info *info = sc_scope_info(computer);
	for (size_t i = 0; info != NULL && i < info->n; i++) {
		const op_value *v = info->pairs[i].value;
		if (strcmp(info->pairs[i].key, PL_NODE) == 0 && v != NULL && v->type == OP_STR) return v->str;
	}
	return NULL;
}

// the names as one text, each once: every name with its length before it
static char *names_key(const char *const *names, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(names[i]) + 21;
	char *s = es_alloc(len), *o = s;
	for (size_t i = 0; i < n; i++) o += sprintf(o, "%zu:%s", strlen(names[i]), names[i]);
	return s;
}

// path (as c sees it) waited on by the reader now: a computer's (in its run now), else a setup's (the
// context's node, its setup running); anyone else's is shown nowhere, so not held. held from the root,
// shown to each asker as it sees it
static void wait_for(es_context *c, const char *const *path, size_t npath) {
	es_ermine *e = c->ermine;
	struct es_nodes *x = state(e);
	sc_run *run = sc_get_run(e->scheduler);
	const char *computer = run == NULL ? NULL : computer_node(sc_run_computer(run));
	const char *key = computer != NULL ? computer : c->node;
	if (computer == NULL && !es_map_has(&x->setting, c->node)) return;
	int has_n = computer != NULL;
	// the number this run will have: its computer's latest record's and one (that record read, tracked,
	// as system.ts' waitFor reads it)
	const crn_run *latest = NULL;
	if (has_n) es_latest_run(e, computer, &latest);
	unsigned n = has_n ? (latest != NULL ? latest->n : 0) + 1 : 0;
	es_missing *m = es_map_get(&x->missing, key);
	if (m == NULL) {
		m = es_alloc(sizeof *m);
		es_map_set(&x->missing, key, m);
	} else if (m->has_n != has_n || m->n != n) {
		for (size_t i = 0; i < m->npaths; i++) es_names_free(&m->paths[i]);
		m->npaths = 0;
		es_map_free(&m->keys);
		m->keys = (es_map){0};
	}
	m->has_n = has_n;
	m->n = n;
	es_names abs = names_of(path, npath);
	char *k = names_key(CP(abs.names), abs.n);
	if (es_map_has(&m->keys, k)) {
		free(k);
		es_names_free(&abs);
		return;
	}
	es_map_set(&m->keys, k, NULL);
	free(k);
	m->paths = realloc(m->paths, (m->npaths + 1) * sizeof *m->paths);
	if (m->paths == NULL) abort();
	m->paths[m->npaths++] = abs;
}

const es_missing *es_missing_of(es_ermine *e, const char *id) {
	return es_map_get(&state(e)->missing, id);
}

void es_missing_drop(es_ermine *e, const char *id) {
	struct es_nodes *x = state(e);
	es_missing *m = es_map_get(&x->missing, id);
	if (m == NULL) return;
	es_map_del(&x->missing, id);
	missing_free(m);
}

void es_setting(es_ermine *e, const char *process, int running) {
	struct es_nodes *x = state(e);
	if (running) es_map_set(&x->setting, process, NULL);
	else {
		es_map_del(&x->setting, process);
		es_missing_drop(e, process);
	}
}

// the value at key of x's part, tracked; none: *out NULL; a pending memo with no value: PENDING
static int read_part(es_context *c, es_target x, const char *part, const op_key *key, size_t nkey,
	const op_value **out) {
	es_ermine *e = c->ermine;
	*out = NULL;
	es_context *t = c;
	es_node_data n;
	TRY(node_part(t, x, part, &n));
	const char *id;
	if (!es_id_of(t, &n, &id)) {
		// a node not there: pending, as a memo with no value is ("not there yet" one way) [chee 10-25:
		// "i think a missing node should also throw pending"], the read tracked so its coming reruns
		// it, and said where the reader waits
		int code = check(t);
		if (!code && n.has_path && c->peeping == 0) wait_for(c, CP(n.path), n.npath);
		if (!code) code = es_fail(ES_PENDING, "%s", "");
		es_node_data_free(&n);
		return code;
	}
	int code = 0;
	if (t->guarded) {
		op_value *field = field_of(key, nkey);
		code = ask_read(t, gd_target_of(thing_of(id, &n), n.part, nkey ? field : NULL));
		op_free(field);
	}
	if (!code && c->peeping == 0) es_calls_read(e, n.part, id, key, nkey, 1, 0);
	if (!code) {
		const op_value *v = pl_read(t->places, tb_string(n.part), tb_string(id), key, nkey);
		int pending = 0;
		if (strcmp(n.part, "value") == 0 && es_is_memo(e, id)) {
			pending = v == NULL && cst_pending(t->places, tb_string(id));
		}
		code = check(t);
		if (!code && pending) code = es_fail(ES_PENDING, "%s", "");
		if (!code) *out = v;
	}
	es_node_data_free(&n);
	return code;
}

int es_read(es_context *c, es_target x, const op_key *key, size_t nkey, const op_value **out) {
	return read_part(c, x, NULL, key, nkey, out);
}
int es_read_attributes(es_context *c, es_target x, const op_key *key, size_t nkey,
	const op_value **out) {
	return read_part(c, x, "attributes", key, nkey, out);
}

void es_versions_free(es_versions *v) {
	for (size_t i = 0; i < v->n; i++) {
		op_free(v->items[i].held);
		op_free(v->items[i].from.more);
	}
	free(v->items);
	*v = (es_versions){0};
}

// read's, from its entry's change; then what features show (onRead). each item's change as its view
static int versions_part(es_context *c, es_target x, const char *part, const op_key *key,
	size_t nkey, es_versions *out) {
	es_ermine *e = c->ermine;
	*out = (es_versions){0};
	es_context *t = c;
	es_node_data n;
	TRY(node_part(t, x, part, &n));
	const op_value *shown;
	int code = read_part(c, x, part, key, nkey, &shown);
	const char *id = NULL;
	if (!code && !es_id_of(t, &n, &id)) {
		es_node_data_free(&n);
		return check(t);
	}
	if (code) return es_node_data_free(&n), code;
	es_versions items = {0};
	es_version first = {0};
	if (shown != NULL) {
		first.value = shown;
		const nd_entry *entry = tb_get(e->table, tb_string(n.part), tb_string(id));
		if (entry != NULL) {
			first.from.change = pl_change_value(e->places, &entry->change);
			if (first.from.change != NULL) first.from.view = es_change_view_of(e, first.from.change);
		}
		items.items = es_alloc(sizeof *items.items);
		items.items[0] = first;
		items.n = items.cap = 1;
	}
	es_reading rd = {.node = &n, .part = n.part, .id = id, .path = key, .npath = nkey, .context = c};
	es_versions shown_out = {0};
	code = es_hook_read(e, &rd, &items, &shown_out);
	if (items.items != shown_out.items) free(items.items);
	es_node_data_free(&n);
	if (code) return es_versions_free(&shown_out), code;
	// a feature's item with a change: its view
	for (size_t i = 0; i < shown_out.n; i++) {
		es_from *f = &shown_out.items[i].from;
		if (f->change != NULL && f->view == NULL) f->view = es_change_view_of(e, f->change);
	}
	*out = shown_out;
	return 0;
}

// children's ids turned handles (no ids given out): each version's value, a new map
static int handles_for(es_context *t, es_versions *v) {
	for (size_t i = 0; i < v->n; i++) {
		es_version *it = &v->items[i];
		if (it->value == NULL || it->value->type != OP_MAP) continue;
		op_value *m = op_map();
		for (size_t k = 0; k < it->value->count; k++) {
			const op_value *x = it->value->items[k];
			if (x->type == OP_STR) {
				op_set(m, it->value->keys[k], es_handle_value(es_handle_by_id(t, x->str, "value")));
			} else {
				op_set(m, it->value->keys[k], op_ref((op_value *)x));
			}
		}
		op_free(it->held);
		it->held = m;
		it->value = m;
	}
	return 0;
}

int es_read_all(es_context *c, es_target x, const op_key *key, size_t nkey, es_versions *out) {
	return versions_part(c, x, NULL, key, nkey, out);
}
int es_read_all_attributes(es_context *c, es_target x, const op_key *key, size_t nkey,
	es_versions *out) {
	return versions_part(c, x, "attributes", key, nkey, out);
}
int es_read_all_children(es_context *c, es_target x, es_versions *out) {
	TRY(versions_part(c, x, "children", NULL, 0, out));
	handles_for(c, out);
	return 0;
}

void es_items_free(es_items *i) {
	free(i->items);
	*i = (es_items){0};
}
static void items_push(es_items *l, const op_value *value, const char *from, es_handle *node,
	int no) {
	l->items = realloc(l->items, (l->n + 1) * sizeof *l->items);
	if (l->items == NULL) abort();
	l->items[l->n++] = (es_item){.value = value, .from = from, .node = node, .refused = no};
}

// every node x's path reaches. a refused one keeps its place, with no value and no node
int es_read_entries(es_context *c, es_target x, es_items *out) {
	es_ermine *e = c->ermine;
	*out = (es_items){0};
	es_context *t = c;
	es_node_data n;
	TRY(es_node_of(t, x, &n));
	int code = 0;
	if (!n.has_path) {
		if (n.id != NULL) {
			int no;
			code = refused(t, gd_target_of(thing_of(n.id, NULL), n.part, NULL), &no);
			if (!code && no) items_push(out, NULL, "id", NULL, 1);
			else if (!code) {
				es_calls_read(e, n.part, n.id, NULL, 0, 1, 0);
				const op_value *v = pl_read(t->places, tb_string(n.part), tb_string(n.id), NULL, 0);
				// a node there by id, with or without a value (as by a path); nothing under that id: none
				size_t held;
				tb_at(e->table, tb_string(n.id), &held);
				if (v != NULL || held > 0) {
					items_push(out, v, "id", es_handle_by_id(t, n.id, n.part), 0);
				}
			}
		}
		es_node_data_free(&n);
		if (!code) code = check(t);
		if (code) es_items_free(out);
		return code;
	}
	pl_answers all = pl_gets(t->places, CP(n.path), n.npath);
	for (size_t i = 0; i < all.n; i++) {
		es_calls_read(e, n.part, all.items[i].id.string, NULL, 0, 1, 0);
	}
	if (!t->guarded) {
		for (size_t i = 0; i < all.n; i++) {
			const char *id = all.items[i].id.string;
			items_push(out, pl_read(t->places, tb_string(n.part), tb_string(id), NULL, 0),
				all.items[i].from, es_handle_by_id(t, id, n.part), 0);
		}
	} else if (n.npath == 0) {
		// the root: no name in a folder to ask by, so the node itself, as read asks
		for (size_t i = 0; i < all.n && !code; i++) {
			const char *id = all.items[i].id.string;
			int no;
			code = refused(t, gd_target_of(thing_of(id, &n), n.part, NULL), &no);
			if (code) break;
			if (no) items_push(out, NULL, all.items[i].from, NULL, 1);
			else {
				items_push(out, pl_read(t->places, tb_string(n.part), tb_string(id), NULL, 0),
					all.items[i].from, es_handle_by_id(t, id, n.part), 0);
			}
		}
	} else {
		pl_member *in = es_alloc((all.n + 1) * sizeof *in);
		for (size_t i = 0; i < all.n; i++) {
			in[i] = (pl_member){n.path[n.npath - 1], all.items[i].id, all.items[i].from};
		}
		pl_members list = {all.n, in}, asked;
		gd_answer a = gd_members(t->guard, &list, CP(n.path), n.npath - 1, &asked);
		free(in);
		code = answered(a, &(gd_refusal){"read", "refused", {0}, 0});
		if (!code) {
			for (size_t i = 0; i < all.n; i++) {
				const char *id = all.items[i].id.string;
				if (gd_is_refused(asked.items[i].id)) {
					items_push(out, NULL, all.items[i].from, NULL, 1);
				} else {
					items_push(out, pl_read(t->places, tb_string(n.part), tb_string(id), NULL, 0),
						all.items[i].from, es_handle_by_id(t, id, n.part), 0);
				}
			}
		}
		pl_members_free(&asked);
	}
	pl_answers_free(&all);
	es_node_data_free(&n);
	if (!code) code = check(t);
	if (code) es_items_free(out);
	return code;
}

int es_has_node(es_context *c, es_target x, int *out) {
	es_items items;
	*out = 0;
	TRY(es_read_entries(c, x, &items));
	for (size_t i = 0; i < items.n; i++) {
		if (!items.items[i].refused) {
			*out = 1;
			break;
		}
	}
	es_items_free(&items);
	return 0;
}

// f with nothing it reads tracked; a pending memo it reads ends it, as none
typedef struct {
	es_thunk f;
	void *ctx;
	int code;
} peeping;
static void peep_run(void *p) {
	peeping *s = p;
	s->code = s->f(s->ctx);
	if (s->code == ES_PENDING) s->code = 0;
}
int es_peep(es_context *c, es_thunk f, void *ctx) {
	peeping s = {f, ctx, 0};
	c->peeping++;
	pl_peep(c->places, peep_run, &s);
	c->peeping--;
	return s.code;
}

void es_children_free(es_children *c) {
	for (size_t i = 0; i < c->n; i++) free(c->names[i]);
	free(c->names);
	free(c->nodes);
	*c = (es_children){0};
}

int es_list(es_context *c, es_target x, es_names *out) {
	es_ermine *e = c->ermine;
	*out = (es_names){0};
	es_context *t = c;
	es_node_data n;
	TRY(es_node_of(t, x, &n));
	const char *id;
	int has = es_id_of(t, &n, &id);
	int code = 0;
	if (t->guarded && has) code = ask_read(t, gd_target_of(thing_of(id, &n), "children", NULL));
	if (!code && has) es_calls_read(e, "children", id, NULL, 0, 1, 1);
	es_names got;
	names_init(&got);
	if (!code) {
		if (n.has_path) {
			pl_members m = pl_list(t->places, CP(n.path), n.npath);
			for (size_t i = 0; i < m.n; i++) names_add(&got, m.items[i].name);
			pl_members_free(&m);
		} else if (n.id != NULL) {
			pl_namelist nl = {0};
			pl_keys(t->places, tb_string("children"), tb_string(n.id), NULL, 0, 0, &nl);
			for (size_t i = 0; i < nl.n; i++) names_add(&got, nl.items[i]);
			pl_namelist_free(&nl);
		}
		if (!code) code = check(t);
	}
	es_node_data_free(&n);
	if (code) return es_names_free(&got), code;
	*out = got;
	return 0;
}

// x's children, each as a handle (reached by this process's path, so its own to hold)
int es_read_children(es_context *c, es_target x, es_children *out) {
	*out = (es_children){0};
	es_context *t = c;
	es_node_data n;
	TRY(es_node_of(t, x, &n));
	const char *id;
	es_id_of(t, &n, &id);
	es_names names;
	int code = es_list(c, x, &names);
	if (code) return es_node_data_free(&n), code;
	const op_value *kids = id != NULL
		? pl_read(t->places, tb_string("children"), tb_string(id), NULL, 0) : NULL;
	out->names = es_alloc((names.n + 1) * sizeof *out->names);
	out->nodes = es_alloc((names.n + 1) * sizeof *out->nodes);
	for (size_t i = 0; i < names.n && !code; i++) {
		const char *at = NULL;
		const op_value *kid = kids != NULL && kids->type == OP_MAP ? op_get(kids, names.names[i]) : NULL;
		// a name's node as its path reaches it (a process's node, named by its row), else the entry's
		if (n.has_path && at == NULL) {
			es_names p = names_of(CP(n.path), n.npath);
			names_add(&p, names.names[i]);
			tb_key k;
			if (pl_get(t->places, CP(p.names), p.n, &k)) at = k.string;
			es_names_free(&p);
		}
		if (at == NULL && kid != NULL && kid->type == OP_STR) at = kid->str;
		if (at == NULL) continue;
		out->names[out->n] = es_dup(names.names[i]);
		out->nodes[out->n++] = es_handle_by_id(t, at, "value");
	}
	es_names_free(&names);
	es_node_data_free(&n);
	if (!code) code = check(t);
	if (code) es_children_free(out);
	return code;
}

// pipes -----------------------------------------------------------------------------------------------------
// pipe(from, fn) | pipe(from, to, fnA?, fnB?) (system.ts: the comment above pipe says it all): a node of
// its own, in its own scope { node, pipe }, told each write at from (and, with a way back, at to). its
// writes are its own, asked as the context that made it; it is never told its own. "pulse" timing:
// told at the next pulse (es_pipes_told, before the scheduler's); "write": as the write lands. a pipe
// told more than PIPE_LOOPING pipes' writes in a row, or that deep, is looping and told no more

#define PIPE_LOOPING 64

static void pipe_stop(pipe_t *p) {
	for (size_t i = 0; i < p->nlistens; i++) {
		listening *l = p->listens[i];
		if (l->stopped) continue;
		l->stopped = 1;
		pl_stop(l->watch);
	}
}

static void heard_free(heard_t *h) {
	if (h->patches != NULL) block_free(h->patches);
	op_free(h->value);
	op_free(h->held);
}

static void pipe_free(pipe_t *p) {
	for (size_t j = 0; j < p->nlistens; j++) {
		es_names_free(&p->listens[j]->path);
		free(p->listens[j]->part);
		free(p->listens[j]);
	}
	free(p->listens);
	free(p->watching);
	es_names_free(&p->path);
	free(p->key);
	free(p->id);
	op_free(p->id_value);
	op_free(p->flag);
	free(p);
}

// the pipes gone, freed: what they heard and is not told yet dropped, out of all_pipes, their scope
// let go. not while telling (a write told may be another's, gone in it)
static void pipes_gone(struct es_nodes *x) {
	if (x->telling > 0 || x->ngone_pipes == 0) return;
	size_t k = 0;
	for (size_t i = 0; i < x->npiped; i++) {
		if (x->piped[i].p->gone) heard_free(&x->piped[i]);
		else x->piped[k++] = x->piped[i];
	}
	x->npiped = k;
	for (size_t i = 0; i < x->ngone_pipes; i++) {
		pipe_t *p = x->gone_pipes[i];
		pipe_t *last = x->all_pipes[--x->nall_pipes];
		x->all_pipes[p->at] = last;
		last->at = p->at;
		sc_release(p->scope);
		pipe_free(p);
	}
	x->ngone_pipes = 0;
}

static void pipes_free(struct es_nodes *x) {
	for (size_t i = 0; i < x->npiped; i++) heard_free(&x->piped[i]);
	free(x->piped);
	// the scheduler is gone by now (es_close): the pipes' holds go with it
	for (size_t i = 0; i < x->nall_pipes; i++) pipe_free(x->all_pipes[i]);
	free(x->all_pipes);
	free(x->gone_pipes);
	es_map_free(&x->pipes);
	es_map_free(&x->pipe_ids);
	for (size_t i = 0; i < x->norders; i++) free(x->orders[i]);
	free(x->orders);
	for (size_t i = 0; i < x->nregs; i++) free(x->regs[i]);
	free(x->regs);
}

int es_pipe_looped(es_ermine *e, const char *id) {
	pipe_t *p = e->nodes == NULL ? NULL : es_map_get(&e->nodes->pipe_ids, id);
	return p != NULL && p->looped;
}

// a path as a key that two paths share only if they are the same: each name by its length
static char *pipe_key(char *const *path, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(path[i]) + 24;
	char *s = es_alloc(len), *o = s;
	for (size_t i = 0; i < n; i++) o += snprintf(o, len - (size_t)(o - s), "%zu:%s", strlen(path[i]), path[i]);
	return s;
}

// a deep equal: maps by their keys (in any order), lists, bytes and typed arrays by their bytes
static int values_equal(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return !a->bool_ == !b->bool_;
	case OP_NUM: return op_same_num(a, b) != 0;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	case OP_TYPED:
		if (a->kind != b->kind) return 0;
		// fall through
	case OP_BYTES: return a->bytes == b->bytes && (a->bytes == 0 || memcmp(a->data, b->data, a->bytes) == 0);
	case OP_STAND: return a->count == b->count && values_equal(a->items[0], b->items[0]);
	case OP_LIST:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			if (!values_equal(a->items[i], b->items[i])) return 0;
		}
		return 1;
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			if (!values_equal(a->items[i], op_get(b, a->keys[i]))) return 0;
		}
		return 1;
	}
	return 0;
}

// an Error as a status holds it (status.h's)
static op_value *pipe_error(const char *message) {
	op_value *m = op_map();
	op_set(m, "name", op_str("Error"));
	op_set(m, "message", op_str(message));
	return op_stand(m);
}

// the message of what was thrown last
static char *pipe_failure(int code) {
	const es_error *t = es_thrown();
	return es_dup(t->message != NULL ? t->message : es_code_name(code));
}

// a pipe's status, in the status table: failed (the error), or none (done)
typedef struct {
	pipe_t *p;
	const char *error;
} pipe_stating;
static void pipe_status_run(void *data) {
	pipe_stating *s = data;
	pipe_t *p = s->p;
	const nd_entry *at = tb_get(p->e->table, tb_string(CST_TABLE), tb_string(p->id));
	const op_value *had = at != NULL && at->value != NULL && at->value->type == OP_MAP
		? op_get(at->value, CST_ATTRIBUTE)
		: NULL;
	if (s->error == NULL && had == NULL) return;
	op_key key = {.type = OP_STR_KEY, .s = CST_ATTRIBUTE};
	op_patch patch = {0};
	op_value *own = NULL;
	if (s->error == NULL) {
		patch.place = (op_target){.path = &key, .length = 1};
	} else if (had == NULL) {
		own = op_map();
		op_set(own, CST_ATTRIBUTE, pipe_error(s->error));
		patch.has_value = 1;
		patch.value = own;
	} else {
		own = pipe_error(s->error);
		patch.place = (op_target){.path = &key, .length = 1};
		patch.has_value = 1;
		patch.value = own;
	}
	es_write w = {.part = CST_TABLE, .id = p->id, .patches = &patch, .npatches = 1};
	if (es_context_put(p->cx, &w)) es_clear_thrown();
	op_free(own);
}
static void pipe_status(pipe_t *p, const char *error, int looped) {
	pipe_stating s = {p, error};
	p->looped = looped;
	sc_run_with_scope(p->scope, pipe_status_run, &s);
}

// the pipe's node unplaced and its entries gone (its scope gone, not made again)
static void pipe_gone_node(pipe_t *p) {
	es_ermine *e = p->e;
	es_context *c = p->cx;
	nd_entry *children;
	const char *last;
	if (es_folder_slot(c, CP(p->path.names), p->path.n, &children, &last) == 0) {
		const op_value *held = children->value != NULL && children->value->type == OP_MAP
			? op_get(children->value, last)
			: NULL;
		tb_key parent = {0};
		int ours = held != NULL && held->type == OP_STR && strcmp(held->str, p->id) == 0;
		if (ours && p->path.n == 1) parent = pl_root(c->places);
		else if (ours && !pl_get(c->places, CP(p->path.names), p->path.n - 1, &parent)) ours = 0;
		if (ours) {
			op_key step = {.type = OP_STR_KEY, .s = last};
			op_patch out = {.place = {.path = &step, .length = 1}};
			es_write w = {.part = "children", .id = parent.string, .patches = &out, .npatches = 1};
			if (es_context_put(c, &w)) es_clear_thrown();
		}
	} else {
		es_clear_thrown();
	}
	// every part at the node (the table's scratch is changed by each delete: names copied first)
	size_t n = 0;
	const tb_entry *at = tb_at(e->table, tb_string(p->id), &n);
	char **parts = es_alloc((n + 1) * sizeof *parts);
	size_t np = 0;
	for (size_t i = 0; i < n; i++) {
		if (at[i].part.string != NULL) parts[np++] = es_dup(at[i].part.string);
	}
	for (size_t i = 0; i < np; i++) {
		es_write w = {.part = parts[i], .id = p->id, .gone = 1};
		if (es_context_put(c, &w)) es_clear_thrown();
		free(parts[i]);
	}
	free(parts);
	es_held_drop(e, p->id);
}

static char *pipe_teardown(void *data) {
	pipe_reg *r = data;
	pipe_t *p = r->p;
	struct es_nodes *x = state(r->e);
	pipe_reg *last = x->regs[--x->nregs];
	x->regs[r->at] = last;
	last->at = r->at;
	// p NULL: the pipe was made again, this scope an earlier make's (the pipe may be freed by now)
	int current = p != NULL && p->scope == r->scope;
	free(r);
	if (!current) return NULL;
	pipe_stop(p);
	if (es_map_get(&x->pipes, p->key) == p) es_map_del(&x->pipes, p->key);
	if (es_map_get(&x->pipe_ids, p->id) == p) es_map_del(&x->pipe_ids, p->id);
	p->gone = 1;
	pipe_gone_node(p);
	ES_PUSH(x->gone_pipes, x->ngone_pipes, x->capgone_pipes, p);
	pipes_gone(x);
	return NULL;
}

// p told w, in its own scope: its fn, or its patches written at to (back: at from)
typedef struct {
	pipe_t *p;
	const es_watched *w;
	int back, code;
} pipe_telling;

typedef struct {
	es_context *c;
	const char *id, *part;
	const op_value *now;
} pipe_peeking;
static void pipe_peek(void *data) {
	pipe_peeking *k = data;
	k->now = pl_read(k->c->places, tb_string(k->part), tb_string(k->id), NULL, 0);
}

static void pipe_told_run(void *data) {
	pipe_telling *t = data;
	pipe_t *p = t->p;
	es_context *c = p->cx;
	const es_watched *w = t->w;
	if (p->tell != NULL) {
		t->code = p->tell(c, p->ctx, w);
		return;
	}
	if (w->refused) return;
	es_pipe_gave g = {0};
	es_pipe_map f = t->back ? p->back : p->there;
	if (f != NULL) {
		t->code = f(c, p->ctx, w, &g);
		if (t->code) return;
	} else {
		g.given = 1;
		g.patches = w->patches;
		g.n = w->npatches;
	}
	if (!g.given || g.n == 0) {
		op_free(g.own);
		return;
	}
	es_target target = es_on_node(t->back ? p->from : p->to);
	// a write that would change nothing is not made (so a mirror pair settles)
	es_node_data nd;
	int code = es_node_of(c, target, &nd);
	if (code == 0) {
		const char *id;
		if (es_id_of(c, &nd, &id)) {
			pipe_peeking k = {c, id, nd.part, NULL};
			pl_peep(c->places, pipe_peek, &k);
			op_value *next = NULL;
			size_t failed;
			if (op_apply(k.now, g.patches, g.n, NULL, &next, &failed) == OP_OK && next != NULL &&
				values_equal(k.now, next)) {
				op_free(next);
				es_node_data_free(&nd);
				op_free(g.own);
				return;
			}
			op_free(next);
		}
		es_node_data_free(&nd);
		code = es_patch(c, target, g.patches, g.n);
	}
	op_free(g.own);
	t->code = code;
}

static void pipe_told(pipe_t *p, const es_watched *w, int back, int by_pipe) {
	struct es_nodes *x = state(p->e);
	if (!sc_scope_alive(p->scope) || p->looping) return;
	p->chain = by_pipe ? p->chain + 1 : 0;
	if (x->pipe_depth >= PIPE_LOOPING || p->chain > PIPE_LOOPING) {
		p->looping = 1;
		pipe_status(p, "looping: a pipe told pipes' writes more than 64 in a row", 1);
		return;
	}
	x->pipe_depth++;
	// p, or one it tells, gone while it is told: freed after (pipes_gone)
	x->telling++;
	pipe_telling t = {p, w, back, 0};
	const char *bad = sc_run_with_scope(p->scope, pipe_told_run, &t);
	if (bad != NULL) {
		// its scope went as it was told: nothing to say
		if (strcmp(bad, SC_DISPOSED) != 0) {
			es_fail_text(bad);
			t.code = ES_FAILED;
		}
	}
	if (t.code) {
		char *message = pipe_failure(t.code);
		es_clear_thrown();
		pipe_status(p, message, 0);
		free(message);
	} else if (!p->looping) {
		pipe_status(p, NULL, 0);
	}
	x->pipe_depth--;
	x->telling--;
	pipes_gone(x);
}

// the pipes' heard writes told, before the scheduler's pulse (those heard while telling: the pulse after)
void es_pipes_told(es_ermine *e) {
	struct es_nodes *x = e->nodes;
	if (x == NULL) return;
	pipes_gone(x);
	if (x->npiped == 0) return;
	heard_t *now = x->piped;
	size_t n = x->npiped;
	x->piped = NULL;
	x->npiped = x->cappiped = 0;
	x->telling++;
	for (size_t i = 0; i < n; i++) {
		heard_t *h = &now[i];
		es_watched w = {.refused = h->refused, .value = h->value, .change = h->change};
		if (h->patches != NULL) w.patches = h->patches->patches, w.npatches = h->patches->n;
		if (!h->p->gone) pipe_told(h->p, &w, h->back, h->by_pipe);
		heard_free(h);
	}
	x->telling--;
	free(now);
	pipes_gone(x);
}

// a write landing at a node a pipe listens to: told now, or held for the next pulse
static void pipe_heard(const pl_fact *fact, void *ctx) {
	listening *l = ctx;
	pipe_t *p = l->p;
	es_ermine *e = p->e;
	int by_pipe = 0;
	const ch_header *h = fact->change;
	for (size_t i = 0; h != NULL && i < h->metadata_length; i++) {
		const ch_entry *m = &h->metadata[i];
		const op_value *v = m->value;
		// never told its own writes
		if (strcmp(m->key, PL_NODE) == 0 && v != NULL && v->type == OP_STR && strcmp(v->str, p->id) == 0) {
			return;
		}
		if (strcmp(m->key, "pipe") == 0) by_pipe = 1;
	}
	int no = 0;
	gd_thing thing = {.id = fact->id, .path = CP(l->path.names), .npath = l->path.n};
	int code = refused(p->cx, gd_target_of(thing, l->part, NULL), &no);
	if (code) {
		// pending or failed is no yes: it is not told, as a thrown answer tells nothing (the
		// reference's rethrows it to the writer, which a listener here cannot). the pipe's status says
		char *message = pipe_failure(code);
		es_clear_thrown();
		pipe_status(p, message, 0);
		free(message);
		return;
	}
	es_watched w = {.refused = no};
	if (!no) {
		w.patches = fact->patches;
		w.npatches = fact->patches_length;
		if (fact->change != NULL) {
			const op_value *change = pl_change_value(e->places, fact->change);
			if (change != NULL) w.change = es_change_view_of(e, change);
		}
		if (fact->entry != NULL) w.value = fact->entry->value;
	}
	if (p->write) {
		pipe_told(p, &w, l->back, by_pipe);
		return;
	}
	struct es_nodes *x = state(e);
	heard_t later = {.p = p, .back = l->back, .by_pipe = by_pipe, .refused = no, .change = w.change};
	if (w.change != NULL) later.held = op_ref((op_value *)w.change->change);
	if (!no) {
		if (w.npatches > 0) later.patches = block_new(w.patches, w.npatches);
		later.value = w.value == NULL ? NULL : op_ref((op_value *)w.value);
	}
	ES_PUSH(x->piped, x->npiped, x->cappiped, later);
	es_queue_pulse(e);
}

static void listen(pipe_t *p, const es_node_data *n, int back) {
	listening *l = es_alloc(sizeof *l);
	l->p = p;
	l->back = back;
	l->part = es_dup(n->part);
	l->path = names_of(CP(n->path), n->npath);
	pl_watching options = {.has_part = 1, .part = tb_string(l->part)};
	l->watch = pl_watch_path(p->cx->places, CP(l->path.names), l->path.n, pipe_heard, l, &options);
	ES_PUSH(p->listens, p->nlistens, p->caplistens, l);
}

// how many pipes the owner's run has made so far, and one more counted: pipe-<n>
static void order_gone(order_t *o) { o->owner = NULL; }
static char *order_teardown(void *data) {
	order_gone(data);
	return NULL;
}
static unsigned pipe_order(es_ermine *e, const void *owner, unsigned run_n) {
	struct es_nodes *x = state(e);
	order_t *o = NULL;
	for (size_t i = 0; i < x->norders && o == NULL; i++) {
		if (x->orders[i]->owner == owner) o = x->orders[i];
	}
	if (o == NULL) {
		for (size_t i = 0; i < x->norders && o == NULL; i++) {
			if (x->orders[i]->owner == NULL) o = x->orders[i];
		}
		if (o == NULL) {
			o = es_alloc(sizeof *o);
			ES_PUSH(x->orders, x->norders, x->caporders, o);
		}
		*o = (order_t){owner, run_n, 0};
		free(sc_register_teardown(e->scheduler, (sc_scope *)owner, order_teardown, o));
	}
	if (o->run_n != run_n) o->run_n = run_n, o->count = 0;
	return o->count++;
}

typedef struct {
	es_context *c;
	char *const *path;
	size_t npath;
	char *id;
} pipe_building;
static int pipe_build(void *data) {
	pipe_building *b = data;
	char *id;
	int code = es_build(b->c, CP(b->path), b->npath, NULL, b->id, &id);
	if (code == 0) free(id);
	return code;
}

// the handle a target is: its own, else one minted for the node it reached
static const es_handle *pipe_handle(es_context *c, es_target x, const es_node_data *n) {
	return x.node != NULL ? x.node : es_handle_make(c, n);
}

static int pipe_ask(es_context *c, const es_node_data *n, int edit) {
	if (!c->guarded) return 0;
	const char *id;
	gd_thing thing;
	if (es_id_of(c, n, &id)) thing = thing_of(id, n);
	else thing = (gd_thing){.path = CP(n->path), .npath = n->npath};
	gd_target target = gd_target_of(thing, n->part, NULL);
	return edit ? ask(c, "edit", target) : ask_read(c, target);
}

static int make_pipe(es_context *c, es_target from, const es_pipe_options *o, es_handle **out) {
	es_ermine *e = c->ermine;
	struct es_nodes *x = state(e);
	ALIVE(c);
	if (o->tell == NULL && !o->has_to) {
		return es_fail(ES_NOT_A_FUNCTION,
			"not-a-function: pipe takes (from, fn) or (from, to, fnA?, fnB?)");
	}
	es_node_data n, tn = {0};
	TRY(node_part(c, from, NULL, &n));
	int code = 0;
	if (!n.has_path) code = places_fail(ES_NOTHING_THERE, "a node with no place");
	if (!code && o->has_to) code = node_part(c, o->to, NULL, &tn);
	if (!code) code = pipe_ask(c, &n, 0);
	if (!code && o->has_to) code = pipe_ask(c, &tn, 1);
	if (code) {
		es_node_data_free(&n);
		es_node_data_free(&tn);
		return code;
	}
	sc_scope *own = es_owner(c);
	sc_run *run = sc_get_run(e->scheduler);
	sc_computer *computer = run == NULL ? NULL : sc_run_computer(run);
	unsigned run_n = run == NULL ? 0 : sc_run_n(run);
	const void *owner = computer != NULL ? (const void *)computer : (const void *)own;
	unsigned k = pipe_order(e, owner, run_n);
	char numbered[40];
	snprintf(numbered, sizeof numbered, "pipe-%u", k);
	es_names path;
	code = es_resolve(c, o->name.text != NULL || o->name.steps != NULL ? o->name : es_text(numbered), &path);
	if (code) {
		es_node_data_free(&n);
		es_node_data_free(&tn);
		return code;
	}
	char *key = pipe_key(path.names, path.n);
	pipe_t *p = es_map_get(&x->pipes, key);
	if (p != NULL && p->owner == owner && sc_scope_alive(p->scope)) {
		if (computer != NULL && p->run_computer == computer && p->run_n == run_n) {
			char *at = names_join(CP(path.names), path.n);
			code = places_fail(ES_ALREADY_THERE, at);
			free(at);
		}
	} else {
		pipe_building b = {c, path.names, path.n, es_new_id(e)};
		code = es_inside(c, pipe_build, &b);
		if (code) {
			free(b.id);
		} else {
			p = es_alloc(sizeof *p);
			p->e = e;
			p->cx = c;
			p->id = b.id;
			p->id_value = op_str(p->id);
			p->flag = op_bool(1);
			p->owner = owner;
			p->key = es_dup(key);
			p->path = names_of(CP(path.names), path.n);
			p->at = x->nall_pipes;
			ES_PUSH(x->all_pipes, x->nall_pipes, x->capall_pipes, p);
			es_map_set(&x->pipes, key, p);
			es_map_set(&x->pipe_ids, p->id, p);
		}
	}
	free(key);
	if (code) {
		es_node_data_free(&n);
		es_node_data_free(&tn);
		es_names_free(&path);
		return code;
	}
	// made again: listened at again if what it listens at changed
	int back = o->has_to && o->back != NULL && tn.has_path;
	char *from_at = names_join(CP(n.path), n.npath);
	char *to_at = back ? names_join(CP(tn.path), tn.npath) : NULL;
	size_t size = strlen(from_at) + strlen(n.part) + (to_at != NULL ? strlen(to_at) + strlen(tn.part) : 0) + 8;
	char *watching = es_alloc(size);
	snprintf(watching, size, "%s\x1f%s\x1f%s\x1f%s", from_at, n.part, to_at != NULL ? to_at : "",
		to_at != NULL ? tn.part : "");
	free(from_at);
	free(to_at);
	if (p->watching == NULL || strcmp(p->watching, watching) != 0) {
		pipe_stop(p);
		free(p->watching);
		p->watching = watching;
		listen(p, &n, 0);
		if (back) listen(p, &tn, 1);
	} else {
		free(watching);
	}
	p->from = pipe_handle(c, from, &n);
	p->to = o->has_to ? pipe_handle(c, o->to, &tn) : NULL;
	es_node_data_free(&n);
	es_node_data_free(&tn);
	// made again: the new functions, told again. its scope: this run's (or the owner's), told its node
	p->tell = o->tell;
	p->there = o->there;
	p->back = o->back;
	p->ctx = o->ctx;
	p->write = o->write;
	p->looping = 0;
	p->chain = 0;
	p->run_computer = computer;
	p->run_n = run_n;
	sc_pair info[2] = {{PL_NODE, p->id_value}, {"pipe", p->flag}};
	sc_scope *scope = sc_create_scope(e->scheduler, info, 2, own);
	if (scope == NULL) {
		es_names_free(&path);
		return es_fail_text(SC_DISPOSED);
	}
	// made again: the scope it had (old, going as its owner's run ends) let go
	// its registration stays till that scope goes, no longer the pipe's (which may be freed first)
	if (p->scope != NULL) {
		for (size_t i = 0; i < x->nregs; i++) {
			if (x->regs[i]->scope == p->scope) x->regs[i]->p = NULL;
		}
		sc_release(p->scope);
	}
	p->scope = scope;
	pipe_reg *reg = es_alloc(sizeof *reg);
	reg->e = e;
	reg->p = p;
	reg->scope = scope;
	reg->at = x->nregs;
	ES_PUSH(x->regs, x->nregs, x->capregs, reg);
	free(sc_register_teardown(e->scheduler, scope, pipe_teardown, reg));
	es_queue_pulse(e);
	if (out != NULL) {
		es_node_data nd = {.has_path = 1, .path = path.names, .npath = path.n, .part = (char *)"value"};
		*out = es_handle_make(c, &nd);
	}
	es_names_free(&path);
	return 0;
}

int es_pipe_at(es_context *c, es_target from, const es_pipe_options *o, es_handle **out,
	const ch_site *site) {
	if (out != NULL) *out = NULL;
	const ch_site *was = es_enter(c->ermine, site);
	int code = make_pipe(c, from, o, out);
	es_enter(c->ermine, was);
	return code;
}

const char *const *es_get_args(es_context *c, size_t *n) {
	*n = c->nargs;
	return CP(c->args);
}

// patch ------------------------------------------------------------------------------------------------------------

typedef struct {
	es_context *c, *t;
	es_target x;
	const char *part;
	const op_patch *patches;
	size_t n;
} patching;
// the part patched: asked "edit" first, the write the node's side makes
static int patch_in(void *p) {
	patching *s = p;
	es_node_data n;
	TRY(node_part(s->t, s->x, s->part, &n));
	const char *id;
	int code = need_id(s->t, &n, &id);
	if (!code) code = ask(s->t, "edit", gd_target_of(thing_of(id, &n), n.part, NULL));
	if (!code && s->n) {
		es_write w = {.part = n.part, .id = id, .has_path = n.has_path, .path = CP(n.path),
			.npath = n.npath, .patches = s->patches, .npatches = s->n};
		code = es_context_put(s->t, &w);
	}
	es_node_data_free(&n);
	return code;
}
static int patch_part(es_context *c, es_target x, const char *part, const op_patch *patches,
	size_t n, const ch_site *site) {
	patching s = {c, c, x, part, patches, n};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, patch_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}

int es_patch_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_site *site) {
	return patch_part(c, x, NULL, patches, n, site);
}
int es_patch_attributes_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_site *site) {
	return patch_part(c, x, "attributes", patches, n, site);
}

// patchChildren ------------------------------------------------------------------------------------------------------

// a patch's value as a target: a handle, a string path, or a list of steps (anything else is no handle)
static int target_of_value(es_context *c, const op_value *v, es_target *x, es_names *own) {
	*own = (es_names){0};
	es_handle *h = es_handle_in(c->ermine, v);
	if (h != NULL) return *x = es_on_node(h), 0;
	if (v->type == OP_STR) return *x = es_on_path(es_text(v->str)), 0;
	if (v->type == OP_LIST) {
		names_init(own);
		for (size_t i = 0; i < v->count; i++) {
			if (v->items[i]->type != OP_STR) return es_names_free(own), not_a_handle();
			names_add(own, v->items[i]->str);
		}
		return *x = es_on_path(es_steps(CP(own->names), own->n)), 0;
	}
	// a stand-in that is no handle of this ermine's, or any other value
	return not_a_handle();
}

typedef struct {
	es_context *c, *t;
	es_target x;
	const op_patch *patches;
	size_t n;
} childing;
static int children_in(void *p) {
	childing *s = p;
	es_ermine *e = s->c->ermine;
	es_node_data n;
	TRY(es_node_of(s->t, s->x, &n));
	const char *folder;
	int code = need_id(s->t, &n, &folder);
	for (size_t i = 0; i < s->n && !code; i++) {
		const op_patch *p = &s->patches[i];
		if (p->place.length != 1 || p->place.path[0].type != OP_STR_KEY || p->has_move ||
			p->place.has_range) {
			code = not_patches();
			break;
		}
		const char *name = p->place.path[0].s;
		op_value *field;
		gd_thing parent = thing_of(folder, &n);
		gd_target slot = gd_slot(parent, name, &field);
		nd_entry *children = tb_get(e->table, tb_string("children"), tb_string(folder));
		pset ps;
		if (p->has_value && p->value != NULL) {
			// a path in a patch: the caller's, resolved as the caller resolves it
			es_target v;
			es_names own;
			code = target_of_value(s->c, p->value, &v, &own);
			char *id = NULL;
			if (!code) code = es_id_through(s->c, v, &id);
			if (!code) code = es_ask_placing(s->t, &slot, v, id);
			if (!code) code = placing(children, name, id, &ps);
			if (!code) {
				es_write w = {.part = "children", .id = folder, .patches = ps.p, .npatches = ps.n};
				code = es_context_put(s->t, &w);
				pset_free(&ps);
			}
			es_names_free(&own);
			free(id);
		} else if (children != NULL) {
			code = ask(s->t, "place", slot);
			if (!code) code = unplacing(children, name, &ps);
			if (!code) {
				es_write w = {.part = "children", .id = folder, .patches = ps.p, .npatches = ps.n};
				code = es_context_put(s->t, &w);
				pset_free(&ps);
			}
		}
		op_free(field);
	}
	es_node_data_free(&n);
	return code;
}
int es_patch_children_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_site *site) {
	childing s = {c, c, x, patches, n};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, children_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}

// place, unplace, rename, remove ----------------------------------------------------------------------------------

typedef struct {
	es_context *c;
	es_at p, to;
	es_target x;
} tree;

static int place_in(void *v) {
	tree *s = v;
	es_context *c = s->c;
	es_names path;
	TRY(es_resolve(c, s->p, &path));
	char *id = NULL;
	int code = es_id_through(c, s->x, &id);
	const char *parent = NULL;
	if (!code && path.n) code = get_id(c, CP(path.names), path.n - 1, &parent);
	if (!code && (parent == NULL || path.n == 0)) {
		code = places_fail_path(ES_NOTHING_THERE, CP(path.names), path.n);
	}
	if (!code) {
		op_value *field;
		gd_target slot = slot_at(parent, CP(path.names), path.n, &field);
		code = es_ask_placing(c, &slot, s->x, id);
		op_free(field);
	}
	if (!code) code = es_place_under(c, parent, path.names[path.n - 1], id, NULL, 0);
	free(id);
	es_names_free(&path);
	return code;
}
int es_place_at(es_context *c, es_at p, es_target x, const ch_site *site) {
	tree s = {.c = c, .p = p, .x = x};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, place_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}

static int unplace_in(void *v) {
	tree *s = v;
	es_context *c = s->c;
	es_names path;
	TRY(es_resolve(c, s->p, &path));
	nd_entry *children;
	const char *name, *parent;
	int code = es_folder_slot(c, CP(path.names), path.n, &children, &name);
	if (!code) code = get_id(c, CP(path.names), path.n - 1, &parent);
	if (!code) code = ask_slot(c, parent, CP(path.names), path.n);
	if (!code) {
		pset ps;
		code = unplacing(children, name, &ps);
		if (!code) {
			es_write w = {.part = "children", .id = parent, .patches = ps.p, .npatches = ps.n};
			code = es_context_put(c, &w);
			pset_free(&ps);
		}
	}
	es_names_free(&path);
	return code;
}
int es_unplace_at(es_context *c, es_at p, const ch_site *site) {
	tree s = {.c = c, .p = p};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, unplace_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}

// move's patches, checked as move checks: the one it goes into first; to the same name: none. each is
// the entry (0 the source's, 1 the target's) and its patches
typedef struct {
	pset ps[2];
	int entry[2];
	size_t n;
} moves;
static void moves_free(moves *m) {
	for (size_t i = 0; i < m->n; i++) pset_free(&m->ps[i]);
	*m = (moves){0};
}
static int moving(const nd_entry *from, const char *name, const nd_entry *into, const char *to,
	moves *m) {
	*m = (moves){0};
	if (!pl_is_name(to)) return places_fail(ES_NOT_A_NAME, to);
	const char *id = child_of(from, name);
	if (id == NULL) return places_fail(ES_NOTHING_THERE, name);
	if (from == into) {
		if (strcmp(name, to) == 0) return 0;
		if (is_map(from) && op_get(from->value, to) != NULL) return places_fail(ES_ALREADY_THERE, to);
		pset *s = &m->ps[0];
		s->key[0] = (op_key){.type = OP_STR_KEY, .s = to};
		s->key[1] = (op_key){.type = OP_STR_KEY, .s = name};
		s->p[0] = (op_patch){.place = {.path = &s->key[0], .length = 1}, .has_move = 1,
			.move = {.path = &s->key[1], .length = 1}};
		s->n = 1;
		m->entry[0] = 0;
		m->n = 1;
		return 0;
	}
	TRY(placing(into, to, id, &m->ps[0]));
	m->entry[0] = 1;
	m->n = 1;
	int code = unplacing(from, name, &m->ps[1]);
	if (code) return moves_free(m), code;
	m->entry[1] = 0;
	m->n = 2;
	return 0;
}

static int rename_in(void *v) {
	tree *s = v;
	es_context *c = s->c;
	es_ermine *e = c->ermine;
	es_names from, to = {0};
	TRY(es_resolve(c, s->p, &from));
	nd_entry *source;
	const char *name, *source_parent = NULL, *parent = NULL;
	int code = es_folder_slot(c, CP(from.names), from.n, &source, &name);
	if (!code) code = get_id(c, CP(from.names), from.n - 1, &source_parent);
	if (!code) code = es_resolve(c, s->to, &to);
	if (!code) {
		gd_refusal why = {0};
		code = answered(gd_move(CP(from.names), from.n, CP(to.names), to.n, &why), &why);
	}
	if (!code) code = ask_slot(c, source_parent, CP(from.names), from.n);
	if (!code && to.n) code = get_id(c, CP(to.names), to.n - 1, &parent);
	if (!code && (parent == NULL || to.n == 0)) {
		code = places_fail_path(ES_NOTHING_THERE, CP(to.names), to.n);
	}
	if (!code) code = ask_slot(c, parent, CP(to.names), to.n);
	if (!code) {
		nd_entry *into = tb_get(e->table, tb_string("children"), tb_string(parent));
		moves m;
		code = moving(source, name, into, to.names[to.n - 1], &m);
		for (size_t i = 0; i < m.n && !code; i++) {
			es_write w = {.part = "children", .id = m.entry[i] == 0 ? source_parent : parent,
				.patches = m.ps[i].p, .npatches = m.ps[i].n};
			code = es_context_put(c, &w);
		}
		moves_free(&m);
	}
	es_names_free(&from);
	es_names_free(&to);
	return code;
}
int es_rename_at(es_context *c, es_at from, es_at to, const ch_site *site) {
	tree s = {.c = c, .p = from, .to = to};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, rename_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}

static int remove_in(void *v) {
	tree *s = v;
	es_context *c = s->c, *t = c;
	es_ermine *e = c->ermine;
	es_node_data n;
	TRY(es_node_of(t, s->x, &n));
	const char *found;
	int code = need_id(t, &n, &found);
	// the id outlives its entries: the table lets go of its key with the last
	char *id = code ? NULL : es_dup(found);
	if (!code) code = ask(t, "remove", gd_target_of(thing_of(id, &n), NULL, NULL));
	if (!code && n.has_path && n.npath) {
		nd_entry *children;
		const char *name;
		if (es_folder_slot(t, CP(n.path), n.npath, &children, &name) == 0) {
			const char *there = child_of(children, name);
			const char *parent;
			if (there != NULL && strcmp(there, id) == 0 &&
				get_id(t, CP(n.path), n.npath - 1, &parent) == 0 && parent != NULL) {
				pset ps;
				code = unplacing(children, name, &ps);
				if (!code) {
					es_write w = {.part = "children", .id = parent, .patches = ps.p, .npatches = ps.n};
					code = es_context_put(c, &w);
					pset_free(&ps);
				}
			}
		} else es_clear_thrown();
	}
	if (!code) {
		// every part the node has, taken out (the parts copied: each write changes the table)
		size_t count;
		const tb_entry *at = tb_at(e->table, tb_string(id), &count);
		char **parts = es_alloc((count + 1) * sizeof *parts);
		for (size_t i = 0; i < count; i++) parts[i] = es_dup(at[i].part.string);
		for (size_t i = 0; i < count && !code; i++) {
			es_write w = {.part = parts[i], .id = id, .gone = 1};
			code = es_context_put(c, &w);
		}
		free_names(parts, count);
	}
	if (!code) {
		crn_drop(e->runs, tb_string(id));
		es_calls_drop(e, id);
		es_held_drop(e, id);
	}
	free(id);
	es_node_data_free(&n);
	return code;
}
int es_remove_at(es_context *c, es_target x, const ch_site *site) {
	tree s = {.c = c, .x = x};
	const ch_site *was = es_enter(c->ermine, site);
	int code = es_inside(c, remove_in, &s);
	es_enter(c->ermine, was);
	if (code) return code;
	es_queue_pulse(c->ermine);
	return 0;
}
