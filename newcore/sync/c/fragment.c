#include "fragment.h"

#include <stdlib.h>
#include <string.h>

size_t fragment_depth(const uint8_t id[32]) {
	size_t n = 0;
	while (n < 32 && id[n] == 0) n++;
	return n;
}

// where an id is, or would go
static size_t find(const fragment_ids *ids, const uint8_t id[32], bool *found) {
	size_t lo = 0, hi = ids->count;
	while (lo < hi) {
		size_t mid = (lo + hi) / 2;
		int c = memcmp(ids->ids[mid], id, 32);
		if (c == 0) return *found = true, mid;
		if (c < 0) lo = mid + 1;
		else hi = mid;
	}
	*found = false;
	return lo;
}

static bool has(const fragment_ids *ids, const uint8_t id[32]) {
	bool found;
	find(ids, id, &found);
	return found;
}

bool fragment_add(fragment_ids *ids, const uint8_t id[32]) {
	bool found;
	size_t at = find(ids, id, &found);
	if (found) return false;
	if (ids->count == ids->capacity) {
		ids->capacity = ids->capacity ? ids->capacity * 2 : 8;
		ids->ids = realloc(ids->ids, ids->capacity * 32);
		if (ids->ids == NULL) abort();
	}
	memmove(ids->ids[at + 1], ids->ids[at], (ids->count - at) * 32);
	memcpy(ids->ids[at], id, 32);
	ids->count++;
	return true;
}

static void drop(fragment_ids *ids, const uint8_t id[32]) {
	bool found;
	size_t at = find(ids, id, &found);
	if (!found) return;
	memmove(ids->ids[at], ids->ids[at + 1], (ids->count - at - 1) * 32);
	ids->count--;
}

// a stack of ids, in the order pushed
static void push(fragment_ids *stack, const uint8_t id[32]) {
	if (stack->count == stack->capacity) {
		stack->capacity = stack->capacity ? stack->capacity * 2 : 8;
		stack->ids = realloc(stack->ids, stack->capacity * 32);
		if (stack->ids == NULL) abort();
	}
	memcpy(stack->ids[stack->count++], id, 32);
}

static void clear(fragment_ids *ids) {
	free(ids->ids);
	memset(ids, 0, sizeof *ids);
}

void fragment_free(fragment *f) {
	clear(&f->members);
	clear(&f->boundary);
	clear(&f->checkpoints);
}

void fragment_release(fragment *list, size_t count) {
	for (size_t i = 0; i < count; i++) fragment_free(&list[i]);
	free(list);
}

fragment_code fragment_walk(const uint8_t head[32], fragment_lookup lookup, fragment_known known, void *context, fragment *out) {
	size_t deep = fragment_depth(head);
	if (deep == 0) return FRAGMENT_DEPTH_ZERO;
	const uint8_t(*parents)[32];
	size_t count;
	if (!lookup(context, head, &parents, &count)) return FRAGMENT_MISSING;
	fragment f = {0};
	memcpy(f.head, head, 32);
	fragment_ids visited = {0}, queue = {0};
	fragment_add(&visited, head);
	fragment_add(&f.members, head);
	for (size_t i = 0; i < count; i++) push(&queue, parents[i]);
	fragment_code code = FRAGMENT_OK;
	while (queue.count > 0) {
		uint8_t id[32];
		memcpy(id, queue.ids[--queue.count], 32);
		if (!fragment_add(&visited, id)) continue;
		if (!lookup(context, id, &parents, &count)) {
			code = FRAGMENT_MISSING;
			break;
		}
		size_t d = fragment_depth(id);
		// the same depth or more: a boundary commit, not walked through
		if (d >= deep) fragment_add(&f.boundary, id);
		else {
			fragment_add(&f.members, id);
			if (d > 0) fragment_add(&f.checkpoints, id);
			for (size_t i = 0; i < count; i++)
				if (!has(&visited, parents[i])) push(&queue, parents[i]);
		}
	}
	clear(&visited);
	clear(&queue);
	if (code != FRAGMENT_OK) return fragment_free(&f), code;
	// the fragments here whose heads are boundary commits are below this one
	for (size_t b = 0; b < f.boundary.count; b++) {
		const fragment *below = known(context, f.boundary.ids[b]);
		if (below == NULL) continue;
		for (size_t m = 0; m < below->members.count; m++) {
			drop(&f.members, below->members.ids[m]);
			drop(&f.checkpoints, below->members.ids[m]);
		}
	}
	*out = f;
	return FRAGMENT_OK;
}

// the fragments made so far, over the host's
typedef struct {
	fragment_lookup lookup;
	fragment_known known;
	void *context;
	fragment *made;
	size_t count, capacity;
} here;

static const fragment *made(const here *h, const uint8_t head[32]) {
	for (size_t i = 0; i < h->count; i++)
		if (memcmp(h->made[i].head, head, 32) == 0) return &h->made[i];
	return NULL;
}

static const fragment *here_known(void *context, const uint8_t head[32]) {
	here *h = context;
	const fragment *f = made(h, head);
	return f ? f : h->known(h->context, head);
}

static bool here_lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count) {
	here *h = context;
	return h->lookup(h->context, id, parents, count);
}

fragment_code fragment_build(const uint8_t (*heads)[32], size_t count, fragment_lookup lookup, fragment_known known, void *context, fragment **out, size_t *out_count) {
	here h = {.lookup = lookup, .known = known, .context = context};
	fragment_ids queue = {0}, visited = {0};
	for (size_t i = 0; i < count; i++) push(&queue, heads[i]);
	while (queue.count > 0) {
		uint8_t id[32];
		memcpy(id, queue.ids[--queue.count], 32);
		if (!fragment_add(&visited, id)) continue;
		const fragment *have = here_known(&h, id);
		if (have != NULL) {
			for (size_t i = 0; i < have->boundary.count; i++) push(&queue, have->boundary.ids[i]);
			continue;
		}
		if (fragment_depth(id) == 0) {
			const uint8_t(*parents)[32];
			size_t n;
			if (lookup(context, id, &parents, &n))
				for (size_t i = 0; i < n; i++) push(&queue, parents[i]);
			continue;
		}
		fragment f;
		fragment_code code = fragment_walk(id, here_lookup, here_known, &h, &f);
		// a commit it needs is not here: no fragment for this head
		if (code == FRAGMENT_MISSING) continue;
		for (size_t i = 0; i < f.boundary.count; i++) push(&queue, f.boundary.ids[i]);
		if (h.count == h.capacity) {
			h.capacity = h.capacity ? h.capacity * 2 : 8;
			h.made = realloc(h.made, h.capacity * sizeof *h.made);
			if (h.made == NULL) abort();
		}
		h.made[h.count++] = f;
	}
	clear(&queue);
	clear(&visited);
	// every fragment is made: strip the members and checkpoints of all the fragments below each
	for (size_t i = 0; i < h.count; i++) {
		fragment *f = &h.made[i];
		fragment_ids below = {0}, seen = {0}, todo = {0};
		for (size_t b = 0; b < f->boundary.count; b++) push(&todo, f->boundary.ids[b]);
		while (todo.count > 0) {
			uint8_t id[32];
			memcpy(id, todo.ids[--todo.count], 32);
			if (!fragment_add(&seen, id)) continue;
			const fragment *g = here_known(&h, id);
			if (g == NULL) continue;
			for (size_t m = 0; m < g->members.count; m++) fragment_add(&below, g->members.ids[m]);
			for (size_t b = 0; b < g->boundary.count; b++) push(&todo, g->boundary.ids[b]);
		}
		for (size_t m = 0; m < below.count; m++) {
			drop(&f->members, below.ids[m]);
			drop(&f->checkpoints, below.ids[m]);
		}
		clear(&below);
		clear(&seen);
		clear(&todo);
	}
	*out = h.made;
	*out_count = h.count;
	return FRAGMENT_OK;
}
