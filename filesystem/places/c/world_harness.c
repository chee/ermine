// The harnesses' shared world (world_harness.h).
#define _POSIX_C_SOURCE 200809L
#include "world_harness.h"
#include "status.h"
#include "../../../conformance/c/protocol_harness.h"
#include "../../../core/scheduler/c/trace.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

sc_scheduler *world_scheduler;
tb_table *world_table;
pt_paths *world_paths;
pl *world_places;
static cst *world_status;
sc_scope *world_host;
static pc_cache *cache;
static const pl_contributor *const *contributors;
static size_t ncontributors;

void world_contribute(const pl_contributor *const *list, size_t n) {
	contributors = list;
	ncontributors = n;
}

static tb_event table_event;
static void *table_ctx;

void world_event(tb_event event, void *ctx) {
	table_event = event;
	table_ctx = ctx;
}

pc_cache *world_cached(void) {
	if (cache == NULL) cache = pc_new(world_places, world_scheduler);
	return cache;
}

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// what is kept until the end: the lines, the values made, the nodes
static hh_line **lines;
static size_t nlines, caplines;
static op_value **values;
static size_t nvalues, capvalues;
static nd_entry **nodes;
static size_t nnodes, capnodes;

void world_keep(op_value *value) { PUSH(values, nvalues, capvalues, value); }
void world_keep_node(nd_entry *node) { PUSH(nodes, nnodes, capnodes, node); }

void *world_alloc(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (p == NULL) abort();
	return p;
}
char *world_copy(const char *text) { return strcpy(world_alloc(strlen(text) + 1), text); }
char *world_format(const char *format, ...) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) abort();
	va_list args;
	va_start(args, format);
	vfprintf(s, format, args);
	va_end(args);
	fclose(s);
	return text;
}

const char *world_text(const op_value *v) { return v && v->type == OP_STR ? v->str : NULL; }
bool world_is(const op_value *v, op_type type) { return v && v->type == type; }
bool world_whole(const op_value *v, int64_t *out) {
	if (v == NULL || v->type != OP_NUM || v->num != floor(v->num) || fabs(v->num) > 1e15) return false;
	*out = (int64_t)v->num;
	return true;
}
op_value *world_snap(const op_value *v) { return v ? op_ref((op_value *)v) : op_null(); }

op_value *world_patches(const op_patch *patches, size_t n) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) hh_fail("out of memory");
	putc('[', s);
	for (size_t i = 0; i < n; i++) {
		if (i) putc(',', s);
		hh_put_patch(s, &patches[i]);
	}
	putc(']', s);
	fclose(s);
	op_value *list = op_json_read(text, NULL);
	free(text);
	return list;
}

// scopes ----------------------------------------------------------------------------------------

static sc_scope **named;
static size_t nnamed, capnamed;

sc_scope *world_scope(const char *name) {
	for (size_t i = 0; i < nnamed; i++) {
		if (strcmp((char *)sc_scope_user(named[i]), name) == 0) return named[i];
	}
	return NULL;
}
char *world_name(sc_scope *o, const char *name) {
	if (world_scope(name)) return world_format("name taken: %s", name);
	sc_scope_set(o, world_copy(name));
	PUSH(named, nnamed, capnamed, o);
	return NULL;
}

// the scopes given a node ("node" on root or scope), and its id (the line's, kept)
typedef struct {
	const sc_scope *scope;
	const char *id;
} given_node;
static given_node *given;
static size_t ngiven, capgiven;

// places' node_of: the node a scope was given, else none
static const char *node_of(void *data, const sc_scope *o) {
	(void)data;
	for (size_t i = 0; i < ngiven; i++)
		if (given[i].scope == o) return given[i].id;
	return NULL;
}

const char *world_hosted(void (*f)(void *data), void *data) {
	return sc_run_with_scope(world_host, f, data);
}

const sc_pair *world_info(const op_value *list, size_t *n) {
	*n = 0;
	if (!world_is(list, OP_LIST) || list->count == 0) return NULL;
	sc_pair *out = hh_take(list->count * sizeof *out);
	for (size_t i = 0; i < list->count; i++) {
		const op_value *p = list->items[i];
		out[(*n)++] = (sc_pair){world_text(p->items[0]), p->items[1]};
	}
	return out;
}

// moments, as told (named when asked: a new computer is due before it has a name)
typedef struct {
	sc_told m;
	char *error;
	sc_computer **through;
} moment;
static moment *moments;
static size_t nmoments, capmoments;

// each computation's latest ended run's reads, in order, as pl_spot named each as the run ended
typedef struct {
	sc_computer *c;
	op_value *reads;
} spotted;
static spotted *spotteds;
static size_t nspotted, capspotted;

op_value *world_where(const pl_where *w) {
	op_value *o = op_map();
	op_set(o, "part", op_str(w->part.string));
	op_set(o, "id", op_str(w->id.string));
	if (w->change) {
		op_set(o, "path", op_null());
		return o;
	}
	op_value *path = op_list();
	for (size_t i = 0; i < w->length; i++) {
		const op_key *k = &w->path[i];
		op_push(path, k->type == OP_NUM_KEY ? op_num((double)k->n) : op_str(k->s));
	}
	op_set(o, "path", path);
	return o;
}

static void name_reads(const sc_told *m) {
	op_value *reads = op_list();
	for (size_t i = 0; i < m->nreads; i++) {
		pl_where w;
		op_push(reads, pl_spot(world_places, m->reads[i], &w) ? world_where(&w) : op_null());
	}
	for (size_t i = 0; i < nspotted; i++) {
		if (spotteds[i].c != m->c) continue;
		op_free(spotteds[i].reads);
		spotteds[i].reads = reads;
		return;
	}
	PUSH(spotteds, nspotted, capspotted, ((spotted){m->c, reads}));
}

const op_value *world_reads(const sc_computer *c) {
	for (size_t i = 0; i < nspotted; i++)
		if (spotteds[i].c == c) return spotteds[i].reads;
	return NULL;
}

static sc_trace trace;

static void told_moment(const sc_told *m, void *data) {
	(void)data;
	if (m->kind == SC_T_ENDS) name_reads(m);
	// the reads are good for the call only
	moment x = {.m = *m};
	x.m.reads = NULL;
	x.m.nreads = 0;
	x.error = m->error ? world_copy(m->error) : NULL;
	x.m.error = x.error;
	if (m->nthrough) {
		x.through = world_alloc(m->nthrough * sizeof *x.through);
		memcpy(x.through, m->through, m->nthrough * sizeof *x.through);
		x.m.through = x.through;
	}
	PUSH(moments, nmoments, capmoments, x);
}

static const char *ended_name(sc_ended e) {
	switch (e) {
	case SC_DONE: return "done";
	case SC_PENDED: return "pending";
	case SC_FAIL: return "failed";
	case SC_STOPPED_RUN: return "stopped";
	default: return "looping";
	}
}
static op_value *name_json(const sc_computer *c) { return op_str((const char *)sc_scope_user(c)); }

static op_value *moment_json(const moment *x) {
	const sc_told *m = &x->m;
	op_value *o = op_map();
	switch (m->kind) {
	case SC_T_DUE:
		op_set(o, "due", name_json(m->c));
		op_set(o, "tick", op_num((double)((int64_t)m->tick)));
		if (m->by) op_set(o, "writer", name_json(m->by));
		break;
	case SC_T_STARTS:
		op_set(o, "starts", name_json(m->c));
		op_set(o, "run", op_num((double)(m->run)));
		op_set(o, "rank", op_num((double)(m->rank)));
		break;
	case SC_T_ACTS:
		op_set(o, "acts", name_json(m->c));
		op_set(o, "run", op_num((double)(m->run)));
		if (m->error) op_set(o, "error", op_str(m->error));
		break;
	case SC_T_ENDS:
		op_set(o, "ends", name_json(m->c));
		op_set(o, "run", op_num((double)(m->run)));
		op_set(o, "ended", op_str(ended_name(m->ended)));
		if (m->equal >= 0) op_set(o, "equal", op_bool(m->equal));
		if (m->error) op_set(o, "error", op_str(m->error));
		if (m->waits) op_set(o, "waits", name_json(m->waits));
		if (m->nthrough) {
			op_value *t = op_list();
			for (size_t i = 0; i < m->nthrough; i++) op_push(t, name_json(m->through[i]));
			op_set(o, "through", t);
		}
		break;
	}
	return o;
}

// watches ---------------------------------------------------------------------------------------

static world_watch **watches;
static size_t nwatches, capwatches;

char *world_set(void *value, void *data) {
	world_watch *w = data;
	op_value *was = w->value;
	w->value = op_ref(value);
	op_free(was);
	return NULL;
}
bool world_equal(const void *a, const void *b, void *data) {
	(void)data;
	char *x = op_json_text(a), *y = op_json_text(b);
	bool same = strcmp(x, y) == 0;
	free(x);
	free(y);
	return same;
}
void world_drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

// a compute made, with the scope open
typedef struct {
	sc_def def;
	bool effect;
	sc_computer *made;
} making;
static void make_in_scope(void *data) {
	making *m = data;
	m->made = m->effect ? sc_create_effect(world_scheduler, m->def) : sc_create_computer(world_scheduler, m->def);
}

char *world_make(world_watch *w, const char *name, const char *scope, sc_def def, bool effect) {
	sc_scope *o = scope ? world_scope(scope) : NULL;
	if (o == NULL) return world_copy("no such scope");
	w->name = world_copy(name);
	PUSH(watches, nwatches, capwatches, w);
	making m = {.def = def, .effect = effect};
	const char *bad = sc_run_with_scope(o, make_in_scope, &m);
	if (bad) return world_copy(bad);
	if (m.made == NULL) return world_copy(SC_DISPOSED);
	return world_name(m.made, name);
}

op_value *world_error_take(char *why) {
	op_value *o = world_error(why);
	free(why);
	return o;
}

op_value *world_error(const char *why) {
	op_value *o = op_map();
	op_set(o, "error", op_str(why));
	return o;
}

tb_key world_key(const op_value *j) { return tb_string(world_text(j)); }
const char *world_part(const op_value *j) {
	const char *s = world_text(j);
	return s ? s : "value";
}

const char **world_address(const op_value *list, size_t *n) {
	*n = world_is(list, OP_LIST) ? (size_t)list->count : 0;
	const char **names = world_alloc((*n + 1) * sizeof *names);
	for (size_t i = 0; i < *n; i++) names[i] = world_text(list->items[i]);
	return names;
}

op_key *world_path(const op_value *list, size_t *n) {
	*n = world_is(list, OP_LIST) ? (size_t)list->count : 0;
	op_key *keys = world_alloc((*n + 1) * sizeof *keys);
	for (size_t i = 0; i < *n; i++) {
		const op_value *k = list->items[i];
		int64_t w;
		if (world_is(k, OP_STR)) keys[i] = (op_key){.type = OP_STR_KEY, .s = k->str};
		else if (world_whole(k, &w)) keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)w};
		else keys[i] = (op_key){.type = OP_STR_KEY, .s = ""};
	}
	return keys;
}

op_value *world_ids(const pl_members *list) {
	op_value *a = op_list();
	for (size_t i = 0; i < list->n; i++) op_push(a, op_str(list->items[i].id.string));
	return a;
}

// writes ----------------------------------------------------------------------------------------

// the header of a write made now, with the scope open. 0, or -1 with *why
static int header_now(ch_header *h, pl_made **made, const char **why) {
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, h, made);
	if (bad == NULL) return 0;
	free(bad);
	*why = SC_UNSCOPED;
	return -1;
}

// a write made: the nodes it changed hold the header's block too
static void hold_header(const pl_changed *changed, pl_made *made) {
	for (size_t i = 0; i < changed->n; i++) {
		pl_hold_also(world_places, changed->entries[i], pl_made_ref(made), pl_made_free);
	}
}

op_value *world_status_json(const op_value *status) {
	if (cst_is_pending(status)) return op_str("pending");
	const char *message = cst_error(status);
	if (message == NULL) return op_null();
	op_value *o = op_map();
	op_set(o, "error", op_str(message));
	return o;
}

op_value *world_summary(const ch_header *h) {
	op_value *o = op_map();
	if (h->actor != NULL) op_set(o, "actor", world_snap(h->actor));
	if (h->reader != NULL) op_set(o, "reader", op_str(h->reader));
	if (h->metadata_length > 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < h->metadata_length; i++) {
			op_value *pair = op_list();
			op_push(pair, op_str(h->metadata[i].key));
			op_push(pair, world_snap(h->metadata[i].value));
			op_push(list, pair);
		}
		op_set(o, "metadata", list);
	}
	int64_t now = (int64_t)time(NULL);
	op_set(o, "timely", op_bool(h->has_time && h->time > now - 5 && h->time < now + 5));
	op_set(o, "sites", op_num((double)((int64_t)h->external_length)));
	return o;
}

int world_edit(const char *part, tb_key id, const op_value *patches, nd_entry **out,
	const char **why, size_t *failed) {
	// the patches refer into the list, and are the line's: the node's change refers to them
	size_t count = world_is(patches, OP_LIST) ? patches->count : 0;
	op_patch *list = hh_take((count + 1) * sizeof *list);
	for (size_t i = 0; i < count; i++) hh_patch(patches->items[i], &list[i]);
	ch_header h;
	pl_made *made;
	if (out != NULL) *out = NULL;
	if (header_now(&h, &made, why)) return -1;
	nd_entry *node = tb_get(world_table, tb_string(part), id);
	int code;
	if (node == NULL) {
		node = nd_make_entry(NULL, &h, NULL);
		code = nd_update(node, list, count, h, failed);
		if (code != OP_OK) nd_free_entry(node);
		else {
			world_keep_node(node);
			tb_add(world_table, tb_string(part), id, node);
		}
	} else {
		code = nd_update(node, list, count, h, failed);
		if (code == OP_OK) {
			pl_changed changed = {1, {node}};
			pl_commit(world_places, &changed);
		}
	}
	if (code != OP_OK) {
		pl_made_free(made);
		*why = op_code_name(code);
		return code;
	}
	pl_hold(world_places, node, made, pl_made_free);
	if (out != NULL) *out = node;
	return OP_OK;
}

// upsert (typescript/upsert.ts), by a request's part, id, path (names) and value
static int world_upsert(const op_value *r, const char **why) {
	const op_value *id = op_get(r, "id"), *value = op_get(r, "value");
	if (!world_is(id, OP_STR)) return *why = "id: not a string", -1;
	if (value == NULL) return *why = "no value", -1;
	ch_header h;
	pl_made *made;
	if (header_now(&h, &made, why)) return -1;
	size_t n;
	const char **path = world_address(op_get(r, "path"), &n);
	for (size_t i = 0; i < n; i++) {
		if (path[i] == NULL) path[i] = "";
	}
	pl_changed changed;
	nd_entry *node;
	pl_upsert(world_places, tb_string(world_part(op_get(r, "part"))), world_key(id), path, n, value, h,
		&changed, &node);
	free(path);
	pl_commit(world_places, &changed);
	hold_header(&changed, made);
	if (node != NULL) pl_hold(world_places, node, made, pl_made_free);
	else pl_made_free(made);
	return 0;
}

int world_write(const op_value *r, const char **why, size_t *failed) {
	const char *op = world_text(op_get(r, "op"));
	*why = NULL;
	if (strcmp(op, "upsert") == 0) return world_upsert(r, why);
	if (strcmp(op, "edit") == 0) {
		return world_edit(world_part(op_get(r, "part")), world_key(op_get(r, "id")),
			op_get(r, "patches"), NULL, why, failed);
	}
	const op_value *at = op_get(r, "at");
	const char *name = world_text(op_get(r, "name"));
	const op_value *id = op_get(r, "id"), *to = op_get(r, "to");
	const op_value *toat = world_is(to, OP_MAP) ? op_get(to, "at") : NULL;
	if (!world_is(at, OP_STR)) return *why = "id: not a string", -1;
	if (strcmp(op, "place") == 0 && !world_is(id, OP_STR)) return *why = "id: not a string", -1;
	if (strcmp(op, "move") == 0 && !world_is(toat, OP_STR)) return *why = "id: not a string", -1;
	if (strcmp(op, "place") != 0 && strcmp(op, "unplace") != 0 && strcmp(op, "rename") != 0 &&
		strcmp(op, "move") != 0) {
		return *why = "unknown write", -1;
	}
	ch_header h;
	pl_made *made;
	if (header_now(&h, &made, why)) return -1;
	// a parent's children entry; none: nothing-there
	nd_entry *parent = tb_get(world_table, tb_string("children"), world_key(at));
	nd_entry *into = toat ? tb_get(world_table, tb_string("children"), world_key(toat)) : NULL;
	pl_changed changed = {0};
	int code;
	if (parent == NULL || (strcmp(op, "move") == 0 && into == NULL)) {
		code = PL_NOTHING_THERE;
	} else if (strcmp(op, "place") == 0) {
		code = pl_place(world_places, parent, name, world_key(id), h, &changed);
	} else if (strcmp(op, "unplace") == 0) {
		code = pl_unplace(world_places, parent, name, h, &changed);
	} else if (strcmp(op, "rename") == 0) {
		code = pl_rename(world_places, parent, name, world_text(op_get(r, "to")), h, &changed);
	} else {
		code = pl_move(world_places, parent, name, into, world_text(op_get(to, "name")), h, &changed);
	}
	pl_commit(world_places, &changed);
	hold_header(&changed, made);
	pl_made_free(made);
	if (code) *why = pl_code_name(code);
	return code;
}

op_value *world_fill(const op_value *x, op_value *(*eval)(const op_value *e, void *ctx), void *ctx) {
	if (world_is(x, OP_LIST)) {
		op_value *a = op_list();
		for (size_t i = 0; i < x->count; i++) {
			op_value *y = world_fill(x->items[i], eval, ctx);
			if (y == NULL) return op_free(a), NULL;
			op_push(a, y);
		}
		return a;
	}
	if (!world_is(x, OP_MAP)) return op_ref((op_value *)x);
	if (x->count == 1 && strcmp(x->keys[0], "eval") == 0) return eval(x->items[0], ctx);
	op_value *o = op_map();
	for (size_t i = 0; i < x->count; i++) {
		op_value *y = world_fill(x->items[i], eval, ctx);
		if (y == NULL) return op_free(o), NULL;
		op_set(o, x->keys[i], y);
	}
	return o;
}

// programs --------------------------------------------------------------------------------------

static bool truthy(const op_value *j) {
	if (j == NULL || j->type == OP_NULL) return false;
	if (j->type == OP_BOOL) return j->bool_;
	if (j->type == OP_NUM) return j->num != 0;
	if (j->type == OP_STR) return j->bytes > 0;
	return true;
}
static double number(const op_value *j) { return j && j->type == OP_NUM ? j->num : 0; }

// a list of strings joined, with a separator between
static op_value *joined(const op_value *list, const char *separator) {
	char *s = world_copy("");
	for (size_t i = 0; i < list->count; i++) {
		const op_value *p = list->items[i];
		char *t = p->type == OP_STR ? world_copy(p->str) : op_json_text(p);
		char *more = world_format("%s%s%s", s, i ? separator : "", t);
		free(s), free(t);
		s = more;
	}
	op_value *out = op_str(s);
	free(s);
	return out;
}

// a program run in a scope of its own, made under the one open
typedef struct {
	op_value *(*eval)(const op_value *e, void *ctx);
	void *ctx;
	const op_value *e;
	op_value *out;
} inside;
static void eval_inside(void *data) {
	inside *in = data;
	in->out = in->eval(in->e, in->ctx);
}
op_value *world_basic(const op_value *e, op_value *(*eval)(const op_value *e, void *ctx), void *ctx, bool *handled,
	char **error) {
	const op_value *x;
	*handled = true;
	if ((x = op_get(e, "cat")) || (x = op_get(e, "join"))) {
		op_value *list = eval(x, ctx);
		if (list == NULL) return NULL;
		op_value *out = joined(list, op_get(e, "join") ? "," : "");
		op_free(list);
		return out;
	}
	if ((x = op_get(e, "count"))) {
		op_value *list = eval(x, ctx);
		if (list == NULL) return NULL;
		op_value *out = op_num((double)(list->type == OP_LIST ? list->count : 0));
		op_free(list);
		return out;
	}
	if ((x = op_get(e, "add")) || (x = op_get(e, "lt"))) {
		op_value *a = eval(x->items[0], ctx);
		if (a == NULL) return NULL;
		op_value *b = eval(x->items[1], ctx);
		if (b == NULL) return op_free(a), NULL;
		op_value *out = op_get(e, "add") ? op_num(number(a) + number(b)) : op_bool(number(a) < number(b));
		op_free(a), op_free(b);
		return out;
	}
	if ((x = op_get(e, "if"))) {
		op_value *test = eval(x->items[0], ctx);
		if (test == NULL) return NULL;
		bool yes = truthy(test);
		op_free(test);
		return eval(x->items[yes ? 1 : 2], ctx);
	}
	if ((x = op_get(e, "do"))) {
		op_value *last = op_null();
		for (size_t i = 0; i < x->count; i++) {
			op_free(last);
			last = eval(x->items[i], ctx);
			if (last == NULL) return NULL;
		}
		return last;
	}
	if ((x = op_get(e, "quote"))) return op_ref((op_value *)x);
	if ((x = op_get(e, "within"))) {
		size_t n;
		const sc_pair *info = world_info(x->items[0], &n);
		sc_scope *o = sc_create_scope(world_scheduler, info, n, NULL);
		if (o == NULL) {
			sc_scope *open = sc_get_current_scope(world_scheduler);
			*error = world_copy(open == NULL ? SC_UNSCOPED : sc_scope_alive(open) ? SC_EMPTY : SC_DISPOSED);
			return NULL;
		}
		inside in = {eval, ctx, x->items[1], NULL};
		const char *bad = sc_run_with_scope(o, eval_inside, &in);
		if (bad) *error = world_copy(bad);
		return in.out;
	}
	if (op_get(e, "header")) {
		ch_header h;
		pl_made *made;
		const char *why;
		if (header_now(&h, &made, &why)) return *error = world_copy(why), NULL;
		op_value *out = world_summary(&h);
		pl_made_free(made);
		return out;
	}
	*handled = false;
	return NULL;
}

// requests --------------------------------------------------------------------------------------

static op_value *with_value(const op_value *v) {
	op_value *o = op_map();
	if (v != NULL) op_set(o, "value", world_snap(v));
	return o;
}

// a node of the value given, its header made now, held by the node. NULL: an error, in *out
static nd_entry *made_node(const op_value *value, op_value **out) {
	ch_header h;
	pl_made *made;
	const char *why;
	if (header_now(&h, &made, &why)) return *out = world_error(why), NULL;
	nd_entry *node = nd_make_entry((op_value *)value, &h, NULL);
	pl_hold(world_places, node, made, pl_made_free);
	world_keep_node(node);
	return node;
}

// the value a getOrSet is to make
static const op_value *made_value;
static op_value *make_value(void *ctx) {
	(void)ctx;
	return op_ref((op_value *)made_value);
}
static op_value *world_snap_into(const op_value *got) {
	op_value *o = op_map();
	if (got != NULL) op_set(o, "value", world_snap(got));
	return o;
}

// the world's requests that write or change the table, made in the host's scope
typedef struct {
	const op_value *r;
	op_value *out;
} hosting;

static void in_host(void *data) {
	hosting *c = data;
	const op_value *r = c->r;
	const char *op = world_text(op_get(r, "op"));
	c->out = NULL;
	if (strcmp(op, "kids") == 0 || strcmp(op, "value") == 0) {
		nd_entry *node = made_node(op_get(r, "value"), &c->out);
		if (node == NULL) return;
		tb_sub(world_table, tb_string(op[0] == 'k' ? "children" : "value"), world_key(op_get(r, "id")),
			node);
		c->out = op_map();
	} else if (strcmp(op, "share") == 0) {
		nd_entry *node = made_node(op_get(r, "value"), &c->out);
		if (node == NULL) return;
		// the keys in order; one taken by another node: already-there, the keys before it kept
		const op_value *keys = op_get(r, "keys");
		for (size_t i = 0; i < keys->count; i++) {
			const op_value *k = keys->items[i];
			int code =
				tb_add(world_table, tb_string(world_part(k->items[0])), world_key(k->items[1]), node);
			if (code) {
				c->out = world_error(tb_code_name(code));
				return;
			}
		}
		c->out = op_map();
	} else if (strcmp(op, "getOrSet") == 0) {
		const op_value *id = op_get(r, "id"), *value = op_get(r, "value");
		const char *why;
		ch_header h;
		pl_made *made;
		if (!world_is(id, OP_STR) || value == NULL) {
			c->out = world_error("id: not a string");
			return;
		}
		if (header_now(&h, &made, &why)) {
			c->out = world_error(why);
			return;
		}
		size_t n;
		const char **path = world_address(op_get(r, "path"), &n);
		for (size_t i = 0; i < n; i++) {
			if (path[i] == NULL) path[i] = "";
		}
		pl_changed changed;
		nd_entry *node;
		made_value = value;
		const op_value *got = pl_get_or_set(world_places, tb_string(world_part(op_get(r, "part"))),
			world_key(id), path, n, make_value, NULL, h, &changed, &node);
		free(path);
		pl_commit(world_places, &changed);
		hold_header(&changed, made);
		if (node != NULL) pl_hold(world_places, node, made, pl_made_free);
		else pl_made_free(made);
		c->out = world_snap_into(got);
	} else if (strcmp(op, "del") == 0) {
		int code = tb_del(world_table, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")));
		c->out = code ? world_error(tb_code_name(code)) : op_map();
	} else {
		const char *why;
		size_t failed = 0;
		int code = world_write(r, &why, &failed);
		if (!code) {
			c->out = op_map();
			return;
		}
		c->out = world_error(why);
		if (strcmp(op, "edit") == 0 && code > 0) op_set(c->out, "patch", op_num((double)((int64_t)failed)));
	}
}

// the header request's call: the header of a write made now, summed up
typedef struct {
	const sc_pair *extra;
	size_t n;
	op_value *out;
} heading;
static void in_header(void *data) {
	heading *c = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, c->extra, c->n, CH_HERE, &h, &made);
	if (bad) {
		c->out = world_error_take(bad);
		return;
	}
	c->out = world_summary(&h);
	pl_made_free(made);
}

// the requests' watchPath watches: what each is told, kept by name -------------------------------

typedef struct {
	char *name;
	pl_watch *watch;
	// the facts told since last asked: a list of {part, id, patches, actor?}
	op_value *told;
} told_watch;
static told_watch **told_watches;
static size_t ntold, captold;

static told_watch *told_named(const char *name) {
	for (size_t i = 0; i < ntold; i++) {
		if (strcmp(told_watches[i]->name, name) == 0) return told_watches[i];
	}
	return NULL;
}

static void told_fact(const pl_fact *f, void *ctx) {
	told_watch *w = ctx;
	op_value *o = op_map();
	op_set(o, "part", op_str(f->part.string));
	op_set(o, "id", op_str(f->id.string));
	op_set(o, "patches", world_patches(f->patches, f->patches_length));
	if (f->change != NULL && f->change->actor != NULL) op_set(o, "actor", world_snap(f->change->actor));
	op_push(w->told, o);
}

static op_value *watch_path(const op_value *r) {
	const char *name = world_text(op_get(r, "name"));
	if (name == NULL) return world_error("no name");
	told_watch *old = told_named(name);
	if (old != NULL) {
		pl_stop(old->watch);
		old->watch = NULL;
	}
	size_t n, at_n = 0;
	const char **path = world_address(op_get(r, "path"), &n);
	for (size_t i = 0; i < n; i++) {
		if (path[i] == NULL) path[i] = "";
	}
	pl_watching options = {0};
	const op_value *part = op_get(r, "part"), *at = op_get(r, "at");
	if (world_is(part, OP_STR)) options.has_part = 1, options.part = tb_string(part->str);
	op_key *at_keys = NULL;
	if (world_is(at, OP_LIST)) {
		at_keys = world_path(at, &at_n);
		options.has_at = 1, options.at = at_keys, options.at_length = at_n;
	}
	if (old == NULL) {
		old = world_alloc(sizeof *old);
		old->name = world_copy(name);
		old->told = op_list();
		PUSH(told_watches, ntold, captold, old);
	}
	old->watch = pl_watch_path(world_places, path, n, told_fact, old, &options);
	free(path);
	free(at_keys);
	return op_map();
}

// the world's request; NULL: not one of them
static op_value *world_answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	const char *hosted[] = {"kids", "value", "share", "del", "edit", "upsert",
		"getOrSet", "place", "unplace", "rename", "move"};
	for (size_t i = 0; i < sizeof hosted / sizeof *hosted; i++) {
		if (strcmp(op, hosted[i]) != 0) continue;
		hosting c = {.r = r};
		const char *bad = world_hosted(in_host, &c);
		return bad ? world_error(bad) : c.out;
	}
	if (strcmp(op, "node") == 0) {
		const nd_entry *n = tb_get(world_table, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")));
		return with_value(n ? n->value : NULL);
	}
	if (strcmp(op, "status") == 0) {
		if (world_status == NULL) {
			world_status = cst_new(&(cst_setup){world_places, world_table, world_scheduler});
		}
		return op_map();
	}
	if (strcmp(op, "give") == 0) {
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		const op_value *id = op_get(r, "id");
		if (world_status == NULL) return world_error("no status");
		if (c == NULL) return world_error("no such scope");
		if (!world_is(id, OP_STR)) return world_error("id: not a string");
		cst_give(world_status, c, world_key(id));
		return op_map();
	}
	if (strcmp(op, "statusOf") == 0) {
		const op_value *id = op_get(r, "id");
		if (!world_is(id, OP_STR)) return world_error("id: not a string");
		const op_value *v = cst_status(world_places, world_key(id));
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, "status", world_status_json(v));
		return o;
	}
	if (strcmp(op, "watchPath") == 0) return watch_path(r);
	if (strcmp(op, "watched") == 0) {
		told_watch *t = told_named(world_text(op_get(r, "name")) ? world_text(op_get(r, "name")) : "");
		if (t == NULL) return world_error("no watch");
		op_value *o = op_map();
		op_set(o, "facts", t->told);
		t->told = op_list();
		return o;
	}
	if (strcmp(op, "unwatch") == 0) {
		told_watch *t = told_named(world_text(op_get(r, "name")) ? world_text(op_get(r, "name")) : "");
		if (t != NULL) {
			pl_stop(t->watch);
			op_free(t->told);
			free(t->name);
			for (size_t i = 0; i < ntold; i++) {
				if (told_watches[i] == t) told_watches[i] = told_watches[--ntold], i = ntold;
			}
			free(t);
		}
		return op_map();
	}
	if (strcmp(op, "cache") == 0) {
		world_cached();
		return op_map();
	}
	if (strcmp(op, "cacheKept") == 0) {
		pc_kept k = cache != NULL ? pc_kept_of(cache) : (pc_kept){0};
		op_value *o = op_map();
		op_set(o, "entries", op_num((double)k.entries));
		op_set(o, "reads", op_num((double)k.reads));
		return o;
	}
	if (strcmp(op, "kept") == 0) {
		pt_kept k = pt_kept_of(world_paths);
		op_value *o = op_map();
		op_set(o, "keys", op_num((double)((int64_t)k.keys)));
		op_set(o, "spots", op_num((double)((int64_t)k.spots)));
		op_set(o, "steps", op_num((double)((int64_t)k.steps)));
		return o;
	}
	if (strcmp(op, "root") == 0 || strcmp(op, "scope") == 0) {
		size_t n;
		const sc_pair *info = world_info(op_get(r, "info"), &n);
		sc_scope *o;
		if (op[0] == 'r') {
			o = sc_create_root_scope(world_scheduler, info, n);
			if (o == NULL) return world_error(SC_EMPTY);
		} else {
			sc_scope *parent = world_scope(world_text(op_get(r, "parent")));
			if (parent == NULL) return world_error("no such scope");
			o = sc_create_scope(world_scheduler, info, n, parent);
			if (o == NULL) return world_error(sc_scope_alive(parent) ? SC_EMPTY : SC_DISPOSED);
		}
		char *bad = world_name(o, world_text(op_get(r, "name")));
		if (bad) return world_error_take(bad);
		const char *node = world_text(op_get(r, "node"));
		if (node != NULL) PUSH(given, ngiven, capgiven, ((given_node){o, node}));
		return op_map();
	}
	if (strcmp(op, "dispose") == 0) {
		sc_scope *o = world_scope(world_text(op_get(r, "name")));
		if (o == NULL) return world_error("no such scope");
		char *why = sc_teardown(o);
		if (why) return world_error_take(why);
		return op_map();
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(world_scheduler);
		return op_map();
	}
	if (strcmp(op, "header") == 0) {
		size_t n;
		heading c = {.extra = world_info(op_get(r, "extra"), &n), .n = n};
		const char *scope = world_text(op_get(r, "scope"));
		if (scope == NULL) in_header(&c);
		else {
			sc_scope *o = world_scope(scope);
			if (o == NULL) return world_error("no such scope");
			const char *bad = sc_run_with_scope(o, in_header, &c);
			if (bad) return world_error(bad);
		}
		return c.out;
	}
	if (strcmp(op, "state") == 0) {
		const char *name = world_text(op_get(r, "name"));
		for (size_t i = 0; i < nwatches; i++) {
			if (strcmp(watches[i]->name, name) != 0) continue;
			op_value *o = op_map();
			op_set(o, "runs", op_num((double)(watches[i]->runs)));
			op_set(o, "value", watches[i]->value ? op_ref(watches[i]->value) : op_null());
			return o;
		}
		return world_error("no such watch");
	}
	if (strcmp(op, "moments") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < nmoments; i++) {
			op_push(list, moment_json(&moments[i]));
			free(moments[i].error);
			free(moments[i].through);
		}
		nmoments = 0;
		op_value *o = op_map();
		op_set(o, "moments", list);
		return o;
	}
	return NULL;
}

static sc_pair host_info;

static void world_start(void) {
	world_places = pl_new();
	world_scheduler = sc_new((sc_options){.drop = world_drop});
	sc_trace_start(world_scheduler, &trace, told_moment, NULL);
	sc_on_tracking_end(world_scheduler, pl_forget, world_places);
	world_table = table_event ? tb_make(table_event, table_ctx) : tb_make(pl_event, world_places);
	world_paths = pt_new();
	pl_connect(world_places, &(pl_setup){.root = tb_string("R"), .table = world_table, .paths = world_paths,
		.scheduler = world_scheduler, .contributors = contributors,
		.ncontributors = ncontributors, .node_of = node_of});
	host_info = (sc_pair){"actor", op_str("test")};
	world_host = sc_create_root_scope(world_scheduler, &host_info, 1);
}

void world_line(const op_value *r, FILE *out, op_value *(*answer)(const op_value *request)) {
	if (world_places == NULL) world_start();
	// the line is kept: what the world holds refers into it
	hh_line *line = hh_retain();
	if (nlines == 0 || lines[nlines - 1] != line) PUSH(lines, nlines, caplines, line);
	op_value *a = answer(r);
	if (a == NULL) a = world_answer(r);
	if (a == NULL) {
		hh_unknown(out, r);
		return;
	}
	op_json_write(out, a);
	op_free(a);
}

void world_finish(void) {
	if (world_places == NULL) return;
	cst_stop(world_status);
	pc_free(cache);
	cache = NULL;
	for (size_t i = 0; i < nnamed; i++) free(sc_scope_user(named[i]));
	sc_free(world_scheduler);
	tb_free(world_table);
	pt_free(world_paths);
	pl_free(world_places);
	cst_free(world_status);
	world_status = NULL;
	op_free((op_value *)host_info.value);
	for (size_t i = 0; i < nmoments; i++) {
		free(moments[i].error);
		free(moments[i].through);
	}
	for (size_t i = 0; i < ntold; i++) {
		op_free(told_watches[i]->told);
		free(told_watches[i]->name);
		free(told_watches[i]);
	}
	free(told_watches);
	told_watches = NULL;
	ntold = captold = 0;
	for (size_t i = 0; i < nwatches; i++) {
		op_free(watches[i]->value);
		free(watches[i]->name);
	}
	for (size_t i = 0; i < nspotted; i++) op_free(spotteds[i].reads);
	free(spotteds);
	spotteds = NULL;
	nspotted = capspotted = 0;
	for (size_t i = 0; i < nnodes; i++) nd_free_entry(nodes[i]);
	for (size_t i = 0; i < nvalues; i++) op_free(values[i]);
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(watches), free(named), free(moments), free(nodes), free(lines), free(values), free(given);
	given = NULL;
	ngiven = capgiven = 0;
	world_places = NULL;
}
