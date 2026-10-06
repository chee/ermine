// graph.c: the bare graph. CORE.tex The core: Nodes, Paths, Patches,
// Changes, Placement, Runs and lookup, Operations, Records. The readings the
// papers leave open are in NOTES.md.
//
// What the graph keeps:
// - nodes by id, never removed: a value and the change that last set it, and
//   a directory of slots in code point order of their names, each a
//   non-empty list of ids with the change that last set it;
// - the last time in the graph;
// - subscriptions: the place and address each follows, and the node it
//   reaches;
// - for each process, what its last finished run and its run under way read
//   through a read-only interface, for marking; and the top of the stack.
//
// Nothing here recurses: a walk is a loop over names, a patch a loop over
// its path.

#include "ermine.h"

#include <stdlib.h>
#include <string.h>

// ===========================================================================
// state

typedef struct Slot {
	const char *name;
	ErmIds ids;              // never empty: a slot with no ids is gone
	const ErmChange *change; // the change that last set it
} Slot;

typedef struct Node {
	const char *id;
	Json *value;
	const ErmChange *change; // the change that last set the value; NULL for the root's first
	ERM_LIST(Slot) dir;      // in code point order of names
} Node;

/** what one run read (CORE Changes: what a change marks) */
typedef struct Reads {
	ErmMap values; // nodes whose value it read
	ErmMap slots;  // node -> ErmMap * of the names of slots it read, searched or a walk tried
	ErmMap dirs;   // nodes whose whole directory it read
	ErmMap absent; // ids a walk passed over because their node was not here
} Reads;

typedef struct Process {
	Reads *last;  // its last finished run's reads
	Reads *now;   // the run under way's; NULL: none
	int64_t tag;  // the run under way
} Process;

typedef struct Sub {
	int64_t number;
	ErmPlace place;
	ErmAddress address;
	const char *at; // the node the address reaches; NULL: nothing
	ErmEventFn fn;
	void *data;
	bool live;
} Sub;

typedef struct Graph {
	ErmInterface self; // the top until setTop
	ErmInterface top;  // lookups read each slot through it
	Node *root;
	ErmMap nodes;      // id -> Node *
	ErmTime last;      // the latest time in the graph; 0: none yet
	ERM_LIST(Sub) subs;
	ErmMap processes;  // id -> Process *
	int64_t tags;      // the last run tag given
} Graph;

static void *const YES = (void *)1;

static Node *nodeOf(Graph *graph, const char *id) {
	return ermMapGet(&graph->nodes, id);
}

static Slot *slotOf(Node *node, const char *name) {
	for (int i = 0; i < node->dir.count; i++) {
		if (strcmp(node->dir.items[i].name, name) == 0) return &node->dir.items[i];
	}
	return NULL;
}

static int indexOf(const ErmIds *ids, const char *id) {
	for (int i = 0; i < ids->count; i++) {
		if (strcmp(ids->items[i], id) == 0) return i;
	}
	return -1;
}

static int byCodePoint(const void *a, const void *b) {
	return textCompare(*(const char *const *)a, *(const char *const *)b);
}

static void sortIds(ErmIds *ids) {
	if (ids->count > 1) qsort(ids->items, (size_t)ids->count, sizeof *ids->items, byCodePoint);
}

// ===========================================================================
// marking (CORE Runs and lookup, Changes)

typedef enum { READ_VALUE, READ_SLOT, READ_DIR, READ_ABSENT } ReadKind;

/** remembers a read for marking, when the ctx is a read-only interface of a run under way */
static void remember(Graph *graph, const ErmCtx *ctx, ReadKind kind, const char *node, const char *name) {
	if (!ctx || ctx->mode != ERM_READ_ONLY || !ctx->process || !ctx->run) return;
	Process *process = ermMapGet(&graph->processes, ctx->process);
	if (!process || !process->now || process->tag != ctx->run) return;
	Reads *reads = process->now;
	if (kind == READ_SLOT) {
		ErmMap *names = ermMapGet(&reads->slots, node);
		if (!names) {
			names = allocate(sizeof *names);
			ermMapPut(&reads->slots, node, names);
		}
		ermMapPut(names, name, YES);
		return;
	}
	ermMapPut(kind == READ_VALUE ? &reads->values : kind == READ_DIR ? &reads->dirs : &reads->absent, node, YES);
}

/**
 * Whether a change marks a run that read these: a write marks the readers of
 * the value; a placement or unplacement those of the slot (every walk and
 * search that tried it included) and of the whole directory; a placement
 * that makes a node, also the walks that passed over its id.
 */
static bool marks(const Reads *reads, const ErmChange *change) {
	if (!reads) return false;
	if (change->kind == ERM_WRITE) return ermMapHas(&reads->values, change->node);
	ErmMap *names = ermMapGet(&reads->slots, change->node);
	return (names && ermMapHas(names, change->name)) || ermMapHas(&reads->dirs, change->node) ||
	       (change->value && ermMapHas(&reads->absent, change->id));
}

/** the processes a change marks, the one that made it included, in code point order */
static ErmIds marked(Graph *graph, const ErmChange *change) {
	ErmIds ids = { 0 };
	for (int i = 0; i < graph->processes.count; i++) {
		const ErmMapEntry *entry = &graph->processes.entries[i];
		const Process *process = entry->value;
		if (marks(process->last, change) || marks(process->now, change)) ERM_PUSH(ids, entry->key);
	}
	sortIds(&ids);
	return ids;
}

// ===========================================================================
// walking (CORE Paths)

/** where a walk starts, and the names it walks from there */
typedef struct Target {
	Node *start; // NULL: nothing
	const char *const *names;
	int count;
} Target;

/**
 * Walks the target's first `count` names from its start. Each name selects a
 * slot of the current node, and the walk takes the first id in it whose node
 * is here and, unless it is the target's last name, has the next name, as
 * Plan 9 walks a union. Appends each step to `route` when given, and
 * remembers for ctx each slot it tried and each id it passed over. Returns
 * the node reached, or NULL.
 */
static Node *walk(Graph *graph, const ErmCtx *ctx, const Target *target, int count, ErmRoute *route) {
	Node *node = target->start;
	for (int i = 0; node && i < count; i++) {
		const char *name = target->names[i], *next = i + 1 < target->count ? target->names[i + 1] : NULL;
		remember(graph, ctx, READ_SLOT, node->id, name);
		Slot *slot = slotOf(node, name);
		Node *taken = NULL;
		int position = 0;
		for (; slot && position < slot->ids.count; position++) {
			Node *member = nodeOf(graph, slot->ids.items[position]);
			if (!member) {
				remember(graph, ctx, READ_ABSENT, slot->ids.items[position], NULL);
				continue;
			}
			if (next) remember(graph, ctx, READ_SLOT, member->id, next);
			if (!next || slotOf(member, next)) {
				taken = member;
				break;
			}
		}
		if (taken && route) ERM_PUSH(*route, ((ErmStep){ node->id, name, taken->id, position }));
		node = taken;
	}
	return node;
}

/** the node `count` names reach from `from`, walked as an address on their own */
static Node *reachNames(Graph *graph, const ErmCtx *ctx, Node *from, const char *const *names, int count) {
	Target target = { from, names, count };
	return walk(graph, ctx, &target, count, NULL);
}

/**
 * CORE Paths: an address's target. The place's start, its "/", is the node
 * its hidden names reach; the place itself, its ".", is the node its other
 * names reach from there, and each ".." drops one of them, never going above
 * the start. A first "/" starts at the start, any other address at the
 * place. Each part of the place is followed afresh, as an address is.
 */
static ErmErr resolve(Graph *graph, const ErmCtx *ctx, const ErmAddress *address, Target *out) {
	const ErmPlace *place = &ctx->place;
	int below = address->fromStart ? 0 : place->names.count - place->chroot;
	if (address->ups > below) return ermInvalid("above-root");
	Node *start = reachNames(graph, ctx, graph->root, place->names.items, place->chroot);
	if (below > address->ups) start = reachNames(graph, ctx, start, place->names.items + place->chroot, below - address->ups);
	*out = (Target){ start, address->names.items, address->names.count };
	return ermOk();
}

/** the node a target reaches, and the route to it; NULL: nothing */
static Node *reachOf(Graph *graph, const ErmCtx *ctx, const Target *target, ErmRoute *route) {
	return walk(graph, ctx, target, target->count, route);
}

// ===========================================================================
// reads (CORE Reads are lists)

/** one node a directory read lists, and the route that reached it */
typedef struct Member {
	Node *node;
	ErmRoute route;
} Member;

typedef ERM_LIST(Member) Members;

/**
 * The nodes a directory read of the target lists: the node it starts at when
 * the address has no names; otherwise every node here in the slot its last
 * name selects, in slot order, as ls lists a Plan 9 union.
 */
static Members membersOf(Graph *graph, const ErmCtx *ctx, const Target *target) {
	Members members = { 0 };
	if (!target->count) {
		if (target->start) ERM_PUSH(members, ((Member){ target->start, { 0 } }));
		return members;
	}
	ErmRoute route = { 0 };
	Node *parent = walk(graph, ctx, target, target->count - 1, &route);
	const char *last = target->names[target->count - 1];
	Slot *slot = NULL;
	if (parent) {
		remember(graph, ctx, READ_SLOT, parent->id, last);
		slot = slotOf(parent, last);
	}
	for (int j = 0; slot && j < slot->ids.count; j++) {
		Node *member = nodeOf(graph, slot->ids.items[j]);
		if (!member) {
			remember(graph, ctx, READ_ABSENT, slot->ids.items[j], NULL);
			continue;
		}
		ErmRoute own = { 0 };
		for (int i = 0; i < route.count; i++) ERM_PUSH(own, route.items[i]);
		ERM_PUSH(own, ((ErmStep){ parent->id, last, member->id, j }));
		ERM_PUSH(members, ((Member){ member, own }));
	}
	free(route.items);
	return members;
}

/** a slot's items, in slot order, each from the member's route */
static void slotItems(Graph *graph, const Member *member, const Slot *slot, ErmItems *items) {
	for (int k = 0; k < slot->ids.count; k++) {
		const char *id = slot->ids.items[k];
		ERM_PUSH(*items, ((ErmItem){ .id = id, .pending = !nodeOf(graph, id), .route = member->route, .ups = -1, .position = k, .change = slot->change }));
	}
}

static void readValue(Graph *graph, const ErmCtx *ctx, const Target *target, ErmResult *out) {
	ErmRoute route = { 0 };
	Node *node = reachOf(graph, ctx, target, &route);
	if (!node) {
		free(route.items);
		return;
	}
	remember(graph, ctx, READ_VALUE, node->id, NULL);
	ERM_PUSH(out->items, ((ErmItem){ .value = node->value, .route = route, .ups = -1, .position = -1, .change = node->change }));
}

/** with a name, that slot's items from every member that has it; without, each name with its items from every member */
static void readDirectory(Graph *graph, const ErmCtx *ctx, const Target *target, const char *name, ErmResult *out) {
	Members members = membersOf(graph, ctx, target);
	ErmIds names = { 0 };
	for (int m = 0; m < members.count; m++) {
		Node *node = members.items[m].node;
		if (name) {
			remember(graph, ctx, READ_SLOT, node->id, name);
			Slot *slot = slotOf(node, name);
			if (slot) slotItems(graph, &members.items[m], slot, &out->items);
			continue;
		}
		remember(graph, ctx, READ_DIR, node->id, NULL);
		for (int s = 0; s < node->dir.count; s++) {
			if (indexOf(&names, node->dir.items[s].name) < 0) ERM_PUSH(names, node->dir.items[s].name);
		}
	}
	sortIds(&names);
	for (int n = 0; n < names.count; n++) {
		ErmEntry entry = { names.items[n], { 0 } };
		for (int m = 0; m < members.count; m++) {
			Slot *slot = slotOf(members.items[m].node, names.items[n]);
			if (slot) slotItems(graph, &members.items[m], slot, &entry.items);
		}
		ERM_PUSH(out->listing, entry);
	}
	free(names.items);
	free(members.items);
}

/**
 * CORE Lookup: searches the directories along the place, from the one it
 * reaches, ".", up to its start, and takes the nearest slot with the name.
 * Each step is an ordinary read of one slot, directory([".." x up], name),
 * through the top of the stack, so a wrapper may refuse it; a refusal ends
 * the search, as if there were no parent, and is not an error.
 */
static ErmErr lookup(Graph *graph, const ErmCtx *ctx, const char *name, ErmResult *out) {
	ErmInterface top = graph->top.vt ? graph->top : graph->self;
	int below = ctx->place.names.count - ctx->place.chroot;
	for (int up = 0; up <= below; up++) {
		ErmOp read = { .kind = ERM_OP_DIRECTORY, .address = { false, up, { 0 } }, .name = name };
		ErmStamp none = { 0 };
		ErmResult found = { 0 };
		ErmErr err = top.vt->op(top.self, ctx, &none, &read, &found);
		if (err.kind == ERM_REFUSED) break;
		if (err.kind) return err;
		for (int i = 0; i < found.items.count; i++) {
			ErmItem item = found.items.items[i];
			item.route = (ErmRoute){ 0 };
			item.ups = up;
			item.name = name;
			ERM_PUSH(out->items, item);
		}
		free(found.items.items);
		if (out->items.count) break;
	}
	return ermOk();
}

// ===========================================================================
// patches (CORE Patches)

static ErmErr patchError(const char *code, int index) {
	return ermDetail(ermInvalid(code), "index", jsonInteger(index));
}

/** a key of a path: a string, into an object, or a whole number, into a list */
static bool isKey(const Json *key) {
	return jsonIsString(key) || jsonIsWhole(key, NULL);
}

/** the member of `value` under `key`; NULL when the path is not there */
static Json *member(const Json *value, const Json *key) {
	int64_t index;
	if (jsonIsString(key)) return jsonIsObject(value) ? jsonGetOfLength(value, key->string, key->stringLength) : NULL;
	if (jsonIsArray(value) && jsonIsWhole(key, &index) && index >= 0 && index < value->array.count) return value->array.items[index];
	return NULL;
}

/** a splice of the string or list `target`, counted in code points or elements */
static ErmErr splice(const Json *patch, int index, const Json *target, Json **out) {
	bool text = jsonIsString(target);
	if (!text && !jsonIsArray(target)) return patchError("wrong-kind", index);
	int64_t length = text ? (int64_t)utf8Count(target->string, target->stringLength) : target->array.count, from, to;
	Json *range = jsonGet(patch, "range"), *value = jsonGet(patch, "value");
	if (!jsonIsArray(range) || range->array.count != 2 || !jsonIsWhole(range->array.items[0], &from) ||
	    !jsonIsWhole(range->array.items[1], &to) || from < 0 || from > to || to > length) {
		return ermDetail(patchError("range", index), "length", jsonInteger(length));
	}
	if (value && (text ? !jsonIsString(value) : !jsonIsArray(value))) return patchError("wrong-kind", index);
	if (text) {
		size_t start = utf8Offset(target->string, target->stringLength, (size_t)from);
		size_t end = utf8Offset(target->string, target->stringLength, (size_t)to);
		size_t middle = value ? value->stringLength : 0, rest = target->stringLength - end;
		char *bytes = allocate(start + middle + rest + 1);
		memcpy(bytes, target->string, start);
		if (middle) memcpy(bytes + start, value->string, middle);
		memcpy(bytes + start + middle, target->string + end, rest);
		*out = jsonStringOfLength(bytes, start + middle + rest);
		free(bytes);
		return ermOk();
	}
	Json *list = jsonArray();
	for (int64_t i = 0; i < from; i++) jsonPush(list, target->array.items[i]);
	for (int i = 0; value && i < value->array.count; i++) jsonPush(list, value->array.items[i]);
	for (int64_t i = to; i < length; i++) jsonPush(list, target->array.items[i]);
	*out = list;
	return ermOk();
}

/** one patch to `value`: *out is the new value, sharing everything the patch did not change */
static ErmErr applyPatch(Json *patch, int index, Json *value, Json **out) {
	const char *type = jsonText(jsonGet(patch, "type"));
	if (!type) return patchError("not-a-patch", index);
	if (strcmp(type, "snapshot") == 0) {
		Json *snapshot = jsonGet(patch, "value");
		if (!snapshot) return patchError("not-a-patch", index);
		*out = snapshot;
		return ermOk();
	}
	bool isSplice = strcmp(type, "splice") == 0;
	Json *path = jsonGet(patch, "path"), *key = jsonGet(patch, "key");
	if ((!isSplice && strcmp(type, "set") != 0) || !jsonIsArray(path) || (!isSplice && !jsonIsString(key))) {
		return patchError("not-a-patch", index);
	}
	int depth = path->array.count;
	for (int i = 0; i < depth; i++) {
		if (!isKey(path->array.items[i])) return patchError("not-a-patch", index);
	}
	// the value, each container along the path, then the target
	Json **chain = allocate(((size_t)depth + 1) * sizeof *chain);
	chain[0] = value;
	ErmErr err = ermOk();
	for (int i = 0; i < depth && !err.kind; i++) {
		chain[i + 1] = member(chain[i], path->array.items[i]);
		if (!chain[i + 1]) err = patchError("no-key", index);
	}
	Json *changed = NULL;
	if (!err.kind && isSplice) {
		err = splice(patch, index, chain[depth], &changed);
	} else if (!err.kind && !jsonIsObject(chain[depth])) {
		err = patchError("wrong-kind", index);
	} else if (!err.kind) {
		Json *set = jsonGet(patch, "value");
		changed = jsonShallow(chain[depth]);
		if (set) jsonSet(changed, key->string, key->stringLength, set);
		else jsonRemove(changed, key->string, key->stringLength);
	}
	// copy the containers along the path, from the target up, each holding what changed below it
	for (int i = depth - 1; i >= 0 && !err.kind; i--) {
		Json *copy = jsonShallow(chain[i]), *at = path->array.items[i];
		int64_t n;
		if (jsonIsString(at)) jsonSet(copy, at->string, at->stringLength, changed);
		else if (jsonIsWhole(at, &n)) copy->array.items[n] = changed;
		changed = copy;
	}
	free(chain);
	if (!err.kind) *out = changed;
	return err;
}

/** the patches in order; the first that does not apply makes the whole write invalid */
static ErmErr applyPatches(Json *patches, Json *value, Json **out) {
	for (int i = 0; i < patches->array.count; i++) {
		ErmErr err = applyPatch(patches->array.items[i], i, value, &value);
		if (err.kind) return err;
	}
	*out = value;
	return ermOk();
}

// ===========================================================================
// changes (CORE Changes, Placement)

/** the id of the node a subscription's address reaches now; NULL: nothing */
static const char *reach(Graph *graph, const Sub *sub) {
	ErmCtx ctx = { .place = sub->place };
	Target target;
	if (resolve(graph, &ctx, &sub->address, &target).kind) return NULL;
	Node *node = reachOf(graph, NULL, &target, NULL);
	return node ? node->id : NULL;
}

/**
 * CORE subscribe: sends a change to each subscription whose node it changed,
 * or that it switched to another node or to nothing; a placement that makes
 * the node a subscription comes to reach is sent to it once.
 */
static void deliver(Graph *graph, const ErmChange *change) {
	for (int i = 0; i < graph->subs.count; i++) {
		Sub *sub = &graph->subs.items[i];
		if (!sub->live) continue;
		const char *was = sub->at, *now = reach(graph, sub);
		sub->at = now;
		bool switched = was && now ? strcmp(was, now) != 0 : was != now;
		if (switched || (now && strcmp(now, change->node) == 0)) sub->fn(sub->data, change);
	}
}

/** CORE Placement: places, moves, makes or mounts op->id in the slot op->name of `parent` */
static ErmErr place(Graph *graph, Node *parent, const ErmOp *op, ErmChange *change) {
	if (op->value && nodeOf(graph, op->id)) return ermInvalid("exists");
	Slot *slot = slotOf(parent, op->name);
	int length = slot ? slot->ids.count : 0;
	if (op->hasPosition && op->position > length) return ermDetail(ermInvalid("position"), "length", jsonInteger(length));
	*change = (ErmChange){ .node = parent->id, .kind = ERM_PLACE, .name = op->name, .id = op->id, .hasPosition = op->hasPosition, .position = op->position, .value = op->value };
	if (op->value) {
		Node *made = allocate(sizeof *made);
		made->id = op->id;
		made->value = op->value;
		made->change = change;
		ermMapPut(&graph->nodes, op->id, made);
	}
	if (!slot) {
		int at = 0;
		while (at < parent->dir.count && textCompare(parent->dir.items[at].name, op->name) < 0) at++;
		ERM_PUSH(parent->dir, ((Slot){ 0 }));
		memmove(&parent->dir.items[at + 1], &parent->dir.items[at], (size_t)(parent->dir.count - 1 - at) * sizeof *parent->dir.items);
		slot = &parent->dir.items[at];
		*slot = (Slot){ .name = op->name };
	}
	ErmIds *ids = &slot->ids;
	int old = indexOf(ids, op->id);
	if (op->hasPosition || old < 0) {
		// put it in at its gap, the end when none was given, then take its old place out
		int gap = op->hasPosition ? (int)op->position : ids->count;
		ERM_PUSH(*ids, op->id);
		memmove(&ids->items[gap + 1], &ids->items[gap], (size_t)(ids->count - 1 - gap) * sizeof *ids->items);
		ids->items[gap] = op->id;
		if (old >= 0) {
			int at = old < gap ? old : old + 1;
			memmove(&ids->items[at], &ids->items[at + 1], (size_t)(ids->count - 1 - at) * sizeof *ids->items);
			ids->count--;
		}
	}
	slot->change = change;
	return ermOk();
}

static ErmErr unplace(Node *parent, const ErmOp *op, ErmChange *change) {
	Slot *slot = slotOf(parent, op->name);
	int at = slot ? indexOf(&slot->ids, op->id) : -1;
	if (at < 0) return ermInvalid("not-in-slot");
	*change = (ErmChange){ .node = parent->id, .kind = ERM_UNPLACE, .name = op->name, .id = op->id };
	ErmIds *ids = &slot->ids;
	memmove(&ids->items[at], &ids->items[at + 1], (size_t)(ids->count - 1 - at) * sizeof *ids->items);
	slot->change = change;
	if (--ids->count == 0) {
		// a slot with no ids is gone
		free(ids->items);
		int s = (int)(slot - parent->dir.items);
		memmove(slot, slot + 1, (size_t)(parent->dir.count - 1 - s) * sizeof *slot);
		parent->dir.count--;
	}
	return ermOk();
}

/** write, place or unplace: the time, then the node the address reaches, then the change itself */
static ErmErr change(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, const Target *target, ErmResult *out) {
	if (stamp->time <= graph->last) return ermDetail(ermInvalid("time"), "last", jsonNumber(graph->last));
	Node *node = reachOf(graph, NULL, target, NULL);
	if (!node) return ermInvalid("nothing-there");
	ErmChange *made = allocate(sizeof *made);
	ErmErr err = ermOk();
	if (op->kind == ERM_OP_WRITE) {
		Json *value = NULL;
		err = applyPatches(op->patches, node->value, &value);
		if (!err.kind) {
			*made = (ErmChange){ .node = node->id, .kind = ERM_WRITE, .patches = op->patches };
			node->value = value;
			node->change = made;
		}
	} else if (op->kind == ERM_OP_PLACE) {
		err = place(graph, node, op, made);
	} else {
		err = unplace(node, op, made);
	}
	if (err.kind) {
		free(made);
		return err;
	}
	made->time = stamp->time;
	made->agent = ctx->agent ? ctx->agent : jsonNull();
	made->process = ctx->process;
	made->cause = stamp->cause;
	graph->last = stamp->time;
	out->change = made;
	out->marked = marked(graph, made);
	deliver(graph, made);
	return ermOk();
}

// ===========================================================================
// the interface

/** CORE Operations; an interface that only reads or only writes is checked first */
static ErmErr graphOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	Graph *graph = self;
	bool changes = ermOpIsChange(op->kind);
	if (changes && ctx->mode == ERM_READ_ONLY) return ermInvalid("read-only");
	if (!changes && ctx->mode == ERM_WRITE_ONLY) return ermInvalid("write-only");
	if (op->kind == ERM_OP_LOOKUP) return lookup(graph, ctx, op->name, out);
	Target target;
	ErmErr err = resolve(graph, ctx, &op->address, &target);
	if (err.kind) return err;
	if (changes) return change(graph, ctx, stamp, op, &target, out);
	if (op->kind == ERM_OP_READ) readValue(graph, ctx, &target, out);
	else readDirectory(graph, ctx, &target, op->name, out);
	return ermOk();
}

static ErmErr graphSubscribe(void *self, const ErmCtx *ctx, const ErmAddress *address, ErmEventFn fn, void *data, int64_t *sub) {
	Graph *graph = self;
	Target target;
	ErmErr err = resolve(graph, ctx, address, &target);
	if (err.kind) return err;
	Sub made = { .number = graph->subs.count + 1, .place = ctx->place, .address = *address, .fn = fn, .data = data, .live = true };
	made.at = reach(graph, &made);
	ERM_PUSH(graph->subs, made);
	*sub = made.number;
	return ermOk();
}

static ErmErr graphUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	(void)ctx;
	Graph *graph = self;
	if (sub < 1 || sub > graph->subs.count || !graph->subs.items[sub - 1].live) {
		return ermDetail(ermInvalid("wrong-field"), "field", jsonString("sub"));
	}
	graph->subs.items[sub - 1].live = false;
	return ermOk();
}

// ===========================================================================
// recording (CORE record, finish, Records)

/** an api of one run: passes everything on, logs each operation, and answers invalid once the run has ended */
typedef struct RunApi {
	ErmInterface inner;
	ErmRecording *recording;
} RunApi;

static ErmErr runOp(void *self, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, ErmResult *out) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("stopped");
	ErmErr err = run->inner.vt->op(run->inner.self, ctx, stamp, op, out);
	ERM_PUSH(run->recording->record.log, ((ErmLogged){ *op, err, err.kind ? (ErmResult){ 0 } : *out }));
	return err;
}

static ErmErr runSubscribe(void *self, const ErmCtx *ctx, const ErmAddress *address, ErmEventFn fn, void *data, int64_t *sub) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("stopped");
	return run->inner.vt->subscribe(run->inner.self, ctx, address, fn, data, sub);
}

static ErmErr runUnsubscribe(void *self, const ErmCtx *ctx, int64_t sub) {
	RunApi *run = self;
	if (run->recording->ended) return ermInvalid("stopped");
	return run->inner.vt->unsubscribe(run->inner.self, ctx, sub);
}

static ErmRecording *runRecord(void *self, ErmApi api, const ErmRefs *marked) {
	RunApi *run = self;
	return run->inner.vt->record(run->inner.self, api, marked);
}

static ErmRecord *runFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	RunApi *run = self;
	return run->inner.vt->finish(run->inner.self, recording, ending);
}

static void runSetTop(void *self, ErmInterface top) {
	RunApi *run = self;
	run->inner.vt->setTop(run->inner.self, top);
}

static const ErmVtable runVtable = { runOp, runSubscribe, runUnsubscribe, runRecord, runFinish, runSetTop };

/** a run starts: a read-only api's process reads afresh under a new tag, alongside its last finished run's */
static ErmRecording *graphRecord(void *self, ErmApi api, const ErmRefs *marked) {
	Graph *graph = self;
	ErmRecording *recording = allocate(sizeof *recording);
	recording->tag = ++graph->tags;
	if (api.ctx.mode == ERM_READ_ONLY && api.ctx.process) {
		Process *process = ermMapGet(&graph->processes, api.ctx.process);
		if (!process) {
			process = allocate(sizeof *process);
			ermMapPut(&graph->processes, api.ctx.process, process);
		}
		process->now = allocate(sizeof *process->now);
		process->tag = recording->tag;
	}
	RunApi *run = allocate(sizeof *run);
	run->inner = api.iface;
	run->recording = recording;
	ErmCtx ctx = api.ctx;
	ctx.run = recording->tag;
	recording->api = ermBind((ErmInterface){ &runVtable, run }, ctx);
	recording->record.process = api.ctx.process;
	recording->record.agent = api.ctx.agent;
	for (int i = 0; marked && i < marked->count; i++) ERM_PUSH(recording->record.marked, marked->items[i]);
	return recording;
}

/** a run ends, however it ended: its reads replace the process's last run's */
static ErmRecord *graphFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	Graph *graph = self;
	recording->record.ending = ending;
	recording->ended = true;
	Process *process = recording->record.process ? ermMapGet(&graph->processes, recording->record.process) : NULL;
	if (process && process->now && process->tag == recording->tag) {
		process->last = process->now;
		process->now = NULL;
	}
	return &recording->record;
}

static void graphSetTop(void *self, ErmInterface top) {
	((Graph *)self)->top = top;
}

static const ErmVtable graphVtable = { graphOp, graphSubscribe, graphUnsubscribe, graphRecord, graphFinish, graphSetTop };

ErmInterface ermGraph(const char *root) {
	Graph *graph = allocate(sizeof *graph);
	graph->root = allocate(sizeof *graph->root);
	graph->root->id = root;
	graph->root->value = jsonNull();
	ermMapPut(&graph->nodes, root, graph->root);
	graph->self = (ErmInterface){ &graphVtable, graph };
	return graph->self;
}
