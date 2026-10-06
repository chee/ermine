// ermine.c: the shared helpers ermine.h declares: errors, paths, patch
// shapes, encodings of changes and records, contexts, ops, apis, the string
// map. Owner: the skeleton (done). Pure functions over the shared types;
// no layer's state lives here.

#include "ermine.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ids ----------------------------------------------------------------------------

bool ermIdsHas(const ErmIds *ids, const char *id) {
	for (int i = 0; i < ids->count; i++) {
		if (strcmp(ids->items[i], id) == 0) return true;
	}
	return false;
}

static int compareIds(const void *a, const void *b) {
	return textCompare(*(const char *const *)a, *(const char *const *)b);
}

void ermIdsSort(ErmIds *ids) {
	if (ids->count > 1) qsort(ids->items, (size_t)ids->count, sizeof *ids->items, compareIds);
}

Json *ermIdsToJson(const ErmIds *ids) {
	Json *list = jsonArray();
	for (int i = 0; i < ids->count; i++) jsonPush(list, jsonString(ids->items[i]));
	return list;
}

// errors -------------------------------------------------------------------------

ErmErr ermOk(void) {
	return (ErmErr){ ERM_OK, NULL, NULL };
}

static ErmErr errorOf(ErmErrKind kind, const char *format, va_list arguments) {
	va_list again;
	va_copy(again, arguments);
	int length = vsnprintf(NULL, 0, format, arguments);
	char *text = allocate((size_t)length + 1);
	vsnprintf(text, (size_t)length + 1, format, again);
	va_end(again);
	Json *why = jsonString(text);
	free(text);
	return (ErmErr){ kind, NULL, why };
}

ErmErr ermInvalid(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	ErmErr err = errorOf(ERM_INVALID, format, arguments);
	va_end(arguments);
	return err;
}

ErmErr ermRefused(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	ErmErr err = errorOf(ERM_REFUSED, format, arguments);
	va_end(arguments);
	return err;
}

ErmErr ermThrown(Json *why) {
	return (ErmErr){ ERM_THROWN, NULL, why ? why : jsonNull() };
}

ErmErr ermWithOp(ErmErr err, const char *op) {
	err.op = op;
	return err;
}

const char *ermErrKindText(ErmErrKind kind) {
	switch (kind) {
		case ERM_OK: return "ok";
		case ERM_INVALID: return "invalid";
		case ERM_REFUSED: return "refused";
		case ERM_THROWN: return "thrown";
	}
	return "invalid";
}

Json *ermErrToJson(ErmErr err) {
	Json *object = jsonObject();
	jsonAdd(object, "kind", jsonString(ermErrKindText(err.kind)));
	if (err.op) jsonAdd(object, "op", jsonString(err.op));
	jsonAdd(object, "why", err.why ? err.why : jsonString(""));
	return object;
}

// paths --------------------------------------------------------------------------

ErmErr ermPathFrom(Json *value, ErmPath *out) {
	ErmPath path = { 0 };
	if (!jsonIsArray(value)) return ermInvalid("a path must be a list of steps");
	for (int i = 0; i < value->array.count; i++) {
		Json *step = value->array.items[i];
		const char *parent = jsonText(jsonGet(step, "parent"));
		const char *name = jsonText(jsonGet(step, "name"));
		const char *node = jsonText(jsonGet(step, "node"));
		if (!parent) return ermInvalid("a path step needs a string parent");
		if (!name) return ermInvalid("a path step needs a string name");
		if (!node) return ermInvalid("a path step needs a string node");
		if (i > 0 && strcmp(path.items[i - 1].node, parent) != 0) {
			return ermInvalid("a path step's parent must be the node of the step before");
		}
		ERM_PUSH(path, ((ErmStep){ parent, name, node }));
	}
	*out = path;
	return ermOk();
}

Json *ermPathToJson(const ErmPath *path) {
	Json *list = jsonArray();
	for (int i = 0; i < path->count; i++) {
		Json *step = jsonObject();
		jsonAdd(step, "parent", jsonString(path->items[i].parent));
		jsonAdd(step, "name", jsonString(path->items[i].name));
		jsonAdd(step, "node", jsonString(path->items[i].node));
		jsonPush(list, step);
	}
	return list;
}

// patches ------------------------------------------------------------------------

static ErmErr keysFrom(Json *patch, Json **out) {
	Json *path = jsonGet(patch, "path");
	if (!jsonIsArray(path)) return ermInvalid("a patch needs a path, a list of keys");
	for (int i = 0; i < path->array.count; i++) {
		Json *key = path->array.items[i];
		int64_t index;
		if (jsonIsString(key)) continue;
		if (jsonIsWhole(key, &index) && index >= 0) continue;
		return ermInvalid("a key must be a string or a whole number");
	}
	*out = path;
	return ermOk();
}

static ErmErr patchFrom(Json *value, ErmPatch *out) {
	ErmPatch patch = { 0 };
	const char *type = jsonText(jsonGet(value, "type"));
	if (!jsonIsObject(value) || !type) return ermInvalid("a patch's type must be snapshot, splice or set");
	if (strcmp(type, "snapshot") == 0) {
		patch.type = ERM_SNAPSHOT;
		patch.value = jsonGet(value, "value");
		if (!patch.value) return ermInvalid("a snapshot needs a value");
	} else if (strcmp(type, "splice") == 0) {
		patch.type = ERM_SPLICE;
		ErmErr err = keysFrom(value, &patch.path);
		if (err.kind) return err;
		Json *range = jsonGet(value, "range");
		if (!jsonIsArray(range) || range->array.count != 2 || !jsonIsWhole(range->array.items[0], &patch.from) ||
		    !jsonIsWhole(range->array.items[1], &patch.to) || patch.from < 0 || patch.to < 0) {
			return ermInvalid("a splice needs a range of two whole numbers");
		}
		patch.value = jsonGet(value, "value");
	} else if (strcmp(type, "set") == 0) {
		patch.type = ERM_SET;
		ErmErr err = keysFrom(value, &patch.path);
		if (err.kind) return err;
		patch.key = jsonGet(value, "key");
		if (!jsonIsString(patch.key)) return ermInvalid("a set needs a string key");
		patch.value = jsonGet(value, "value");
	} else {
		return ermInvalid("a patch's type must be snapshot, splice or set");
	}
	*out = patch;
	return ermOk();
}

ErmErr ermPatchesFrom(Json *value, ErmPatches *out) {
	ErmPatches patches = { 0 };
	if (!jsonIsArray(value)) return ermInvalid("patches must be a list");
	for (int i = 0; i < value->array.count; i++) {
		ErmPatch patch;
		ErmErr err = patchFrom(value->array.items[i], &patch);
		if (err.kind) return err;
		ERM_PUSH(patches, patch);
	}
	*out = patches;
	return ermOk();
}

Json *ermPatchToJson(const ErmPatch *patch) {
	Json *object = jsonObject();
	switch (patch->type) {
		case ERM_SNAPSHOT:
			jsonAdd(object, "type", jsonString("snapshot"));
			jsonAdd(object, "value", patch->value);
			break;
		case ERM_SPLICE: {
			jsonAdd(object, "type", jsonString("splice"));
			jsonAdd(object, "path", patch->path);
			Json *range = jsonArray();
			jsonPush(range, jsonInteger(patch->from));
			jsonPush(range, jsonInteger(patch->to));
			jsonAdd(object, "range", range);
			if (patch->value) jsonAdd(object, "value", patch->value);
			break;
		}
		case ERM_SET:
			jsonAdd(object, "type", jsonString("set"));
			jsonAdd(object, "path", patch->path);
			jsonAdd(object, "key", patch->key);
			if (patch->value) jsonAdd(object, "value", patch->value);
			break;
	}
	return object;
}

// changes ------------------------------------------------------------------------

ErmRef ermRefOf(const ErmChange *change) {
	return (ErmRef){ change->node, change->time };
}

Json *ermRefToJson(ErmRef ref) {
	Json *object = jsonObject();
	jsonAdd(object, "node", jsonString(ref.node));
	jsonAdd(object, "time", jsonInteger(ref.time));
	return object;
}

Json *ermRefsToJson(const ErmRefs *refs) {
	Json *list = jsonArray();
	for (int i = 0; i < refs->count; i++) jsonPush(list, ermRefToJson(refs->items[i]));
	return list;
}

Json *ermChangeToJson(const ErmChange *change) {
	Json *object = jsonObject();
	jsonAdd(object, "node", jsonString(change->node));
	jsonAdd(object, "time", jsonInteger(change->time));
	switch (change->kind) {
		case ERM_MAKE:
			jsonAdd(object, "kind", jsonString("make"));
			jsonAdd(object, "value", change->value);
			if (change->data) jsonAdd(object, "data", change->data);
			break;
		case ERM_WRITE: {
			jsonAdd(object, "kind", jsonString("write"));
			Json *patches = jsonArray();
			for (int i = 0; i < change->patches.count; i++) jsonPush(patches, ermPatchToJson(&change->patches.items[i]));
			jsonAdd(object, "patches", patches);
			break;
		}
		case ERM_PLACE:
			jsonAdd(object, "kind", jsonString("place"));
			jsonAdd(object, "name", jsonString(change->name));
			jsonAdd(object, "id", jsonString(change->id));
			if (change->hasPosition) jsonAdd(object, "position", jsonInteger(change->position));
			break;
		case ERM_UNPLACE:
			jsonAdd(object, "kind", jsonString("unplace"));
			jsonAdd(object, "name", jsonString(change->name));
			jsonAdd(object, "id", jsonString(change->id));
			break;
	}
	jsonAdd(object, "agent", change->agent ? change->agent : jsonNull());
	if (change->process) jsonAdd(object, "process", jsonString(change->process));
	if (change->cause) jsonAdd(object, "cause", change->cause);
	if (change->site) jsonAdd(object, "site", change->site);
	return object;
}

Json *ermChangesToJson(const ErmChanges *changes) {
	Json *list = jsonArray();
	for (int i = 0; i < changes->count; i++) jsonPush(list, ermChangeToJson(changes->items[i]));
	return list;
}

Json *ermAppliedToJson(const ErmApplied *applied) {
	Json *object = jsonObject();
	jsonAdd(object, "change", ermChangeToJson(applied->change));
	Json *marked = jsonArray();
	for (int i = 0; i < applied->marked.count; i++) {
		Json *mark = jsonObject();
		jsonAdd(mark, "process", jsonString(applied->marked.items[i]));
		jsonAdd(mark, "by", ermRefToJson(ermRefOf(applied->change)));
		jsonPush(marked, mark);
	}
	jsonAdd(object, "marked", marked);
	return object;
}

// acting -------------------------------------------------------------------------

ErmStamp ermNoStamp(void) {
	return (ErmStamp){ NULL, NULL, 0 };
}

ErmCtx ermOutsideCtx(Json *agent, const char *process, ErmPath path) {
	return (ErmCtx){ agent, process, path, ERM_READ_WRITE, 0 };
}

ErmCtx ermHostCtx(void) {
	return (ErmCtx){ jsonNull(), NULL, { 0 }, ERM_READ_WRITE, 0 };
}

// operations ---------------------------------------------------------------------

ErmOp ermOpMake(Json *id, Json *value, Json *data) {
	return (ErmOp){ .kind = ERM_OP_MAKE, .id = id, .value = value, .data = data };
}

ErmOp ermOpRead(Json *node) {
	return (ErmOp){ .kind = ERM_OP_READ, .node = node };
}

ErmOp ermOpData(Json *node) {
	return (ErmOp){ .kind = ERM_OP_DATA, .node = node };
}

ErmOp ermOpDirectory(Json *node, Json *name) {
	return (ErmOp){ .kind = ERM_OP_DIRECTORY, .node = node, .name = name };
}

ErmOp ermOpLookup(Json *name) {
	return (ErmOp){ .kind = ERM_OP_LOOKUP, .name = name };
}

ErmOp ermOpWrite(Json *node, Json *patches) {
	return (ErmOp){ .kind = ERM_OP_WRITE, .node = node, .patches = patches };
}

ErmOp ermOpPlace(Json *parent, Json *name, Json *id, Json *position) {
	return (ErmOp){ .kind = ERM_OP_PLACE, .parent = parent, .name = name, .id = id, .position = position };
}

ErmOp ermOpUnplace(Json *parent, Json *name, Json *id) {
	return (ErmOp){ .kind = ERM_OP_UNPLACE, .parent = parent, .name = name, .id = id };
}

const char *ermOpName(ErmOpKind kind) {
	switch (kind) {
		case ERM_OP_MAKE: return "make";
		case ERM_OP_READ: return "read";
		case ERM_OP_DATA: return "data";
		case ERM_OP_DIRECTORY: return "directory";
		case ERM_OP_LOOKUP: return "lookup";
		case ERM_OP_WRITE: return "write";
		case ERM_OP_PLACE: return "place";
		case ERM_OP_UNPLACE: return "unplace";
	}
	return "unknown";
}

Json *ermOpNode(const ErmOp *op) {
	switch (op->kind) {
		case ERM_OP_MAKE: return op->id;
		case ERM_OP_READ:
		case ERM_OP_DATA:
		case ERM_OP_DIRECTORY:
		case ERM_OP_WRITE: return op->node;
		case ERM_OP_LOOKUP: return NULL;
		case ERM_OP_PLACE:
		case ERM_OP_UNPLACE: return op->parent;
	}
	return NULL;
}

bool ermOpIsChange(ErmOpKind kind) {
	return kind == ERM_OP_MAKE || kind == ERM_OP_WRITE || kind == ERM_OP_PLACE || kind == ERM_OP_UNPLACE;
}

// records ------------------------------------------------------------------------

const char *ermEndingText(ErmEnding ending) {
	switch (ending) {
		case ERM_DONE: return "done";
		case ERM_PENDING: return "pending";
		case ERM_FAILED: return "failed";
		case ERM_REFUSED_ENDING: return "refused";
	}
	return "failed";
}

static Json *sawToJson(ErmTime saw) {
	return saw ? jsonInteger(saw) : jsonNull();
}

static Json *programToJson(const ErmProgramSeen *program) {
	Json *object = jsonObject();
	jsonAdd(object, "node", jsonString(program->node));
	if (program->refused) jsonAdd(object, "refused", jsonBoolean(true));
	else if (program->saw) jsonAdd(object, "saw", jsonInteger(program->saw));
	else jsonAdd(object, "absent", jsonBoolean(true));
	jsonAdd(object, "slot", ermIdsToJson(&program->slot));
	return object;
}

static Json *searchedToJson(const ErmSearchedList *searched) {
	Json *list = jsonArray();
	for (int i = 0; i < searched->count; i++) {
		const ErmSearched *entry = &searched->items[i];
		Json *object = jsonObject();
		jsonAdd(object, "node", jsonString(entry->node));
		if (entry->refused) jsonAdd(object, "refused", jsonBoolean(true));
		else jsonAdd(object, "saw", sawToJson(entry->saw));
		jsonPush(list, object);
	}
	return list;
}

Json *ermRecordToJson(const ErmRecord *record) {
	Json *object = jsonObject();
	jsonAdd(object, "process", jsonString(record->process));
	jsonAdd(object, "run", jsonInteger(record->run));
	jsonAdd(object, "agent", record->agent ? record->agent : jsonNull());
	jsonAdd(object, "marked", ermRefsToJson(&record->marked));
	if (record->hasCompute) jsonAdd(object, "compute", programToJson(&record->compute));
	if (record->hasEffect) jsonAdd(object, "effect", programToJson(&record->effect));
	Json *lookups = jsonArray();
	for (int i = 0; i < record->lookups.count; i++) {
		const ErmLookupEntry *entry = &record->lookups.items[i];
		Json *lookup = jsonObject();
		jsonAdd(lookup, "name", jsonString(entry->name));
		jsonAdd(lookup, "searched", searchedToJson(&entry->searched));
		jsonAdd(lookup, "found", ermIdsToJson(&entry->found));
		jsonPush(lookups, lookup);
	}
	jsonAdd(object, "lookups", lookups);
	Json *reads = jsonArray();
	for (int i = 0; i < record->reads.count; i++) {
		Json *read = jsonObject();
		jsonAdd(read, "node", jsonString(record->reads.items[i].node));
		jsonAdd(read, "saw", sawToJson(record->reads.items[i].saw));
		jsonPush(reads, read);
	}
	jsonAdd(object, "reads", reads);
	Json *directories = jsonArray();
	for (int i = 0; i < record->directories.count; i++) {
		const ErmDirEntry *entry = &record->directories.items[i];
		Json *directory = jsonObject();
		jsonAdd(directory, "node", jsonString(entry->node));
		if (entry->name) jsonAdd(directory, "name", jsonString(entry->name));
		jsonAdd(directory, "saw", sawToJson(entry->saw));
		jsonPush(directories, directory);
	}
	jsonAdd(object, "directories", directories);
	if (record->value) jsonAdd(object, "value", record->value);
	jsonAdd(object, "cleanup", ermRefsToJson(&record->cleanup));
	jsonAdd(object, "changes", ermRefsToJson(&record->changes));
	jsonAdd(object, "ending", jsonString(ermEndingText(record->ending)));
	Json *errors = jsonArray();
	for (int i = 0; i < record->errors.count; i++) jsonPush(errors, ermErrToJson(record->errors.items[i]));
	jsonAdd(object, "errors", errors);
	return object;
}

Json *ermEventToJson(const ErmEvent *event) {
	Json *object = jsonObject();
	if (event->change) jsonAdd(object, "change", ermChangeToJson(event->change));
	else jsonAdd(object, "record", ermRecordToJson(event->record));
	return object;
}

// apis ---------------------------------------------------------------------------

ErmApi ermBind(ErmInterface iface, ErmCtx ctx) {
	return (ErmApi){ iface, ctx };
}

ErmErr ermApiOp(ErmApi api, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	ErmStamp none = ermNoStamp();
	return api.iface.vt->op(api.iface.self, &api.ctx, stamp ? stamp : &none, op, out);
}

static ErmErr applied(ErmApi api, const ErmStamp *stamp, ErmOp op, ErmApplied *out) {
	ErmResult result = { 0 };
	ErmErr err = ermApiOp(api, stamp, &op, &result);
	if (!err.kind && out) *out = result.applied;
	return err;
}

ErmErr ermApiMake(ErmApi api, const ErmStamp *stamp, Json *id, Json *value, Json *data, ErmApplied *out) {
	return applied(api, stamp, ermOpMake(id, value, data), out);
}

ErmErr ermApiRead(ErmApi api, Json *node, Json **value, ErmTime *time) {
	ErmResult result = { 0 };
	ErmOp op = ermOpRead(node);
	ErmErr err = ermApiOp(api, NULL, &op, &result);
	if (!err.kind) {
		if (value) *value = result.value;
		if (time) *time = result.time;
	}
	return err;
}

ErmErr ermApiData(ErmApi api, Json *node, Json **data) {
	ErmResult result = { 0 };
	ErmOp op = ermOpData(node);
	ErmErr err = ermApiOp(api, NULL, &op, &result);
	if (!err.kind && data) *data = result.data;
	return err;
}

ErmErr ermApiDirectory(ErmApi api, Json *node, Json *name, ErmResult *out) {
	ErmOp op = ermOpDirectory(node, name);
	return ermApiOp(api, NULL, &op, out);
}

ErmErr ermApiLookup(ErmApi api, Json *name, ErmResult *out) {
	ErmOp op = ermOpLookup(name);
	return ermApiOp(api, NULL, &op, out);
}

ErmErr ermApiWrite(ErmApi api, const ErmStamp *stamp, Json *node, Json *patches, ErmApplied *out) {
	return applied(api, stamp, ermOpWrite(node, patches), out);
}

ErmErr ermApiPlace(ErmApi api, const ErmStamp *stamp, Json *parent, Json *name, Json *id, Json *position, ErmApplied *out) {
	return applied(api, stamp, ermOpPlace(parent, name, id, position), out);
}

ErmErr ermApiUnplace(ErmApi api, const ErmStamp *stamp, Json *parent, Json *name, Json *id, ErmApplied *out) {
	return applied(api, stamp, ermOpUnplace(parent, name, id), out);
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

/** the slot of the index holding the live entry for key, or -1 */
static int findSlot(const ErmMap *map, const char *key) {
	if (!map->indexSize) return -1;
	int mask = map->indexSize - 1;
	for (int slot = (int)(hashOf(key) & (uint64_t)mask);; slot = (slot + 1) & mask) {
		int entry = map->index[slot];
		if (entry == -1) return -1;
		if (entry >= 0 && map->entries[entry].live && strcmp(map->entries[entry].key, key) == 0) return slot;
	}
}

static void reindex(ErmMap *map, int size) {
	free(map->index);
	map->indexSize = size;
	map->index = allocate((size_t)size * sizeof *map->index);
	for (int i = 0; i < size; i++) map->index[i] = -1;
	int mask = size - 1;
	for (int e = 0; e < map->count; e++) {
		if (!map->entries[e].live) continue;
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
	map->entries[map->count] = (ErmMapEntry){ copyString(key), value, true };
	map->count++;
	map->live++;
	// entries (dead ones included, since index slots keep them) at most half the index
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

bool ermMapRemove(ErmMap *map, const char *key) {
	int slot = findSlot(map, key);
	if (slot < 0) return false;
	map->entries[map->index[slot]].live = false; // the index slot keeps pointing at it, as a tombstone
	map->live--;
	return true;
}
