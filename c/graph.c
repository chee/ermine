// graph.c: the bare graph. CORE.tex "The core": Nodes, Patches, Changes,
// Placement, Processes and lookup, Operations, Records. PROTOCOL.tex
// Encodings, Records. Owner: the Graph agent.
//
// What the graph keeps:
// - nodes by id: value, fixed data (null when not given), directory (slots
//   in code point order of their names, each non-empty, ids unique in a slot),
//   and the time of its latest change;
// - the last time in the graph;
// - each process's remembered reads, from the run with its current tag:
//   node values, single slots (node, name) and whole directories;
// - subscriptions, numbered from 1, in the order made;
// - the next run tag, and the top of the stack.
//
// Sharing: a node's value and directory are never changed in place once
// they have been handed out. A write builds the new value by copying only
// the containers along each patch's path (jsonShallow) and swaps the
// pointer; a placement builds a new slot list and a new ids list for the
// slot it changes. So results (value, slot ids, whole directory) can share
// the node's own memory.
//
// Readings (see also ermine.h CONVENTIONS and ../haskell/NOTES.md):
// - A change's time must be given and greater than every time in the graph;
//   the time check comes before the node checks. A failed op uses no time.
// - Modes: READ_ONLY rejects make/write/place/unplace; WRITE_ONLY rejects
//   read/data/directory/lookup. Both are invalid.
// - A make marks readers of the node's value, of its whole directory and of
//   any slot of it (they all read it absent).
// - A place/unplace of name s in p marks readers of slot (p, s) and of p's
//   whole directory; not readers of p's value.
// - Place: the parent must exist; the placed id may be absent. A position k
//   is where the id ends up: with r the slot without the id, 0 <= k <=
//   |r| + 1, and k > |r| puts it at the end; anything further is invalid.
//   Without a position a new id goes at the end and one already there stays.
// - Unplace: invalid when the parent is absent or the id is not in the slot.
// - Lookup: the parent of each path step, last to first; each slot read
//   goes through the top with the lookup's own ctx. A refusal ends the
//   search (listed last, refused, not remembered: protect refused before
//   the graph saw it), and the lookup still succeeds. Any other error of
//   such a read is the lookup's error.
// - data is not remembered as a read (fixed data never changes).
// - Subscribing to an absent id is allowed; it receives the node's making.
// - Recording: logs as ermine.h RECORDING says. Once finished, every api of
//   the recording (api, quiet and every `with`) answers invalid "the run has
//   ended", and that error is not logged.

#include "ermine.h"

#include <stdlib.h>
#include <string.h>

// ===========================================================================
// state

typedef struct Node {
	Json *value;
	Json *data; // fixed data: a JSON null when not given
	ErmSlots dir; // names in code point order; replaced, never changed in place, once handed out
	ErmTime time; // the latest change
} Node;

/** one process's remembered reads, from the run with this tag */
typedef struct Reads {
	int64_t tag;
	ErmMap nodes; // node id -> (void *)1
	ErmMap dirs;  // node id -> (void *)1
	ErmMap slots; // node id -> ErmMap * (name -> (void *)1)
} Reads;

typedef struct Sub {
	int64_t number;
	const char *node;
	ErmEventFn fn;
	void *data;
	bool live;
} Sub;

typedef struct Graph {
	ErmInterface self; // this graph's own interface: the top until setTop
	ErmInterface top;  // told by setTop; lookups read each slot through it
	ErmMap nodes;      // id -> Node *
	ErmTime last;      // the latest time in the graph; 0 when none
	ErmMap reads;      // process id -> Reads *
	ERM_LIST(Sub) subs;
	int64_t nextSub;
	int64_t nextTag;
} Graph;

static void *const YES = (void *)1;

static Node *nodeOf(Graph *graph, const char *id) {
	return ermMapGet(&graph->nodes, id);
}

// ===========================================================================
// remembered reads

typedef enum { REMEMBER_NODE, REMEMBER_SLOT, REMEMBER_DIR } RememberKind;

/** remembers a read for marking, when the ctx is a current READ_ONLY run (ermine.h REMEMBERED READS) */
static void remember(Graph *graph, const ErmCtx *ctx, RememberKind kind, const char *node, const char *name) {
	if (ctx->mode != ERM_READ_ONLY || !ctx->process || !ctx->run) return;
	Reads *reads = ermMapGet(&graph->reads, ctx->process);
	if (!reads || reads->tag != ctx->run) return;
	switch (kind) {
		case REMEMBER_NODE:
			ermMapPut(&reads->nodes, node, YES);
			break;
		case REMEMBER_DIR:
			ermMapPut(&reads->dirs, node, YES);
			break;
		case REMEMBER_SLOT: {
			ErmMap *names = ermMapGet(&reads->slots, node);
			if (!names) {
				names = allocate(sizeof *names);
				ermMapPut(&reads->slots, node, names);
			}
			ermMapPut(names, name, YES);
			break;
		}
	}
}

/**
 * Whether a change of this kind to node `id` (name: the placement's slot)
 * marks these reads (CORE Changes). A making also marks readers of the
 * directory, or of a slot of it, while it was absent.
 */
static bool marks(const Reads *reads, ErmChangeKind kind, const char *id, const char *name) {
	bool value = ermMapHas(&reads->nodes, id);
	bool dir = ermMapHas(&reads->dirs, id);
	ErmMap *names = ermMapGet(&reads->slots, id);
	switch (kind) {
		case ERM_MAKE: return value || dir || (names && names->live > 0);
		case ERM_WRITE: return value;
		case ERM_PLACE:
		case ERM_UNPLACE: return dir || (names && ermMapHas(names, name));
	}
	return false;
}

// ===========================================================================
// directories

/** the index of the slot named `name`, or -1 */
static int slotIndex(const ErmSlots *dir, const char *name) {
	for (int i = 0; i < dir->count; i++) {
		if (strcmp(dir->items[i].name, name) == 0) return i;
	}
	return -1;
}

/** a new directory: `dir` with the slot `name` holding `ids` (gone when empty); `dir` is not changed */
static ErmSlots withSlot(const ErmSlots *dir, const char *name, ErmIds ids) {
	ErmSlots out = { 0 };
	bool placed = false;
	for (int i = 0; i < dir->count; i++) {
		int order = textCompare(dir->items[i].name, name);
		if (order == 0) {
			if (ids.count) ERM_PUSH(out, ((ErmSlot){ dir->items[i].name, ids }));
			placed = true;
			continue;
		}
		if (order > 0 && !placed) {
			if (ids.count) ERM_PUSH(out, ((ErmSlot){ name, ids }));
			placed = true;
		}
		ERM_PUSH(out, dir->items[i]);
	}
	if (!placed && ids.count) ERM_PUSH(out, ((ErmSlot){ name, ids }));
	return out;
}

// ===========================================================================
// patches (CORE Patches)

/** applies one splice or set to `target`, the value at the end of the path; *out is a new value */
static ErmErr applyAtTarget(const ErmPatch *patch, Json *target, Json **out) {
	if (patch->type == ERM_SPLICE) {
		int64_t from = patch->from, to = patch->to;
		if (jsonIsString(target)) {
			size_t count = utf8Count(target->string, target->stringLength);
			if (from > to || (uint64_t)to > count) return ermInvalid("the range is outside the string");
			if (patch->value && !jsonIsString(patch->value)) return ermInvalid("a splice of a string takes a string");
			size_t start = utf8Offset(target->string, target->stringLength, (size_t)from);
			size_t end = utf8Offset(target->string, target->stringLength, (size_t)to);
			size_t middle = patch->value ? patch->value->stringLength : 0;
			size_t length = start + middle + (target->stringLength - end);
			char *bytes = allocate(length + 1);
			memcpy(bytes, target->string, start);
			if (middle) memcpy(bytes + start, patch->value->string, middle);
			memcpy(bytes + start + middle, target->string + end, target->stringLength - end);
			*out = jsonStringOfLength(bytes, length);
			free(bytes);
			return ermOk();
		}
		if (jsonIsArray(target)) {
			if (from > to || to > target->array.count) return ermInvalid("the range is outside the list");
			if (patch->value && !jsonIsArray(patch->value)) return ermInvalid("a splice of a list takes a list");
			Json *list = jsonArray();
			for (int i = 0; i < from; i++) jsonPush(list, target->array.items[i]);
			if (patch->value) {
				for (int i = 0; i < patch->value->array.count; i++) jsonPush(list, patch->value->array.items[i]);
			}
			for (int i = (int)to; i < target->array.count; i++) jsonPush(list, target->array.items[i]);
			*out = list;
			return ermOk();
		}
		return ermInvalid("a splice needs a string or a list");
	}
	// ERM_SET
	if (!jsonIsObject(target)) return ermInvalid("a set needs an object");
	Json *object = jsonShallow(target);
	if (patch->value) jsonSet(object, patch->key->string, patch->key->stringLength, patch->value);
	else jsonRemove(object, patch->key->string, patch->key->stringLength);
	*out = object;
	return ermOk();
}

/** follows the patch's path from key `at`, copying each container on the way; *out is the new `value` */
static ErmErr applyAt(const ErmPatch *patch, int at, Json *value, Json **out) {
	if (at == patch->path->array.count) return applyAtTarget(patch, value, out);
	Json *key = patch->path->array.items[at];
	int64_t index;
	if (jsonIsString(key)) {
		if (!jsonIsObject(value)) return ermInvalid("the path is not there");
		Json *child = jsonGetOfLength(value, key->string, key->stringLength);
		if (!child) return ermInvalid("the path has no key %s", key->string);
		Json *changed;
		ErmErr err = applyAt(patch, at + 1, child, &changed);
		if (err.kind) return err;
		Json *copy = jsonShallow(value);
		jsonSet(copy, key->string, key->stringLength, changed);
		*out = copy;
		return ermOk();
	}
	if (jsonIsWhole(key, &index) && jsonIsArray(value)) {
		if (index < 0 || index >= value->array.count) return ermInvalid("the path's index is outside the list");
		Json *changed;
		ErmErr err = applyAt(patch, at + 1, value->array.items[index], &changed);
		if (err.kind) return err;
		Json *copy = jsonShallow(value);
		copy->array.items[index] = changed;
		*out = copy;
		return ermOk();
	}
	return ermInvalid("the path is not there");
}

/** applies the patches in order to `value`; nothing shared is changed. Invalid at the first that does not apply. */
static ErmErr applyPatches(const ErmPatches *patches, Json *value, Json **out) {
	Json *current = value;
	for (int i = 0; i < patches->count; i++) {
		const ErmPatch *patch = &patches->items[i];
		if (patch->type == ERM_SNAPSHOT) {
			current = patch->value;
			continue;
		}
		ErmErr err = applyAt(patch, 0, current, &current);
		if (err.kind) return err;
	}
	*out = current;
	return ermOk();
}

// ===========================================================================
// changes

/** sends an event to the subscribers of `node`, in subscription order */
static void send(Graph *graph, const char *node, const ErmEvent *event) {
	for (int i = 0; i < graph->subs.count; i++) {
		Sub sub = graph->subs.items[i];
		if (sub.live && strcmp(sub.node, node) == 0) sub.fn(sub.data, event);
	}
}

/** the time check every change makes first (CORE Changes) */
static ErmErr checkTime(Graph *graph, const ErmStamp *stamp) {
	if (stamp->time == ERM_NO_TIME) return ermInvalid("a change needs a time");
	if (stamp->time <= graph->last) {
		return ermInvalid("the time %lld is not greater than every time in the graph", (long long)stamp->time);
	}
	return ermOk();
}

/**
 * Applies a change whose node state has already been built: sets the node,
 * the last time, marks, sends it to subscribers, and fills out->applied.
 */
static void commit(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, ErmChange *change, Node *node, ErmResult *out) {
	change->time = stamp->time;
	change->agent = ctx->agent ? ctx->agent : jsonNull();
	change->process = ctx->process;
	change->cause = stamp->cause;
	change->site = stamp->site;
	node->time = stamp->time;
	ermMapPut(&graph->nodes, change->node, node);
	graph->last = stamp->time;
	ErmIds marked = { 0 };
	for (int i = 0; i < graph->reads.count; i++) {
		const ErmMapEntry *entry = &graph->reads.entries[i];
		if (!entry->live) continue;
		if (ctx->process && strcmp(ctx->process, entry->key) == 0) continue;
		if (marks(entry->value, change->kind, change->node, change->name)) ERM_PUSH(marked, entry->key);
	}
	ermIdsSort(&marked);
	ErmEvent event = { change, NULL };
	send(graph, change->node, &event);
	out->applied = (ErmApplied){ change, marked };
}

static ErmErr textOf(Json *value, const char *what, const char **out) {
	*out = jsonText(value);
	if (!*out) return ermInvalid("the %s must be a string", what);
	return ermOk();
}

#define TRY(expression) \
	do { \
		ErmErr tried = (expression); \
		if (tried.kind) return tried; \
	} while (0)

static ErmErr opMake(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	const char *id;
	TRY(textOf(op->id, "id", &id));
	if (!op->value) return ermInvalid("a make needs a value");
	TRY(checkTime(graph, stamp));
	if (nodeOf(graph, id)) return ermInvalid("a node with id %s exists", id);
	Node *node = allocate(sizeof *node);
	node->value = op->value;
	node->data = op->data ? op->data : jsonNull();
	ErmChange *change = allocate(sizeof *change);
	change->node = id;
	change->kind = ERM_MAKE;
	change->value = op->value;
	change->data = op->data;
	commit(graph, ctx, stamp, change, node, out);
	return ermOk();
}

static ErmErr opWrite(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	const char *id;
	ErmPatches patches;
	TRY(textOf(op->node, "node", &id));
	TRY(ermPatchesFrom(op->patches, &patches));
	TRY(checkTime(graph, stamp));
	Node *node = nodeOf(graph, id);
	if (!node) return ermInvalid("no node has the id %s", id);
	Json *value;
	TRY(applyPatches(&patches, node->value, &value));
	node->value = value;
	ErmChange *change = allocate(sizeof *change);
	change->node = id;
	change->kind = ERM_WRITE;
	change->patches = patches;
	commit(graph, ctx, stamp, change, node, out);
	return ermOk();
}

static ErmErr opPlace(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	const char *parent, *name, *id;
	int64_t position = 0;
	TRY(textOf(op->parent, "parent", &parent));
	TRY(textOf(op->name, "name", &name));
	TRY(textOf(op->id, "id", &id));
	if (op->position && (!jsonIsWhole(op->position, &position) || position < 0)) {
		return ermInvalid("a position must be a whole number");
	}
	TRY(checkTime(graph, stamp));
	Node *node = nodeOf(graph, parent);
	if (!node) return ermInvalid("no node has the id %s", parent);
	int at = slotIndex(&node->dir, name);
	ErmIds empty = { 0 };
	const ErmIds *slot = at >= 0 ? &node->dir.items[at].ids : &empty;
	bool there = ermIdsHas(slot, id);
	ErmIds rest = { 0 };
	for (int i = 0; i < slot->count; i++) {
		if (strcmp(slot->items[i], id) != 0) ERM_PUSH(rest, slot->items[i]);
	}
	ErmIds ids = { 0 };
	if (!op->position) {
		if (there) {
			ids = *slot; // unchanged; still a change
		} else {
			ids = rest;
			ERM_PUSH(ids, id);
		}
	} else {
		if (position > rest.count + 1) return ermInvalid("the position is past the end of the slot");
		for (int i = 0; i < rest.count; i++) {
			if (i == position) ERM_PUSH(ids, id);
			ERM_PUSH(ids, rest.items[i]);
		}
		if (position >= rest.count) ERM_PUSH(ids, id);
	}
	node->dir = withSlot(&node->dir, name, ids);
	ErmChange *change = allocate(sizeof *change);
	change->node = parent;
	change->kind = ERM_PLACE;
	change->name = name;
	change->id = id;
	change->hasPosition = op->position != NULL;
	change->position = position;
	commit(graph, ctx, stamp, change, node, out);
	return ermOk();
}

static ErmErr opUnplace(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	const char *parent, *name, *id;
	TRY(textOf(op->parent, "parent", &parent));
	TRY(textOf(op->name, "name", &name));
	TRY(textOf(op->id, "id", &id));
	TRY(checkTime(graph, stamp));
	Node *node = nodeOf(graph, parent);
	if (!node) return ermInvalid("no node has the id %s", parent);
	int at = slotIndex(&node->dir, name);
	if (at < 0 || !ermIdsHas(&node->dir.items[at].ids, id)) return ermInvalid("%s is not in the slot %s", id, name);
	const ErmIds *slot = &node->dir.items[at].ids;
	ErmIds ids = { 0 };
	for (int i = 0; i < slot->count; i++) {
		if (strcmp(slot->items[i], id) != 0) ERM_PUSH(ids, slot->items[i]);
	}
	node->dir = withSlot(&node->dir, name, ids);
	ErmChange *change = allocate(sizeof *change);
	change->node = parent;
	change->kind = ERM_UNPLACE;
	change->name = name;
	change->id = id;
	commit(graph, ctx, stamp, change, node, out);
	return ermOk();
}

// ===========================================================================
// reads

static ErmErr opRead(Graph *graph, const ErmCtx *ctx, const ErmOp *op, ErmResult *out) {
	const char *id;
	TRY(textOf(op->node, "node", &id));
	remember(graph, ctx, REMEMBER_NODE, id, NULL);
	Node *node = nodeOf(graph, id);
	out->value = node ? node->value : NULL;
	out->time = node ? node->time : 0;
	return ermOk();
}

static ErmErr opData(Graph *graph, const ErmOp *op, ErmResult *out) {
	const char *id;
	TRY(textOf(op->node, "node", &id));
	Node *node = nodeOf(graph, id);
	out->data = node ? node->data : NULL;
	return ermOk();
}

static ErmErr opDirectory(Graph *graph, const ErmCtx *ctx, const ErmOp *op, ErmResult *out) {
	const char *id, *name = NULL;
	TRY(textOf(op->node, "node", &id));
	if (op->name) TRY(textOf(op->name, "name", &name));
	remember(graph, ctx, name ? REMEMBER_SLOT : REMEMBER_DIR, id, name);
	Node *node = nodeOf(graph, id);
	if (!node) {
		out->listing = ERM_LIST_ABSENT;
		out->time = 0;
		return ermOk();
	}
	out->time = node->time;
	if (name) {
		int at = slotIndex(&node->dir, name);
		out->listing = ERM_LIST_SLOT;
		out->slot = at >= 0 ? node->dir.items[at].ids : (ErmIds){ 0 };
	} else {
		out->listing = ERM_LIST_WHOLE;
		out->whole = node->dir;
	}
	return ermOk();
}

/** CORE Lookup: the parent of each path step, last to first; the nearest non-empty slot with the name */
static ErmErr opLookup(Graph *graph, const ErmCtx *ctx, const ErmOp *op, ErmResult *out) {
	const char *name;
	TRY(textOf(op->name, "name", &name));
	ErmInterface top = graph->top.vt ? graph->top : graph->self;
	ErmStamp none = ermNoStamp();
	ErmSearchedList searched = { 0 };
	ErmIds found = { 0 };
	Json *nameJson = jsonString(name);
	for (int i = ctx->path.count - 1; i >= 0; i--) {
		const char *parent = ctx->path.items[i].parent;
		ErmOp read = ermOpDirectory(jsonString(parent), nameJson);
		ErmResult result = { 0 };
		ErmErr err = top.vt->op(top.self, ctx, &none, &read, &result);
		if (err.kind == ERM_REFUSED) {
			ERM_PUSH(searched, ((ErmSearched){ parent, 0, true }));
			break;
		}
		if (err.kind) return err;
		ERM_PUSH(searched, ((ErmSearched){ parent, result.time, false }));
		if (result.listing == ERM_LIST_SLOT && result.slot.count > 0) {
			found = result.slot;
			break;
		}
	}
	out->found = found;
	out->searched = searched;
	return ermOk();
}

// ===========================================================================
// the operation

/** CORE Operations: make, read, data, directory, lookup, write, place, unplace */
static ErmErr graphOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	Graph *graph = self;
	ErmStamp none = ermNoStamp();
	if (!stamp) stamp = &none;
	if (ermOpIsChange(op->kind)) {
		if (ctx->mode == ERM_READ_ONLY) return ermInvalid("this interface only reads");
	} else if (ctx->mode == ERM_WRITE_ONLY) {
		return ermInvalid("this interface only writes");
	}
	switch (op->kind) {
		case ERM_OP_MAKE: return opMake(graph, ctx, stamp, op, out);
		case ERM_OP_WRITE: return opWrite(graph, ctx, stamp, op, out);
		case ERM_OP_PLACE: return opPlace(graph, ctx, stamp, op, out);
		case ERM_OP_UNPLACE: return opUnplace(graph, ctx, stamp, op, out);
		case ERM_OP_READ: return opRead(graph, ctx, op, out);
		case ERM_OP_DATA: return opData(graph, op, out);
		case ERM_OP_DIRECTORY: return opDirectory(graph, ctx, op, out);
		case ERM_OP_LOOKUP: return opLookup(graph, ctx, op, out);
	}
	return ermInvalid("unknown operation");
}

// ===========================================================================
// subscriptions

/** CORE Operations: subscribe(node); an absent node may be subscribed to */
static ErmErr graphSubscribe(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub) {
	(void)ctx;
	Graph *graph = self;
	const char *id;
	TRY(textOf(node, "node", &id));
	int64_t number = graph->nextSub++;
	ERM_PUSH(graph->subs, ((Sub){ number, id, fn, data, true }));
	*sub = number;
	return ermOk();
}

/** CORE Operations: unsubscribe; an unknown number is invalid */
static ErmErr graphUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	(void)ctx;
	Graph *graph = self;
	for (int i = 0; i < graph->subs.count; i++) {
		if (graph->subs.items[i].live && graph->subs.items[i].number == sub) {
			graph->subs.items[i].live = false;
			return ermOk();
		}
	}
	return ermInvalid("no subscription has that number");
}

// ===========================================================================
// recordings (ermine.h RECORDING)

/** an interface over `inner` that belongs to one run: answers invalid once the run has ended, and logs when `log` */
typedef struct RunApi {
	ErmInterface inner;
	ErmRecording *recording;
	bool log;
} RunApi;

static void logOp(ErmRecord *record, const ErmOp *op, ErmErr err, const ErmResult *result) {
	if (err.kind) {
		ERM_PUSH(record->errors, ermWithOp(err, ermOpName(op->kind)));
		return;
	}
	switch (op->kind) {
		case ERM_OP_READ:
			ERM_PUSH(record->reads, ((ErmReadEntry){ jsonText(op->node), result->time }));
			break;
		case ERM_OP_DIRECTORY:
			ERM_PUSH(record->directories,
			         ((ErmDirEntry){ jsonText(op->node), op->name ? jsonText(op->name) : NULL, result->time }));
			break;
		case ERM_OP_LOOKUP:
			ERM_PUSH(record->lookups, ((ErmLookupEntry){ jsonText(op->name), result->searched, result->found }));
			break;
		case ERM_OP_MAKE:
		case ERM_OP_WRITE:
		case ERM_OP_PLACE:
		case ERM_OP_UNPLACE:
			ERM_PUSH(record->changes, ermRefOf(result->applied.change));
			break;
		case ERM_OP_DATA:
			break;
	}
}

static ErmErr runOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("the run has ended");
	ErmErr err = run->inner.vt->op(run->inner.self, ctx, stamp, op, out);
	if (run->log) logOp(&run->recording->record, op, err, out);
	return err;
}

static ErmErr runSubscribe(void *self, const ErmCtx *ctx, Json *node, ErmEventFn fn, void *data, int64_t *sub) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("the run has ended");
	return run->inner.vt->subscribe(run->inner.self, ctx, node, fn, data, sub);
}

static ErmErr runUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("the run has ended");
	return run->inner.vt->unsubscribe(run->inner.self, ctx, sub);
}

static ErmRecording *runRecord(void *self, ErmApi api, int64_t number, const ErmRefs *marked) {
	RunApi *run = self;
	return run->inner.vt->record(run->inner.self, api, number, marked);
}

static ErmRecord *runFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	RunApi *run = self;
	return run->inner.vt->finish(run->inner.self, recording, ending);
}

static void runSetTop(void *self, ErmInterface top) {
	RunApi *run = self;
	run->inner.vt->setTop(run->inner.self, top);
}

static const ErmVtable runVtable = {
	runOp, runSubscribe, runUnsubscribe, runRecord, runFinish, runSetTop,
};

static ErmApi runApi(ErmRecording *recording, ErmApi api, bool log) {
	RunApi *run = allocate(sizeof *run);
	run->inner = api.iface;
	run->recording = recording;
	run->log = log;
	ErmCtx ctx = api.ctx;
	ctx.run = recording->tag;
	return ermBind((ErmInterface){ &runVtable, run }, ctx);
}

static ErmApi recordingWith(ErmRecording *recording, ErmApi other) {
	return runApi(recording, other, true);
}

/** CORE Operations: record(api, changes) */
static ErmRecording *graphRecord(void *self, ErmApi api, int64_t run, const ErmRefs *marked) {
	Graph *graph = self;
	ErmRecording *recording = allocate(sizeof *recording);
	recording->tag = graph->nextTag++;
	recording->graph = graph;
	recording->with = recordingWith;
	if (api.ctx.mode == ERM_READ_ONLY && api.ctx.process) {
		Reads *reads = allocate(sizeof *reads);
		reads->tag = recording->tag;
		ermMapPut(&graph->reads, api.ctx.process, reads);
	}
	recording->api = runApi(recording, api, true);
	recording->quiet = runApi(recording, api, false);
	recording->record.process = api.ctx.process;
	recording->record.run = run;
	recording->record.agent = api.ctx.agent;
	if (marked) {
		for (int i = 0; i < marked->count; i++) ERM_PUSH(recording->record.marked, marked->items[i]);
	}
	return recording;
}

/** CORE Operations: finish(recording, ending) */
static ErmRecord *graphFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	Graph *graph = self;
	recording->record.ending = ending;
	recording->ended = true;
	if (recording->record.process) {
		ErmEvent event = { NULL, &recording->record };
		send(graph, recording->record.process, &event);
	}
	return &recording->record;
}

static void graphSetTop(void *self, ErmInterface top) {
	((Graph *)self)->top = top;
}

static const ErmVtable graphVtable = {
	graphOp, graphSubscribe, graphUnsubscribe, graphRecord, graphFinish, graphSetTop,
};

ErmInterface ermGraph(void) {
	Graph *graph = allocate(sizeof *graph);
	graph->nextSub = 1;
	graph->nextTag = 1;
	graph->self = (ErmInterface){ &graphVtable, graph };
	return graph->self;
}
