// graph.c: the bare graph. CORE.tex The core: Nodes, Paths, Patches,
// Changes, Placement, Runs and lookup, Operations, Records. The readings the
// papers leave open are in NOTES.md.
//
// What the graph keeps (CORE What the graph holds):
// - nodes by id: a value and the change that last set it, whether it is
//   ephemeral, and a directory of slots in code point order of their names,
//   each a non-empty list of ids with the last change to it that was not
//   ephemeral, and the ids in it that such a change put there (what keeping
//   the graph keeps). An ordinary node is never removed; an ephemeral one
//   goes as soon as it is unplaced from its slot: it is freed, and its id
//   maps to NULL, naming nothing;
// - for each ephemeral node, the one slot it is in (its parent and the
//   slot's name), so letting it go needs no search;
// - the last time in the graph;
// - subscriptions: the place and address each follows, and the node it
//   reaches and the route of its own names there;
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
	ErmIds kept;             // the ids in it a change that was not ephemeral put there
	const ErmChange *change; // the last change to it that was not ephemeral; NULL: none
} Slot;

typedef struct Node {
	const char *id;
	Json *value;
	const ErmChange *change; // the change that last set the value; NULL for the root's first
	bool ephemeral;          // made so by the placement that made it
	struct Node *parent;     // an ephemeral node's one parent, the node it was made in; NULL for an ordinary node
	const char *slot;        // and the name of its one slot there
	ERM_LIST(Slot) dir;      // in code point order of names
} Node;

/** what one run read (CORE Changes: what a change marks) */
typedef struct Reads {
	ErmMap values; // nodes whose value it read
	ErmMap slots;  // node -> ErmMap * of the names of slots it read, searched or a walk tried
	ErmMap dirs;   // nodes whose whole directory it read
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
	ErmRoute route; // the route of the address's own names to it; empty when it reaches nothing
	ErmEventFn fn;
	void *data;
	bool live;
} Sub;

typedef struct Graph {
	ErmInterface self; // the top until setTop
	ErmInterface top;  // lookups read each slot through it
	Node *root;
	ErmMap nodes;      // id -> Node *, the node made with that id; NULL once an ephemeral one has gone
	ErmTime last;      // the latest time in the graph; 0: none yet
	ERM_LIST(Sub) subs;
	ErmMap processes;  // id -> Process *
	int64_t tags;      // the last run tag given
} Graph;

static void *const YES = (void *)1;

/** the node with the id, if it is here */
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

/** whether any slot of a node that is here holds the id, whether or not the id's node is here: a search of every slot */
static bool heldAnywhere(Graph *graph, const char *id) {
	for (int i = 0; i < graph->nodes.count; i++) {
		Node *node = graph->nodes.entries[i].value;
		if (!node) continue;
		for (int s = 0; s < node->dir.count; s++) {
			if (indexOf(&node->dir.items[s].ids, id) >= 0) return true;
		}
	}
	return false;
}

static int byCodePoint(const void *a, const void *b) {
	return textCompare(*(const char *const *)a, *(const char *const *)b);
}

static void sortIds(ErmIds *ids) {
	if (ids->count > 1) qsort(ids->items, (size_t)ids->count, sizeof *ids->items, byCodePoint);
}

/** takes ids[at] out, keeping the order of the rest */
static void takeAt(ErmIds *ids, int at) {
	memmove(&ids->items[at], &ids->items[at + 1], (size_t)(ids->count - 1 - at) * sizeof *ids->items);
	ids->count--;
}

// ===========================================================================
// marking (CORE Runs and lookup, Changes)

typedef enum { READ_VALUE, READ_SLOT, READ_DIR } ReadKind;

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
	ermMapPut(kind == READ_VALUE ? &reads->values : &reads->dirs, node, YES);
}

static bool readSlot(const Reads *reads, const char *node, const char *name) {
	ErmMap *names = reads ? ermMapGet(&reads->slots, node) : NULL;
	return names && ermMapHas(names, name);
}

/**
 * Whether a change marks a run that read these: a write marks the readers of
 * the value; a placement or unplacement those of the slot (every walk and
 * search that tried it included) and of the whole directory.
 */
static bool marks(const Reads *reads, const ErmChange *change) {
	if (!reads) return false;
	if (change->kind == ERM_WRITE) return ermMapHas(&reads->values, change->node);
	return readSlot(reads, change->node, change->name) || ermMapHas(&reads->dirs, change->node);
}

/** whether a process read a slot that holds the id, wherever it is */
static bool readHolder(Graph *graph, const Process *process, const char *id) {
	for (int i = 0; i < graph->nodes.count; i++) {
		Node *node = graph->nodes.entries[i].value;
		if (!node) continue;
		for (int s = 0; s < node->dir.count; s++) {
			const Slot *slot = &node->dir.items[s];
			if (indexOf(&slot->ids, id) >= 0 && (readSlot(process->last, node->id, slot->name) || readSlot(process->now, node->id, slot->name))) return true;
		}
	}
	return false;
}

/**
 * Adds the processes a change marks, the one that made it included, that are
 * not marked yet, each by this change. A change that makes an id's node here
 * also marks the readers of every slot that holds that id, so a mounted node
 * that arrives fills every slot that waited for it (one that goes is held by
 * no slot by then).
 */
static void mark(Graph *graph, const ErmChange *change, ErmMarks *marked) {
	for (int i = 0; i < graph->processes.count; i++) {
		const ErmMapEntry *entry = &graph->processes.entries[i];
		const Process *process = entry->value;
		bool already = false;
		for (int m = 0; m < marked->count && !already; m++) already = strcmp(marked->items[m].process, entry->key) == 0;
		if (already) continue;
		if (marks(process->last, change) || marks(process->now, change) || (change->value && readHolder(graph, process, change->id))) {
			ERM_PUSH(*marked, ((ErmMark){ entry->key, change->time }));
		}
	}
}

static int byProcess(const void *a, const void *b) {
	return textCompare(((const ErmMark *)a)->process, ((const ErmMark *)b)->process);
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
			if (!member) continue;
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

/**
 * CORE Paths: an address's target. The place's start, its "/", is the node
 * its hidden names reach, walked as an address on their own; the place
 * itself, its ".", is the node its other names reach from there. Each ".."
 * goes back one step the way the place was reached, to the node its walk came
 * through, never above the start: the place's walk taken only that far, each
 * step taking the member that has the place's next name. A first "/" starts
 * at the start, any other address at the place. The place is followed afresh
 * each time, as an address is.
 */
static ErmErr resolve(Graph *graph, const ErmCtx *ctx, const ErmAddress *address, Target *out) {
	const ErmPlace *place = &ctx->place;
	int below = address->fromStart ? 0 : place->names.count - place->chroot;
	if (address->ups > below) return ermInvalid("above-root");
	Target hidden = { graph->root, place->names.items, place->chroot };
	Target down = { walk(graph, ctx, &hidden, hidden.count, NULL), place->names.items + place->chroot, below };
	*out = (Target){ walk(graph, ctx, &down, below - address->ups, NULL), address->names.items, address->names.count };
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
 * The nodes a read of the target is of: the node it starts at when the
 * address has no names; otherwise every node here in the slot its last name
 * selects, in slot order, as ls lists a Plan 9 union, each with its own
 * route. The first is the node the address reaches.
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
		if (!member) continue;
		ErmRoute own = { 0 };
		for (int i = 0; i < route.count; i++) ERM_PUSH(own, route.items[i]);
		ERM_PUSH(own, ((ErmStep){ parent->id, last, member->id, j }));
		ERM_PUSH(members, ((Member){ member, own }));
	}
	free(route.items);
	return members;
}

/** a slot's items, in slot order, each from the member's route; an item says pending while its id's node is not here, and ephemeral while it is here and ephemeral */
static void slotItems(Graph *graph, const Member *member, const Slot *slot, ErmItems *items) {
	for (int k = 0; k < slot->ids.count; k++) {
		const char *id = slot->ids.items[k];
		Node *node = nodeOf(graph, id);
		ERM_PUSH(*items, ((ErmItem){ .id = id, .pending = !node, .ephemeral = node && node->ephemeral, .route = member->route, .ups = -1, .position = k, .change = slot->change }));
	}
}

/** CORE Reads are lists: an item for each node the address's last name selects that is here, in slot order, each with its own value, route and change */
static void readValue(Graph *graph, const ErmCtx *ctx, const Target *target, ErmResult *out) {
	Members members = membersOf(graph, ctx, target);
	for (int m = 0; m < members.count; m++) {
		Node *node = members.items[m].node;
		remember(graph, ctx, READ_VALUE, node->id, NULL);
		ERM_PUSH(out->items, ((ErmItem){ .value = node->value, .ephemeral = node->ephemeral, .route = members.items[m].route, .ups = -1, .position = -1, .change = node->change }));
	}
	free(members.items);
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
 * CORE Lookup: searches the directories the place's walk went through, from
 * the one it reaches, ".", back up to its start, and takes the nearest slot
 * with the name that holds a node that is here, all its items; a slot whose
 * ids are all absent is passed over. Each step is an ordinary read of one
 * slot, directory([".." x up], name), through the top of the stack, so a
 * wrapper may refuse it; a refusal ends the search, as if there were no
 * parent, and is not an error: the lookup then found nothing, and gives one
 * item saying where the search was refused.
 */
static ErmErr lookup(Graph *graph, const ErmCtx *ctx, const char *name, ErmResult *out) {
	ErmInterface top = graph->top.vt ? graph->top : graph->self;
	int below = ctx->place.names.count - ctx->place.chroot;
	for (int up = 0; up <= below && !out->items.count; up++) {
		ErmOp read = { .kind = ERM_OP_DIRECTORY, .address = { false, up, { 0 } }, .name = name };
		ErmStamp none = { 0 };
		ErmResult found = { 0 };
		ErmErr err = top.vt->op(top.self, ctx, &none, &read, &found);
		if (err.kind == ERM_REFUSED) {
			ERM_PUSH(out->items, ((ErmItem){ .refused = true, .ups = up, .position = -1 }));
			break;
		}
		if (err.kind) return err;
		bool here = false;
		for (int i = 0; i < found.items.count; i++) here = here || !found.items.items[i].pending;
		for (int i = 0; here && i < found.items.count; i++) {
			ErmItem item = found.items.items[i];
			item.route = (ErmRoute){ 0 };
			item.ups = up;
			item.name = name;
			ERM_PUSH(out->items, item);
		}
		free(found.items.items);
	}
	return ermOk();
}

// ===========================================================================
// patches (CORE Patches)

static ErmErr patchError(const char *code, int index) {
	return ermDetail(ermInvalid(code), "index", jsonInteger(index));
}

/** a key: a string, into an object, or a whole number (0, 1, 2 ...), into a list */
static bool isKey(const Json *key) {
	int64_t index;
	return jsonIsString(key) || (jsonIsWhole(key, &index) && index >= 0);
}

/**
 * The member of `value` under a path's key, in *out; or why the path is not
 * there: wrong-kind for a key of the wrong kind for where it leads (a string
 * into anything but a map, a number into anything but a list, any key into
 * bytes, a typed array, a live value or a scalar), no-key for a map that
 * lacks the key or a list that does not reach the index.
 */
static const char *member(const Json *value, const Json *key, Json **out) {
	if (jsonIsString(key)) {
		if (!jsonIsObject(value)) return "wrong-kind";
		*out = jsonGetOfLength(value, key->string, key->stringLength);
		return *out ? NULL : "no-key";
	}
	int64_t index;
	jsonIsWhole(key, &index);
	if (!jsonIsArray(value)) return "wrong-kind";
	if (index >= value->array.count) return "no-key";
	*out = value->array.items[index];
	return NULL;
}

/** what a splice works on: a string, a list, bytes or a typed array of one kind; -1 for anything else */
static int sortOf(const Json *value) {
	if (!value) return -1;
	if (value->type == JSON_TYPED) return JSON_LIVE + 1 + (int)value->typed.kind;
	return value->type == JSON_STRING || value->type == JSON_ARRAY || value->type == JSON_BYTES ? (int)value->type : -1;
}

/** how many code points, elements or octets */
static int64_t lengthOf(const Json *value) {
	switch (value->type) {
		case JSON_STRING: return (int64_t)utf8Count(value->string, value->stringLength);
		case JSON_ARRAY: return value->array.count;
		case JSON_BYTES: return (int64_t)value->bytes.length;
		default: return (int64_t)value->typed.count;
	}
}

/** a buffer's parts [0, from) of `target`, all of `middle`, [to, end) of `target`, each part `size` bytes an element */
static void *joined(const void *target, size_t length, const void *middle, size_t count, size_t from, size_t to, size_t size, size_t *total) {
	*total = from + count + length - to;
	char *out = allocate(*total * size);
	if (from) memcpy(out, target, from * size);
	if (count) memcpy(out + from * size, middle, count * size);
	if (length > to) memcpy(out + (from + count) * size, (const char *)target + to * size, (length - to) * size);
	return out;
}

/**
 * A splice of the string, list, bytes or typed array `target`, counted in
 * code points, elements or octets, with a value of the same sort, a typed
 * array of the same kind. Checked kind first, then range.
 */
static ErmErr splice(const Json *patch, int index, const Json *target, Json **out) {
	Json *range = jsonGet(patch, "range"), *value = jsonGet(patch, "value");
	int sort = sortOf(target);
	if (sort < 0 || (value && sortOf(value) != sort)) return patchError("wrong-kind", index);
	int64_t length = lengthOf(target), from, to;
	if (!jsonIsArray(range) || range->array.count != 2 || !jsonIsWhole(range->array.items[0], &from) ||
	    !jsonIsWhole(range->array.items[1], &to) || from < 0 || from > to || to > length) {
		return ermDetail(patchError("range", index), "length", jsonInteger(length));
	}
	size_t total;
	if (target->type == JSON_STRING) {
		size_t start = utf8Offset(target->string, target->stringLength, (size_t)from);
		size_t end = utf8Offset(target->string, target->stringLength, (size_t)to);
		char *text = joined(target->string, target->stringLength, value ? value->string : NULL, value ? value->stringLength : 0, start, end, 1, &total);
		*out = jsonStringOfLength(text, total);
		free(text);
	} else if (target->type == JSON_ARRAY) {
		Json *list = jsonArray();
		for (int64_t i = 0; i < from; i++) jsonPush(list, target->array.items[i]);
		for (int i = 0; value && i < value->array.count; i++) jsonPush(list, value->array.items[i]);
		for (int64_t i = to; i < length; i++) jsonPush(list, target->array.items[i]);
		*out = list;
	} else if (target->type == JSON_BYTES) {
		void *octets = joined(target->bytes.data, target->bytes.length, value ? value->bytes.data : NULL, value ? value->bytes.length : 0, (size_t)from, (size_t)to, 1, &total);
		*out = jsonBytes(octets, total);
		free(octets);
	} else {
		size_t size = jsonKindSize(target->typed.kind);
		void *elements = joined(target->typed.data, target->typed.count, value ? value->typed.data : NULL, value ? value->typed.count : 0, (size_t)from, (size_t)to, size, &total);
		*out = jsonTyped(target->typed.kind, elements, total);
		free(elements);
	}
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
	// its form first: a type it has, a path of keys, and for a set a key
	if ((!isSplice && strcmp(type, "set") != 0) || !jsonIsArray(path) || (!isSplice && !isKey(key))) {
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
		const char *code = member(chain[i], path->array.items[i], &chain[i + 1]);
		if (code) err = patchError(code, index);
	}
	Json *changed = NULL;
	if (!err.kind && isSplice) {
		err = splice(patch, index, chain[depth], &changed);
	} else if (!err.kind && (!jsonIsObject(chain[depth]) || !jsonIsString(key))) {
		// a set applies to an object, by a string key: a number into an object is the wrong kind
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

/**
 * Follows a subscription's address now: sets what it reaches, and the route
 * of the address's own names to it, as a read's first item gives it. Returns
 * whether either changed: another node or none, or another step, member or
 * position on the way.
 */
static bool follow(Graph *graph, Sub *sub) {
	ErmCtx ctx = { .place = sub->place };
	Target target;
	ErmRoute route = { 0 };
	Node *node = resolve(graph, &ctx, &sub->address, &target).kind ? NULL : reachOf(graph, NULL, &target, &route);
	if (!node) route.count = 0;
	const char *at = node ? node->id : NULL;
	bool moved = (at && sub->at) ? strcmp(at, sub->at) != 0 : at != sub->at;
	moved = moved || route.count != sub->route.count;
	for (int s = 0; !moved && s < route.count; s++) {
		const ErmStep *a = &route.items[s], *b = &sub->route.items[s];
		moved = strcmp(a->parent, b->parent) || strcmp(a->name, b->name) || strcmp(a->node, b->node) || a->position != b->position;
	}
	free(sub->route.items);
	sub->at = at;
	sub->route = route;
	return moved;
}

/**
 * CORE subscribe: sends a change to each subscription whose node it changed,
 * and each change that changed the subscription's route, whether or not it
 * then reaches another node, with what reading its address now gives; so a
 * placement that makes the node a subscription comes to reach is sent to it
 * once, as a route change.
 */
static void deliver(Graph *graph, const ErmChange *change) {
	for (int i = 0; i < graph->subs.count; i++) {
		Sub *sub = &graph->subs.items[i];
		if (!sub->live) continue;
		if (follow(graph, sub)) {
			ErmCtx ctx = { .place = sub->place };
			Target target;
			ErmResult now = { 0 };
			if (!resolve(graph, &ctx, &sub->address, &target).kind) readValue(graph, &ctx, &target, &now);
			sub->fn(sub->data, change, &now.items);
			free(now.items.items);
		} else if (sub->at && strcmp(sub->at, change->node) == 0) {
			sub->fn(sub->data, change, NULL);
		}
	}
}

/** the slot of that name, made empty in code point order of names when it is not there */
static Slot *slotMade(Node *parent, const char *name) {
	Slot *slot = slotOf(parent, name);
	if (slot) return slot;
	int at = 0;
	while (at < parent->dir.count && textCompare(parent->dir.items[at].name, name) < 0) at++;
	ERM_PUSH(parent->dir, ((Slot){ 0 }));
	memmove(&parent->dir.items[at + 1], &parent->dir.items[at], (size_t)(parent->dir.count - 1 - at) * sizeof *parent->dir.items);
	parent->dir.items[at] = (Slot){ .name = name };
	return &parent->dir.items[at];
}

/** takes the id at `at` out of a slot of `parent`, and a slot with no ids is gone */
static void takeOut(Node *parent, Slot *slot, int at) {
	const char *id = slot->ids.items[at];
	int kept = indexOf(&slot->kept, id);
	if (kept >= 0) takeAt(&slot->kept, kept);
	takeAt(&slot->ids, at);
	if (slot->ids.count) return;
	free(slot->ids.items);
	free(slot->kept.items);
	int s = (int)(slot - parent->dir.items);
	memmove(slot, slot + 1, (size_t)(parent->dir.count - 1 - s) * sizeof *slot);
	parent->dir.count--;
}

/**
 * CORE Ephemeral nodes: whether placing op->id in the slot op->name of
 * `parent` breaks an ephemeral node's uniqueness. Making an ephemeral node
 * with an id any slot holds does (a search, only when one is made); so does
 * placing an ephemeral node that is here, or mounting its id, in any slot but
 * the one it was made in.
 */
static bool onePlace(Graph *graph, Node *parent, const ErmOp *op) {
	if (op->value) return op->ephemeral && heldAnywhere(graph, op->id);
	Node *placed = nodeOf(graph, op->id);
	return placed && placed->ephemeral && (placed->parent != parent || strcmp(placed->slot, op->name) != 0);
}

/**
 * CORE Placement: checks, then places, moves, makes or mounts op->id in the
 * slot op->name of `parent`: exists, ephemeral-parent, one-place, then
 * position. A change that is not ephemeral is the slot's last, and keeps the
 * id there. An ephemeral node made here keeps this slot as its one slot.
 */
static ErmErr place(Graph *graph, Node *parent, const ErmOp *op, ErmChange *change) {
	if (op->value && nodeOf(graph, op->id)) return ermInvalid("exists");
	if (op->value && !op->ephemeral && parent->ephemeral) return ermInvalid("ephemeral-parent");
	if (onePlace(graph, parent, op)) return ermInvalid("one-place");
	Slot *slot = slotOf(parent, op->name);
	int length = slot ? slot->ids.count : 0;
	if (op->hasPosition && op->position > length) return ermDetail(ermInvalid("position"), "length", jsonInteger(length));
	Node *placed = nodeOf(graph, op->id);
	*change = (ErmChange){ .node = parent->id, .kind = ERM_PLACE, .name = op->name, .id = op->id, .hasPosition = op->hasPosition, .position = op->position, .value = op->value };
	change->ephemeral = parent->ephemeral || (op->value ? op->ephemeral : placed && placed->ephemeral);
	if (op->value) {
		Node *made = allocate(sizeof *made);
		made->id = op->id;
		made->value = op->value;
		made->change = change;
		made->ephemeral = op->ephemeral;
		if (op->ephemeral) {
			made->parent = parent;
			made->slot = op->name;
		}
		ermMapPut(&graph->nodes, op->id, made);
	}
	slot = slotMade(parent, op->name);
	ErmIds *ids = &slot->ids;
	int old = indexOf(ids, op->id);
	if (op->hasPosition || old < 0) {
		// put it in at its gap, the end when none was given, then take its old place out
		int gap = op->hasPosition ? (int)op->position : ids->count;
		ERM_PUSH(*ids, op->id);
		memmove(&ids->items[gap + 1], &ids->items[gap], (size_t)(ids->count - 1 - gap) * sizeof *ids->items);
		ids->items[gap] = op->id;
		if (old >= 0) takeAt(ids, old < gap ? old : old + 1);
	}
	if (!change->ephemeral) {
		slot->change = change;
		if (indexOf(&slot->kept, op->id) < 0) ERM_PUSH(slot->kept, op->id);
	}
	return ermOk();
}

static ErmErr unplace(Graph *graph, Node *parent, const ErmOp *op, ErmChange *change) {
	Slot *slot = slotOf(parent, op->name);
	int at = slot ? indexOf(&slot->ids, op->id) : -1;
	if (at < 0) return ermInvalid("not-in-slot");
	Node *placed = nodeOf(graph, op->id);
	*change = (ErmChange){ .node = parent->id, .kind = ERM_UNPLACE, .name = op->name, .id = op->id };
	change->ephemeral = parent->ephemeral || (placed && placed->ephemeral);
	if (!change->ephemeral) slot->change = change;
	takeOut(parent, slot, at);
	return ermOk();
}

/** a change is made: it is the graph's latest, marks its readers and is sent to its subscribers */
static void made(Graph *graph, const ErmChange *change, ErmResult *out) {
	graph->last = change->time;
	mark(graph, change, &out->marked);
	deliver(graph, change);
}

/**
 * CORE Ephemeral nodes: an ephemeral node unplaced from its one slot goes,
 * after what it held. Its slots are taken apart, by name in code point order
 * and the ids of each in slot order; each member taken out is an unplacement
 * of its own, ephemeral, at the next time, by the agent, process and cause of
 * the change `by` that let the first node go, and each ephemeral member, its
 * one slot being this one, is taken apart the same way before the next. An
 * ordinary member stays, here. A loop over a stack of the nodes being taken
 * apart, not recursion; ephemeral nodes hold each other in a tree, so each
 * is on the stack once.
 */
static void letGo(Graph *graph, Node *first, const ErmChange *by, ErmResult *out) {
	ERM_LIST(Node *) going = { 0 };
	ERM_PUSH(going, first);
	while (going.count) {
		Node *node = going.items[going.count - 1];
		if (!node->dir.count) {
			// it goes: its id (the request's, not the node's) names nothing, and the node is freed
			ERM_PUSH(out->gone, node->id);
			ermMapPut(&graph->nodes, node->id, NULL);
			free(node->dir.items);
			free(node);
			going.count--;
			continue;
		}
		Slot *slot = &node->dir.items[0];
		const char *id = slot->ids.items[0];
		ErmChange *change = allocate(sizeof *change);
		*change = (ErmChange){ .node = node->id, .time = graph->last + 1, .kind = ERM_UNPLACE, .name = slot->name, .id = id, .agent = by->agent, .process = by->process, .cause = by->cause, .ephemeral = true };
		takeOut(node, slot, 0);
		made(graph, change, out);
		Node *held = nodeOf(graph, id);
		if (held && held->ephemeral) ERM_PUSH(going, held);
	}
	free(going.items);
}

/** whether a write would snapshot a live value: only an ephemeral node may hold one */
static bool snapshotsLive(const Json *patches) {
	for (int i = 0; i < patches->array.count; i++) {
		const Json *patch = patches->array.items[i], *value = jsonGet(patch, "value");
		const char *type = jsonText(jsonGet(patch, "type"));
		if (type && strcmp(type, "snapshot") == 0 && value && value->type == JSON_LIVE) return true;
	}
	return false;
}

/** write, place or unplace at `node`: when (the time), then what (the change itself) */
static ErmErr changeAt(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, Node *node, ErmResult *out) {
	if (stamp->time <= graph->last) return ermDetail(ermInvalid("time"), "last", jsonNumber(graph->last));
	ErmChange *change = allocate(sizeof *change);
	ErmErr err = ermOk();
	if (op->kind == ERM_OP_WRITE) {
		Json *value = NULL;
		if (!node->ephemeral && snapshotsLive(op->patches)) err = ermDetail(ermInvalid("wrong-field"), "field", jsonString("patches"));
		else err = applyPatches(op->patches, node->value, &value);
		if (!err.kind) {
			*change = (ErmChange){ .node = node->id, .kind = ERM_WRITE, .patches = op->patches, .ephemeral = node->ephemeral };
			node->value = value;
			node->change = change;
		}
	} else if (op->kind == ERM_OP_PLACE) {
		err = place(graph, node, op, change);
	} else {
		err = unplace(graph, node, op, change);
	}
	if (err.kind) {
		free(change);
		return err;
	}
	change->time = stamp->time;
	change->agent = ctx->agent ? ctx->agent : jsonNull();
	change->process = ctx->process;
	change->cause = stamp->cause;
	out->change = change;
	made(graph, change, out);
	Node *unplaced = op->kind == ERM_OP_UNPLACE ? nodeOf(graph, op->id) : NULL;
	if (unplaced && unplaced->ephemeral) letGo(graph, unplaced, change, out);
	if (out->marked.count > 1) qsort(out->marked.items, (size_t)out->marked.count, sizeof *out->marked.items, byProcess);
	return ermOk();
}

/** write, place or unplace: where (the node the address reaches), then when and what (changeAt) */
static ErmErr change(Graph *graph, const ErmCtx *ctx, const ErmStamp *stamp, const ErmOp *op, const Target *target, ErmResult *out) {
	Node *node = reachOf(graph, NULL, target, NULL);
	if (!node) return ermInvalid("nothing-there");
	return changeAt(graph, ctx, stamp, op, node, out);
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
	follow(graph, &made);
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

static ErmRecording *runRecord(void *self, ErmApi api, const ErmTimes *marked) {
	RunApi *run = self;
	return run->inner.vt->record(run->inner.self, api, marked);
}

static ErmRecord *runFinish(void *self, ErmRecording *recording, ErmEnding ending) {
	RunApi *run = self;
	return run->inner.vt->finish(run->inner.self, recording, ending);
}

static void runForget(void *self, const char *process) {
	RunApi *run = self;
	run->inner.vt->forget(run->inner.self, process);
}

static void runReload(void *self) {
	RunApi *run = self;
	run->inner.vt->reload(run->inner.self);
}

static void runSetTop(void *self, ErmInterface top) {
	RunApi *run = self;
	run->inner.vt->setTop(run->inner.self, top);
}

static const ErmVtable runVtable = { runOp, runSubscribe, runUnsubscribe, runForget, runReload, runRecord, runFinish, runSetTop };

/** a run starts: a read-only api's process reads afresh under a new tag, alongside its last finished run's */
static ErmRecording *graphRecord(void *self, ErmApi api, const ErmTimes *marked) {
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

/** CORE forget: drops the reads kept for the process, its run under way's too */
static void graphForget(void *self, const char *process) {
	Process *kept = ermMapGet(&((Graph *)self)->processes, process);
	if (kept) kept->last = kept->now = NULL;
}

/**
 * PROTOCOL reload: the graph as storing it and loading it again leaves it.
 * Every ephemeral node goes, and is freed; each slot of the rest keeps only the ids a change
 * that was not ephemeral put there, and its last such change, and a slot left
 * with none goes. Every
 * subscription and every reader's kept reads are dropped. The last time is
 * kept. Not a change: it marks no one and is sent to no one.
 */
static void graphReload(void *self) {
	Graph *graph = self;
	for (int i = 0; i < graph->nodes.count; i++) {
		Node *node = graph->nodes.entries[i].value;
		if (!node || !node->ephemeral) continue;
		for (int s = 0; s < node->dir.count; s++) {
			free(node->dir.items[s].ids.items);
			free(node->dir.items[s].kept.items);
		}
		free(node->dir.items);
		free(node);
		graph->nodes.entries[i].value = NULL;
	}
	for (int i = 0; i < graph->nodes.count; i++) {
		Node *node = graph->nodes.entries[i].value;
		if (!node) continue;
		for (int s = 0; s < node->dir.count; s++) {
			Slot *slot = &node->dir.items[s];
			for (int k = slot->ids.count - 1; k >= 0; k--) {
				if (indexOf(&slot->kept, slot->ids.items[k]) < 0) takeAt(&slot->ids, k);
			}
			if (slot->ids.count) continue;
			free(slot->ids.items);
			free(slot->kept.items);
			memmove(slot, slot + 1, (size_t)(node->dir.count - 1 - s) * sizeof *slot);
			node->dir.count--;
			s--;
		}
	}
	for (int i = 0; i < graph->subs.count; i++) graph->subs.items[i].live = false;
	for (int i = 0; i < graph->processes.count; i++) graphForget(graph, graph->processes.entries[i].key);
}

static const ErmVtable graphVtable = { graphOp, graphSubscribe, graphUnsubscribe, graphForget, graphReload, graphRecord, graphFinish, graphSetTop };

ErmInterface ermGraph(const char *root) {
	Graph *graph = allocate(sizeof *graph);
	graph->root = allocate(sizeof *graph->root);
	graph->root->id = root;
	graph->root->value = jsonNull();
	ermMapPut(&graph->nodes, root, graph->root);
	graph->self = (ErmInterface){ &graphVtable, graph };
	return graph->self;
}

ErmTime ermGraphLast(ErmInterface graph) {
	return ((Graph *)graph.self)->last;
}

ErmErr ermGraphRelease(ErmInterface graph, const ErmCtx *ctx, const ErmStamp *stamp, const char *id, ErmResult *out) {
	Graph *self = graph.self;
	Node *node = nodeOf(self, id);
	if (!node || !node->ephemeral) return ermInvalid("nothing-there");
	ErmOp op = { .kind = ERM_OP_UNPLACE, .name = node->slot, .id = id };
	return changeAt(self, ctx, stamp, &op, node->parent, out);
}
