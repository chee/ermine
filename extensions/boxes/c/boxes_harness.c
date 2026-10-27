// boxes' ops beside the ermine harness (ermine/system/c/ermine_harness.c, which documents the
// protocol and the programs; typescript/boxes_harness.ts documents these ops). linked with it: the
// ops are installed by a constructor, through ermine_harness.h's hooks.
//   box, boxput, boxtake, boxclose, boxstart, boxwhy, look, names; the "start" op's "in" names a box
// a box lives till the process exits (after the ermine, which hh_finish frees)
#include "../../../ermine/system/c/ermine_harness.h"
#include "../../../conformance/c/harness.h"
#include "boxes.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
	char *name;
	bx_box *box;
} named_t;
static named_t *boxes;
static size_t nboxes, capboxes;

// the newest of a name: a name made again (a new ermine's) is the new box, never the first one's, which
// belongs to an ermine that is gone (it is let go at exit)
static bx_box *box_named(const char *name) {
	for (size_t i = nboxes; name != NULL && i-- > 0;) {
		if (strcmp(boxes[i].name, name) == 0) return boxes[i].box;
	}
	return NULL;
}
static void free_boxes(void) {
	for (size_t i = 0; i < nboxes; i++) {
		free(boxes[i].name);
		bx_free(boxes[i].box);
	}
	free(boxes);
	boxes = NULL;
	nboxes = capboxes = 0;
}

static pl *places_named(const char *name) {
	bx_box *b = box_named(name);
	return b != NULL ? bx_places(b) : NULL;
}

static const char *text(const op_value *r, const char *key) {
	const op_value *v = r != NULL && r->type == OP_MAP ? op_get(r, key) : NULL;
	return v != NULL && v->type == OP_STR ? v->str : NULL;
}

// a path as the request has it: text "a/b", its empty names gone. names copied, hh_take's
static const char **names_of(const op_value *r, const char *key, size_t *n) {
	const char *s = text(r, key);
	if (s == NULL) s = "";
	char *copy = hh_take(strlen(s) + 1);
	strcpy(copy, s);
	const char **names = hh_take((strlen(s) + 1) * sizeof *names);
	*n = 0;
	for (char *p = copy, *next; p != NULL; p = next) {
		next = strchr(p, '/');
		if (next != NULL) *next++ = '\0';
		if (*p != '\0') names[(*n)++] = p;
	}
	return names;
}

static int not_found(const char *what, const char *name) {
	return es_fail(ES_FAILED, "no %s %s", what, name != NULL ? name : "");
}

static int cmp_names(const void *a, const void *b) {
	return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static int op_box(const op_value *r, es_ermine *e, op_value **res) {
	const char *name = text(r, "name");
	if (name == NULL) return es_fail(ES_FAILED, "box needs a name");
	bx_box *b;
	int code;
	if (text(r, "at") != NULL) {
		size_t n;
		const char **at = names_of(r, "at", &n);
		code = bx_create_at(e, at, n, &b);
	} else if (text(r, "id") != NULL) {
		code = bx_create_id(e, text(r, "id"), &b);
	} else {
		code = bx_create(e, &b);
	}
	if (code != 0) return code;
	named_t entry = {es_dup(name), b};
	ES_PUSH(boxes, nboxes, capboxes, entry);
	*res = op_map();
	return 0;
}

// the id at a path in the host's graph
static int host_id(es_ermine *e, const op_value *r, const char *key, tb_key *id) {
	size_t n;
	const char **path = names_of(r, key, &n);
	if (!pl_get(e->places, path, n, id)) {
		return es_fail(ES_NOTHING_THERE, "%s (%s)", es_code_name(ES_NOTHING_THERE),
			text(r, key) != NULL ? text(r, key) : "");
	}
	return 0;
}

static int op_put(const op_value *r, es_ermine *e, op_value **res) {
	bx_box *b = box_named(text(r, "box"));
	if (b == NULL) return not_found("box", text(r, "box"));
	tb_key id;
	int found = host_id(e, r, "node", &id);
	if (found != 0) return found;
	size_t n;
	const char **path = names_of(r, "path", &n);
	int code = bx_put(b, path, n, id.string);
	if (code != 0) return code;
	*res = op_map();
	return 0;
}

static int op_take(const op_value *r, es_ermine *e, op_value **res) {
	(void)e;
	bx_box *b = box_named(text(r, "box"));
	if (b == NULL) return not_found("box", text(r, "box"));
	size_t n;
	const char **path = names_of(r, "path", &n);
	int code = bx_take(b, path, n);
	if (code != 0) return code;
	*res = op_map();
	return 0;
}

static int op_close(const op_value *r, es_ermine *e, op_value **res) {
	(void)e;
	bx_box *b = box_named(text(r, "box"));
	if (b == NULL) return not_found("box", text(r, "box"));
	int code = bx_close(b);
	if (code != 0) return code;
	*res = op_map();
	return 0;
}

// boxstart's programs: setup adds a teardown noting its why. a record stays till the process exits
typedef struct {
	char *name;
	char **whys;
	size_t n, cap;
} told_t;
static told_t **toldr;
static size_t ntold, captold;
static told_t *told_named(const char *name) {
	for (size_t i = 0; name != NULL && i < ntold; i++) {
		if (strcmp(toldr[i]->name, name) == 0) return toldr[i];
	}
	return NULL;
}
static void note_why(void *ctx, const char *why) {
	told_t *t = ctx;
	char *w = es_dup(why);
	ES_PUSH(t->whys, t->n, t->cap, w);
}
static es_out told_program(es_context *c, void *ctx) {
	int code = es_add_teardown(c, note_why, ctx);
	return code != 0 ? es_out_code(code) : es_out_of(NULL);
}

static int op_boxstart(const op_value *r, es_ermine *e, op_value **res) {
	(void)e;
	bx_box *b = box_named(text(r, "box"));
	if (b == NULL) return not_found("box", text(r, "box"));
	if (text(r, "name") == NULL || text(r, "at") == NULL) return es_fail(ES_FAILED, "boxstart needs a name and an at");
	told_t *t = es_alloc(sizeof *t);
	*t = (told_t){es_dup(text(r, "name")), NULL, 0, 0};
	ES_PUSH(toldr, ntold, captold, t);
	es_started *started = NULL;
	es_refused refused = {0};
	int code = bx_start(b, told_program, t, es_text(text(r, "at")), NULL, &started, &refused);
	if (code == ES_TAKEN) {
		*res = op_map();
		op_set(*res, "refused", op_str(refused.refused));
		es_refused_free(&refused);
		return 0;
	}
	if (code != 0) return code;
	*res = op_map();
	return 0;
}

static int op_boxwhy(const op_value *r, es_ermine *e, op_value **res) {
	(void)e;
	told_t *t = told_named(text(r, "name"));
	op_value *list = op_list();
	for (size_t i = 0; t != NULL && i < t->n; i++) op_push(list, op_str(t->whys[i]));
	*res = op_map();
	op_set(*res, "whys", list);
	return 0;
}

// the places of a request's "in" (a box's), else the ermine's
static int places_of(const op_value *r, es_ermine *e, pl **out) {
	if (text(r, "in") == NULL) {
		*out = e->places;
		return 0;
	}
	*out = places_named(text(r, "in"));
	return *out != NULL ? 0 : not_found("box", text(r, "in"));
}

static int op_look(const op_value *r, es_ermine *e, op_value **res) {
	pl *p;
	int code = places_of(r, e, &p);
	if (code != 0) return code;
	size_t n;
	const char **path = names_of(r, "path", &n);
	tb_key id;
	*res = op_map();
	if (!pl_get(p, path, n, &id)) {
		op_set(*res, "there", op_bool(0));
		return 0;
	}
	op_set(*res, "there", op_bool(1));
	const op_value *v = pl_read(p, tb_string("value"), id, NULL, 0);
	if (v != NULL) op_set(*res, "value", op_ref((op_value *)v));
	return 0;
}

static int op_names(const op_value *r, es_ermine *e, op_value **res) {
	pl *p;
	int code = places_of(r, e, &p);
	if (code != 0) return code;
	size_t n;
	const char **path = names_of(r, "path", &n);
	pl_members list = pl_list(p, path, n);
	const char **names = hh_take((list.n + 1) * sizeof *names);
	for (size_t i = 0; i < list.n; i++) names[i] = list.items[i].name;
	qsort(names, list.n, sizeof *names, cmp_names);
	op_value *out = op_list();
	for (size_t i = 0; i < list.n; i++) op_push(out, op_str(names[i]));
	pl_members_free(&list);
	*res = op_map();
	op_set(*res, "names", out);
	return 0;
}

static int boxes_op(const op_value *r, es_ermine *e, op_value **res) {
	const char *op = text(r, "op");
	if (op == NULL) return HX_NOT_MINE;
	if (strcmp(op, "box") == 0) return op_box(r, e, res);
	if (strcmp(op, "boxput") == 0) return op_put(r, e, res);
	if (strcmp(op, "boxtake") == 0) return op_take(r, e, res);
	if (strcmp(op, "boxclose") == 0) return op_close(r, e, res);
	if (strcmp(op, "boxstart") == 0) return op_boxstart(r, e, res);
	if (strcmp(op, "boxwhy") == 0) return op_boxwhy(r, e, res);
	if (strcmp(op, "look") == 0) return op_look(r, e, res);
	if (strcmp(op, "names") == 0) return op_names(r, e, res);
	return HX_NOT_MINE;
}

__attribute__((constructor)) static void install(void) {
	hx_op = boxes_op;
	hx_places = places_named;
	atexit(free_boxes);
}
