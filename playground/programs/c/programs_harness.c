// programs (programs.h, types.h) on the line protocol of typescript/programs_harness.ts, which documents
// it (conformance/c/harness.h has the loop). Its world is pw.h's, made at the first
// line: an ermine, its places the host's, and boxes (extensions/boxes) over it. An address given as a string is split as
// path.ts' parse splits it.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pw.h"
#include "../../../extensions/boxes/c/boxes.h"
#include "../../../experiments/software/c/functions.h"
#include "../../compilers/c/mem.h"
#include "../../libraries/upsert/c/upsert.h"
#include "programs.h"
#include "programs_json.h"
#include "../../../ermine/types/c/types.h"

static ty_ids made_ids;

typedef struct {
	char *name;
	bx_box *box;
} naming;
static naming *named;
static size_t nnamed, capnamed;

static bx_box *box_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nnamed; i++) {
		if (strcmp(named[i].name, name) == 0) return named[i].box;
	}
	return NULL;
}

// a uuid's form: a folder a box made
static int is_uuid(const char *s) {
	if (strlen(s) != 36) return 0;
	for (size_t i = 0; i < 36; i++) {
		int dash = i == 8 || i == 13 || i == 18 || i == 23;
		if (dash ? s[i] != '-' : strchr("0123456789abcdef", s[i]) == NULL) return 0;
	}
	return 1;
}

// an address's steps, the strings copied: a string split as path.ts' parse does (a leading "/" is
// "/", empty pieces skipped), a list as it is (a piece that is no string: "")
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (pw_is(a, OP_STR)) {
		const char *p = a->str;
		if (*p == '/') PG_PUSH(s.v, s.n, s.cap, pg_dup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = pg_alloc(len + 1);
				memcpy(piece, p, len);
				PG_PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (pw_is(a, OP_LIST)) {
		for (size_t i = 0; i < a->count; i++) {
			const char *t = pw_text(a->items[i]);
			PG_PUSH(s.v, s.n, s.cap, pg_dup(t != NULL ? t : ""));
		}
	}
	return s;
}

static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}

// a value with every folder a box made as "box:<name>": new
static op_value *mask(const op_value *v) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		for (size_t i = 0; i < nnamed; i++) {
			if (!is_uuid(v->str) || strcmp(bx_root(named[i].box), v->str) != 0) continue;
			char *s = pw_format("box:%s", named[i].name);
			op_value *o = op_str(s);
			free(s);
			return o;
		}
		return op_ref((op_value *)v);
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

// reads -----------------------------------------------------------------------------------------

typedef struct {
	bx_box *box;
	pl *places;
} reader;

static reader reader_of(const op_value *r, int *ok) {
	*ok = 1;
	const op_value *name = op_get(r, "box");
	if (name == NULL) return (reader){NULL, pw_places};
	bx_box *b = box_named(pw_text(name));
	if (b == NULL) return *ok = 0, (reader){0};
	return (reader){b, bx_places(b)};
}

// the type of a node at a place ({ id, at }): { type }, null for none
static op_value *typed_node(const op_value *r, const reader *rd, const op_value *node) {
	size_t n;
	const char **at = pw_address(op_get(node, "at"), &n);
	char *t = ty_type_of(rd->places, pw_text(op_get(node, "id")), at, n, NULL);
	free(at);
	op_value *out = op_map();
	op_set(out, "type", t != NULL ? op_str(t) : op_null());
	free(t);
	(void)r;
	return out;
}

// the type of each member of a folder, by name: { types: { name: type | null } }
static op_value *typed_folder(const reader *rd, const op_value *folder) {
	size_t n;
	const char **path = pw_address(folder, &n);
	pl_members here = pl_members_at(rd->places, path, n);
	const char **at = pw_alloc((n + 2) * sizeof *at);
	for (size_t i = 0; i < n; i++) at[i] = path[i];
	op_value *types = op_map();
	for (size_t i = 0; i < here.n; i++) {
		if (here.items[i].id.symbol != NULL) continue;
		at[n] = here.items[i].name;
		char *t = ty_type_of(rd->places, here.items[i].id.string, at, n + 1, NULL);
		op_set(types, here.items[i].name, t != NULL ? op_str(t) : op_null());
		free(t);
	}
	pl_members_free(&here);
	free(at);
	free(path);
	op_value *out = op_map();
	op_set(out, "types", types);
	return out;
}

// satisfy (a program), openWith (a file) or a type (a node, a folder's members), the answer as JSON
static op_value *look(const op_value *r, const reader *rd) {
	if (op_get(r, "node") != NULL) return typed_node(r, rd, op_get(r, "node"));
	if (op_get(r, "folder") != NULL) return typed_folder(rd, op_get(r, "folder"));
	size_t n;
	const char **from = pw_address(op_get(r, "from"), &n);
	op_value *out;
	if (op_get(r, "file") == NULL) {
		pg_found *f = pg_satisfy(rd->places, pw_text(op_get(r, "program")), from, n);
		out = pg_found_json(f);
		pg_found_free(f);
	} else {
		// a file: an id, or { id, at }, a place typed by its name too
		const op_value *file = op_get(r, "file");
		size_t nat = 0;
		const char **at = NULL;
		const char *id = pw_text(file);
		if (file->type == OP_MAP) {
			id = pw_text(op_get(file, "id"));
			at = pw_address(op_get(file, "at"), &nat);
		}
		pg_opened *o = pg_open_with_at(rd->places, id, at, nat, from, n);
		free(at);
		out = pg_opened_json(o);
		pg_opened_free(o);
	}
	free(from);
	return mask_take(out);
}

typedef struct {
	pw_watch watch;
	const op_value *request;
	reader rd;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(void *previous, void *data) {
	(void)previous;
	program *p = data;
	p->watch.runs++;
	op_value *v = look(p->request, &p->rd);
	if (pl_status(p->rd.places) == SC_STOP) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

// writes ----------------------------------------------------------------------------------------

typedef struct {
	const op_value *request;
	const char *op;
	bx_box *box;
	int code;
	const char *why;
	// create: the box made
	bx_box *made;
} call;

static void commit_host(void *ctx, const pl_changed *changed) {
	(void)ctx;
	pl_commit(pw_places, changed);
}

static void write(void *data) {
	call *c = data;
	const op_value *r = c->request;
	if (strcmp(c->op, "upsert") == 0) {
		ch_header h;
		pl_made *made;
		char *bad = pl_header(pw_places, NULL, 0, CH_HERE, &h, &made);
		if (bad) {
			free(bad);
			c->code = -1, c->why = SC_UNSCOPED;
			return;
		}
		pl_changed changed = {0};
		nd_entry *node = NULL;
		size_t n;
		const char **path = pw_address(op_get(r, "path"), &n);
		for (size_t i = 0; i < n; i++) {
			if (path[i] == NULL) path[i] = "";
		}
		up_upsert(pw_places, pw_table, tb_string(pw_part(op_get(r, "part"))), pw_key(op_get(r, "id")), path,
			n, op_get(r, "value"), h, &changed, &node);
		free(path);
		commit_host(NULL, &changed);
		for (size_t i = 0; i < changed.n; i++) {
			pl_hold_also(pw_places, changed.entries[i], pl_made_ref(made), pl_made_free);
		}
		if (node != NULL) pl_hold(pw_places, node, pl_made_ref(made), pl_made_free);
		pl_made_free(made);
		return;
	}
	steps st = steps_of(op_get(r, c->op[0] == 'c' ? "at" : "path"));
	const char *const *path = (const char *const *)st.v;
	if (strcmp(c->op, "create") == 0) {
		c->code = op_get(r, "at") != NULL ? bx_create_at(pw_ermine, path, st.n, &c->made) : bx_create(pw_ermine, &c->made);
	}
	else if (strcmp(c->op, "box") == 0) c->code = bx_put(c->box, path, st.n, pw_text(op_get(r, "node")));
	else c->code = bx_take(c->box, path, st.n);
	steps_free(&st);
	if (c->code != 0) c->why = es_code_name(c->code);
}

// types ------------------------------------------------------------------------------------------------

static char *joined(void *ctx, const char *const *path, size_t n) {
	(void)ctx;
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(path[i]) + 1;
	char *s = pw_alloc(len);
	for (size_t i = 0; i < n; i++) {
		if (i) strcat(s, "/");
		strcat(s, path[i]);
	}
	return s;
}

// a request's string or list of strings, as a NULL-terminated list
static const char *const *list_of(const op_value *v) {
	if (v == NULL) return NULL;
	size_t n = v->type == OP_LIST ? v->count : v->type == OP_STR ? 1 : 0;
	const char **out = pw_alloc((n + 1) * sizeof *out);
	size_t k = 0;
	for (size_t i = 0; i < n; i++) {
		const op_value *s = v->type == OP_LIST ? v->items[i] : v;
		if (s->type == OP_STR) out[k++] = s->str;
	}
	return out;
}

static void install(void *data) {
	const op_value *list = data;
	ty_install_setup s = {.places = pw_places, .table = pw_table, .root = tb_string("R"),
		.id = joined, .commit = commit_host, .ids = &made_ids};
	ty_known *known = NULL;
	if (pw_is(list, OP_LIST)) {
		known = pw_alloc((list->count + 1) * sizeof *known);
		for (size_t i = 0; i < list->count; i++) {
			const op_value *t = list->items[i];
			known[i] = (ty_known){pw_text(op_get(t, "identifier")), list_of(op_get(t, "conformsTo")),
				list_of(op_get(t, "filenameExtension")), list_of(op_get(t, "mimeType"))};
		}
		s.list = known;
		s.n = list->count;
	}
	ty_install(&s);
	for (size_t i = 0; known != NULL && i < s.n; i++) {
		free((void *)known[i].conforms), free((void *)known[i].extensions), free((void *)known[i].mimes);
	}
	free(known);
}

// requests --------------------------------------------------------------------------------------

typedef struct {
	const char *part;
	tb_key id;
	const op_value *value;
} entering;
static void enter(void *data) {
	entering *e = data;
	pw_put_entry(e->part, e->id, e->value);
}

static op_value *answer(const op_value *r) {
	const char *op = pw_text(op_get(r, "op"));
	if (op == NULL) return pw_error("no op");
	if (strcmp(op, "attrs") == 0 || strcmp(op, "host") == 0) {
		op_value *fn = strcmp(op, "host") == 0 ? hf_value("") : NULL;
		entering e = {fn != NULL ? "value" : "attributes", pw_key(op_get(r, "id")),
			fn != NULL ? fn : op_get(r, "value")};
		pw_hosted(enter, &e);
		op_free(fn);
		return op_map();
	}
	if (strcmp(op, "upsert") == 0 || strcmp(op, "box") == 0 || strcmp(op, "unbox") == 0) {
		bx_box *b = box_named(pw_text(op_get(r, "box")));
		if (op[0] != 'u' || op[1] != 'p') {
			if (b == NULL) return pw_error("no such box");
		}
		call c = {.request = r, .op = op, .box = b};
		pw_hosted(write, &c);
		return c.code ? pw_error(c.why) : op_map();
	}
	if (strcmp(op, "types") == 0) {
		pw_hosted(install, (void *)op_get(r, "list"));
		return op_map();
	}
	if (strcmp(op, "create") == 0) {
		call c = {.request = r, .op = op};
		const char *folder = pw_text(op_get(r, "folder"));
		if (folder != NULL) {
			c.code = bx_create_id(pw_ermine, folder, &c.made);
		} else pw_hosted(write, &c);
		if (c.code) return pw_error(c.why != NULL ? c.why : es_code_name(c.code));
		naming n = {pw_copy(pw_text(op_get(r, "name"))), c.made};
		PG_PUSH(named, nnamed, capnamed, n);
		return op_map();
	}
	if (strcmp(op, "program") == 0 || strcmp(op, "open") == 0 || strcmp(op, "type") == 0) {
		int ok;
		reader rd = reader_of(r, &ok);
		if (!ok) return pw_error("no such box");
		op_value *o = look(r, &rd);
		pl_status(rd.places);
		return o;
	}
	if (strcmp(op, "watch") == 0) {
		int ok;
		program *p = pw_alloc(sizeof *p);
		p->request = r;
		p->rd = reader_of(r, &ok);
		PG_PUSH(programs, nprograms, capprograms, p);
		char *bad = pw_make(&p->watch, pw_text(op_get(r, "name")), pw_text(op_get(r, "scope")),
			(sc_def){.f = program_f, .set = pw_set, .equal = pw_equal, .data = p});
		if (bad) return pw_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "state") == 0) {
		const char *name = pw_text(op_get(r, "name"));
		for (size_t i = 0; i < nprograms; i++) {
			program *p = programs[i];
			if (strcmp(p->watch.name, name) != 0) continue;
			op_value *o = op_map();
			op_set(o, "runs", op_num((double)p->watch.runs));
			const op_value *v = p->watch.value, *only = op_get(r, "only");
			if (v == NULL) op_set(o, "value", op_null());
			else if (only == NULL || op_get(v, "refused") != NULL) op_set(o, "value", op_ref((op_value *)v));
			else {
				op_value *m = op_map();
				for (size_t k = 0; k < only->count; k++) {
					op_value *x = op_get(v, pw_text(only->items[k]));
					if (x != NULL) op_set(m, pw_text(only->items[k]), op_ref(x));
				}
				op_set(o, "value", m);
			}
			return o;
		}
		return pw_error("no such compute");
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) {
	pw_line(request, out, answer);
}

void hh_finish(void) {
	pw_close();
	pw_free();
	for (size_t i = 0; i < nnamed; i++) bx_free(named[i].box);
	ty_ids_free(&made_ids);
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(programs);
	for (size_t i = 0; i < nnamed; i++) free(named[i].name);
	free(named);
}
