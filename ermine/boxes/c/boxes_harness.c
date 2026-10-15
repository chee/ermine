// The C boxes (boxes.h) on the line protocol of typescript/boxes_harness.ts, which documents it and
// the programs (conformance/c/harness.h has the loop). Its world is places' (the scheduler, the table,
// the host's places at root "R", children alone, the host's scope, the watches:
// filesystem/places/c/world.h), made by world_line at the first line: the table's hook tells the
// host's places alone, and a box's places, a view of them, shares their spots. An address given as a
// string is split here as path.ts' parse splits it.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/world.h"
#include "boxes.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static bx_host host;

// boxes by name, and the path cache on each one's places (made at its first cached read)
typedef struct {
	char *name;
	bx *box;
	pc_cache *cache;
} naming;
static naming *named;
static size_t nnamed, capnamed;

static naming *box_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nnamed; i++) {
		if (strcmp(named[i].name, name) == 0) return &named[i];
	}
	return NULL;
}

// the ids writes made, and the name each was made at: "new:<name>"
typedef struct {
	char *id;
	char *label;
} fresh;
static fresh *fresh_ids;
static size_t nfresh, capfresh;

static const char *label_of(const char *id) {
	for (size_t i = 0; i < nfresh; i++) {
		if (strcmp(fresh_ids[i].id, id) == 0) return fresh_ids[i].label;
	}
	return NULL;
}

// whether a string is a uuid's form: 36, the dashes at 8, 13, 18 and 23, hex between
static bool is_uuid(const char *s) {
	if (strlen(s) != 36) return false;
	for (size_t i = 0; i < 36; i++) {
		bool dash = i == 8 || i == 13 || i == 18 || i == 23;
		if (dash ? s[i] != '-' : strchr("0123456789abcdef", s[i]) == NULL || s[i] == 0) return false;
	}
	return true;
}

// the folders on the way from an id along names, through saved children, each one a write made (a
// uuid) named by its name
static void learn(const char *from, const char *const *names, size_t n) {
	tb_key at = tb_string(from);
	for (size_t i = 0; i < n; i++) {
		const nd_entry *kids = tb_get(world_table, tb_string("children"), at);
		const op_value *v = kids != NULL && kids->value != NULL && kids->value->type == OP_MAP
			? op_get(kids->value, names[i])
			: NULL;
		if (v == NULL || v->type != OP_STR) return;
		if (is_uuid(v->str) && label_of(v->str) == NULL) {
			PUSH(fresh_ids, nfresh, capfresh, ((fresh){world_copy(v->str), world_format("new:%s", names[i])}));
		}
		at = tb_string(v->str);
	}
}

// a value with every fresh id as "new:<name>": new
static op_value *mask(const op_value *v) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		const char *label = label_of(v->str);
		return label != NULL ? op_str(label) : op_ref((op_value *)v);
	}
	if (v->type == OP_LIST) {
		op_value *a = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(a, mask(v->items[i]));
		return a;
	}
	if (v->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) op_set(m, v->keys[i], mask(v->items[i]));
		return m;
	}
	return op_ref((op_value *)v);
}

static op_value *mask_take(op_value *v) {
	op_value *m = mask(v);
	op_free(v);
	return m;
}

// an address's steps, the strings copied: a string split as path.ts' parse does (a leading "/" is
// "/", empty pieces skipped), a list as it is (a piece that is no string: "")
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (world_is(a, OP_STR)) {
		const char *p = a->str;
		if (*p == '/') PUSH(s.v, s.n, s.cap, world_copy("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = world_alloc(len + 1);
				memcpy(piece, p, len);
				PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (world_is(a, OP_LIST)) {
		for (size_t i = 0; i < a->count; i++) {
			const char *t = world_text(a->items[i]);
			PUSH(s.v, s.n, s.cap, world_copy(t != NULL ? t : ""));
		}
	}
	return s;
}

static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}

// the names an address comes to inside a root (bx_inside): borrowed from s, freed by the caller
static const char **inside(const steps *s, const char *const *from, size_t nfrom, size_t *n) {
	const char **out = world_alloc((nfrom + s->n + 1) * sizeof *out);
	*n = bx_inside((const char *const *)s->v, s->n, from, nfrom, out);
	return out;
}

static op_value *names_list(const char *const *names, size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
	return a;
}

// reads ------------------------------------------------------------------------------------------

// where a request reads: a box's places (through its cache when cached), or the host's
typedef struct {
	pl *places;
	pc_cache *cache;
} reader;

// the reader of a request; *ok 0: no such box
static reader reader_of(const op_value *r, int *ok) {
	*ok = 1;
	const op_value *name = op_get(r, "box");
	if (name == NULL) return (reader){world_places, NULL};
	naming *b = box_named(world_text(name));
	if (b == NULL) return *ok = 0, (reader){0};
	const op_value *cached = op_get(r, "cached");
	if (cached == NULL || cached->type != OP_BOOL || !cached->bool_) {
		return (reader){bx_places(b->box), NULL};
	}
	if (b->cache == NULL) b->cache = pc_new(bx_places(b->box), world_scheduler);
	return (reader){bx_places(b->box), b->cache};
}

static op_value *get_json(const reader *rd, const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	op_value *out;
	if (rd->cache != NULL) {
		char *id = pc_get(rd->cache, names, n);
		out = id != NULL ? op_str(id) : op_null();
		free(id);
	} else {
		tb_key id;
		out = pl_get(rd->places, names, n, &id) ? op_str(id.string) : op_null();
	}
	free(names);
	return mask_take(out);
}

static op_value *answer_json(const char *id, const char *from) {
	op_value *m = op_map();
	op_set(m, "id", op_str(id));
	op_set(m, "from", op_str(from));
	return m;
}

static op_value *entries_json(const reader *rd, const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	op_value *a = op_list();
	if (rd->cache != NULL) {
		pc_answers list = pc_gets(rd->cache, names, n);
		for (size_t i = 0; i < list.n; i++) op_push(a, answer_json(list.items[i].id, list.items[i].from));
		pc_answers_free(&list);
	} else {
		pl_answers list = pl_gets(rd->places, names, n);
		for (size_t i = 0; i < list.n; i++) {
			op_push(a, answer_json(list.items[i].id.string, list.items[i].from));
		}
		pl_answers_free(&list);
	}
	free(names);
	return mask_take(a);
}

static op_value *names_json(const reader *rd, const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	op_value *a = op_list();
	if (rd->cache != NULL) {
		pc_names list = pc_list(rd->cache, names, n);
		for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i]));
		pc_names_free(&list);
	} else {
		pl_members list = pl_list(rd->places, names, n);
		for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i].name));
		pl_members_free(&list);
	}
	free(names);
	return a;
}

static op_value *member_json(const char *name, const char *id, const char *from) {
	op_value *m = op_map();
	op_set(m, "name", op_str(name));
	// NULL: a level, no id
	if (id != NULL) op_set(m, "id", op_str(id));
	if (from != NULL) op_set(m, "from", op_str(from));
	return m;
}

static op_value *members_json(const reader *rd, const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	op_value *a = op_list();
	if (rd->cache != NULL) {
		pc_members list = pc_members_at(rd->cache, names, n);
		for (size_t i = 0; i < list.n; i++) {
			op_push(a, member_json(list.items[i].name, list.items[i].id, list.items[i].from));
		}
		pc_members_free(&list);
	} else {
		pl_members list = pl_members_at(rd->places, names, n);
		for (size_t i = 0; i < list.n; i++) {
			op_push(a, member_json(list.items[i].name, list.items[i].id.string, list.items[i].from));
		}
		pl_members_free(&list);
	}
	free(names);
	return mask_take(a);
}

// the lookup of names from a path, as JSON: the nearest path, or null
static op_value *lookup_json(const reader *rd, const op_value *names_list, const op_value *from_list) {
	size_t n, nfrom;
	const char **names = world_address(names_list, &n), **from = world_address(from_list, &nfrom);
	size_t *depths = world_alloc((nfrom + 1) * sizeof *depths);
	op_value *out = op_null();
	if (pl_lookup(rd->places, names, n, from, nfrom, 0, depths)) {
		op_free(out);
		out = op_list();
		for (size_t i = 0; i < depths[0]; i++) op_push(out, op_str(from[i]));
		for (size_t i = 0; i < n; i++) op_push(out, op_str(names[i]));
	}
	free(depths), free(names), free(from);
	return out;
}

// programs --------------------------------------------------------------------------------------

typedef struct {
	const reader *rd;
	bool stopped;
	char *error;
} ctx;

static op_value *eval(const op_value *e, ctx *c) {
	if (!world_is(e, OP_MAP)) {
		if (!world_is(e, OP_LIST)) return op_ref((op_value *)e);
		op_value *a = op_list();
		for (size_t i = 0; i < e->count; i++) {
			op_value *x = eval(e->items[i], c);
			if (x == NULL) return op_free(a), NULL;
			op_push(a, x);
		}
		return a;
	}
	const op_value *x;
	op_value *out;
	if ((x = op_get(e, "get"))) out = get_json(c->rd, x);
	else if ((x = op_get(e, "entries"))) out = entries_json(c->rd, x);
	else if ((x = op_get(e, "names"))) out = names_json(c->rd, x);
	else if ((x = op_get(e, "members"))) out = members_json(c->rd, x);
	else if ((x = op_get(e, "lookup"))) out = lookup_json(c->rd, x->items[0], x->items[1]);
	else {
		if (c->error == NULL) c->error = world_copy("unknown program");
		return NULL;
	}
	if (pl_status(c->rd->places) == SC_STOP) {
		c->stopped = true;
		return op_free(out), NULL;
	}
	return out;
}

typedef struct {
	world_watch watch;
	const op_value *f;
	reader rd;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(void *previous, void *data) {
	(void)previous;
	program *p = data;
	p->watch.runs++;
	ctx c = {.rd = &p->rd};
	op_value *v = eval(p->f, &c);
	if (c.error) {
		op_free(v);
		return (sc_out){.kind = SC_FAILED, .error = c.error};
	}
	if (c.stopped) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

// writes ----------------------------------------------------------------------------------------

// a write, made in the host's scope: place, create, box, unbox, write, start, stop
typedef struct {
	const op_value *request;
	const char *op;
	bx *box;
	int code;
	const char *why;
	// create: the box made
	bx *made;
} call;

// the header's block held once more by each entry changed, and by the entry made
static void hold(pl_changed *changed, nd_entry *node, pl_made *made) {
	for (size_t i = 0; i < changed->n; i++) {
		pl_hold_also(world_places, changed->entries[i], pl_made_ref(made), pl_made_free);
	}
	if (node != NULL) pl_hold(world_places, node, pl_made_ref(made), pl_made_free);
}

static void write(void *data) {
	call *c = data;
	const op_value *r = c->request;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad);
		c->code = -1, c->why = SC_UNSCOPED;
		return;
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	if (strcmp(c->op, "place") == 0) {
		nd_entry *parent = tb_get(world_table, tb_string("children"), world_key(op_get(r, "at")));
		c->code = parent == NULL ? PL_NOTHING_THERE
		                         : pl_place(world_places, parent, world_text(op_get(r, "name")),
		                             world_key(op_get(r, "id")), h, &changed);
		pl_commit(world_places, &changed);
		hold(&changed, NULL, made);
	} else if (strcmp(c->op, "write") == 0) {
		size_t n;
		const char **path = world_address(op_get(r, "path"), &n);
		tb_key at;
		nd_entry *kids = pl_get(bx_places(c->box), path, n, &at)
			? tb_get(world_table, tb_string("children"), at)
			: NULL;
		free(path);
		c->code = kids == NULL ? PL_NOTHING_THERE
		                       : pl_place(bx_places(c->box), kids, world_text(op_get(r, "name")),
		                           world_key(op_get(r, "id")), h, &changed);
		pl_commit(bx_places(c->box), &changed);
		hold(&changed, NULL, made);
	} else if (strcmp(c->op, "create") == 0) {
		const op_value *at = op_get(r, "at");
		steps s = at != NULL ? steps_of(at) : (steps){0};
		if (at == NULL) PUSH(s.v, s.n, s.cap, world_copy("/"));
		c->code = bx_create(&host, (const char *const *)s.v, s.n, c->box, h, made, &c->made);
		if (c->code == 0) {
			size_t n;
			const char **names = inside(&s, NULL, 0, &n);
			learn(c->box != NULL ? bx_root(c->box) : "R", names, n);
			free(names);
		}
		steps_free(&s);
	} else if (strcmp(c->op, "box") == 0 || strcmp(c->op, "unbox") == 0) {
		steps s = steps_of(op_get(r, "path"));
		if (c->op[0] == 'b') {
			c->code = bx_box(c->box, (const char *const *)s.v, s.n, world_key(op_get(r, "node")), h, made,
				&changed);
			if (c->code == 0) {
				size_t n;
				const char **names = inside(&s, NULL, 0, &n);
				learn(bx_root(c->box), names, n);
				free(names);
			}
		} else {
			c->code = bx_unbox(c->box, (const char *const *)s.v, s.n, h, made, &changed);
		}
		steps_free(&s);
	} else {
		size_t n;
		const char **path = world_address(op_get(r, "path"), &n);
		for (size_t i = 0; i < n; i++) {
			if (path[i] == NULL) path[i] = "";
		}
		tb_key root = tb_string(bx_root(c->box));
		if (strcmp(c->op, "start") == 0) {
			c->code = pr_add(world_places, world_table, root, path, n, world_key(op_get(r, "id")), h,
				&changed, &node);
		} else {
			c->code = pr_remove(world_places, world_table, root, path, n, h, &changed);
		}
		free(path);
		pl_commit(world_places, &changed);
		hold(&changed, node, made);
	}
	pl_made_free(made);
	if (c->code > 0) c->why = pl_code_name(c->code);
}

// requests --------------------------------------------------------------------------------------

static op_value *with(const char *key, op_value *v) {
	op_value *o = op_map();
	op_set(o, key, v);
	return o;
}

// a map with key v, or an empty one when v is null
static op_value *maybe(const char *key, op_value *v) {
	if (v->type != OP_NULL) return with(key, v);
	op_free(v);
	return op_map();
}

static bool is(const char *op, const char *name) { return strcmp(op, name) == 0; }

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	host = (bx_host){world_places, world_table, NULL, NULL};
	const op_value *name = op_get(r, "box");
	naming *b = box_named(world_text(name));
	if (name != NULL && b == NULL) return world_error("no such box");
	if (is(op, "create")) {
		const op_value *up = op_get(r, "parent");
		naming *parent = box_named(world_text(up));
		if (up != NULL && parent == NULL) return world_error("no such box");
		const op_value *id = op_get(r, "id");
		call c = {.request = r, .op = op, .box = parent != NULL ? parent->box : NULL};
		if (id != NULL) c.code = bx_create_id(&host, world_text(id), c.box, &c.made);
		else world_hosted(write, &c);
		if (c.code) return world_error(c.why != NULL ? c.why : pl_code_name(c.code));
		PUSH(named, nnamed, capnamed, ((naming){world_copy(world_text(op_get(r, "name"))), c.made, NULL}));
		return with("root", mask_take(op_str(bx_root(c.made))));
	}
	if (is(op, "place") || is(op, "box") || is(op, "unbox") || is(op, "write") || is(op, "start") ||
		is(op, "stop")) {
		call c = {.request = r, .op = op, .box = b != NULL ? b->box : NULL};
		world_hosted(write, &c);
		return c.code ? world_error(c.why) : op_map();
	}
	if (is(op, "inside")) {
		steps s = steps_of(op_get(r, "address"));
		size_t nfrom, n;
		const char **from = world_address(op_get(r, "from"), &nfrom);
		const char **names = inside(&s, from, nfrom, &n);
		op_value *o = with("path", names_list(names, n));
		free(names), free(from);
		steps_free(&s);
		return o;
	}
	if (is(op, "rows") || is(op, "saved")) {
		const nd_entry *node = op[0] == 'r'
			? tb_get(world_table, tb_string(PR_PART), tb_string(bx_root(b->box)))
			: tb_get(world_table, tb_string("children"), world_key(op_get(r, "id")));
		if (node == NULL || node->value == NULL) return op_map();
		return with("value", mask(node->value));
	}
	if (is(op, "get") || is(op, "entries") || is(op, "list") || is(op, "members") || is(op, "lookup")) {
		int ok;
		reader rd = reader_of(r, &ok);
		op_value *o;
		if (op[0] == 'g') o = maybe("id", get_json(&rd, op_get(r, "path")));
		else if (op[0] == 'e') o = with("entries", entries_json(&rd, op_get(r, "path")));
		else if (op[1] == 'i') o = with("names", names_json(&rd, op_get(r, "at")));
		else if (op[0] == 'm') o = with("members", members_json(&rd, op_get(r, "at")));
		else o = maybe("path", lookup_json(&rd, op_get(r, "names"), op_get(r, "from")));
		pl_status(rd.places);
		return o;
	}
	if (is(op, "watch")) {
		int ok;
		program *p = world_alloc(sizeof *p);
		p->f = op_get(r, "f");
		p->rd = reader_of(r, &ok);
		PUSH(programs, nprograms, capprograms, p);
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")),
			(sc_def){.f = program_f, .set = world_set, .equal = world_equal, .data = p}, false);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	// the caches' listeners away while the scheduler lives, then the boxes' views, before the
	// host's places go with the world
	for (size_t i = 0; i < nnamed; i++) pc_free(named[i].cache);
	for (size_t i = 0; i < nnamed; i++) bx_free(named[i].box);
	world_finish();
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(programs);
	for (size_t i = 0; i < nnamed; i++) free(named[i].name);
	free(named);
	for (size_t i = 0; i < nfresh; i++) free(fresh_ids[i].id), free(fresh_ids[i].label);
	free(fresh_ids);
}
