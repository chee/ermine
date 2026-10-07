// collect.c: collect.h.

#include "collect.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// a set of pointers (open addressing) -------------------------------------------------

typedef struct Set {
	const void **slots;
	size_t capacity, count;
} Set;

static size_t hashOf(const void *p) {
	uint64_t x = (uint64_t)(uintptr_t)p;
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
	return (size_t)x;
}

static void setGrow(Set *set);

/** true when it was not there */
static bool setAdd(Set *set, const void *p) {
	if ((set->count + 1) * 2 > set->capacity) setGrow(set);
	size_t mask = set->capacity - 1;
	for (size_t i = hashOf(p) & mask;; i = (i + 1) & mask) {
		if (set->slots[i] == p) return false;
		if (!set->slots[i]) {
			set->slots[i] = p;
			set->count++;
			return true;
		}
	}
}

static void setGrow(Set *set) {
	Set bigger = { calloc(set->capacity ? set->capacity * 2 : 64, sizeof *set->slots), set->capacity ? set->capacity * 2 : 64, 0 };
	if (!bigger.slots) abort();
	for (size_t i = 0; i < set->capacity; i++) {
		if (set->slots[i]) setAdd(&bigger, set->slots[i]);
	}
	free(set->slots);
	*set = bigger;
}

static bool setHas(const Set *set, const void *p) {
	if (!set->capacity) return false;
	size_t mask = set->capacity - 1;
	for (size_t i = hashOf(p) & mask; set->slots[i]; i = (i + 1) & mask) {
		if (set->slots[i] == p) return true;
	}
	return false;
}

// walking and freeing values ---------------------------------------------------------

typedef ERM_LIST(Json *) Stack;

static void children(Json *value, Stack *stack) {
	if (value->type == JSON_ARRAY) {
		for (int i = 0; i < value->array.count; i++) ERM_PUSH(*stack, value->array.items[i]);
	} else if (value->type == JSON_OBJECT) {
		for (int i = 0; i < value->object.count; i++) ERM_PUSH(*stack, value->object.members[i].value);
	}
}

/** one value's own storage, not its children's */
static void freeOne(Json *value) {
	if (value->type == JSON_STRING || value->type == JSON_LIVE) {
		free(value->string);
	} else if (value->type == JSON_BYTES) {
		free(value->bytes.data);
	} else if (value->type == JSON_TYPED) {
		free(value->typed.data);
	} else if (value->type == JSON_ARRAY) {
		free(value->array.items);
	} else if (value->type == JSON_OBJECT) {
		for (int i = 0; i < value->object.count; i++) free(value->object.members[i].key);
		free(value->object.members);
	}
	free(value);
}

static void mark(Set *kept, Json *const *roots, int count, Stack *stack) {
	for (int r = 0; r < count; r++) {
		if (roots[r]) ERM_PUSH(*stack, roots[r]);
	}
	while (stack->count) {
		Json *at = stack->items[--stack->count];
		if (at && setAdd(kept, at)) children(at, stack);
	}
}

size_t jsonSweep(Json *const *old, int oldCount, Json *const *keep, int keepCount) {
	Set kept = { 0 }, seen = { 0 };
	Stack stack = { 0 };
	mark(&kept, keep, keepCount, &stack);
	size_t freed = 0;
	for (int r = 0; r < oldCount; r++) {
		if (old[r]) ERM_PUSH(stack, old[r]);
	}
	while (stack.count) {
		Json *at = stack.items[--stack.count];
		if (!at || setHas(&kept, at) || !setAdd(&seen, at)) continue;
		children(at, &stack);
		freeOne(at);
		freed++;
	}
	free(kept.slots);
	free(seen.slots);
	free(stack.items);
	return freed;
}

void jsonFreeAnswer(Json *answer) {
	static const char *const shared[] = { "value", "agent", "cause", "patches", "seq" };
	Set seen = { 0 };
	Stack stack = { 0 };
	if (answer) ERM_PUSH(stack, answer);
	while (stack.count) {
		Json *at = stack.items[--stack.count];
		if (!at || !setAdd(&seen, at)) continue;
		if (at->type == JSON_ARRAY) {
			for (int i = 0; i < at->array.count; i++) ERM_PUSH(stack, at->array.items[i]);
		} else if (at->type == JSON_OBJECT) {
			for (int i = 0; i < at->object.count; i++) {
				const JsonMember *m = &at->object.members[i];
				bool keep = false;
				for (size_t k = 0; k < sizeof shared / sizeof *shared && !keep; k++) {
					keep = m->keyLength == strlen(shared[k]) && memcmp(m->key, shared[k], m->keyLength) == 0;
				}
				if (!keep) ERM_PUSH(stack, m->value);
			}
		}
		freeOne(at);
	}
	free(seen.slots);
	free(stack.items);
}

void ermResultFree(ErmResult *out) {
	// the items of one member of a union share its route: each route is freed once
	Set routes = { 0 };
	for (int i = 0; i < out->items.count; i++) {
		if (out->items.items[i].route.items && setAdd(&routes, out->items.items[i].route.items)) free(out->items.items[i].route.items);
	}
	free(out->items.items);
	for (int e = 0; e < out->listing.count; e++) {
		ErmItems *items = &out->listing.items[e].items;
		for (int i = 0; i < items->count; i++) {
			if (items->items[i].route.items && setAdd(&routes, items->items[i].route.items)) free(items->items[i].route.items);
		}
		free(items->items);
	}
	free(out->listing.items);
	free(out->marked.items);
	free(out->gone.items);
	free(routes.slots);
	*out = (ErmResult){ 0 };
}

// the collector ------------------------------------------------------------------------

typedef struct Record {
	char *node;
	Json *value;             // what the node held after the last write collected
	const ErmChange *change; // that write's change
	Json *tree;              // what that write was made of
	ERM_LIST(Json *) roots;  // what earlier writes and values left, freed once nothing holds events
	ERM_LIST(ErmChange *) changes;
	ERM_LIST(Json *) bases;  // values from elsewhere (its placement's, an untracked write's): never freed
} Record;

struct Collector {
	ErmInterface graph;
	bool (*holding)(void *data, const char *node);
	void *data;
	ERM_LIST(Record *) records;
	size_t freed;
};

Collector *collectorNew(ErmInterface graph, bool (*holding)(void *data, const char *node), void *data) {
	Collector *collector = allocate(sizeof *collector);
	collector->graph = graph;
	collector->holding = holding;
	collector->data = data;
	return collector;
}

size_t collectFreed(const Collector *collector) {
	return collector->freed;
}

/** the one item reading the address gives, beneath every wrapper, untracked */
static bool readOne(Collector *collector, const ErmCtx *ctx, const ErmAddress *address, ErmItem *item) {
	ErmCtx read = { .agent = ctx->agent, .place = ctx->place };
	ErmOp op = { .kind = ERM_OP_READ, .address = *address };
	ErmResult out = { 0 };
	ErmInterface g = collector->graph;
	bool one = !g.vt->op(g.self, &read, NULL, &op, &out).kind && out.items.count == 1;
	if (one) *item = out.items.items[0];
	ermResultFree(&out);
	return one && item->value;
}

Before collectBefore(Collector *collector, const ErmCtx *ctx, const ErmAddress *address) {
	ErmItem item;
	if (!collector || !readOne(collector, ctx, address, &item) || !item.ephemeral) return (Before){ 0 };
	return (Before){ item.value, item.change, true };
}

static Record *recordOf(Collector *collector, const char *node) {
	for (int i = 0; i < collector->records.count; i++) {
		if (strcmp(collector->records.items[i]->node, node) == 0) return collector->records.items[i];
	}
	return NULL;
}

/** frees what the record's earlier writes left, keeping what its value and last write reach, and its bases */
static void sweep(Collector *collector, Record *record) {
	if (collector->holding && collector->holding(collector->data, record->node)) return;
	if (record->roots.count) {
		ERM_LIST(Json *) keep = { 0 };
		ERM_PUSH(keep, record->value);
		ERM_PUSH(keep, record->tree);
		for (int i = 0; i < record->bases.count; i++) ERM_PUSH(keep, record->bases.items[i]);
		collector->freed += jsonSweep(record->roots.items, record->roots.count, keep.items, keep.count);
		free(keep.items);
	}
	for (int i = 0; i < record->changes.count; i++) free(record->changes.items[i]);
	record->roots.count = record->changes.count = 0;
}

bool collectAfter(Collector *collector, const ErmCtx *ctx, const ErmAddress *address, Before before, Json *tree) {
	ErmItem item;
	if (!collector || !before.known || !readOne(collector, ctx, address, &item)) return false;
	if (!item.change || item.change == before.change || item.change->kind != ERM_WRITE) return false;
	Record *record = recordOf(collector, item.change->node);
	if (!record) {
		record = allocate(sizeof *record);
		record->node = copyString(item.change->node);
		ERM_PUSH(record->bases, before.value);
		ERM_PUSH(collector->records, record);
	} else if (record->value != before.value || record->change != before.change) {
		// someone else wrote it since: what was there is theirs; what this record's writes left is let be
		ERM_PUSH(record->bases, before.value);
		record->roots.count = record->changes.count = 0;
	} else {
		ERM_PUSH(record->roots, before.value);
		if (record->tree) ERM_PUSH(record->roots, record->tree);
		if (record->change) ERM_PUSH(record->changes, (ErmChange *)record->change);
	}
	record->value = item.value;
	record->change = item.change;
	record->tree = tree;
	sweep(collector, record);
	return true;
}

void collectForget(Collector *collector, const char *node) {
	if (!collector) return;
	for (int i = 0; i < collector->records.count; i++) {
		Record *record = collector->records.items[i];
		if (strcmp(record->node, node) != 0) continue;
		// the node is gone: its last value and write are garbage too, unless events still hold them
		if (!collector->holding || !collector->holding(collector->data, record->node)) {
			ERM_PUSH(record->roots, record->value);
			if (record->tree) ERM_PUSH(record->roots, record->tree);
			if (record->change) ERM_PUSH(record->changes, (ErmChange *)record->change);
			record->value = NULL;
			record->tree = NULL;
			sweep(collector, record);
		}
		free(record->roots.items);
		free(record->changes.items);
		free(record->bases.items);
		free(record->node);
		free(record);
		memmove(&collector->records.items[i], &collector->records.items[i + 1], (size_t)(collector->records.count - i - 1) * sizeof *collector->records.items);
		collector->records.count--;
		return;
	}
}
