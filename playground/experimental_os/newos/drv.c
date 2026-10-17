// drv.c: what the drivers share, over newOS's API (drv.h).
//
// THE KIT'S JSON IS THE TURN'S. Every Json the kit makes or hands out (drvPath,
// drvUnder, drvMap, drvHere, drvItem, drvRead, drvNames, drvOp's answer, an
// error's why, an ErmGiven's fields) is held by the kit's pool and let go at
// the turn's end (drvSweep, from hostTurn). A driver borrows it (json.h): to
// keep it past the turn, or to put it in a container of its own, it jsonRefs
// it first, and lets that hold go itself. What a driver gives the kit (a
// map's values, a write's value, a function's output) the kit takes, as a
// container does: a fresh value becomes the turn's too; the turn's stays the
// turn's (the kit takes a hold of its own); a value borrowed from elsewhere (a
// part of a read, one the driver keeps) is jsonRef'd or jsonShallow'd first.

#include "drv.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static Host *host;

void drvUse(Host *h) { host = h; }
Host *drvHost(void) { return host; }

// --- the turn's values: held here, by address, let go at the sweep

static struct {
	Json **items;
	size_t n, room;
	size_t *slots, nslots; // open addressing: items' index + 1; 0: empty
} pool;

static size_t slotHash(const Json *v) {
	uintptr_t x = (uintptr_t)v;
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdull;
	x ^= x >> 33;
	return (size_t)x;
}

static bool pooled(const Json *v) {
	if (!v || !pool.nslots) return false;
	for (size_t s = slotHash(v) & (pool.nslots - 1); pool.slots[s]; s = (s + 1) & (pool.nslots - 1))
		if (pool.items[pool.slots[s] - 1] == v) return true;
	return false;
}

/** v the turn's: its one hold the pool's, let go at the sweep; v (already the turn's: as it is) */
static Json *turn(Json *v) {
	if (!v || pooled(v)) return v;
	if (pool.n == pool.room) {
		pool.room = pool.room ? pool.room * 2 : 1024;
		pool.items = realloc(pool.items, sizeof *pool.items * pool.room);
	}
	pool.items[pool.n++] = v;
	if (pool.n * 2 >= pool.nslots) {
		free(pool.slots);
		pool.nslots = pool.nslots ? pool.nslots * 2 : 4096;
		pool.slots = calloc(pool.nslots, sizeof *pool.slots);
		for (size_t i = 0; i < pool.n; i++) {
			size_t s = slotHash(pool.items[i]) & (pool.nslots - 1);
			while (pool.slots[s]) s = (s + 1) & (pool.nslots - 1);
			pool.slots[s] = i + 1;
		}
	} else {
		size_t s = slotHash(v) & (pool.nslots - 1);
		while (pool.slots[s]) s = (s + 1) & (pool.nslots - 1);
		pool.slots[s] = pool.n;
	}
	return v;
}

/** a value given to the kit to hold in a container: a hold of the kit's own of the turn's, else the caller's hold taken */
static Json *given(Json *v) {
	return pooled(v) ? jsonRef(v) : v;
}

/** a hold given to the kit (jsonOfValKept's): the turn's; one the pool holds already is let go */
static Json *held(Json *v) {
	if (!pooled(v)) return turn(v);
	jsonFree(v);
	return v;
}

void drvSweep(void) {
	for (size_t i = 0; i < pool.n; i++) jsonFree(pool.items[i]);
	pool.n = 0;
	if (pool.nslots) memset(pool.slots, 0, sizeof *pool.slots * pool.nslots);
}

// --- errors

ErmErr ermOk(void) { return (ErmErr){ 0 }; }

ErmErr ermInvalid(const char *code) {
	return (ErmErr){ ERM_INVALID, NULL, drvMap("code", jsonString(code), NULL) };
}

ErmErr ermDetail(ErmErr err, const char *key, Json *value) {
	if (!err.why) err.why = turn(jsonObject());
	jsonAdd(err.why, key, given(value));
	return err;
}

ErmErr ermField(const char *code, const char *field) {
	return ermDetail(ermInvalid(code), "field", jsonString(field));
}

static const ap_error *apError(ErmErr e) {
	const char *code = jsonText(jsonGet(e.why, "code"));
	char *message = e.why ? jsonPrint(e.why) : NULL;
	const ap_error *out = ap_error_new(hostOs(host), code ? code : "thrown", message);
	free(message);
	return out;
}

static void said(const char *op, const Json *address, const ap_error *e) {
	char *what = address ? jsonPrint(address) : NULL;
	fprintf(stderr, "[os] driver: %s %s: %s%s%s\n", op, what ? what : "", e->code ? e->code : "thrown", e->message ? ": " : "", e->message ? e->message : "");
	free(what);
}

// --- functions: an ErmFn as the API's ap_fn

typedef struct DrvFn {
	ap_fn base;
	ErmFn fn;
} DrvFn;

/** the given of the function running now, innermost last: a part's start and call go through it */
static ap_given *running[64];
static int depth;

static const ap_error *call(ap_fn *self, ap_given *ag, op_value **out, int *pending) {
	(void)pending;
	DrvFn *f = (DrvFn *)self;
	ErmGiven g = {
		.sc = ag,
		.api = ag->api,
		.peep = ag->peep,
		.self = ag->self ? turn(jsonString(ag->self)) : NULL,
		.name = ag->name ? turn(jsonString(ag->name)) : NULL,
		.value = ag->value ? held(jsonOfValKept(ag->value)) : NULL,
		.previous = ag->previous ? held(jsonOfValKept(ag->previous)) : NULL,
		.args = ag->args ? turn(jsonOfVal(ag->args)) : NULL,
		.killed = ag->part == AP_CLEANUP ? turn(jsonBoolean(ag->killed)) : NULL,
	};
	if (depth < 64) running[depth] = ag;
	depth++;
	Json *o = NULL;
	ErmErr e = f->fn.call(f->fn.data, &g, &o);
	depth--;
	if (e.kind) return apError(e);
	*out = o ? valOf(turn(o)) : NULL;
	return NULL;
}

static ap_given *now(void) {
	return depth > 0 && depth <= 64 ? running[depth - 1] : NULL;
}

static void drvFree(ap_fn *self) {
	free(self);
}

ap_fn *drvFn(ErmFn fn) {
	if (!fn.call) return NULL;
	DrvFn *f = calloc(1, sizeof *f);
	f->base.call = call;
	f->base.free = drvFree;
	f->fn = fn;
	return &f->base;
}

op_value *ermFunction(ErmFn fn) {
	ap_given *g = now();
	return ap_live(g ? g->api : ap_host(hostOs(host)), drvFn(fn));
}

// --- the map

static uint64_t hashOf(const char *key) {
	uint64_t hash = 1469598103934665603ull; // FNV-1a
	for (const unsigned char *c = (const unsigned char *)key; *c; c++) {
		hash ^= *c;
		hash *= 1099511628211ull;
	}
	return hash;
}

static int findSlot(const ErmMap *map, const char *key) {
	if (!map->indexSize) return -1;
	int mask = map->indexSize - 1;
	for (int slot = (int)(hashOf(key) & (uint64_t)mask);; slot = (slot + 1) & mask) {
		int entry = map->index[slot];
		if (entry == -1) return -1;
		if (strcmp(map->entries[entry].key, key) == 0) return slot;
	}
}

static void reindex(ErmMap *map, int size) {
	free(map->index);
	map->indexSize = size;
	map->index = malloc((size_t)size * sizeof *map->index);
	for (int i = 0; i < size; i++) map->index[i] = -1;
	int mask = size - 1;
	for (int e = 0; e < map->count; e++) {
		int slot = (int)(hashOf(map->entries[e].key) & (uint64_t)mask);
		while (map->index[slot] != -1) slot = (slot + 1) & mask;
		map->index[slot] = e;
	}
}

void *ermMapGet(const ErmMap *map, const char *key) {
	int slot = findSlot(map, key);
	return slot >= 0 ? map->entries[map->index[slot]].value : NULL;
}

bool ermMapHas(const ErmMap *map, const char *key) {
	return findSlot(map, key) >= 0;
}

void ermMapPut(ErmMap *map, const char *key, void *value) {
	int slot = findSlot(map, key);
	if (slot >= 0) {
		map->entries[map->index[slot]].value = value;
		return;
	}
	map->entries = growArray(map->entries, map->count, &map->capacity, sizeof *map->entries);
	map->entries[map->count++] = (ErmMapEntry){ copyString(key), value };
	if (map->count * 2 > map->indexSize) {
		int size = map->indexSize ? map->indexSize : 16;
		while (map->count * 2 > size) size *= 2;
		reindex(map, size);
	} else {
		int mask = map->indexSize - 1;
		int at = (int)(hashOf(key) & (uint64_t)mask);
		while (map->index[at] != -1) at = (at + 1) & mask;
		map->index[at] = map->count - 1;
	}
}

// --- addresses and maps

Json *drvPath(const char *first, ...) {
	Json *a = jsonArray();
	va_list ap;
	va_start(ap, first);
	for (const char *p = first; p; p = va_arg(ap, const char *)) jsonPush(a, jsonString(p));
	va_end(ap);
	return turn(a);
}

Json *drvUnder(const Json *address, const char *first, ...) {
	Json *a = jsonArray();
	for (int i = 0; address && i < address->array.count; i++) jsonPush(a, jsonRef(address->array.items[i]));
	va_list ap;
	va_start(ap, first);
	for (const char *p = first; p; p = va_arg(ap, const char *)) jsonPush(a, jsonString(p));
	va_end(ap);
	return turn(a);
}

Json *drvMap(const char *key, ...) {
	Json *m = jsonObject();
	va_list ap;
	va_start(ap, key);
	for (const char *k = key; k; k = va_arg(ap, const char *)) jsonAdd(m, k, given(va_arg(ap, Json *)));
	va_end(ap);
	return turn(m);
}

/** an address's names, for this turn */
static const char *const *names(const Json *address, size_t *n) {
	*n = 0;
	const char *const *out = hostPathOf(host, address, n);
	return out ? out : hostPath(host, n, NULL);
}

/** the id at an address, NULL if none */
static const char *idAt(const ErmPartApi *api, const Json *address) {
	size_t n;
	const char *const *a = names(address, &n);
	const ap_item *it = hostLook((ap_api *)api, a, n);
	return it ? it->id : NULL;
}

// --- reads

Json *drvItem(const ErmPartApi *api, Json *address) {
	size_t n;
	const char *const *a = names(address, &n);
	ap_items items = { 0 };
	if (ap_content((ap_api *)api, a, n, &items)) return NULL;
	for (size_t i = 0; i < items.n; i++) {
		const ap_item *it = &items.items[i];
		if (!it->node || !it->has_versions) continue;
		for (size_t k = 0; k < it->nversions; k++) {
			const ap_version *v = &it->versions[k];
			if (v->status) continue;
			// the same Json while the value is the same (val.h): the drivers' caches key on it
			Json *change = jsonObject(), *item = jsonObject();
			jsonAdd(change, "time", jsonInteger(v->change.time));
			jsonAdd(item, "value", jsonOfValKept(v->content));
			jsonAdd(item, "change", change);
			return turn(item);
		}
		return NULL;
	}
	return NULL;
}

Json *drvRead(const ErmPartApi *api, Json *address) {
	Json *v = jsonGet(drvItem(api, address), "value");
	return !v || pooled(v) ? v : turn(jsonRef(v));
}

bool drvHas(const ErmPartApi *api, Json *address) {
	return idAt(api, address) != NULL;
}

Json *drvNames(const ErmPartApi *api, Json *address) {
	size_t n;
	const char *const *a = names(address, &n);
	ap_namelist list = { 0 };
	Json *out = turn(jsonArray());
	if (ap_names((ap_api *)api, a, n, &list)) return out;
	// whether a node is loaded there, without its value: a name listed is not read, so a node under it
	// written (a layer drawn, a window moved) runs no one who only listed its names again
	const char **at = malloc(sizeof *at * (n + 1));
	for (size_t k = 0; k < n; k++) at[k] = a[k];
	for (size_t i = 0; i < list.n; i++) {
		at[n] = list.names[i];
		if (ap_first((ap_api *)api, at, n + 1)) jsonPush(out, jsonString(list.names[i]));
	}
	free(at);
	return out;
}

// --- writes

/**
 * a patch from the old core's shapes ({type: "snapshot", value}, {type: "set", path, key, value},
 * {type: "splice", path, range, value}) or core's ({path, range?, value?})
 */
static bool patchOf(const Json *p, op_patch *out) {
	const char *type = jsonText(jsonGet(p, "type"));
	bool snapshot = type && !strcmp(type, "snapshot"), set = type && !strcmp(type, "set");
	if (type && !snapshot && !set && strcmp(type, "splice")) return false;
	Json *path = snapshot ? NULL : jsonGet(p, "path");
	size_t given = jsonIsArray(path) ? (size_t)path->array.count : 0, n = given + (set ? 1 : 0);
	op_key *keys = n ? hostTemp(host, n * sizeof *keys) : NULL;
	for (size_t i = 0; i < given; i++) {
		Json *k = path->array.items[i];
		int64_t whole;
		if (jsonIsWhole(k, &whole)) keys[i] = (op_key){ .type = OP_NUM_KEY, .n = (long)whole };
		else keys[i] = (op_key){ .type = OP_STR_KEY, .s = jsonText(k) ? hostTempDup(host, jsonText(k)) : "" };
	}
	if (set) keys[n - 1] = (op_key){ .type = OP_STR_KEY, .s = hostTempDup(host, jsonText(jsonGet(p, "key")) ? jsonText(jsonGet(p, "key")) : "") };
	Json *value = jsonGet(p, "value"), *range = jsonGet(p, "range");
	*out = (op_patch){ .place = { .path = keys, .length = n }, .has_value = value != NULL, .value = value ? valOf(value) : NULL };
	int64_t from, to;
	if (!snapshot && jsonIsArray(range) && range->array.count == 2 && jsonIsWhole(range->array.items[0], &from) && jsonIsWhole(range->array.items[1], &to))
		out->place.has_range = 1, out->place.from = (long)from, out->place.to = (long)to;
	return true;
}

static const ap_error *write(const ErmPartApi *api, Json *address, Json *patches) {
	size_t n, np = jsonIsArray(patches) ? (size_t)patches->array.count : 0;
	const char *const *a = names(address, &n);
	op_patch *ps = calloc(np ? np : 1, sizeof *ps);
	for (size_t i = 0; i < np; i++)
		if (!patchOf(patches->array.items[i], &ps[i])) {
			free(ps);
			return ap_error_new(hostOs(host), "wrong-field", "a patch of a kind the kit does not know");
		}
	const ap_error *e = ap_write((ap_api *)api, a, n, ps, np, NULL, NULL);
	for (size_t i = 0; i < np; i++) op_free((op_value *)ps[i].value);
	free(ps);
	return e;
}

/** one patch, the kit's own, holding the value given (the turn's: a hold of its own) */
static Json *patch(const char *type, const char *key, Json *value) {
	Json *p = jsonObject();
	jsonAdd(p, "type", jsonString(type));
	if (key) {
		jsonAdd(p, "path", jsonArray());
		jsonAdd(p, "key", jsonString(key));
	}
	jsonAdd(p, "value", given(turn(value)));
	Json *patches = jsonArray();
	jsonPush(patches, p);
	return patches;
}

void drvSnap(const ErmPartApi *api, Json *address, Json *value) {
	Json *patches = patch("snapshot", NULL, value);
	const ap_error *e = write(api, address, patches);
	jsonFree(patches);
	if (e) said("write", address, e);
}

void drvSet(const ErmPartApi *api, Json *address, const char *key, Json *value) {
	Json *patches = patch("set", key, value);
	const ap_error *e = write(api, address, patches);
	jsonFree(patches);
	if (e) said("write", address, e);
}

static const ap_error *place(const ErmPartApi *api, Json *at, const char *name, const char *id, const op_value *value, bool ephemeral) {
	const char *parent = idAt(api, at);
	if (!parent) return ap_error_new(hostOs(host), "nothing-there", "nothing at the parent");
	const char *made = NULL;
	const ap_error *e = ap_create((ap_api *)api, value, id, ephemeral, &made);
	if (e) return e;
	return ap_insert((ap_api *)api, parent, name, made, NULL, NULL);
}

void drvPlace(const ErmPartApi *api, Json *at, const char *name, const char *id, Json *value) {
	op_value *v = valOf(turn(value));
	const ap_error *e = place(api, at, name, id, v, true);
	op_free(v);
	if (e) said("place", at, e);
}

void drvMake(const ErmPartApi *api, Json *at, const char *name, const char *id, Json *value) {
	turn(value);
	if (drvHas(api, drvUnder(at, name, NULL))) return;
	op_value *v = valOf(value);
	const ap_error *e = place(api, at, name, id, v, true);
	op_free(v);
	if (e) said("place", at, e);
}

void drvMakeLive(const ErmPartApi *api, Json *at, const char *name, const char *id, op_value *value) {
	if (drvHas(api, drvUnder(at, name, NULL))) return;
	const ap_error *e = place(api, at, name, id, value, true);
	if (e) said("place", at, e);
}

static const ap_error *unplace(const ErmPartApi *api, Json *at, const char *name, const char *id) {
	size_t n;
	const char *const *a = names(at, &n);
	const char *parent = idAt(api, at);
	if (!parent) return ap_error_new(hostOs(host), "nothing-there", "nothing at the parent");
	ap_items items = { 0 };
	const ap_error *e = ap_children((ap_api *)api, a, n, name, &items);
	if (e) return e;
	for (size_t i = 0; i < items.n; i++) {
		if (id && strcmp(items.items[i].id, id)) continue;
		return ap_remove((ap_api *)api, parent, name, (long)i, NULL);
	}
	return ap_error_new(hostOs(host), "nothing-there", "no such id in that list");
}

Json *drvOp(const ErmPartApi *api, const char *op, Json *fields) {
	turn(fields);
	Json *address = jsonGet(fields, "address");
	const char *name = jsonText(jsonGet(fields, "name")), *id = jsonText(jsonGet(fields, "id"));
	const ap_error *e = NULL;
	Json *ok = turn(jsonNull());
	if (!strcmp(op, "write")) {
		e = write(api, address, jsonGet(fields, "patches"));
	} else if (!strcmp(op, "place")) {
		Json *eph = jsonGet(fields, "ephemeral");
		op_value *v = valOf(jsonGet(fields, "value"));
		e = place(api, address, name ? name : "", id && *id ? id : NULL, v, eph && eph->type == JSON_BOOLEAN && eph->boolean);
		op_free(v);
	} else if (!strcmp(op, "unplace")) {
		e = unplace(api, address, name ? name : "", id);
	} else if (!strcmp(op, "call")) {
		ap_given *g = now();
		size_t n;
		const char *const *a = names(address, &n);
		Json *args = jsonGet(fields, "args");
		op_value *av = args ? valOf(args) : NULL, *out = NULL;
		if (!g) e = ap_error_new(hostOs(host), "stopped", "call outside a part");
		else e = ap_call(g, a, n, av, &out);
		op_free(av);
		if (!e && out) ok = turn(jsonOfVal(out));
	} else {
		e = ap_error_new(hostOs(host), "unsupported", op);
	}
	if (e) {
		said(op, address, e);
		return NULL;
	}
	return ok;
}

// --- processes

Json *drvHere(const ErmGiven *g) {
	Json *here = hostHere(host, g->sc->self);
	return here ? turn(here) : drvPath("/", NULL);
}

void drvHandler(const ErmGiven *g, Json *here, const char *name, ErmFn fn) {
	drvMake(g->api, here, "on", NULL, jsonNull());
	op_value *live = ap_live(g->api, drvFn(fn));
	drvMakeLive(g->api, drvUnder(here, "on", NULL), name, NULL, live);
	op_free(live);
}

void drvClaim(const ErmGiven *g, Json *here, int irq) {
	char n[16];
	snprintf(n, sizeof n, "%d", irq);
	Json *line = drvPath("/", "hw", "irq", n, NULL);
	if (drvHas(g->api, line)) drvSet(g->api, line, "owner", drvUnder(here, "on", "irq", NULL));
}

void drvChild(const ErmGiven *g, Json *here, const char *name, ErmFn compute, ErmFn effect) {
	size_t n;
	const char *const *a = hostPathOf(host, here, &n);
	ap_startop op = { .address = a, .naddress = n, .name = name, .compute = drvFn(compute), .effect = drvFn(effect) };
	const char *id = NULL;
	const ap_error *e = ap_start(g->sc, &op, &id);
	if (e) said("start", here, e);
}

void drvKill(const char *pid) {
	hostKill(host, pid);
}

// --- base64

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *drvBase64(const uint8_t *bytes, size_t n) {
	char *out = malloc((n + 2) / 3 * 4 + 1), *o = out;
	for (size_t i = 0; i < n; i += 3) {
		uint32_t v = (uint32_t)bytes[i] << 16 | (i + 1 < n ? (uint32_t)bytes[i + 1] << 8 : 0) | (i + 2 < n ? bytes[i + 2] : 0);
		*o++ = B64[v >> 18 & 63];
		*o++ = B64[v >> 12 & 63];
		*o++ = i + 1 < n ? B64[v >> 6 & 63] : '=';
		*o++ = i + 2 < n ? B64[v & 63] : '=';
	}
	*o = 0;
	return out;
}

uint8_t *drvUnbase64(const char *text, size_t *n) {
	size_t len = text ? strlen(text) : 0;
	uint8_t *out = malloc(len * 3 / 4 + 3);
	size_t m = 0;
	uint32_t acc = 0;
	int bits = 0;
	for (size_t i = 0; i < len; i++) {
		const char *at = strchr(B64, text[i]);
		if (!at || !text[i]) continue;
		acc = acc << 6 | (uint32_t)(at - B64);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[m++] = (uint8_t)(acc >> bits);
		}
	}
	*n = m;
	return out;
}
