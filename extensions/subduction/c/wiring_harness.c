// The C wiring on the line protocol (newcore/conformance/wiring/harness.ts has it): one JSON request per
// line in, one answer per line out, in order. Several named devices in one process, each a scheduler
// (scheduler/c/scheduler.h) wired to a transport device (transport.h), linked by in-memory pipes as
// transport_harness.c links them. Values in their JSON form; keys, seeds and made bytes as lowercase hex.
//   {op: "reset"}, {op: "device", name, seed, root, actor}, {op: "follow", device, doc},
//   {op: "link", a, b}, {op: "unlink", a, b}, {op: "pump"},
//   host operations: write set insert remove pop rename move create (device, ...), {op: "ops", device, ops},
//   {op: "read", device, id, object?, only?}, {op: "records", device, node?, only?},
//   {op: "versions", device, id, object, list}, {op: "watch", device, address}, {op: "marked", device},
//   {op: "stored", device, doc}
// The values a request builds are not freed (they are handed on to the graph), so this leaks them.
#define _POSIX_C_SOURCE 200809L
#include "wiring.h"

#include "id.h"

#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../core/scheduler/c/scheduler.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif
#elif defined(__SANITIZE_ADDRESS__)
const char *__asan_default_options(void) { return "detect_leaks=0"; }
#endif

static void hex(const uint8_t *b, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", b[i]);
}

static uint8_t *unhex(const char *s, size_t *n) {
	*n = strlen(s) / 2;
	uint8_t *bytes = malloc(*n ? *n : 1);
	if (bytes == NULL) abort();
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) fputs("bad hex\n", stderr), exit(1);
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static void print(const Json *j) {
	char *s = jsonPrint(j);
	puts(s);
	free(s);
}

static void print_error(const char *why) {
	Json *j = jsonObject();
	jsonAdd(j, "error", jsonString(why));
	print(j);
}

// -- values: json.h's to notify's and protect's, and back

static nt_value *nt_of(const Json *j) {
	nt_value *v;
	switch (j->type) {
	case JSON_BOOLEAN: return nt_bool(j->boolean);
	case JSON_NUMBER: return nt_num(j->number);
	case JSON_STRING: return nt_str(j->string);
	case JSON_BYTES: return nt_bytes(j->bytes.data, j->bytes.length);
	case JSON_TYPED: return nt_typed((nt_elements)j->typed.kind, j->typed.data, j->typed.count);
	case JSON_STAND: return nt_stand(nt_of(j->stand.kind));
	case JSON_ARRAY:
		v = nt_list();
		for (int i = 0; i < j->array.count; i++) nt_push(v, nt_of(j->array.items[i]));
		return v;
	case JSON_OBJECT:
		v = nt_map();
		for (int i = 0; i < j->object.count; i++) nt_set(v, j->object.members[i].key, nt_of(j->object.members[i].value));
		return v;
	default: return nt_null();
	}
}

static Json *json_of_nt(const nt_value *v) {
	Json *j;
	switch (v->type) {
	case NT_NULL: return jsonNull();
	case NT_BOOL: return jsonBoolean(v->bool_);
	case NT_NUM: return jsonNumber(v->num);
	case NT_STR: return jsonStringOfLength(v->str, v->bytes);
	case NT_BYTES: return jsonBytes(v->data, v->bytes);
	case NT_TYPED: return jsonTyped((JsonKind)v->kind, v->data, nt_length(v));
	case NT_STAND: return jsonStand(json_of_nt(v->items[0]));
	case NT_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, json_of_nt(v->items[i]));
		return j;
	default:
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], json_of_nt(v->items[i]));
		return j;
	}
}

static const char *kept(pr_arena *a, const char *s, size_t n) {
	char *c = pr_alloc(a, n + 1);
	memcpy(c, s, n);
	c[n] = 0;
	return c;
}

static pr_value pr_of(pr_arena *a, const Json *j) {
	pr_value v;
	switch (j->type) {
	case JSON_BOOLEAN: return pr_bool(j->boolean);
	case JSON_NUMBER: return pr_num(j->number);
	case JSON_STRING: return pr_str(a, j->string, j->stringLength);
	case JSON_ARRAY:
		v = pr_list();
		for (int i = 0; i < j->array.count; i++) pr_push(a, &v, pr_of(a, j->array.items[i]));
		return v;
	case JSON_OBJECT:
		v = pr_map();
		for (int i = 0; i < j->object.count; i++)
			pr_put(a, &v, kept(a, j->object.members[i].key, j->object.members[i].keyLength), pr_of(a, j->object.members[i].value));
		return v;
	default: return pr_null();
	}
}

static const pr_value *pr_ptr(pr_arena *a, const Json *j) {
	if (j == NULL) return NULL;
	pr_value *v = pr_alloc(a, sizeof *v);
	*v = pr_of(a, j);
	return v;
}

static Json *json_of_pr(const pr_value *v) {
	Json *j;
	switch (v->kind) {
	case PR_BOOL: return jsonBoolean(v->yes != 0);
	case PR_NUM: return jsonNumber(v->num);
	case PR_STR: return jsonStringOfLength(v->str, v->n);
	case PR_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->n; i++) jsonPush(j, json_of_pr(&v->items[i]));
		return j;
	case PR_MAP:
		j = jsonObject();
		for (size_t i = 0; i < v->n; i++) jsonAdd(j, v->keys[i], json_of_pr(&v->items[i]));
		return j;
	default: return jsonNull();
	}
}

// -- patches: a place, and a patch, from json.h's and to it

static bool whole(const Json *x, long *out) {
	int64_t n;
	if (x == NULL || !jsonIsWhole(x, &n)) return false;
	*out = (long)n;
	return true;
}

static void place_of(const Json *m, nt_place *p) {
	memset(p, 0, sizeof *p);
	const Json *path = jsonGet(m, "path");
	nt_key *ks = calloc((size_t)(path ? path->array.count : 0) + 1, sizeof *ks);
	for (int i = 0; path && i < path->array.count; i++) {
		const Json *x = path->array.items[i];
		long n;
		if (x->type == JSON_STRING) ks[i] = (nt_key){.type = NT_STR_KEY, .s = x->string};
		else if (whole(x, &n)) ks[i] = (nt_key){.type = NT_NUM_KEY, .n = n};
	}
	p->path = ks;
	p->length = path ? (size_t)path->array.count : 0;
	const Json *r = jsonGet(m, "range");
	if (r && r->type == JSON_ARRAY && r->array.count == 2 && whole(r->array.items[0], &p->from) && whole(r->array.items[1], &p->to)) p->has_range = 1;
}

static nt_patch *patches_of(const Json *list, size_t *n) {
	*n = list ? (size_t)list->array.count : 0;
	nt_patch *ps = calloc(*n + 1, sizeof *ps);
	for (size_t i = 0; i < *n; i++) {
		const Json *j = list->array.items[i], *value = jsonGet(j, "value"), *move = jsonGet(j, "move");
		place_of(j, &ps[i].place);
		if (value) ps[i].has_value = 1, ps[i].value = nt_of(value);
		if (move) ps[i].has_move = 1, place_of(move, &ps[i].move);
	}
	return ps;
}

static Json *place_json(const nt_place *p) {
	Json *j = jsonObject(), *path = jsonArray();
	for (size_t i = 0; i < p->length; i++) {
		const nt_key *k = &p->path[i];
		if (k->type == NT_STR_KEY) jsonPush(path, jsonString(k->s));
		else jsonPush(path, jsonInteger(k->n));
	}
	jsonAdd(j, "path", path);
	if (p->has_range) {
		Json *r = jsonArray();
		jsonPush(r, jsonInteger(p->from));
		jsonPush(r, jsonInteger(p->to));
		jsonAdd(j, "range", r);
	}
	return j;
}

static Json *patch_json(const nt_patch *p) {
	Json *j = place_json(&p->place);
	if (p->has_value) jsonAdd(j, "value", json_of_nt(p->value));
	if (p->has_move) jsonAdd(j, "move", place_json(&p->move));
	return j;
}

// -- the devices

typedef struct device {
	char *name;
	uint8_t seed[32], key[32];
	transport *t;
	sc_sched *s;
	wiring *w;
	uint8_t (*made)[32]; // what the lock's make gives, for the next creates
	size_t made_count, made_next, made_room;
	size_t calls, procs, watches;
	Json *records, *marks;
} device;

typedef struct {
	device *a, *b;
	uint64_t ca, cb;
	bool live;
} wire;

static device **devices;
static size_t device_count;
static wire *links;
static size_t link_count;
static size_t moved;

static device *named(const char *name) {
	for (size_t i = 0; name && i < device_count; i++)
		if (strcmp(devices[i]->name, name) == 0) return devices[i];
	return NULL;
}

static void reset(void) {
	for (size_t i = 0; i < device_count; i++) {
		device *d = devices[i];
		sc_free(d->s);
		wiring_free(d->w);
		transport_free(d->t);
		free(d->name);
		free(d->made);
		free(d);
	}
	free(devices);
	free(links);
	devices = NULL, links = NULL, device_count = link_count = 0;
}

// runs a device, handing what it sends to the other end of its link
static int64_t run(device *d) {
	int64_t wait = transport_run(d->t);
	transport_out out;
	while (transport_next(d->t, &out)) {
		if (out.kind == TRANSPORT_SEND) {
			for (size_t i = 0; i < link_count; i++) {
				wire *l = &links[i];
				if (!l->live) continue;
				if (l->a == d && l->ca == out.conn) transport_received(l->b->t, l->cb, out.bytes, out.length);
				else if (l->b == d && l->cb == out.conn) transport_received(l->a->t, l->ca, out.bytes, out.length);
				else continue;
				moved++;
				break;
			}
		}
		transport_out_free(&out);
	}
	return wait;
}

static void nap(void) {
	nanosleep(&(struct timespec){0, 1000000}, NULL);
}

// everything runs until quiet: no message crossing, no sealing, taking in or committing left
static const char *pump(void) {
	size_t quiet = 0, last = (size_t)-1;
	for (int round = 0; round < 2000; round++) {
		bool waiting = true;
		for (size_t i = 0; i < device_count; i++) {
			device *d = devices[i];
			if (wiring_idle(d->w)) moved++;
			if (run(d) == 0) waiting = false;
			const char *why = wiring_trouble(d->w);
			if (why) return why;
		}
		if (moved == last && waiting) {
			if (++quiet >= 5) return NULL;
		} else quiet = 0, last = moved;
		nap();
	}
	return "never quiet";
}

// -- what a device's scheduler is wired with

static size_t sign(void *context, const uint8_t *message, size_t length, uint8_t signature[64]) {
	ermEd25519Sign(context, message, length, signature);
	return 64;
}

// the k-th call gives n bytes, the first four k big-endian, the rest zero
static void random_of(void *context, size_t n, uint8_t *out) {
	device *d = context;
	memset(out, 0, n);
	uint32_t k = (uint32_t)++d->calls;
	for (size_t i = 0; i < 4 && i < n; i++) out[i] = (uint8_t)(k >> (24 - 8 * i));
}

// the id of a node made: the lock "unlocked" and the bytes the next create was given, else random ones
static const char *id_of(void *context, int64_t time) {
	(void)time;
	device *d = context;
	uint8_t made[32];
	if (d->made_next < d->made_count) memcpy(made, d->made[d->made_next++], 32);
	else {
		FILE *f = fopen("/dev/urandom", "rb");
		if (f == NULL || fread(made, 1, 32, f) != 32) abort();
		fclose(f);
	}
	char id[ID_LENGTH + 1];
	id_make("unlocked", made, 32, id);
	return sc_dup(d->s, id);
}

// a header's fields as answered: never time; the actor an agent that is only an actor is
static Json *header_json(const gr_change *h, bool node) {
	Json *j = jsonObject();
	if (node && h->node) jsonAdd(j, "node", jsonString(h->node));
	if (h->actor) jsonAdd(j, "actor", json_of_pr(sc_actor(h->actor)));
	if (h->reader) jsonAdd(j, "reader", jsonString(h->reader));
	if (h->site) jsonAdd(j, "site", json_of_pr(h->site));
	if (h->cause) jsonAdd(j, "cause", json_of_pr(h->cause));
	return j;
}

static Json *record_json(const gr_record *r) {
	Json *j = jsonObject(), *at;
	jsonAdd(j, "node", jsonString(r->node));
	if (r->where == GR_VALUE) jsonAdd(j, "object", jsonString("value"));
	else {
		Json *o = jsonArray();
		jsonPush(o, jsonString(r->where == GR_INFO ? "info" : "children"));
		jsonPush(o, jsonString(r->name));
		jsonAdd(j, "object", o);
	}
	Json *ps = jsonArray();
	for (size_t i = 0; i < r->npatches; i++) jsonPush(ps, patch_json(&r->patches[i]));
	jsonAdd(j, "patches", ps);
	jsonAdd(j, "header", header_json(r->header, false));
	if (r->at == GR_AT_VERSION) at = jsonInteger(r->from);
	else {
		at = jsonArray();
		jsonPush(at, jsonInteger(r->from));
		jsonPush(at, jsonInteger(r->to));
		if (r->at == GR_AT_POP && r->to == r->from + 1) at = jsonInteger(r->from);
		if (r->at == GR_AT_POP) {
			Json *pop = jsonObject();
			jsonAdd(pop, "pop", at);
			at = pop;
		}
	}
	jsonAdd(j, "at", at);
	jsonAdd(j, "ephemeral", jsonBoolean(r->ephemeral != 0));
	return j;
}

static void changed(void *context, const gr_record *r) {
	device *d = context;
	jsonPush(d->records, record_json(r));
	if (d->w) wiring_changed(d->w, r);
}

static void versions(void *context, const char *node, gr_where where, const char *name, const gr_incoming *list,
	size_t count, const gr_from *from) {
	sc_versions(context, node, where, name, list, count, from);
}

// -- host operations

static const char *error_code(const sc_error *e) {
	return e->code ? e->code : e->message ? e->message : "thrown";
}

static Json *answer_error(const char *code) {
	Json *j = jsonObject();
	jsonAdd(j, "error", jsonString(code));
	return j;
}

// a span, or a number: a number n is [n, n + 1), a gap [n, n] when gap
static bool span_of(const Json *j, bool gap, pl_span *out, int *is_span) {
	long a, b;
	*is_span = 0;
	if (j == NULL) return false;
	if (j->type == JSON_ARRAY && j->array.count == 2 && whole(j->array.items[0], &a) && whole(j->array.items[1], &b)) {
		*out = (pl_span){a, b};
		*is_span = 1;
		return true;
	}
	if (!whole(j, &a)) return false;
	*out = (pl_span){a, gap ? a : a + 1};
	return true;
}

static const char **strings_of(const Json *list, size_t *n) {
	*n = list ? (size_t)list->array.count : 0;
	const char **out = calloc(*n + 1, sizeof *out);
	for (size_t i = 0; i < *n; i++) out[i] = list->array.items[i]->string;
	return out;
}

// the setup of a process that makes an ephemeral node
typedef struct {
	sc_fn fn;
	const nt_value *value;
	const char *id, *made;
} makefn;
static const sc_error *make_call(sc_fn *self, sc_given *g, nt_value **out, int *pending) {
	makefn *m = (makefn *)self;
	(void)pending;
	*out = nt_num(0);
	return sc_create(g->api, m->value, m->id, 1, &m->made);
}

// the setup of a process whose value is the one given
typedef struct {
	sc_fn fn;
	const Json *value;
} valuefn;
static const sc_error *value_call(sc_fn *self, sc_given *g, nt_value **out, int *pending) {
	(void)g, (void)pending;
	*out = nt_of(((valuefn *)self)->value);
	return NULL;
}

// the bytes the next create or start is given for its id
static void push_made(device *d, const Json *made) {
	size_t k;
	uint8_t *bytes = unhex(jsonText(made), &k);
	if (d->made_count == d->made_room) {
		d->made_room = d->made_room ? d->made_room * 2 : 8;
		d->made = realloc(d->made, d->made_room * 32);
	}
	memcpy(d->made[d->made_count++], bytes, 32);
	free(bytes);
}

// a compute that reads an address, tracked, and notes the changes that marked it
typedef struct {
	sc_fn fn;
	device *d;
	const char **address;
	size_t n;
} watchfn;
static const sc_error *watch_call(sc_fn *self, sc_given *g, nt_value **out, int *pending) {
	watchfn *w = (watchfn *)self;
	(void)pending;
	for (size_t i = 0; i < g->nby; i++) jsonPush(w->d->marks, header_json(g->marks[i], false));
	sc_items items;
	*out = nt_num(0);
	return sc_content(g->api, w->address, w->n, &items);
}

static Json *host(device *d, const Json *r) {
	sc_api *api = sc_host(d->s);
	const char *op = jsonText(jsonGet(r, "op"));
	const sc_error *e = NULL;
	pl_span index, slot;
	int span = 0, slot_span = 0;
	bool has_slot = span_of(jsonGet(r, "slotindex"), false, &slot, &slot_span);
	bool has_index = span_of(jsonGet(r, "index"), true, &index, &span);
	const char *id = jsonText(jsonGet(r, "id")), *name = jsonText(jsonGet(r, "name"));
	size_t np, n;
	if (!strcmp(op, "write") || !strcmp(op, "set")) {
		const char **address = strings_of(jsonGet(r, "address"), &n);
		nt_patch *ps = patches_of(jsonGet(r, "patches"), &np);
		long item = has_index ? index.from : 0;
		if (!strcmp(op, "write")) e = sc_write(api, address, n, ps, np, has_index ? &item : NULL, has_slot ? &slot : NULL, slot_span, NULL);
		else e = sc_set(api, address, n, jsonText(jsonGet(r, "name")), ps, np, has_index ? &item : NULL, has_slot ? &slot : NULL, slot_span, NULL);
	} else if (!strcmp(op, "insert")) {
		e = sc_insert(api, id, name, jsonText(jsonGet(r, "child")), has_index ? &index : NULL, has_slot ? &slot : NULL, NULL);
	} else if (!strcmp(op, "remove")) {
		pl_span gone;
		int s;
		span_of(jsonGet(r, "index"), false, &gone, &s);
		e = sc_remove(api, id, name, gone, has_slot ? &slot : NULL, NULL);
	} else if (!strcmp(op, "pop")) {
		e = sc_pop(api, id, name, slot, NULL);
	} else if (!strcmp(op, "rename")) {
		int64_t times[2];
		e = sc_rename(api, id, name, jsonText(jsonGet(r, "to")), times);
	} else if (!strcmp(op, "move")) {
		int64_t times[2];
		size_t count;
		long from, to;
		whole(jsonGet(r, "index"), &from);
		bool has_to = whole(jsonGet(r, "toindex"), &to);
		e = sc_move(api, id, name, from, jsonText(jsonGet(r, "toid")), jsonText(jsonGet(r, "toname")), has_to ? &to : NULL, times, &count);
	} else if (!strcmp(op, "create")) {
		const Json *made = jsonGet(r, "made"), *value = jsonGet(r, "value"), *eph = jsonGet(r, "ephemeral");
		if (made) push_made(d, made);
		const nt_value *v = value ? nt_of(value) : NULL;
		const char *out = NULL, *given = jsonText(jsonGet(r, "id"));
		if (!(eph && eph->boolean)) e = sc_create(api, v, given, 0, &out);
		else {
			// only a process makes an ephemeral node: one started at the root, whose setup creates it
			makefn *m = calloc(1, sizeof *m);
			m->fn.call = make_call;
			m->value = v, m->id = given;
			char pid[32];
			snprintf(pid, sizeof pid, "proc-%zu", ++d->procs);
			sc_startop so = {0};
			so.code.setup = &m->fn;
			so.address = calloc(1, sizeof *so.address);
			so.id = sc_dup(d->s, pid);
			e = sc_start(d->s, &so, NULL);
			out = m->made;
		}
		if (e) return answer_error(error_code(e));
		Json *j = jsonObject();
		jsonAdd(j, "id", jsonString(out ? out : ""));
		return j;
	} else if (!strcmp(op, "start")) {
		// a process at the root, named proc-k, whose setup gives value: its node is ephemeral
		const Json *made = jsonGet(r, "made");
		if (made && made->type == JSON_ARRAY) {
			for (int i = 0; i < made->array.count; i++) push_made(d, made->array.items[i]);
		} else if (made) push_made(d, made);
		valuefn *m = calloc(1, sizeof *m);
		m->fn.call = value_call;
		m->value = jsonGet(r, "value");
		char pname[32];
		snprintf(pname, sizeof pname, "proc-%zu", ++d->procs);
		sc_startop so = {0};
		so.code.setup = &m->fn;
		so.address = calloc(1, sizeof *so.address);
		so.name = sc_dup(d->s, pname);
		const char *out = NULL;
		e = sc_start(d->s, &so, &out);
		if (e) return answer_error(error_code(e));
		Json *j = jsonObject();
		jsonAdd(j, "id", jsonString(out ? out : ""));
		return j;
	} else return answer_error("unknown op");
	return e ? answer_error(error_code(e)) : jsonObject();
}

static const char *HOST[] = {"write", "set", "insert", "remove", "pop", "rename", "move", "create", "start", NULL};

// each version of an object, the fields of each version only: the others left out
static Json *only_of(Json *x, const Json *fields) {
	if (fields == NULL || fields->type != JSON_ARRAY) return x;
	Json *out = jsonObject();
	for (int i = 0; i < fields->array.count; i++) {
		const char *f = jsonText(fields->array.items[i]);
		Json *v = f ? jsonGet(x, f) : NULL;
		if (v) jsonAdd(out, f, v);
	}
	return out;
}

static Json *read_op(device *d, const Json *r) {
	nd_node *n = sc_get(d->s, jsonText(jsonGet(r, "id")));
	if (n == NULL) return jsonNull();
	const Json *object = jsonGet(r, "object");
	nd_object o = n->value;
	bool children = false;
	if (object && object->type == JSON_ARRAY) {
		children = strcmp(object->array.items[0]->string, "children") == 0;
		const nd_entry *es = children ? n->children : n->info;
		size_t cnt = children ? n->children_length : n->info_length;
		o = (nd_object){0};
		for (size_t i = 0; i < cnt; i++)
			if (!strcmp(es[i].name, object->array.items[1]->string)) o = es[i].object;
	}
	Json *out = jsonArray();
	for (size_t i = 0; i < o.length; i++) {
		const nd_version *v = &o.versions[i];
		Json *j = jsonObject(), *content;
		// no content (a removal among other heads): left out
		if (!v->content) content = NULL;
		else if (children) {
			const nd_list *l = v->content;
			content = jsonArray();
			for (size_t k = 0; l && k < l->length; k++) jsonPush(content, l->items[k].id ? jsonString(l->items[k].id) : jsonNull());
		} else content = json_of_nt(v->content);
		if (content) jsonAdd(j, "content", content);
		jsonAdd(j, "change", header_json(v->change, true));
		if (v->because) {
			const gr_synced *b = v->because;
			Json *because = jsonObject(), *place = jsonObject(), *why = jsonObject();
			jsonAdd(because, "layer", jsonString(b->layer));
			jsonAdd(place, "lamport", jsonInteger(b->lamport));
			jsonAdd(place, "name", jsonString(b->name));
			jsonAdd(because, "place", place);
			if (b->signer) jsonAdd(why, "signer", jsonString(b->signer));
			jsonAdd(because, "why", why);
			jsonAdd(j, "because", because);
		}
		jsonPush(out, only_of(j, jsonGet(r, "only")));
	}
	return out;
}

static Json *records_op(device *d, const Json *r) {
	const char *node = jsonText(jsonGet(r, "node"));
	Json *out = jsonArray();
	for (int i = 0; i < d->records->array.count; i++) {
		Json *x = d->records->array.items[i];
		if (node == NULL || strcmp(jsonText(jsonGet(x, "node")), node) == 0) jsonPush(out, only_of(x, jsonGet(r, "only")));
	}
	d->records = jsonArray();
	return out;
}

// versions called directly: list as given, [{content, change, because?}], change with its time
static Json *versions_op(device *d, const Json *r) {
	pr_arena *a = sc_pr_arena(d->s);
	const Json *object = jsonGet(r, "object"), *list = jsonGet(r, "list");
	gr_where where = GR_VALUE;
	const char *name = NULL;
	if (object->type == JSON_ARRAY) {
		where = strcmp(object->array.items[0]->string, "info") == 0 ? GR_INFO : GR_CHILDREN;
		name = object->array.items[1]->string;
	}
	size_t n = (size_t)list->array.count;
	gr_incoming *in = calloc(n + 1, sizeof *in);
	gr_change *changes = calloc(n + 1, sizeof *changes);
	gr_synced *becauses = calloc(n + 1, sizeof *becauses);
	for (size_t i = 0; i < n; i++) {
		const Json *v = list->array.items[i], *c = jsonGet(v, "change"), *b = jsonGet(v, "because");
		int64_t time = 0;
		if (jsonGet(c, "time")) jsonIsWhole(jsonGet(c, "time"), &time);
		changes[i] = (gr_change){time, pr_ptr(a, jsonGet(c, "actor")), jsonText(jsonGet(c, "reader")), pr_ptr(a, jsonGet(c, "cause")),
			pr_ptr(a, jsonGet(c, "site")), jsonText(jsonGet(c, "node")), GR_NOWHERE, NULL};
		in[i].content = jsonGet(v, "content") ? nt_of(jsonGet(v, "content")) : NULL;
		in[i].change = &changes[i];
		if (b) {
			int64_t lamport = 0;
			jsonIsWhole(jsonGet(jsonGet(b, "place"), "lamport"), &lamport);
			becauses[i] = (gr_synced){jsonText(jsonGet(b, "layer")), lamport, jsonText(jsonGet(jsonGet(b, "place"), "name")),
				jsonText(jsonGet(jsonGet(b, "why"), "signer"))};
			in[i].because = &becauses[i];
		}
	}
	sc_versions(d->s, jsonText(jsonGet(r, "id")), where, name, in, n, NULL);
	free(in);
	free(changes);
	free(becauses);
	return jsonObject();
}

static Json *watch_op(device *d, const Json *r) {
	watchfn *w = calloc(1, sizeof *w);
	w->fn.call = watch_call;
	w->d = d;
	w->address = strings_of(jsonGet(r, "address"), &w->n);
	char pid[32];
	snprintf(pid, sizeof pid, "watch-%zu", ++d->watches);
	sc_startop so = {0};
	so.code.compute = &w->fn;
	so.address = calloc(1, sizeof *so.address);
	so.id = sc_dup(d->s, pid);
	const sc_error *e = sc_start(d->s, &so, NULL);
	return e ? answer_error(error_code(e)) : jsonObject();
}

static int by_id(const void *x, const void *y) {
	return memcmp(x, y, 32);
}

static Json *device_op(const Json *r) {
	size_t k;
	uint8_t *seed = unhex(jsonText(jsonGet(r, "seed")), &k);
	device *d = calloc(1, sizeof *d);
	if (d == NULL || k != 32) abort();
	d->name = copyString(jsonText(jsonGet(r, "name")));
	memcpy(d->seed, seed, 32);
	free(seed);
	ermEd25519Public(d->seed, d->key);
	d->records = jsonArray();
	d->marks = jsonArray();
	ErmStore *store = malloc(sizeof *store);
	if (store == NULL) abort();
	*store = ermStoreMemory();
	d->t = transport_create(d->seed, store);
	sc_options so = {0};
	so.root = jsonText(jsonGet(r, "root"));
	so.host = jsonText(jsonGet(r, "actor"));
	so.id = id_of;
	so.id_ctx = d;
	so.changed = changed;
	so.changed_ctx = d;
	d->s = sc_new(&so);
	wiring_options wo = {0};
	wo.versions = versions;
	wo.context = d->s;
	memcpy(wo.signer.key, d->key, 32);
	wo.signer.sign = sign;
	wo.signer.context = d->seed;
	wo.random = random_of;
	wo.random_context = d;
	d->w = wiring_create(d->t, &wo);
	devices = realloc(devices, (device_count + 1) * sizeof *devices);
	if (devices == NULL) abort();
	devices[device_count++] = d;
	if (id_is(so.root)) transport_follow(d->t, so.root);
	Json *j = jsonObject();
	char key[65];
	hex(d->key, 32, key);
	jsonAdd(j, "key", jsonString(key));
	return j;
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		if (!jsonDecode(&request)) fputs("bad value\n", stderr), exit(1);
		const char *op = jsonText(jsonGet(request, "op")), *doc = jsonText(jsonGet(request, "doc"));
		device *d = named(jsonText(jsonGet(request, "device")));
		bool is_host = false;
		for (size_t i = 0; op && HOST[i]; i++) is_host = is_host || strcmp(HOST[i], op) == 0;
		if (op == NULL) print_error("unknown op undefined");
		else if (strcmp(op, "reset") == 0) {
			reset();
			puts("{}");
		} else if (strcmp(op, "device") == 0) print(device_op(request));
		else if (strcmp(op, "link") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			if (a == NULL || b == NULL) print_error("no device");
			else {
				links = realloc(links, (link_count + 1) * sizeof *links);
				if (links == NULL) abort();
				size_t before_a = transport_connected(a->t), before_b = transport_connected(b->t);
				links[link_count++] = (wire){a, b, transport_connect(a->t, "ermine"), transport_connect(b->t, "ermine"), true};
				// the handshake done
				for (int round = 0; round < 2000 && (transport_connected(a->t) == before_a || transport_connected(b->t) == before_b); round++) {
					run(a);
					run(b);
					nap();
				}
				puts("{}");
			}
		} else if (strcmp(op, "unlink") == 0) {
			device *a = named(jsonText(jsonGet(request, "a"))), *b = named(jsonText(jsonGet(request, "b")));
			for (size_t i = 0; a && b && i < link_count; i++) {
				wire *l = &links[i];
				if (!l->live || !((l->a == a && l->b == b) || (l->a == b && l->b == a))) continue;
				transport_closed(l->a->t, l->ca);
				transport_closed(l->b->t, l->cb);
				l->live = false;
			}
			puts("{}");
		} else if (strcmp(op, "pump") == 0) {
			const char *trouble = pump();
			if (trouble) print_error(trouble);
			else puts("{}");
		} else if (d == NULL) print_error("no device");
		else if (is_host) print(host(d, request));
		else if (strcmp(op, "ops") == 0) {
			Json *out = jsonArray();
			const Json *ops = jsonGet(request, "ops");
			for (int i = 0; i < ops->array.count; i++) jsonPush(out, host(d, ops->array.items[i]));
			print(out);
		} else if (strcmp(op, "follow") == 0) {
			if (doc && transport_follow(d->t, doc) == TRANSPORT_OK) puts("{}");
			else print_error("not a document");
		} else if (strcmp(op, "read") == 0) print(read_op(d, request));
		else if (strcmp(op, "records") == 0) print(records_op(d, request));
		else if (strcmp(op, "versions") == 0) print(versions_op(d, request));
		else if (strcmp(op, "watch") == 0) print(watch_op(d, request));
		else if (strcmp(op, "marked") == 0) {
			print(d->marks);
			d->marks = jsonArray();
		} else if (strcmp(op, "stored") == 0 && doc) {
			uint8_t(*ids)[32];
			size_t n = transport_stored(d->t, doc, &ids);
			qsort(ids, n, 32, by_id);
			Json *out = jsonArray();
			for (size_t i = 0; i < n; i++) {
				char h[65];
				hex(ids[i], 32, h);
				jsonPush(out, jsonString(h));
			}
			free(ids);
			print(out);
		} else {
			char m[128];
			snprintf(m, sizeof m, "unknown op %s", op);
			print_error(m);
		}
		fflush(stdout);
		// nothing a scheduler gave is held past a line: what each let go of goes
		for (size_t i = 0; i < device_count; i++) sc_sweep(devices[i]->s);
	}
	reset();
	free(line);
	return 0;
}
