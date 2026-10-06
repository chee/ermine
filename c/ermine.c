// ermine.c: the helpers ermine.h declares: errors, addresses, the protocol's
// encodings of items and changes, operation names, apis and the string map.
// Pure functions over the shared types; no layer's state lives here.

#include "ermine.h"

#include <stdlib.h>
#include <string.h>

// errors -------------------------------------------------------------------------

ErmErr ermOk(void) {
	return (ErmErr){ ERM_OK, NULL, NULL };
}

ErmErr ermInvalid(const char *code) {
	Json *why = jsonObject();
	jsonAdd(why, "code", jsonString(code));
	return (ErmErr){ ERM_INVALID, NULL, why };
}

ErmErr ermDetail(ErmErr err, const char *key, Json *value) {
	jsonAdd(err.why, key, value);
	return err;
}

Json *ermErrToJson(ErmErr err) {
	Json *object = jsonObject();
	jsonAdd(object, "kind", jsonString(err.kind == ERM_REFUSED ? "refused" : "invalid"));
	if (err.op) jsonAdd(object, "op", jsonString(err.op));
	jsonAdd(object, "why", err.why);
	return object;
}

// addresses ----------------------------------------------------------------------

bool ermIsName(const char *text) {
	return strcmp(text, ".") != 0 && strcmp(text, "..") != 0 && strcmp(text, "/") != 0;
}

/** appends the names parts[from..]; false at the first part that is not a name */
static bool namesFrom(Json *parts, int from, ErmIds *out) {
	for (int i = from; i < parts->array.count; i++) {
		const char *name = jsonText(parts->array.items[i]);
		if (!name || !ermIsName(name)) return false;
		ERM_PUSH(*out, name);
	}
	return true;
}

bool ermNamesFrom(Json *list, ErmIds *out) {
	*out = (ErmIds){ 0 };
	return jsonIsArray(list) && namesFrom(list, 0, out);
}

bool ermAddressFrom(Json *parts, ErmAddress *out) {
	*out = (ErmAddress){ 0 };
	if (!jsonIsArray(parts)) return false;
	int i = 0, count = parts->array.count;
	const char *part = count ? jsonText(parts->array.items[0]) : NULL;
	if (part && strcmp(part, "/") == 0) {
		out->fromStart = true;
		i = 1;
	}
	for (; i < count && (part = jsonText(parts->array.items[i])) && strcmp(part, "..") == 0; i++) out->ups++;
	return namesFrom(parts, i, &out->names);
}

// encodings ----------------------------------------------------------------------

static Json *routeToJson(const ErmRoute *route) {
	Json *list = jsonArray();
	for (int i = 0; i < route->count; i++) {
		const ErmStep *step = &route->items[i];
		Json *object = jsonObject();
		jsonAdd(object, "parent", jsonString(step->parent));
		jsonAdd(object, "name", jsonString(step->name));
		jsonAdd(object, "node", jsonString(step->node));
		jsonAdd(object, "position", jsonInteger(step->position));
		jsonPush(list, object);
	}
	return list;
}

/** {"value": v, "from", "change"?} or {"id", "from", "change"?, "pending"?} */
static Json *itemToJson(const ErmItem *item) {
	Json *object = jsonObject();
	if (item->value) jsonAdd(object, "value", item->value);
	else jsonAdd(object, "id", jsonString(item->id));
	Json *from = jsonObject();
	if (item->ups >= 0) {
		Json *path = jsonArray();
		for (int i = 0; i < item->ups; i++) jsonPush(path, jsonString(".."));
		jsonPush(path, jsonString(item->name));
		jsonAdd(from, "path", path);
	} else {
		jsonAdd(from, "route", routeToJson(&item->route));
	}
	if (item->position >= 0) jsonAdd(from, "position", jsonInteger(item->position));
	jsonAdd(object, "from", from);
	if (item->change) jsonAdd(object, "change", ermChangeToJson(item->change));
	if (item->pending) jsonAdd(object, "pending", jsonBoolean(true));
	return object;
}

Json *ermItemsToJson(const ErmItems *items) {
	Json *list = jsonArray();
	for (int i = 0; i < items->count; i++) jsonPush(list, itemToJson(&items->items[i]));
	return list;
}

Json *ermListingToJson(const ErmListing *listing) {
	Json *list = jsonArray();
	for (int i = 0; i < listing->count; i++) {
		Json *pair = jsonArray();
		jsonPush(pair, jsonString(listing->items[i].name));
		jsonPush(pair, ermItemsToJson(&listing->items[i].items));
		jsonPush(list, pair);
	}
	return list;
}

Json *ermChangeToJson(const ErmChange *change) {
	static const char *const kinds[] = { "write", "place", "unplace" };
	Json *object = jsonObject();
	jsonAdd(object, "node", jsonString(change->node));
	jsonAdd(object, "time", jsonNumber(change->time));
	jsonAdd(object, "kind", jsonString(kinds[change->kind]));
	if (change->kind == ERM_WRITE) {
		jsonAdd(object, "patches", change->patches);
	} else {
		jsonAdd(object, "name", jsonString(change->name));
		jsonAdd(object, "id", jsonString(change->id));
		if (change->hasPosition) jsonAdd(object, "position", jsonInteger(change->position));
		if (change->value) jsonAdd(object, "value", change->value);
	}
	jsonAdd(object, "agent", change->agent);
	if (change->process) jsonAdd(object, "process", jsonString(change->process));
	if (change->cause) jsonAdd(object, "cause", change->cause);
	return object;
}

Json *ermRefToJson(ErmRef ref) {
	Json *object = jsonObject();
	jsonAdd(object, "node", jsonString(ref.node));
	jsonAdd(object, "time", jsonNumber(ref.time));
	return object;
}

Json *ermChangeAnswer(const ErmResult *result) {
	Json *object = jsonObject();
	jsonAdd(object, "change", ermChangeToJson(result->change));
	Json *marked = jsonArray();
	for (int i = 0; i < result->marked.count; i++) {
		Json *mark = jsonObject();
		jsonAdd(mark, "process", jsonString(result->marked.items[i]));
		jsonAdd(mark, "by", ermRefToJson((ErmRef){ result->change->node, result->change->time }));
		jsonPush(marked, mark);
	}
	jsonAdd(object, "marked", marked);
	return object;
}

// operations ---------------------------------------------------------------------

const char *ermOpName(ErmOpKind kind) {
	static const char *const names[] = { "read", "directory", "lookup", "write", "place", "unplace" };
	return names[kind];
}

bool ermOpIsChange(ErmOpKind kind) {
	return kind == ERM_OP_WRITE || kind == ERM_OP_PLACE || kind == ERM_OP_UNPLACE;
}

ErmApi ermBind(ErmInterface iface, ErmCtx ctx) {
	return (ErmApi){ iface, ctx };
}

ErmErr ermApiOp(ErmApi api, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	ErmStamp none = { 0 };
	return api.iface.vt->op(api.iface.self, &api.ctx, stamp ? stamp : &none, op, out);
}

// the string map -----------------------------------------------------------------

static uint64_t hashOf(const char *key) {
	uint64_t hash = 1469598103934665603ull; // FNV-1a
	for (const unsigned char *c = (const unsigned char *)key; *c; c++) {
		hash ^= *c;
		hash *= 1099511628211ull;
	}
	return hash;
}

/** the slot of the index holding the entry for key, or -1 */
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
	map->index = allocate((size_t)size * sizeof *map->index);
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
	map->entries[map->count] = (ErmMapEntry){ copyString(key), value };
	map->count++;
	// entries at most half the index
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
