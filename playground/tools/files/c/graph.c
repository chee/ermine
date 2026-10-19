// graph.c: the graph the files program works on. See graph.h; the rules are typescript/graph.ts's.
#define _POSIX_C_SOURCE 200809L
#include "graph.h"

#include "../../../../core/node/c/node.h"
#include "../../../../core/node/c/update.h"
#include "../../../../core/scheduler/c/paths.h"
#include "../../../../core/table/c/table.h"
#include "../../../../filesystem/places/c/guard.h"
#include "../../../../filesystem/places/c/places.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void *alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (!p) abort();
	return p;
}
static char *copy(const char *s) {
	char *c = strdup(s);
	if (!c) abort();
	return c;
}

// a growing list of pointers, freed together
typedef struct {
	void **items;
	size_t count, capacity;
} Heap;
static void *keep(Heap *h, void *p) {
	if (h->count == h->capacity) {
		h->capacity = h->capacity ? h->capacity * 2 : 16;
		h->items = realloc(h->items, h->capacity * sizeof *h->items);
		if (!h->items) abort();
	}
	h->items[h->count++] = p;
	return p;
}

// what the node's change refers to: a header's pieces
typedef struct {
	ch_header h;
	op_value *actor;
	char *reader;
	ch_entry *meta;
	size_t metas;
} Pieces;
static void pieces_free(Pieces *p) {
	op_free(p->actor);
	free(p->reader);
	for (size_t i = 0; i < p->metas; i++) {
		free((char *)p->meta[i].key);
		op_free((op_value *)p->meta[i].value);
	}
	free(p->meta);
	free(p);
}

struct fg_api {
	fg *g;
	sc_scope *scope;
	sc_pair info[3];
	size_t ninfo;
	// program: "files", the pair of an api with no actor (the scheduler refuses a scope that says nothing)
	op_value *actor, *cause, *program;
	char *file, *from;
};

struct fg {
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	gd *guard;
	sc_scope *host;
	sc_pair host_info;
	op_value *host_actor;
	char *root;
	fg_options o;
	unsigned long minted;
	char error[512];
	Heap apis;      // fg_api *
	Heap ephemerals; // char *
	Heap nodes;     // sd_node * built by fg_get, with what they refer to in `jsons` and `arrays`
	Heap jsons;     // Json * built by fg_get, freed by fg_release
	Heap arrays;    // malloc'd arrays built by fg_get, freed by fg_release
	Heap made;      // nd_entry * made here
	Heap pieces;    // Pieces *
};

// values -----------------------------------------------------------------------------------------------------------------

op_value *fg_value_of(const Json *j) {
	switch (j->type) {
	case JSON_NULL: return op_null();
	case JSON_BOOLEAN: return op_bool(j->boolean);
	case JSON_NUMBER: return j->big ? op_whole(j->bigNegative, j->big, j->bigLength) : op_num(j->number);
	case JSON_STRING: return op_str_n(j->string, j->stringLength);
	case JSON_BYTES: return op_bytes(j->bytes.data, j->bytes.length);
	case JSON_TYPED: return op_typed((op_elements)j->typed.kind, j->typed.data, j->typed.count);
	case JSON_STAND: return op_stand(fg_value_of(j->stand.kind));
	case JSON_ARRAY: {
		op_value *l = op_list();
		for (int i = 0; i < j->array.count; i++) op_push(l, fg_value_of(j->array.items[i]));
		return l;
	}
	default: {
		op_value *m = op_map();
		for (int i = 0; i < j->object.count; i++) op_set(m, j->object.members[i].key, fg_value_of(j->object.members[i].value));
		return m;
	}
	}
}

Json *fg_json_of(const op_value *v) {
	Json *j;
	switch (v->type) {
	case OP_NULL: return jsonNull();
	case OP_BOOL: return jsonBoolean(v->bool_ != 0);
	case OP_NUM: return v->big ? jsonWhole(v->bigNegative, v->big, v->bigLength) : jsonNumber(v->num);
	case OP_STR: return jsonStringOfLength(v->str, v->bytes);
	case OP_BYTES: return jsonBytes(v->data, v->bytes);
	case OP_TYPED: return jsonTyped((JsonKind)v->kind, v->data, op_length(v));
	case OP_STAND: return jsonStand(fg_json_of(v->items[0]));
	case OP_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, fg_json_of(v->items[i]));
		return j;
	default:
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], fg_json_of(v->items[i]));
		return j;
	}
}

// the graph -----------------------------------------------------------------------------------------------------------------

static char *mint(fg *g, bool ephemeral) {
	if (g->o.mint && !ephemeral) return g->o.mint(g->o.context);
	char text[64];
	snprintf(text, sizeof text, "n%lx-%lx%lx", ++g->minted, (unsigned long)time(NULL), (unsigned long)rand());
	return copy(text);
}

static const char *fail(fg *g, const char *format, const char *a, const char *b) {
	snprintf(g->error, sizeof g->error, format, a ? a : "", b ? b : "");
	return g->error;
}

// the table's event: places first, then the host's
static void event(void *ctx, tb_key part, tb_key id) {
	fg *g = ctx;
	pl_event(g->places, part, id);
	if (g->o.event) g->o.event(g->o.context, part, id);
}

fg *fg_new(const fg_options *options) {
	fg *g = alloc(sizeof *g);
	g->o = *options;
	g->root = copy(options->root);
	g->places = pl_new();
	g->s = sc_new((sc_options){0});
	sc_on_tracking_end(g->s, pl_forget, g->places);
	g->table = tb_make(event, g);
	g->paths = pt_new();
	pl_connect(g->places, &(pl_setup){.root = tb_string(g->root), .table = g->table, .paths = g->paths, .scheduler = g->s, .contributors = NULL, .ncontributors = 0});
	g->guard = gd_new(&(gd_setup){.places = g->places, .table = g->table, .may = options->may});
	g->host_actor = op_str("host");
	g->host_info = (sc_pair){"actor", g->host_actor};
	g->host = sc_create_root_scope(g->s, &g->host_info, 1);
	return g;
}

void fg_free(fg *g) {
	if (!g) return;
	fg_release(g);
	gd_free(g->guard);
	pl_free(g->places);
	sc_free(g->s);
	for (size_t i = 0; i < g->apis.count; i++) {
		fg_api *a = g->apis.items[i];
		op_free(a->actor), op_free(a->cause), op_free(a->program);
		free(a->file), free(a->from);
		free(a);
	}
	free(g->apis.items);
	for (size_t i = 0; i < g->ephemerals.count; i++) free(g->ephemerals.items[i]);
	free(g->ephemerals.items);
	tb_free(g->table);
	pt_free(g->paths);
	for (size_t i = 0; i < g->made.count; i++) nd_free_entry(g->made.items[i]);
	free(g->made.items);
	for (size_t i = 0; i < g->pieces.count; i++) pieces_free(g->pieces.items[i]);
	free(g->pieces.items);
	op_free(g->host_actor);
	free(g->nodes.items), free(g->jsons.items), free(g->arrays.items);
	free(g->root);
	free(g);
}

tb_table *fg_table(const fg *g) {
	return g->table;
}

typedef struct {
	fg *g;
	nd_entry *const *changed;
	size_t count;
} Landed;

static void do_landed(void *data) {
	Landed *l = data;
	for (size_t i = 0; i < l->count; i++) {
		pl_changed changed = {1, {l->changed[i]}};
		pl_commit(l->g->places, &changed);
	}
}

void fg_landed(fg *g, nd_entry *const *changed, size_t count) {
	Landed l = {g, changed, count};
	sc_run_with_scope(g->host, do_landed, &l);
}

fg *fg_of(const fg_api *api) {
	return api->g;
}

static fg_api *api_new(fg *g, const char *actor, const char *file, const char *from, const op_value *cause) {
	fg_api *a = keep(&g->apis, alloc(sizeof *a));
	a->g = g;
	if (actor) a->actor = op_str(actor);
	if (a->actor) a->info[a->ninfo++] = (sc_pair){"actor", a->actor};
	// with no actor, whose it is: the program's
	else a->program = op_str("files"), a->info[a->ninfo++] = (sc_pair){"program", a->program};
	if (file) {
		a->file = copy(file);
		if (from) a->from = copy(from);
		op_value *c = op_map();
		op_set(c, "file", op_str(file));
		if (from) op_set(c, "from", op_str(from));
		a->cause = c;
		a->info[a->ninfo++] = (sc_pair){"cause", a->cause};
	}
	(void)cause;
	a->scope = sc_create_root_scope(g->s, a->info, a->ninfo);
	return a;
}

fg_api *fg_actor(fg *g, const char *actor) {
	return api_new(g, actor, NULL, NULL, NULL);
}

static nd_entry *entry_at(const fg *g, const char *part, const char *id) {
	return tb_get(g->table, tb_string(part), tb_string(id));
}

bool fg_loaded(const fg *g, const char *id) {
	return entry_at(g, "children", id) || entry_at(g, "value", id);
}

const op_value *fg_value(const fg *g, const char *id) {
	nd_entry *e = entry_at(g, "value", id);
	return e ? e->value : NULL;
}

// the ids a slot value says
static size_t ids_of(const op_value *v, const char ***out) {
	size_t n = 0;
	const char **ids = alloc((v && v->type == OP_LIST ? v->count + 1 : 2) * sizeof *ids);
	if (v && v->type == OP_STR) ids[n++] = v->str;
	else if (v && v->type == OP_LIST)
		for (size_t i = 0; i < v->count; i++)
			if (v->items[i]->type == OP_STR) ids[n++] = v->items[i]->str;
	*out = ids;
	return n;
}

static const op_value *slot_value(const fg *g, const char *holder, const char *slot) {
	nd_entry *k = entry_at(g, "children", holder);
	return k && k->value && k->value->type == OP_MAP ? op_get(k->value, slot) : NULL;
}

size_t fg_ids(const fg *g, const char *holder, const char *slot, const char ***out) {
	return ids_of(slot_value(g, holder, slot), out);
}

size_t fg_slots(const fg *g, const char *id, const char ***out) {
	nd_entry *k = entry_at(g, "children", id);
	size_t n = k && k->value && k->value->type == OP_MAP ? k->value->count : 0;
	const char **names = alloc((n + 1) * sizeof *names);
	for (size_t i = 0; i < n; i++) names[i] = k->value->keys[i];
	*out = names;
	return n;
}

bool fg_ephemeral(const fg *g, const char *id) {
	for (size_t i = 0; i < g->ephemerals.count; i++)
		if (strcmp(g->ephemerals.items[i], id) == 0) return true;
	return false;
}

// writes: each runs with the api's scope open, through a closure -------------------------------------------------------------

// what a write's change refers to, until the entry's next update
typedef struct {
	op_patch *patches;
	size_t n;
	op_key *keys;
	op_value **values;
	char **names;
	pl_made *made;
} Block;
static void block_free(void *p) {
	Block *b = p;
	for (size_t i = 0; i < b->n; i++) op_free(b->values[i]);
	for (size_t i = 0; i < b->n; i++) free(b->names[i]);
	free(b->patches), free(b->keys), free(b->values), free(b->names);
	if (b->made) pl_made_free(b->made);
	free(b);
}

typedef struct {
	fg_api *api;
	const char *err;
	// the closure's inputs
	const char *a, *b, *c, *d;
	long i, j, k;
	op_value *value;
	bool flag;
	const op_patch *patches;
	size_t n;
	char **out;
} Call;

static fg *gof(Call *c) {
	return c->api->g;
}

static int header_now(fg *g, ch_header *h, pl_made **made) {
	char *bad = pl_header(g->places, NULL, 0, NULL, h, made);
	if (!bad) return 0;
	snprintf(g->error, sizeof g->error, "%s", bad);
	free(bad);
	return -1;
}

// a children or value entry patched, said written; made if it was not there. patches/values/names are the caller's, copied
static const char *patch_entry(fg *g, const char *part, const char *id, const op_patch *patches, size_t n) {
	ch_header h;
	pl_made *made;
	if (header_now(g, &h, &made)) return g->error;
	Block *b = alloc(sizeof *b);
	b->n = n;
	b->patches = alloc(n * sizeof *b->patches);
	size_t total = 1;
	for (size_t i = 0; i < n; i++) total += patches[i].place.length;
	b->keys = alloc(total * sizeof *b->keys);
	b->values = alloc((n + 1) * sizeof *b->values);
	b->names = alloc((n + 1) * sizeof *b->names);
	size_t used = 0;
	for (size_t i = 0; i < n; i++) {
		b->patches[i] = patches[i];
		// the path's keys copied: a string key's text too
		const op_target *t = &patches[i].place;
		op_key *path = &b->keys[used];
		for (size_t k = 0; k < t->length; k++) {
			path[k] = t->path[k];
			if (path[k].type == OP_STR_KEY && k == 0) {
				b->names[i] = copy(path[k].s);
				path[k].s = b->names[i];
			}
		}
		used += t->length;
		b->patches[i].place.path = path;
		if (patches[i].has_value && patches[i].value) b->values[i] = op_ref((op_value *)patches[i].value), b->patches[i].value = b->values[i];
	}
	b->made = pl_made_ref(made);
	pl_made_free(made);
	nd_entry *e = entry_at(g, part, id);
	size_t failed = 0;
	int code;
	if (!e) {
		e = nd_make_entry(NULL, &h);
		code = nd_update(e, b->patches, n, h, &failed);
		if (code != OP_OK) {
			nd_free_entry(e);
			block_free(b);
			return fail(g, "%s", op_code_name(code), NULL);
		}
		keep(&g->made, e);
		pl_hold(g->places, e, b, block_free);
		tb_add(g->table, tb_string(part), tb_string(id), e);
		return NULL;
	}
	code = nd_update(e, b->patches, n, h, &failed);
	if (code != OP_OK) {
		block_free(b);
		return fail(g, "%s", op_code_name(code), NULL);
	}
	pl_hold(g->places, e, b, block_free);
	pl_changed changed = {1, {e}};
	pl_commit(g->places, &changed);
	if (g->o.wrote) g->o.wrote(g->o.context, &e, 1);
	return NULL;
}

// a slot set to ids, the holder's children entry made if it was not there
static const char *set_slot(fg *g, const char *holder, const char *slot, const char *const *ids, size_t n) {
	if (!entry_at(g, "children", holder)) {
		op_value *empty = op_map();
		op_patch made = {.has_value = 1, .value = empty};
		const char *e = patch_entry(g, "children", holder, &made, 1);
		op_free(empty);
		if (e) return e;
	}
	op_key key = {.type = OP_STR_KEY, .s = slot};
	// a slot emptied is gone
	if (n == 0) {
		if (!slot_value(g, holder, slot)) return NULL;
		op_patch p = {.place = {.path = &key, .length = 1}};
		return patch_entry(g, "children", holder, &p, 1);
	}
	op_value *v;
	if (n == 1) v = op_str(ids[0]);
	else {
		v = op_list();
		for (size_t i = 0; i < n; i++) op_push(v, op_str(ids[i]));
	}
	op_patch p = {.place = {.path = &key, .length = 1}, .has_value = 1, .value = v};
	const char *e = patch_entry(g, "children", holder, &p, 1);
	op_free(v);
	return e;
}

static const char *ask(fg *g, const char *op, const char *holder, const char *slot) {
	op_value *field;
	gd_target t = gd_slot((gd_thing){.id = tb_string(holder)}, slot, &field);
	gd_refusal why = {0};
	gd_answer a = gd_write(g->guard, op, &t, 1, &why);
	op_free(field);
	if (a == GD_REFUSED) return fail(g, "%s refused: %s", why.op ? why.op : op, why.reason ? why.reason : "");
	if (a != GD_OK) return fail(g, "%s not answered", op, NULL);
	return NULL;
}

static void do_create(void *data) {
	Call *c = data;
	fg *g = gof(c);
	ch_header h;
	pl_made *made;
	if (header_now(g, &h, &made)) {
		c->err = g->error;
		return;
	}
	char *id = mint(g, c->flag);
	// ephemeral before its entries land, so whoever their events tell can ask
	if (c->flag) keep(&g->ephemerals, copy(id));
	// the entries' change refers to the header's block: one hold each
	if (c->value) {
		nd_entry *e = nd_make_entry(c->value, &h);
		keep(&g->made, e);
		pl_hold(g->places, e, pl_made_ref(made), pl_made_free);
		tb_add(g->table, tb_string("value"), tb_string(id), e);
	}
	op_value *none = op_map();
	nd_entry *k = nd_make_entry(none, &h);
	op_free(none);
	keep(&g->made, k);
	pl_hold(g->places, k, pl_made_ref(made), pl_made_free);
	tb_add(g->table, tb_string("children"), tb_string(id), k);
	pl_made_free(made);
	*c->out = id;
}

static void do_insert(void *data) {
	Call *c = data;
	fg *g = gof(c);
	if ((c->err = ask(g, "place", c->a, c->b))) return;
	const char **ids;
	size_t n = fg_ids(g, c->a, c->b, &ids);
	const char **out = alloc((n + 2) * sizeof *out);
	size_t at = c->i < 0 ? n : (size_t)c->i > n ? n : (size_t)c->i;
	size_t to = c->j < 0 ? at : (size_t)c->j > n ? n : (size_t)c->j;
	if (to < at) to = at;
	size_t m = 0;
	for (size_t i = 0; i < at; i++) out[m++] = ids[i];
	out[m++] = c->c;
	for (size_t i = to; i < n; i++) out[m++] = ids[i];
	c->err = set_slot(g, c->a, c->b, out, m);
	free(ids), free(out);
}

static void do_remove(void *data) {
	Call *c = data;
	fg *g = gof(c);
	if ((c->err = ask(g, "unplace", c->a, c->b))) return;
	const char **ids;
	size_t n = fg_ids(g, c->a, c->b, &ids);
	const char **out = alloc((n + 1) * sizeof *out);
	size_t from = (size_t)c->i > n ? n : (size_t)c->i, to = (size_t)c->j > n ? n : (size_t)c->j, m = 0;
	for (size_t i = 0; i < n; i++)
		if (i < from || i >= to) out[m++] = ids[i];
	c->err = set_slot(g, c->a, c->b, out, m);
	free(ids), free(out);
}

static void do_move(void *data) {
	Call *c = data;
	fg *g = gof(c);
	if ((c->err = ask(g, "place", c->c, c->d))) return;
	const char **ids;
	size_t n = fg_ids(g, c->a, c->b, &ids);
	if (c->i < 0 || (size_t)c->i >= n) {
		free(ids);
		c->err = fail(g, "the slot \"%s\" has no member %s", c->b, "there");
		return;
	}
	const char *id = ids[c->i];
	const char **rest = alloc((n + 1) * sizeof *rest);
	size_t m = 0;
	for (size_t i = 0; i < n; i++)
		if ((long)i != c->i) rest[m++] = ids[i];
	if (strcmp(c->a, c->c) == 0 && strcmp(c->b, c->d) == 0) {
		size_t at = c->j < 0 || (size_t)c->j > m ? m : (size_t)c->j;
		const char **out = alloc((m + 2) * sizeof *out);
		size_t o = 0;
		for (size_t i = 0; i < at; i++) out[o++] = rest[i];
		out[o++] = id;
		for (size_t i = at; i < m; i++) out[o++] = rest[i];
		c->err = set_slot(g, c->a, c->b, out, o);
		free(out), free(rest), free(ids);
		return;
	}
	// the id is borrowed from the slot's value, which the write replaces
	char *held = copy(id);
	c->err = set_slot(g, c->a, c->b, rest, m);
	free(rest), free(ids);
	if (!c->err) {
		const char **there;
		size_t t = fg_ids(g, c->c, c->d, &there);
		size_t at = c->j < 0 || (size_t)c->j > t ? t : (size_t)c->j;
		const char **out = alloc((t + 2) * sizeof *out);
		size_t o = 0;
		for (size_t i = 0; i < at; i++) out[o++] = there[i];
		out[o++] = held;
		for (size_t i = at; i < t; i++) out[o++] = there[i];
		c->err = set_slot(g, c->c, c->d, out, o);
		free(out), free((void *)there);
	}
	free(held);
}

static void do_write(void *data) {
	Call *c = data;
	fg *g = gof(c);
	if (c->k != 0) {
		c->err = fail(g, "the node has no such version", NULL, NULL);
		return;
	}
	if (!fg_loaded(g, c->a)) {
		c->err = fail(g, "the node is not loaded", NULL, NULL);
		return;
	}
	gd_target t = gd_target_of((gd_thing){.id = tb_string(c->a)}, "value", NULL);
	gd_refusal why = {0};
	gd_answer a = gd_write(g->guard, "write", &t, 1, &why);
	if (a == GD_REFUSED) {
		c->err = fail(g, "%s refused: %s", "write", why.reason);
		return;
	}
	c->err = patch_entry(g, "value", c->a, c->patches, c->n);
}

static const char *within(fg_api *api, void (*f)(void *), Call *c) {
	c->api = api;
	const char *e = sc_run_with_scope(api->scope, f, c);
	if (e) return fail(api->g, "%s", e, NULL);
	return c->err;
}

const char *fg_create(fg_api *api, op_value *value, bool ephemeral, char **id) {
	Call c = {.value = value, .flag = ephemeral, .out = id};
	return within(api, do_create, &c);
}

const char *fg_insert(fg_api *api, const char *holder, const char *slot, const char *id, long at, long to) {
	Call c = {.a = holder, .b = slot, .c = id, .i = at, .j = to};
	return within(api, do_insert, &c);
}

const char *fg_remove(fg_api *api, const char *holder, const char *slot, long from, long to) {
	Call c = {.a = holder, .b = slot, .i = from, .j = to};
	return within(api, do_remove, &c);
}

const char *fg_move(fg_api *api, const char *holder, const char *slot, long at, const char *into, const char *name, long to) {
	Call c = {.a = holder, .b = slot, .c = into, .d = name, .i = at, .j = to};
	return within(api, do_move, &c);
}

const char *fg_write(fg_api *api, const char *id, const op_patch *patches, size_t n, size_t version) {
	Call c = {.a = id, .patches = patches, .n = n, .k = (long)version};
	return within(api, do_write, &c);
}

// the store's side -----------------------------------------------------------------------------------------------------

// a change as the store saves it: time, actor, reader, metadata
static Json *change_json(const ch_header *h) {
	Json *j = jsonObject();
	jsonAdd(j, "time", jsonInteger(h->has_time ? h->time : 0));
	if (h->actor) jsonAdd(j, "actor", fg_json_of(h->actor));
	if (h->reader) jsonAdd(j, "reader", jsonString(h->reader));
	if (h->metadata_length) {
		Json *m = jsonObject();
		for (size_t i = 0; i < h->metadata_length; i++)
			jsonAdd(m, h->metadata[i].key, fg_json_of(h->metadata[i].value));
		jsonAdd(j, "metadata", m);
	}
	return j;
}

static sd_version version_of(fg *g, Json *content, const ch_header *h) {
	keep(&g->jsons, content);
	Json *change = change_json(h);
	keep(&g->jsons, change);
	return (sd_version){content, change, NULL};
}

const sd_node *fg_get(fg *g, const char *id) {
	nd_entry *value = entry_at(g, "value", id), *attributes = entry_at(g, "attributes", id), *children = entry_at(g, "children", id);
	if (!value && !attributes && !children) return NULL;
	sd_contents c = {0};
	sd_version *vs = alloc(sizeof *vs);
	keep(&g->arrays, vs);
	if (value && value->value) {
		vs[0] = version_of(g, fg_json_of(value->value), &value->change);
		c.value = (sd_object){vs, 1};
	}
	if (attributes && attributes->value && attributes->value->type == OP_MAP) {
		size_t n = attributes->value->count;
		sd_entry *es = alloc((n + 1) * sizeof *es);
		sd_version *ivs = alloc((n + 1) * sizeof *ivs);
		keep(&g->arrays, es), keep(&g->arrays, ivs);
		for (size_t i = 0; i < n; i++) {
			ivs[i] = version_of(g, fg_json_of(attributes->value->items[i]), &attributes->change);
			es[i] = (sd_entry){attributes->value->keys[i], {&ivs[i], 1}};
		}
		c.info = es, c.info_length = n;
	}
	if (children && children->value && children->value->type == OP_MAP) {
		size_t n = children->value->count;
		sd_entry *es = alloc((n + 1) * sizeof *es);
		sd_version *cvs = alloc((n + 1) * sizeof *cvs);
		keep(&g->arrays, es), keep(&g->arrays, cvs);
		for (size_t i = 0; i < n; i++) {
			const char **ids;
			size_t m = ids_of(children->value->items[i], &ids);
			sd_item *items = alloc((m + 1) * sizeof *items);
			sd_list *list = alloc(sizeof *list);
			keep(&g->arrays, items), keep(&g->arrays, list);
			for (size_t k = 0; k < m; k++) items[k] = (sd_item){ids[k], NULL};
			free((void *)ids);
			*list = (sd_list){items, m};
			Json *change = change_json(&children->change);
			keep(&g->jsons, change);
			cvs[i] = (sd_version){list, change, NULL};
			es[i] = (sd_entry){children->value->keys[i], {&cvs[i], 1}};
		}
		c.children = es, c.children_length = n;
	}
	sd_header h = {0};
	const ch_header *first = value ? &value->change : children ? &children->change : &attributes->change;
	h.has_time = 1, h.time = first->has_time ? first->time : 0;
	sd_node *node = sd_make(id, &c, &h, NULL);
	keep(&g->nodes, node);
	return node;
}

void fg_release(fg *g) {
	for (size_t i = 0; i < g->nodes.count; i++) sd_free(g->nodes.items[i]);
	g->nodes.count = 0;
	for (size_t i = 0; i < g->jsons.count; i++) jsonFree(g->jsons.items[i]);
	g->jsons.count = 0;
	for (size_t i = 0; i < g->arrays.count; i++) free(g->arrays.items[i]);
	g->arrays.count = 0;
}

// a change read back from its record: a header whose pieces the graph holds
static const ch_header *header_in(fg *g, const Json *change, int64_t time) {
	Pieces *p = alloc(sizeof *p);
	keep(&g->pieces, p);
	ch_header *h = &p->h;
	h->has_time = 1;
	h->time = time;
	bool object = change && change->type == JSON_OBJECT;
	const Json *t = object ? jsonGet(change, "time") : NULL;
	if (t && t->type == JSON_NUMBER) h->time = (int64_t)t->number;
	const Json *actor = object ? jsonGet(change, "actor") : NULL;
	if (actor) h->actor = p->actor = fg_value_of(actor);
	const Json *reader = object ? jsonGet(change, "reader") : NULL;
	if (reader && reader->type == JSON_STRING) h->reader = p->reader = copy(reader->string);
	const Json *meta = object ? jsonGet(change, "metadata") : NULL;
	// an object; old data a list of pairs: a key once, its first
	if (meta && meta->type == JSON_OBJECT && meta->object.count) {
		p->meta = alloc((size_t)meta->object.count * sizeof *p->meta);
		for (int i = 0; i < meta->object.count; i++) {
			const JsonMember *k = &meta->object.members[i];
			p->meta[p->metas++] = (ch_entry){copy(k->key), fg_value_of(k->value)};
		}
		h->metadata = p->meta, h->metadata_length = p->metas;
	} else if (meta && meta->type == JSON_ARRAY && meta->array.count) {
		p->meta = alloc((size_t)meta->array.count * sizeof *p->meta);
		for (int i = 0; i < meta->array.count; i++) {
			const Json *pair = meta->array.items[i];
			if (pair->type != JSON_ARRAY || pair->array.count != 2 || pair->array.items[0]->type != JSON_STRING) continue;
			bool seen = false;
			for (size_t j = 0; j < p->metas && !seen; j++) seen = strcmp(p->meta[j].key, pair->array.items[0]->string) == 0;
			if (!seen) p->meta[p->metas++] = (ch_entry){copy(pair->array.items[0]->string), fg_value_of(pair->array.items[1])};
		}
		h->metadata = p->meta, h->metadata_length = p->metas;
	}
	return h;
}

typedef struct {
	fg *g;
	const sd_node *node;
	const char *err;
} Intro;

static void do_intro(void *data) {
	Intro *in = data;
	fg *g = in->g;
	const sd_node *n = in->node;
	int64_t time = n->header.has_time ? n->header.time : 0;
	if (n->value.length && n->value.versions[0].content) {
		const sd_version *v = &n->value.versions[0];
		const ch_header *h = header_in(g, v->change, time);
		op_value *content = fg_value_of(v->content);
		nd_entry *e = nd_make_entry(content, h);
		op_free(content);
		keep(&g->made, e);
		tb_sub(g->table, tb_string("value"), tb_string(n->id), e);
	}
	op_value *info = op_map();
	const Json *ichange = NULL;
	for (size_t i = 0; i < n->info_length; i++) {
		const sd_object *o = &n->info[i].object;
		if (!o->length) continue;
		op_set(info, n->info[i].name, fg_value_of(o->versions[0].content));
		if (!ichange) ichange = o->versions[0].change;
	}
	if (info->count) {
		nd_entry *e = nd_make_entry(info, header_in(g, ichange, time));
		keep(&g->made, e);
		tb_sub(g->table, tb_string("attributes"), tb_string(n->id), e);
	}
	op_free(info);
	op_value *slots = op_map();
	const Json *schange = NULL;
	for (size_t i = 0; i < n->children_length; i++) {
		const sd_object *o = &n->children[i].object;
		const sd_list *l = o->length ? o->versions[0].content : NULL;
		size_t m = 0;
		for (size_t k = 0; l && k < l->length; k++) m += l->items[k].id != NULL;
		if (m == 0) continue;
		op_value *v = NULL;
		if (m == 1) {
			for (size_t k = 0; k < l->length; k++)
				if (l->items[k].id) v = op_str(l->items[k].id);
		} else {
			v = op_list();
			for (size_t k = 0; l && k < l->length; k++)
				if (l->items[k].id) op_push(v, op_str(l->items[k].id));
		}
		op_set(slots, n->children[i].name, v);
		if (!schange && o->length) schange = o->versions[0].change;
	}
	nd_entry *k = nd_make_entry(slots, header_in(g, schange, time));
	op_free(slots);
	keep(&g->made, k);
	tb_sub(g->table, tb_string("children"), tb_string(n->id), k);
}

const char *fg_intro(fg *g, const sd_node *node) {
	Intro in = {g, node, NULL};
	const char *e = sc_run_with_scope(g->host, do_intro, &in);
	return e ? fail(g, "%s", e, NULL) : in.err;
}
