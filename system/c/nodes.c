// Nodes: contexts, handles, paths and seen, reads and writes of nodes, and the placement asks.
// ermine.h declares the functions. A failure is a code with es_thrown() set: a PlacesError's
// message is "code" or "code (at)", an ErmineError's "code: message", a Refusal's "op refused:
// reason".
#include "ermine.h"

#include <stdio.h>


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

// failures ----------

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

static int check(es_context *c) {
	return pl_status(c->places) == SC_OK ? 0 : es_fail(ES_STOP, "%s", "");
}

// names ----------

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
static int places_fail_path(int code, const char *const *path, size_t n) {
	char *at = es_join(path, n);
	places_fail(code, at);
	free(at);
	return code;
}

void es_names_free(es_names *names) {
	for (size_t i = 0; i < names->n; i++) free(names->names[i]);
	free(names->names);
	*names = (es_names){0};
}

static void parse(const char *s, es_names *out) {
	size_t k;
	char **steps = es_parse_steps(s, &k);
	for (size_t i = 0; i < k; i++) names_add(out, steps[i]);
	pr_names_free(steps, k);
}
static void plan_step(es_names *r, const char *step) {
	if (strcmp(step, ".") == 0) return;
	if (strcmp(step, "/") == 0) {
		while (r->n) names_pop(r);
		return;
	}
	if (strcmp(step, "..") != 0) names_add(r, step);
	else if (r->n) names_pop(r);
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
	for (size_t i = 0; i < nfrom; i++) plan_step(&r, from[i]);
	for (size_t i = 0; i < steps.n; i++) plan_step(&r, steps.names[i]);
	es_names_free(&steps);
	*out = r;
	return 0;
}

// node data ----------

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

// the state ----------

typedef struct {
	es_names at;
} running_rec;

struct es_handle {
	es_handle_data d;
};

struct es_nodes {
	es_ermine *ermine;
	es_map running;
	// what each reader waits on (es_missing, by reader): only a computer's, for its latest run, and a
	// process's while its setup runs
	es_map missing;
	es_map setting;
	es_context **contexts;
	size_t ncontexts, capcontexts;
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

void es_nodes_free(struct es_nodes *x) {
	if (x == NULL) return;
	for (size_t i = 0; i < x->running.n; i++) running_free(x->running.vals[i]);
	es_map_free(&x->running);
	for (size_t i = 0; i < x->missing.n; i++) missing_free(x->missing.vals[i]);
	es_map_free(&x->missing);
	es_map_free(&x->setting);
	es_map_free(&x->named);
	es_ermine *e = x->ermine;
	for (size_t i = 0; i < e->handles.cap; i++) {
		es_handle *h = (es_handle *)e->handles.keys[i];
		if (h == NULL) continue;
		es_node_data_free(&h->d.node);
		free(h);
	}
	pm_clear(&e->handles);
	e->nodes = NULL;
	while (x->ncontexts) es_context_free(x->contexts[--x->ncontexts]);
	free(x->contexts);
	free(x);
}

// handles ----------

// what a handle names as one string: its part, then its path's names or its id, each with its
// length first (a name may hold any byte but NUL)
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

// One handle per name: a handle is what it names and nothing else, so the same name is the same
// handle, made once and held until close. In C a program's pointer is not seen, so they are never
// let go; steady use names the same nodes, not more.
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

es_handle *es_handle_make(es_context *c, const es_node_data *n) { return es_mint(c->ermine, n); }

es_handle *es_handle_by_id(es_context *c, const char *id, const char *part) {
	es_node_data n = node_at_id(id, part);
	es_handle *h = es_mint(c->ermine, &n);
	es_node_data_free(&n);
	return h;
}

static es_handle *handle_at(es_context *c, es_names *names, const char *part) {
	es_node_data n = node_at_path(names, part);
	es_handle *h = es_handle_make(c, &n);
	es_node_data_free(&n);
	return h;
}

// contexts ----------


es_context *es_context_new(es_ermine *e, const es_context_options *o) {
	es_context *c = es_alloc(sizeof *c);
	c->ermine = e;
	c->scope = o->scope;
	c->folder = es_dup_names(o->folder, o->nfolder);
	c->nfolder = o->nfolder;
	c->at = es_dup_names(o->at, o->nat);
	c->nat = o->nat;
	c->args = es_dup_names(o->args, o->nargs);
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
	pr_names_free(c->folder, c->nfolder);
	pr_names_free(c->at, c->nat);
	pr_names_free(c->args, c->nargs);
	free(c->node);
	free(c);
}

// f with a scope open ----------

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

// nothing open: a process's functions are called from its setup, runs, acts and calls, so after an
// await, a timer or a listener nothing is open. The host falls back to its own scope
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

ch_frame *es_open_frame(es_context *c) {
	ch_frame *f = sc_get_current_frame(c->ermine->scheduler);
	return f != NULL ? f : sc_scope_frame(c->scope);
}

sc_scope *es_owner(es_context *c) {
	sc_scope *o = sc_get_current_scope(c->ermine->scheduler);
	return o != NULL ? o : c->scope;
}

// asking ----------

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
static int refused(es_context *c, gd_target t, int *no) {
	*no = 0;
	if (!c->guarded) return 0;
	gd_refusal why = {0};
	gd_answer a = gd_read(c->guard, &t, 1, &why);
	if (a == GD_REFUSED) return *no = 1, 0;
	return answered(a, &why);
}

gd_thing es_thing_of(const char *id, const es_node_data *n) {
	gd_thing t = {.id = tb_string(id)};
	if (n != NULL && n->has_path) t.path = CP(n->path), t.npath = n->npath;
	return t;
}
static op_value *field_of(const op_key *path, size_t n) {
	op_value *l = op_list();
	for (size_t i = 0; i < n; i++) {
		if (path[i].type == OP_STR_KEY) op_push(l, op_str(path[i].s));
		else if (path[i].type == OP_NUM_KEY) op_push(l, op_num((double)path[i].n));
	}
	return l;
}
// the slot of the name last in path, in the folder parent: what placing there changes. *field is the caller's
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
int es_ask_slot(es_context *c, const char *parent, const char *const *path, size_t npath) {
	return ask_slot(c, parent, path, npath);
}

static int up_go(es_ermine *e, const pl *places, const char *root, const char *at, es_map *visited,
	es_names *out);

// ids and nodes ----------

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

// the placement asks ----------

int es_ask_placing(es_context *c, const gd_target *slot, es_target x, const char *id) {
	if (!c->guarded) return 0;
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	gd_thing thing = es_thing_of(id, &n);
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

// patches ----------

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

static int is_map(const nd_entry *e) { return e != NULL && e->value != NULL && e->value->type == OP_MAP; }
static const char *child_of(const nd_entry *children, const char *name) {
	if (!is_map(children)) return NULL;
	const op_value *v = op_get(children->value, name);
	return v != NULL && v->type == OP_STR ? v->str : NULL;
}

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
static int unplacing(const nd_entry *children, const char *name, pset *s) {
	*s = (pset){0};
	if (child_of(children, name) == NULL) return places_fail(ES_NOTHING_THERE, name);
	pset_name(s, 0, name, NULL);
	return 0;
}

static op_patch whole(const op_value *v) {
	op_patch p = {0};
	if (v != NULL) p.has_value = 1, p.value = v;
	return p;
}

// writing ----------

typedef struct block block;
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

typedef struct {
	ch_frame *frame;
	op_value *list;
} featured;
static void featured_free(void *p) {
	featured *f = p;
	ch_frame_free(f->frame);
	op_free(f->list);
	free(f);
}

// the change a write lands with: its writer's, or made now; for a write a hook changed, that one
// with a frame more on top naming the hooks. *made: the block of a header made now; *fx: the frame
static int header_of(es_ermine *e, const es_write *w, ch_header *h, pl_made **made,
	featured **fx) {
	*made = NULL;
	*fx = NULL;
	if (w->header != NULL) *h = *w->header;
	else TRY(es_header(e, h, made));
	if (w->nfeatures == 0) return 0;
	featured *f = es_alloc(sizeof *f);
	f->list = op_list();
	for (size_t i = 0; i < w->nfeatures; i++) op_push(f->list, op_str(w->features[i]));
	ch_pair info = {ES_FEATURES, f->list};
	f->frame = ch_frame_make(&info, 1, h->frame);
	h->frame = f->frame;
	*fx = f;
	return 0;
}

static void hold(es_ermine *e, const nd_entry *entry, int *first, void *blk,
	void (*release)(void *)) {
	if (blk == NULL) return;
	if (*first) pl_hold(e->places, entry, blk, release), *first = 0;
	else pl_hold_also(e->places, entry, blk, release);
}

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
		// the places' till it is out of the table (taken out, or written over whole), then let go after a
		// pulse (pl_sweep)
		pl_own_in(e->places, fresh, e->table);
		hold(e, fresh, &first, made, pl_made_free);
		hold(e, fresh, &first, fx, featured_free);
		return 0;
	}
	block *b = block_new(w->patches, w->npatches);
	size_t failed = 0;
	int bad = strcmp(w->part, "children") == 0 || strcmp(w->part, PR_PART) == 0
		? pl_update_entry(pl_crow(e->places), entry, b->patches, b->n, h, &failed)
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

typedef struct {
	es_context *c;
	const char *part;
	const es_aim *at;
	const op_patch *patches;
	size_t n;
	int gone;
} writing;
static int in_pulse(es_context *c, es_thunk f, void *ctx, const ch_location *site) {
	const ch_location *was = es_enter(c->ermine, site);
	int code = es_inside(c, f, ctx);
	es_enter(c->ermine, was);
	if (!code) es_queue_pulse(c->ermine);
	return code;
}

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
	size_t n, int gone, const ch_location *site) {
	writing s = {c, part, at, patches, n, gone};
	return in_pulse(c, write_in, &s, site);
}
int es_context_write_at(es_context *c, const char *part, const es_aim *at, const op_patch *patches,
	size_t n, const ch_location *site) {
	return write_run(c, part, at, patches, n, 0, site);
}
int es_context_remove_at(es_context *c, const char *part, const es_aim *at, const ch_location *site) {
	return write_run(c, part, at, NULL, 0, 1, site);
}

// placing and building ----------

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

// seen ----------

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

static int running_at(es_ermine *e, const char *id, char *const *path, size_t n) {
	if (id == NULL) return 0;
	running_rec *r = es_map_get(&state(e)->running, id);
	if (r == NULL || r->at.n != n) return 0;
	for (size_t i = 0; i < n; i++)
		if (strcmp(r->at.names[i], path[i]) != 0) return 0;
	return 1;
}

void es_running_clear(es_ermine *e, const char *process) {
	struct es_nodes *x = state(e);
	running_rec *r = es_map_get(&x->running, process);
	if (r == NULL) return;
	es_map_del(&x->running, process);
	running_free(r);
}

// the names from root down to id, up id's names now (places' names, the latest placed first at each
// step; a process's node is named by its row). 1 and *out; 0: nothing reaches it from root. Read
// untracked
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
	int found = up_go(e, reader->places, pl_root(reader->places).string, id, &visited, &p);
	es_map_free(&visited);
	if (!found) return 0;
	tb_key k;
	if (pl_get(reader->places, CP(p.names), p.n, &k) && strcmp(k.string, id) == 0) {
		return *out = p, 1;
	}
	es_names_free(&p);
	return 0;
}

// getNode, ensureNode, createNode, ref ----------

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
	es_handle **out, const ch_location *site) {
	if (out != NULL) *out = NULL;
	ensuring s = {.c = c, .value = value, .make = make, .ctx = ctx};
	TRY(es_resolve(c, p, &s.path));
	int code = in_pulse(c, ensure_in, &s, site);
	if (code) return es_names_free(&s.path), code;
	if (out != NULL) *out = handle_at(c, &s.path, "value");
	es_names_free(&s.path);
	return 0;
}

int es_ensure_node_at(es_context *c, es_at p, const op_value *value, es_handle **out,
	const ch_location *site) {
	return ensuring_at(c, p, value, NULL, NULL, out, site);
}

int es_ref_at(es_context *c, es_at p, es_make make, void *ctx, es_handle **out,
	const ch_location *site) {
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
	const ch_location *site) {
	es_ermine *e = c->ermine;
	if (out != NULL) *out = NULL;
	char *id = es_new_id(e);
	creating s = {.c = c, .value = value, .id = id};
	int code = es_resolve(c, folder, &s.path);
	if (code) return free(id), code;
	char *name = es_new_id(e);
	names_add(&s.path, name);
	free(name);
	code = in_pulse(c, create_in, &s, site);
	free(id);
	if (code) return es_names_free(&s.path), code;
	if (out != NULL) *out = handle_at(c, &s.path, "value");
	es_names_free(&s.path);
	return 0;
}

// reads ----------

static int node_part(es_context *t, es_target x, const char *part, es_node_data *n) {
	TRY(es_node_of(t, x, n));
	if (part != NULL) {
		free(n->part);
		n->part = es_dup(part);
	}
	return 0;
}

static const char *computer_node(sc_computer *computer) {
	const op_value *v = ch_frame_get(sc_scope_frame(computer), CH_NODE);
	return v != NULL && v->type == OP_STR ? v->str : NULL;
}

static char *names_key(const char *const *names, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(names[i]) + 21;
	char *s = es_alloc(len), *o = s;
	for (size_t i = 0; i < n; i++) o += sprintf(o, "%zu:%s", strlen(names[i]), names[i]);
	return s;
}

// path (as c sees it) waited on by the reader now: a computer's (in its run now), else a setup's.
// Anyone else's is shown nowhere, so not held. Held from the root, shown to each asker as it sees it
static void wait_for(es_context *c, const char *const *path, size_t npath) {
	es_ermine *e = c->ermine;
	struct es_nodes *x = state(e);
	sc_run *run = sc_get_run(e->scheduler);
	const char *computer = run == NULL ? NULL : computer_node(sc_run_computer(run));
	const char *key = computer != NULL ? computer : c->node;
	if (computer == NULL && !es_map_has(&x->setting, c->node)) return;
	int has_n = computer != NULL;
	// the number this run will have: its computer's latest record's, plus one (that record is read and
	// tracked, as system/reading.ts' waitFor reads it)
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

static int read_part(es_context *c, es_target x, const char *part, const op_key *key, size_t nkey,
	const op_value **out) {
	es_ermine *e = c->ermine;
	*out = NULL;
	es_node_data n;
	TRY(node_part(c, x, part, &n));
	const char *id;
	if (!es_id_of(c, &n, &id)) {
		// a node not there is pending, as a memo with no value is. The read is tracked so its coming reruns
		// it, and said where the reader waits
		int code = check(c);
		if (!code && n.has_path && c->peeping == 0) wait_for(c, CP(n.path), n.npath);
		if (!code) code = es_fail(ES_PENDING, "%s", "");
		es_node_data_free(&n);
		return code;
	}
	int code = 0;
	if (c->guarded) {
		op_value *field = field_of(key, nkey);
		code = ask_read(c, gd_target_of(es_thing_of(id, &n), n.part, nkey ? field : NULL));
		op_free(field);
	}
	if (!code && c->peeping == 0) es_calls_read(e, n.part, id, key, nkey, 1, 0);
	if (!code) {
		const op_value *v = pl_read(c->places, tb_string(n.part), tb_string(id), key, nkey);
		int pending = 0;
		if (strcmp(n.part, "value") == 0 && es_is_memo(e, id)) {
			pending = v == NULL && cst_pending(c->places, tb_string(id));
		}
		code = check(c);
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

static int versions_part(es_context *c, es_target x, const char *part, const op_key *key,
	size_t nkey, es_versions *out) {
	es_ermine *e = c->ermine;
	*out = (es_versions){0};
	es_node_data n;
	TRY(node_part(c, x, part, &n));
	const op_value *shown;
	int code = read_part(c, x, part, key, nkey, &shown);
	const char *id = NULL;
	if (!code && !es_id_of(c, &n, &id)) {
		es_node_data_free(&n);
		return check(c);
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
	for (size_t i = 0; i < shown_out.n; i++) {
		es_from *f = &shown_out.items[i].from;
		if (f->change != NULL && f->view == NULL) f->view = es_change_view_of(e, f->change);
	}
	*out = shown_out;
	return 0;
}

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

int es_read_entries(es_context *c, es_target x, es_items *out) {
	es_ermine *e = c->ermine;
	*out = (es_items){0};
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	int code = 0;
	if (!n.has_path) {
		if (n.id != NULL) {
			int no;
			code = refused(c, gd_target_of(es_thing_of(n.id, NULL), n.part, NULL), &no);
			if (!code && no) items_push(out, NULL, "id", NULL, 1);
			else if (!code) {
				if (c->peeping == 0) es_calls_read(e, n.part, n.id, NULL, 0, 1, 0);
				const op_value *v = pl_read(c->places, tb_string(n.part), tb_string(n.id), NULL, 0);
				size_t held;
				tb_at(e->table, tb_string(n.id), &held);
				if (v != NULL || held > 0) {
					items_push(out, v, "id", es_handle_by_id(c, n.id, n.part), 0);
				}
			}
		}
		es_node_data_free(&n);
		if (!code) code = check(c);
		if (code) es_items_free(out);
		return code;
	}
	pl_answers all = pl_gets(c->places, CP(n.path), n.npath);
	for (size_t i = 0; i < all.n && c->peeping == 0; i++) {
		es_calls_read(e, n.part, all.items[i].id.string, NULL, 0, 1, 0);
	}
	if (!c->guarded) {
		for (size_t i = 0; i < all.n; i++) {
			const char *id = all.items[i].id.string;
			items_push(out, pl_read(c->places, tb_string(n.part), tb_string(id), NULL, 0),
				all.items[i].from, es_handle_by_id(c, id, n.part), 0);
		}
	} else if (n.npath == 0) {
		for (size_t i = 0; i < all.n && !code; i++) {
			const char *id = all.items[i].id.string;
			int no;
			code = refused(c, gd_target_of(es_thing_of(id, &n), n.part, NULL), &no);
			if (code) break;
			if (no) items_push(out, NULL, all.items[i].from, NULL, 1);
			else {
				items_push(out, pl_read(c->places, tb_string(n.part), tb_string(id), NULL, 0),
					all.items[i].from, es_handle_by_id(c, id, n.part), 0);
			}
		}
	} else {
		pl_member *in = es_alloc((all.n + 1) * sizeof *in);
		for (size_t i = 0; i < all.n; i++) {
			in[i] = (pl_member){n.path[n.npath - 1], all.items[i].id, all.items[i].from};
		}
		pl_members list = {all.n, in}, asked;
		gd_answer a = gd_members(c->guard, &list, CP(n.path), n.npath - 1, &asked);
		free(in);
		code = answered(a, &(gd_refusal){"read", "refused", {0}, 0});
		if (!code) {
			for (size_t i = 0; i < all.n; i++) {
				const char *id = all.items[i].id.string;
				if (gd_is_refused(asked.items[i].id)) {
					items_push(out, NULL, all.items[i].from, NULL, 1);
				} else {
					items_push(out, pl_read(c->places, tb_string(n.part), tb_string(id), NULL, 0),
						all.items[i].from, es_handle_by_id(c, id, n.part), 0);
				}
			}
		}
		pl_members_free(&asked);
	}
	pl_answers_free(&all);
	es_node_data_free(&n);
	if (!code) code = check(c);
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
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	const char *id;
	int has = es_id_of(c, &n, &id);
	int code = 0;
	if (c->guarded && has) code = ask_read(c, gd_target_of(es_thing_of(id, &n), "children", NULL));
	if (!code && has && c->peeping == 0) es_calls_read(e, "children", id, NULL, 0, 1, 1);
	es_names got;
	names_init(&got);
	if (!code) {
		if (n.has_path) {
			pl_members m = pl_list(c->places, CP(n.path), n.npath);
			for (size_t i = 0; i < m.n; i++) names_add(&got, m.items[i].name);
			pl_members_free(&m);
		} else if (n.id != NULL) {
			pl_namelist nl = {0};
			pl_keys(c->places, tb_string("children"), tb_string(n.id), NULL, 0, 0, &nl);
			for (size_t i = 0; i < nl.n; i++) names_add(&got, nl.items[i]);
			pl_namelist_free(&nl);
		}
		if (!code) code = check(c);
	}
	es_node_data_free(&n);
	if (code) return es_names_free(&got), code;
	*out = got;
	return 0;
}

int es_read_children(es_context *c, es_target x, es_children *out) {
	*out = (es_children){0};
	es_node_data n;
	TRY(es_node_of(c, x, &n));
	const char *id;
	es_id_of(c, &n, &id);
	es_names names;
	int code = es_list(c, x, &names);
	if (code) return es_node_data_free(&n), code;
	const op_value *kids = id != NULL
		? pl_read(c->places, tb_string("children"), tb_string(id), NULL, 0) : NULL;
	out->names = es_alloc((names.n + 1) * sizeof *out->names);
	out->nodes = es_alloc((names.n + 1) * sizeof *out->nodes);
	for (size_t i = 0; i < names.n && !code; i++) {
		const char *at = NULL;
		const op_value *kid = kids != NULL && kids->type == OP_MAP ? op_get(kids, names.names[i]) : NULL;
		if (n.has_path && at == NULL) {
			es_names p = names_of(CP(n.path), n.npath);
			names_add(&p, names.names[i]);
			tb_key k;
			if (pl_get(c->places, CP(p.names), p.n, &k)) at = k.string;
			es_names_free(&p);
		}
		if (at == NULL && kid != NULL && kid->type == OP_STR) at = kid->str;
		if (at == NULL) continue;
		out->names[out->n] = es_dup(names.names[i]);
		out->nodes[out->n++] = es_handle_by_id(c, at, "value");
	}
	es_names_free(&names);
	es_node_data_free(&n);
	if (!code) code = check(c);
	if (code) es_children_free(out);
	return code;
}

const char *const *es_get_args(es_context *c, size_t *n) {
	*n = c->nargs;
	return CP(c->args);
}

// patch ----------

typedef struct {
	es_context *c;
	es_target x;
	const char *part;
	const op_patch *patches;
	size_t n;
} patching;
static int patch_in(void *p) {
	patching *s = p;
	es_node_data n;
	TRY(node_part(s->c, s->x, s->part, &n));
	const char *id;
	int code = need_id(s->c, &n, &id);
	if (!code) code = ask(s->c, "edit", gd_target_of(es_thing_of(id, &n), n.part, NULL));
	if (!code && s->n) {
		es_write w = {.part = n.part, .id = id, .has_path = n.has_path, .path = CP(n.path),
			.npath = n.npath, .patches = s->patches, .npatches = s->n};
		code = es_context_put(s->c, &w);
	}
	es_node_data_free(&n);
	return code;
}
static int patch_part(es_context *c, es_target x, const char *part, const op_patch *patches,
	size_t n, const ch_location *site) {
	patching s = {c, x, part, patches, n};
	return in_pulse(c, patch_in, &s, site);
}

int es_patch_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_location *site) {
	return patch_part(c, x, NULL, patches, n, site);
}
int es_patch_attributes_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_location *site) {
	return patch_part(c, x, "attributes", patches, n, site);
}

// patchChildren ----------

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
	return not_a_handle();
}

// place, unplace, rename, remove ----------

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
int es_place_at(es_context *c, es_at p, es_target x, const ch_location *site) {
	tree s = {.c = c, .p = p, .x = x};
	return in_pulse(c, place_in, &s, site);
}

// a saved child of a folder that something else shadows at its path is not the process's to move
// or take out: nothing-there
static int not_shadowed(es_context *c, const es_names *path, const nd_entry *children, const char *name) {
	const char *saved = child_of(children, name), *there;
	if (saved == NULL) return 0;
	TRY(get_id(c, CP(path->names), path->n, &there));
	if (there == NULL || strcmp(saved, there) != 0) {
		return places_fail_path(ES_NOTHING_THERE, CP(path->names), path->n);
	}
	return 0;
}

// every name that holds id taken out of its folder, as the folder is now (not by a path, which a
// removed folder no longer gives); returns the first error's text
char *es_unplace_names(es_context *c, const char *id) {
	size_t n;
	const pl_slot *slots = pl_names_of(c->places, tb_string(id), &n);
	char **folders = es_alloc((n + 1) * sizeof *folders), **names = es_alloc((n + 1) * sizeof *names);
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		if (slots[i].folder.string == NULL) continue;
		folders[k] = es_dup(slots[i].folder.string);
		names[k++] = es_dup(slots[i].name);
	}
	char *bad = NULL;
	for (size_t i = 0; i < k; i++) {
		nd_entry *children = tb_get(c->ermine->table, tb_string("children"), tb_string(folders[i]));
		const char *there = child_of(children, names[i]);
		pset ps;
		if (there == NULL || strcmp(there, id) != 0 || unplacing(children, names[i], &ps)) continue;
		es_write w = {.part = "children", .id = folders[i], .patches = ps.p, .npatches = ps.n};
		int code = es_context_put(c, &w);
		pset_free(&ps);
		if (code && code != ES_CLOSED && bad == NULL) {
			const es_error *thrown = es_thrown();
			bad = es_dup(thrown->message != NULL ? thrown->message : es_code_name(code));
		}
	}
	pr_names_free(folders, k);
	pr_names_free(names, k);
	return bad;
}

// every memo, effect and action made at a node and under it, each id given stopped: a computer's
// scope torn down, its node and name gone; an action's node value taken out, then its placement let
// go. The process that made them keeps running
static void stop_made(es_context *c, char *const *ids, size_t n) {
	es_ermine *e = c->ermine;
	for (size_t i = 0; i < n; i++) {
		es_stop_computer(e, ids[i]);
		if (!es_is_action(e, ids[i])) continue;
		size_t count;
		const tb_entry *at = tb_at(e->table, tb_string(ids[i]), &count);
		char **parts = es_alloc((count + 1) * sizeof *parts);
		for (size_t k = 0; k < count; k++) parts[k] = es_dup(at[k].part.string);
		for (size_t k = 0; k < count; k++) {
			es_write w = {.part = parts[k], .id = ids[i], .gone = 1};
			es_context_put(c, &w);
		}
		pr_names_free(parts, count);
		es_stop_action(e, ids[i]);
	}
}

typedef struct {
	char **v;
	size_t n, cap;
	es_map seen;
} idlist;
static void under_go(es_ermine *e, const char *id, idlist *l) {
	if (es_map_has(&l->seen, id)) return;
	es_map_set(&l->seen, id, NULL);
	ES_PUSH(l->v, l->n, l->cap, es_dup(id));
	nd_entry *kids = tb_get(e->table, tb_string("children"), tb_string(id));
	if (!is_map(kids)) return;
	for (size_t i = 0; i < kids->value->count; i++) {
		const op_value *x = kids->value->items[i];
		if (x->type == OP_STR) under_go(e, x->str, l);
	}
}
static void under(es_ermine *e, const char *id, idlist *l) {
	*l = (idlist){0};
	under_go(e, id, l);
}
static void idlist_free(idlist *l) {
	pr_names_free(l->v, l->n);
	es_map_free(&l->seen);
}
static void stop_unreached(es_context *c, idlist *l, const char *keep) {
	char **stop = es_alloc((l->n + 1) * sizeof *stop);
	size_t k = 0;
	for (size_t i = 0; i < l->n; i++) {
		es_names p;
		if ((keep == NULL || strcmp(l->v[i], keep) != 0) && es_seen_in(c->ermine, c, l->v[i], &p)) {
			es_names_free(&p);
			continue;
		}
		stop[k++] = l->v[i];
	}
	stop_made(c, stop, k);
	free(stop);
}

typedef struct {
	es_context *c;
	es_target x;
	const op_patch *patches;
	size_t n;
} childing;
static int children_in(void *p) {
	childing *s = p;
	es_ermine *e = s->c->ermine;
	es_node_data n;
	TRY(es_node_of(s->c, s->x, &n));
	const char *folder;
	int code = need_id(s->c, &n, &folder);
	for (size_t i = 0; i < s->n && !code; i++) {
		const op_patch *p = &s->patches[i];
		if (p->place.length != 1 || p->place.path[0].type != OP_STR_KEY || p->has_move ||
			p->place.has_range) {
			code = not_patches();
			break;
		}
		const char *name = p->place.path[0].s;
		op_value *field;
		gd_thing parent = es_thing_of(folder, &n);
		gd_target slot = gd_slot(parent, name, &field);
		nd_entry *children = tb_get(e->table, tb_string("children"), tb_string(folder));
		pset ps;
		if (p->has_value && p->value != NULL) {
			es_target v;
			es_names own;
			code = target_of_value(s->c, p->value, &v, &own);
			char *id = NULL;
			if (!code) code = es_id_through(s->c, v, &id);
			if (!code) code = es_ask_placing(s->c, &slot, v, id);
			if (!code) code = placing(children, name, id, &ps);
			if (!code) {
				es_write w = {.part = "children", .id = folder, .patches = ps.p, .npatches = ps.n};
				code = es_context_put(s->c, &w);
				pset_free(&ps);
			}
			es_names_free(&own);
			free(id);
		} else {
			const char *at = NULL;
			char **names = NULL;
			int running = 0;
			if (n.has_path) {
				names = es_alloc((n.npath + 1) * sizeof *names);
				for (size_t k = 0; k < n.npath; k++) names[k] = n.path[k];
				names[n.npath] = (char *)name;
				running = get_id(s->c, CP(names), n.npath + 1, &at) == 0 &&
					running_at(e, at, names, n.npath + 1);
				if (!running) es_clear_thrown();
			}
			if (running) {
				char *id = es_dup(at);
				code = ask(s->c, "place", slot);
				if (!code) code = es_stop_node(e, id);
				free(id);
			} else if (children != NULL) {
				code = ask(s->c, "place", slot);
				const char *was = child_of(children, name);
				idlist below = {0};
				if (!code && was != NULL) under(e, was, &below);
				if (!code) code = unplacing(children, name, &ps);
				if (!code) {
					es_write w = {.part = "children", .id = folder, .patches = ps.p, .npatches = ps.n};
					code = es_context_put(s->c, &w);
					pset_free(&ps);
				}
				if (!code) stop_unreached(s->c, &below, NULL);
				idlist_free(&below);
			}
			free(names);
		}
		op_free(field);
	}
	es_node_data_free(&n);
	return code;
}
int es_patch_children_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_location *site) {
	childing s = {c, x, patches, n};
	return in_pulse(c, children_in, &s, site);
}

// a name out of its folder; a process's node there (named by its row): the process is stopped,
// which takes the row, and so the name
static int unplace_in(void *v) {
	tree *s = v;
	es_context *c = s->c;
	es_names path;
	TRY(es_resolve(c, s->p, &path));
	const char *at, *folder;
	if (path.n && get_id(c, CP(path.names), path.n, &at) == 0 &&
		running_at(c->ermine, at, path.names, path.n)) {
		char *id = es_dup(at);
		int code = get_id(c, CP(path.names), path.n - 1, &folder);
		if (!code) {
			code = folder != NULL ? ask_slot(c, folder, CP(path.names), path.n)
				: ask(c, "place", gd_target_of((gd_thing){.id = tb_string(id), .path = CP(path.names),
					.npath = path.n}, NULL, NULL));
		}
		if (!code) code = es_stop_node(c->ermine, id);
		free(id);
		es_names_free(&path);
		return code;
	}
	es_clear_thrown();
	nd_entry *children;
	const char *name, *parent;
	int code = es_folder_slot(c, CP(path.names), path.n, &children, &name);
	if (!code) code = not_shadowed(c, &path, children, name);
	if (!code) code = get_id(c, CP(path.names), path.n - 1, &parent);
	if (!code) code = ask_slot(c, parent, CP(path.names), path.n);
	if (!code) {
		pset ps;
		const char *was = child_of(children, name);
		idlist below = {0};
		if (was != NULL) under(c->ermine, was, &below);
		code = unplacing(children, name, &ps);
		if (!code) {
			es_write w = {.part = "children", .id = parent, .patches = ps.p, .npatches = ps.n};
			code = es_context_put(c, &w);
			pset_free(&ps);
		}
		if (!code) stop_unreached(c, &below, NULL);
		idlist_free(&below);
	}
	es_names_free(&path);
	return code;
}
int es_unplace_at(es_context *c, es_at p, const ch_location *site) {
	tree s = {.c = c, .p = p};
	return in_pulse(c, unplace_in, &s, site);
}

// move's patches, checked as move checks: the one it goes into first; to the same name: none. Each
// is the entry (0 the source's, 1 the target's) and its patches
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
	if (!code) code = not_shadowed(c, &from, source, name);
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
int es_rename_at(es_context *c, es_at from, es_at to, const ch_location *site) {
	tree s = {.c = c, .p = from, .to = to};
	return in_pulse(c, rename_in, &s, site);
}

static int remove_in(void *v) {
	tree *s = v;
	es_context *c = s->c;
	es_ermine *e = c->ermine;
	es_node_data n;
	TRY(es_node_of(c, s->x, &n));
	const char *found;
	int code = need_id(c, &n, &found);
	char *id = code ? NULL : es_dup(found);
	if (!code) code = ask(c, "remove", gd_target_of(es_thing_of(id, &n), NULL, NULL));
	idlist below = {0};
	if (!code) under(e, id, &below);
	if (!code && es_map_get(&state(e)->running, id) != NULL) code = es_stop_node(e, id);
	else if (!code && n.has_path && n.npath) {
		nd_entry *children;
		const char *name;
		if (es_folder_slot(c, CP(n.path), n.npath, &children, &name) == 0) {
			const char *there = child_of(children, name);
			const char *parent;
			if (there != NULL && strcmp(there, id) == 0 &&
				get_id(c, CP(n.path), n.npath - 1, &parent) == 0 && parent != NULL) {
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
		size_t count;
		const tb_entry *at = tb_at(e->table, tb_string(id), &count);
		char **parts = es_alloc((count + 1) * sizeof *parts);
		for (size_t i = 0; i < count; i++) parts[i] = es_dup(at[i].part.string);
		for (size_t i = 0; i < count && !code; i++) {
			es_write w = {.part = parts[i], .id = id, .gone = 1};
			code = es_context_put(c, &w);
		}
		pr_names_free(parts, count);
	}
	if (!code) {
		crn_drop(e->runs, tb_string(id));
		es_calls_drop(e, id);
		es_held_drop(e, id);
		// what was made at it and under it stops (the node itself always; what is under it, unless a name
		// still reaches it)
		stop_unreached(c, &below, id);
	}
	idlist_free(&below);
	free(id);
	es_node_data_free(&n);
	return code;
}
int es_remove_at(es_context *c, es_target x, const ch_location *site) {
	tree s = {.c = c, .x = x};
	return in_pulse(c, remove_in, &s, site);
}
