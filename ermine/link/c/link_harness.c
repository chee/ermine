// The C link (link.h) on the line protocol of typescript/link_harness.ts, which documents it and
// the programs (conformance/c/harness.h has the loop). The world (the store, the writes, the
// scheduler) is world.h's; programs are data, evaluated here as the reference does.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "world.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// opened places, by name
typedef struct {
	char *name;
	pl_held *held;
} opened;
static opened *opens;
static size_t nopens, capopens;

static pl_held *held_named(const char *name) {
	for (size_t i = 0; i < nopens; i++) if (strcmp(opens[i].name, name) == 0) return opens[i].held;
	return NULL;
}

// programs --------------------------------------------------------------------------------------

// what a program is evaluated in: how it ended early, if it did: stopped (a read said the run must
// end), or an error
typedef struct {
	bool stopped;
	char *error;
} ctx;

static op_value *eval(const op_value *e, ctx *c);
static op_value *eval_for_fill(const op_value *e, void *c) { return eval(e, c); }

static op_value *thrown(ctx *c, char *error) {
	if (c->error == NULL) c->error = error;
	else free(error);
	return NULL;
}
// whether the reads told since the last check let the program go on
static bool alive(ctx *c) {
	sc_read_status status = lk_status(world_link);
	if (status == SC_STOP) c->stopped = true;
	if (status == SC_CLOSED) thrown(c, world_copy(SC_STOPPED));
	return status == SC_OK;
}
static bool over(const ctx *c) { return c->stopped || c->error != NULL; }

// the list of items a read gave, as strings, after its status
static op_value *listed(ctx *c, pl_list *list) {
	if (!alive(c)) {
		pl_list_free(list);
		return NULL;
	}
	op_value *a = world_items(list);
	pl_list_free(list);
	return a;
}

// the value read at (source, part, id) at path, as JSON
static op_value *evaluate_read(const op_value *x, ctx *c) {
	const op_value *path = x->count > 3 ? x->items[3] : NULL;
	op_value *steps = path ? eval(path, c) : NULL;
	if (path && steps == NULL) return NULL;
	size_t n;
	op_key *keys = world_path(steps, &n);
	const op_value *v = lk_get(world_link, world_key(x->items[0]), world_part(x->items[1]),
		world_key(x->items[2]), keys, n);
	free(keys);
	op_free(steps);
	return alive(c) ? world_snap(v) : NULL;
}

// the patches of the node's latest edit, as JSON, or null
static op_value *patches_of(const ch_header *h) {
	return h != NULL && h->has_op ? world_patches(h->patches, h->patches_length) : op_null();
}

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
	if ((x = op_get(e, "read"))) return evaluate_read(x, c);
	if ((x = op_get(e, "change"))) {
		const ch_header *h = lk_change(world_link, world_key(x->items[0]),
			world_part(x->items[1]), world_key(x->items[2]));
		return alive(c) ? patches_of(h) : NULL;
	}
	if ((x = op_get(e, "get"))) {
		size_t n;
		const char **names = world_address(x, &n);
		const op_value *from = op_get(e, "from");
		pl_at at = from ? world_entry(from) : (pl_at){0};
		pl_list *list = pl_get(world_places, names, n, from ? &at : NULL, NULL);
		free(names);
		return listed(c, list);
	}
	if ((x = op_get(e, "values"))) {
		size_t n;
		const char **names = world_address(x, &n);
		pl_list *list = pl_get(world_places, names, n, NULL, NULL);
		free(names);
		if (!alive(c)) return pl_list_free(list), NULL;
		op_value *a = op_list();
		for (size_t i = 0; i < list->n && !over(c); i++) {
			const op_value *v = lk_get(world_link, list->items[i]->source, "value", list->items[i]->id,
				NULL, 0);
			if (alive(c)) op_push(a, world_snap(v));
		}
		pl_list_free(list);
		if (over(c)) return op_free(a), NULL;
		return a;
	}
	if ((x = op_get(e, "names"))) {
		pl_strings names = pl_names(world_places, world_entry(x), NULL);
		op_value *a = op_list();
		for (size_t i = 0; i < names.n; i++) op_push(a, op_str(names.names[i]));
		pl_strings_free(names);
		if (!alive(c)) return op_free(a), NULL;
		return a;
	}
	if ((x = op_get(e, "level"))) return listed(c, pl_members_at(world_places, world_entry(x), NULL));
	if ((x = op_get(e, "items")) || (x = op_get(e, "kept"))) {
		pl_held *h = held_named(world_text(x));
		const pl_list *list = op_get(e, "items") ? pl_items(h, NULL) : pl_members(h, NULL);
		if (!alive(c)) return NULL;
		return world_items(list);
	}
	if ((x = op_get(e, "write"))) {
		op_value *r = world_fill(x, eval_for_fill, c);
		if (r == NULL) return NULL;
		const char *why;
		size_t failed;
		// the request is kept: the node's change refers into it
		world_keep(r);
		if (world_write(r, &why, &failed)) return thrown(c, world_copy(why));
		return op_null();
	}
	bool handled;
	char *error = NULL;
	op_value *plain = world_basic(e, eval_for_fill, c, &handled, &error);
	if (error) return thrown(c, error);
	if (handled) return plain;
	return thrown(c, world_copy("unknown program"));
}

// a watch's code: counts its run, evaluates its program
typedef struct {
	world_watch watch;
	const op_value *f;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(sc_run *run, void *data) {
	(void)run;
	program *p = data;
	p->watch.runs++;
	ctx c = {0};
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

// requests --------------------------------------------------------------------------------------

static op_value *with_value(const op_value *v) {
	op_value *o = op_map();
	if (v != NULL) op_set(o, "value", world_snap(v));
	return o;
}

// the link's requests; NULL: not one of them
static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "at") == 0) {
		op_value *value = op_get(r, "value");
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		op_value scratch = {0};
		const op_value *v = lk_at(value, keys, n, &scratch);
		// the scratch is on the stack: a number made from it, not held
		op_value *o = with_value(v == &scratch ? NULL : v);
		if (v == &scratch) op_set(o, "value", op_num(scratch.num));
		free(keys);
		return o;
	}
	if (strcmp(op, "read") == 0) {
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		const op_value *v = lk_get(world_link, world_key(op_get(r, "source")),
			world_part(op_get(r, "part")), world_key(op_get(r, "id")), keys, n);
		free(keys);
		lk_status(world_link);
		return with_value(v);
	}
	if (strcmp(op, "change") == 0) {
		const ch_header *h = lk_change(world_link, world_key(op_get(r, "source")),
			world_part(op_get(r, "part")), world_key(op_get(r, "id")));
		lk_status(world_link);
		op_value *o = op_map();
		if (h != NULL && h->has_op) op_set(o, "patches", world_patches(h->patches, h->patches_length));
		return o;
	}
	if (strcmp(op, "get") == 0) {
		size_t n;
		const char **names = world_address(op_get(r, "address"), &n);
		const op_value *from = op_get(r, "from");
		pl_at at = from ? world_entry(from) : (pl_at){0};
		pl_list *list = pl_get(world_places, names, n, from ? &at : NULL, NULL);
		free(names);
		lk_status(world_link);
		op_value *o = op_map();
		op_set(o, "items", world_items(list));
		pl_list_free(list);
		return o;
	}
	if (strcmp(op, "names") == 0) {
		pl_strings names = pl_names(world_places, world_entry(op_get(r, "at")), NULL);
		lk_status(world_link);
		op_value *a = op_list();
		for (size_t i = 0; i < names.n; i++) op_push(a, op_str(names.names[i]));
		pl_strings_free(names);
		op_value *o = op_map();
		op_set(o, "names", a);
		return o;
	}
	if (strcmp(op, "watch") == 0) {
		program *p = world_alloc(sizeof *p);
		p->f = op_get(r, "f");
		PUSH(programs, nprograms, capprograms, p);
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")),
			(sc_def){.f = program_f, .set = world_set, .equal = world_equal, .data = p}, false);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "open") == 0) {
		size_t n;
		const char **names = world_address(op_get(r, "address"), &n);
		pl_held *h = pl_open(world_places, names, n, NULL);
		free(names);
		PUSH(opens, nopens, capopens, ((opened){world_copy(world_text(op_get(r, "name"))), h}));
		return op_map();
	}
	if (strcmp(op, "close") == 0) {
		pl_held *h = held_named(world_text(op_get(r, "name")));
		if (h == NULL) return world_error("no such place");
		pl_drop(h);
		return op_map();
	}
	if (strcmp(op, "reads") == 0) {
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		if (c == NULL) return world_error("no such scope");
		const op_value *reads = world_reads(c);
		op_value *o = op_map();
		op_set(o, "reads", reads ? op_ref((op_value *)reads) : op_list());
		return o;
	}
	if (strcmp(op, "spot") == 0) {
		const char *key = world_text(op_get(r, "key"));
		lk_where w;
		op_value *o = op_map();
		if (key != NULL && lk_spot(world_link, key, &w)) op_set(o, "spot", world_where(&w));
		return o;
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	for (size_t i = 0; i < nopens; i++) {
		pl_close(opens[i].held);
		free(opens[i].name);
	}
	world_finish();
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(opens), free(programs);
}
