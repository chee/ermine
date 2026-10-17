// The C patch nodes (patch.h) on the line protocol of typescript/patch_harness.ts, which documents
// it and the programs (conformance/c/harness.h has the loop). The scheduler, scopes, pulse, state
// and header are the places harness's world (filesystem/places/c/world_harness.h): its table is the view
// places reads, and the table the writes go to is this harness's own.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/protocol_harness.h"
#include "../../../filesystem/places/c/world_harness.h"
#include "patch.h"

static pn *overlay;
static tb_table *table;

static int connected;

// before the first line: the world makes its table with the overlay's view event
void hh_start(void) {
	overlay = pn_new();
	table = tb_make(pn_event, overlay);
	world_event(pn_view_event, overlay);
}

static void start(void) {
	connected = 1;
	pn_connect(overlay, table, world_table, world_places);
}

// programs --------------------------------------------------------------------------------------

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
static bool alive(ctx *c) {
	sc_track_status status = pl_status(world_places);
	if (status == SC_STOP) c->stopped = true;
	return status == SC_OK;
}

// a layer, as the entries request tells it: { value?, from, stale?, error? }
static op_value *item_json(const pn_item *i) {
	op_value *o = op_map();
	op_set(o, "from", op_str(i->from));
	if (i->value != NULL) op_set(o, "value", world_snap(i->value));
	if (i->stale) op_set(o, "stale", op_bool(1));
	if (i->error != NULL) op_set(o, "error", op_str(i->error));
	return o;
}

static op_value *items_json(tb_key part, tb_key id, const op_key *keys, size_t n) {
	pn_items items = pn_entries(overlay, part, id, keys, n);
	op_value *a = op_list();
	for (size_t i = 0; i < items.n; i++) op_push(a, item_json(&items.items[i]));
	pn_items_free(&items);
	return a;
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
	bool reading = (x = op_get(e, "read")) != NULL;
	if (reading || (x = op_get(e, "entries"))) {
		// [id, path?, part?]: the id a string, or a program giving one
		op_value *id = eval(x->items[0], c);
		if (id == NULL) return NULL;
		if (id->type != OP_STR) return op_free(id), thrown(c, world_copy("id: not a string"));
		op_value *steps = x->count > 1 ? eval(x->items[1], c) : NULL;
		if (x->count > 1 && steps == NULL) return op_free(id), NULL;
		size_t n;
		op_key *keys = world_path(steps, &n);
		tb_key part = tb_string(world_part(x->count > 2 ? x->items[2] : NULL));
		op_value *out;
		if (reading) {
			const op_value *v = pl_read(world_places, part, tb_string(id->str), keys, n);
			out = alive(c) ? world_snap(v) : NULL;
		} else {
			out = items_json(part, tb_string(id->str), keys, n);
			if (!alive(c)) op_free(out), out = NULL;
		}
		free(keys);
		op_free(steps);
		op_free(id);
		return out;
	}
	if ((x = op_get(e, "get"))) {
		size_t n;
		const char **names = world_address(x, &n);
		tb_key id;
		int found = pl_get(world_places, names, n, &id);
		free(names);
		if (!alive(c)) return NULL;
		return found ? op_str(id.string) : op_null();
	}
	if ((x = op_get(e, "throw"))) {
		const char *message = world_text(x);
		return thrown(c, world_copy(message ? message : "error"));
	}
	bool handled;
	char *error = NULL;
	op_value *plain = world_basic(e, eval_for_fill, c, &handled, &error);
	if (error) return thrown(c, error);
	if (handled) return plain;
	return thrown(c, world_copy("unknown program"));
}

typedef struct {
	world_watch watch;
	const op_value *f;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(void *previous, void *data) {
	(void)previous;
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

// writes ----------------------------------------------------------------------------------------

static op_value *with_value(const op_value *v) {
	op_value *o = op_map();
	if (v != NULL) op_set(o, "value", world_snap(v));
	return o;
}

// the header of a write made now, with the scope open (the request's metadata after the scope's
// pairs), its time the request's if it gives one. 0, or -1 with *why
static int header_now(const op_value *r, ch_header *h, pl_made **made, const char **why) {
	size_t n;
	const sc_pair *extra = world_info(op_get(r, "metadata"), &n);
	char *bad = pl_header(world_places, extra, n, CH_HERE, h, made);
	if (bad != NULL) {
		free(bad);
		*why = SC_UNSCOPED;
		return -1;
	}
	int64_t time;
	if (world_whole(op_get(r, "time"), &time)) h->has_time = 1, h->time = time;
	return 0;
}

typedef struct {
	const op_value *r;
	op_value *out;
} hosting;

// the entry a write puts: its header made now, held by the node
static nd_entry *made_node(const op_value *r, const op_value *value, op_value **out) {
	ch_header h;
	pl_made *made;
	const char *why;
	if (header_now(r, &h, &made, &why)) return *out = world_error(why), NULL;
	nd_entry *node = nd_make_entry((op_value *)value, &h, NULL);
	pl_hold(world_places, node, made, pl_made_free);
	world_keep_node(node);
	return node;
}

// a value write: the patches to the entry there, said through the overlay's commit; none there: an
// entry made and added (the table's event tells)
static void edit(const op_value *r, op_value **out) {
	const op_value *patches = op_get(r, "patches");
	size_t count = world_is(patches, OP_LIST) ? patches->count : 0;
	op_patch *list = hh_take((count + 1) * sizeof *list);
	for (size_t i = 0; i < count; i++) hh_patch(patches->items[i], &list[i]);
	ch_header h;
	pl_made *made;
	const char *why;
	if (header_now(r, &h, &made, &why)) {
		*out = world_error(why);
		return;
	}
	const char *part = world_part(op_get(r, "part"));
	tb_key id = world_key(op_get(r, "id"));
	nd_entry *node = tb_get(table, tb_string(part), id);
	size_t failed = 0;
	int code;
	if (node == NULL) {
		node = nd_make_entry(NULL, &h, NULL);
		code = nd_update(node, list, count, h, &failed);
		if (code != OP_OK) nd_free_entry(node);
		else {
			world_keep_node(node);
			tb_add(table, tb_string(part), id, node);
		}
	} else {
		code = nd_update(node, list, count, h, &failed);
		if (code == OP_OK) {
			pl_changed changed = {1, {node}};
			pn_commit(overlay, &changed);
		}
	}
	if (code != OP_OK) {
		pl_made_free(made);
		*out = world_error(op_code_name(code));
		op_set(*out, "patch", op_num((double)((int64_t)failed)));
		return;
	}
	pl_hold(world_places, node, made, pl_made_free);
	*out = op_map();
}

static void land(const op_value *r, op_value **out) {
	ch_header h;
	pl_made *made;
	const char *why;
	if (header_now(r, &h, &made, &why)) {
		*out = world_error(why);
		return;
	}
	pl_changed changed;
	nd_entry *node;
	size_t failed = 0;
	int code = pn_land(overlay, world_key(op_get(r, "id")), h, &changed, &node, &failed);
	if (code != 0) {
		pl_made_free(made);
		*out = world_error(code == PN_NOTHING_THERE ? "nothing-there" : op_code_name(code));
		if (code > 0) op_set(*out, "patch", op_num((double)((int64_t)failed)));
		return;
	}
	if (node != NULL) {
		world_keep_node(node);
		pl_hold(world_places, node, made, pl_made_free);
	} else {
		pn_commit(overlay, &changed);
		pl_hold(world_places, changed.entries[0], made, pl_made_free);
	}
	*out = op_map();
}

static void in_host(void *data) {
	hosting *c = data;
	const op_value *r = c->r;
	const char *op = world_text(op_get(r, "op"));
	c->out = NULL;
	if (strcmp(op, "kids") == 0 || strcmp(op, "value") == 0) {
		nd_entry *node = made_node(r, op_get(r, "value"), &c->out);
		if (node == NULL) return;
		tb_sub(table, tb_string(op[0] == 'k' ? "children" : "value"), world_key(op_get(r, "id")), node);
		c->out = op_map();
	} else if (strcmp(op, "patch") == 0) {
		const char *part = world_part(op_get(r, "part"));
		const op_value *on = op_get(r, "on");
		if (!world_is(on, OP_STR)) {
			c->out = world_error("id: not a string");
			return;
		}
		op_value *at;
		if (op_get(r, "at") != NULL) at = op_ref(op_get(r, "at"));
		else {
			nd_entry *target = tb_get(table, tb_string(part), world_key(on));
			at = op_num(target && target->change.has_time ? (double)target->change.time : 0);
		}
		op_value *v = op_map();
		op_set(v, "on", op_ref((op_value *)on));
		op_set(v, "part", op_str(part));
		op_set(v, "at", at);
		op_set(v, "patches", world_snap(op_get(r, "patches")));
		nd_entry *node = made_node(r, v, &c->out);
		op_free(v);
		if (node == NULL) return;
		tb_sub(table, tb_string("patch"), world_key(op_get(r, "id")), node);
		c->out = op_map();
	} else if (strcmp(op, "edit") == 0) {
		edit(r, &c->out);
	} else if (strcmp(op, "land") == 0) {
		land(r, &c->out);
	} else {
		int code = tb_del(table, tb_string(world_part(op_get(r, "part"))), world_key(op_get(r, "id")));
		c->out = code ? world_error(tb_code_name(code)) : op_map();
	}
}

// requests --------------------------------------------------------------------------------------

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (!connected) start();
	if (strcmp(op, "root") == 0 || strcmp(op, "scope") == 0) {
		// a scope needs an info pair: a step that gives none is the test's
		op_value *info = op_get(r, "info");
		if (info == NULL || (info->type == OP_LIST && info->count == 0)) {
			op_value *pair = op_list();
			op_push(pair, op_str("test"));
			op_push(pair, op_ref(op_get(r, "name")));
			if (info == NULL) {
				info = op_list();
				op_set((op_value *)r, "info", info);
			}
			op_push(info, pair);
		}
	}
	const char *hosted[] = {"kids", "value", "patch", "edit", "del", "land"};
	for (size_t i = 0; i < sizeof hosted / sizeof *hosted; i++) {
		if (strcmp(op, hosted[i]) != 0) continue;
		if (!world_is(op_get(r, "id"), OP_STR)) return world_error("id: not a string");
		hosting c = {.r = r};
		const char *bad = world_hosted(in_host, &c);
		return bad ? world_error(bad) : c.out;
	}
	if (strcmp(op, "read") == 0) {
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		const op_value *v = pl_read(world_places, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")), keys, n);
		free(keys);
		pl_status(world_places);
		return with_value(v);
	}
	if (strcmp(op, "entries") == 0) {
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		op_value *items = items_json(tb_string(world_part(op_get(r, "part"))), world_key(op_get(r, "id")),
			keys, n);
		free(keys);
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, "items", items);
		return o;
	}
	if (strcmp(op, "change") == 0) {
		const ch_header *h = pl_change(world_places, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")));
		pl_status(world_places);
		op_value *o = op_map();
		if (h == NULL) return o;
		op_set(o, "time", op_num((double)h->time));
		if (h->actor != NULL) op_set(o, "actor", world_snap(h->actor));
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
		op_set(o, "hasOp", op_bool(h->has_op));
		return o;
	}
	if (strcmp(op, "node") == 0) {
		const nd_entry *n = tb_get(table, tb_string(world_part(op_get(r, "part"))), world_key(op_get(r, "id")));
		return with_value(n ? n->value : NULL);
	}
	if (strcmp(op, "index") == 0) {
		op_value *o = op_map();
		const op_value *id = op_get(r, "id");
		if (id == NULL) {
			op_set(o, "size", op_num((double)pn_targets(overlay)));
			return o;
		}
		if (!world_is(id, OP_STR)) return op_free(o), world_error("id: not a string");
		size_t n;
		const char **ids = pn_index(overlay, id->str, &n);
		op_value *a = op_list();
		for (size_t i = 0; i < n; i++) op_push(a, op_str(ids[i]));
		free(ids);
		op_set(o, "ids", a);
		return o;
	}
	if (strcmp(op, "get") == 0) {
		size_t n;
		const char **names = world_address(op_get(r, "path"), &n);
		tb_key id;
		int found = pl_get(world_places, names, n, &id);
		free(names);
		pl_status(world_places);
		op_value *o = op_map();
		if (found) op_set(o, "id", op_str(id.string));
		return o;
	}
	if (strcmp(op, "watch") == 0) {
		program *p = world_alloc(sizeof *p);
		p->f = op_get(r, "f");
		if (nprograms == capprograms) {
			capprograms = capprograms ? capprograms * 2 : 16;
			programs = realloc(programs, capprograms * sizeof *programs);
			if (programs == NULL) abort();
		}
		programs[nprograms++] = p;
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")),
			(sc_def){.f = program_f, .set = world_set, .equal = world_equal, .data = p}, false);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	if (overlay != NULL) {
		pn_free(overlay);
		tb_free(table);
		overlay = NULL;
		connected = 0;
	}
	world_finish();
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(programs);
}
