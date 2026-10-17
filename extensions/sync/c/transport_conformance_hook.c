// The transport's conformance hooks (transport_conformance_hook.h), in C. transport.c includes this
// file, with CONFORMANCE_HOOK defined, so these reach its own statics: put is Subduction's addCommit
// or addFragment as given, nothing checked or taken in first; what Subduction answers is taken in as
// any save is (transport.c's C_PUT and C_PUT_FRAGMENT calls)
#include "transport_conformance_hook.h"

static bool put(tp_device *t, const char *id, call_kind kind, const uint8_t head[32], const uint8_t (*list)[32],
	size_t count, const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length) {
	doc *d = named(t, id);
	if (d == NULL) return false;
	uint64_t c = kind == C_PUT
		? erm_sd_add_commit(t->sd, d->bytes, head, count ? (const uint8_t *)list : NULL, count, blob, length)
		: erm_sd_add_fragment(t->sd, d->bytes, head, count ? (const uint8_t *)list : NULL, count,
			checks ? (const uint8_t *)checkpoints : NULL, checks, blob, length);
	if (c == 0) return false;
	put_t *p = calloc(1, sizeof *p);
	if (p == NULL) abort();
	p->d = d;
	memcpy(p->head, head, 32);
	p->list = copy(list, count * 32);
	p->count = count;
	p->blob = copy(blob, length);
	p->length = length;
	call(t, c, kind, p);
	t->putting++;
	return true;
}

bool tp_conformance_hook_put(tp_device *t, const char *id, const uint8_t head[32], const uint8_t (*parents)[32], size_t count,
	const uint8_t *blob, size_t length) {
	return put(t, id, C_PUT, head, parents, count, NULL, 0, blob, length);
}

bool tp_conformance_hook_put_fragment(tp_device *t, const char *id, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length) {
	return put(t, id, C_PUT_FRAGMENT, head, boundary, count, checkpoints, checks, blob, length);
}

size_t tp_conformance_hook_putting(const tp_device *t) {
	return t->putting;
}

static int by_waiting(const void *a, const void *b) {
	return memcmp(((const tp_conformance_hook_waiting *)a)->commit, ((const tp_conformance_hook_waiting *)b)->commit, 32);
}

static int by_refused(const void *a, const void *b) {
	return memcmp(((const tp_conformance_hook_refused *)a)->id, ((const tp_conformance_hook_refused *)b)->id, 32);
}

tp_conformance_hook_taking tp_conformance_hook_taking_of(tp_device *t, const char *id, tp_layer layer) {
	tp_conformance_hook_taking out = {0};
	doc *d = named(t, id);
	if (d == NULL) return out;
	if (layer == TP_EPHEMERAL) {
		out.refused = calloc(d->heard.count + 1, sizeof *out.refused);
		if (out.refused == NULL) abort();
		for (size_t i = 0; i < d->heard.slots; i++) {
			if (!d->heard.used[i]) continue;
			tp_conformance_hook_refused *r = &out.refused[out.refused_count++];
			memcpy(r->id, d->heard.keys[i], 32);
			r->code = (tp_code)(uintptr_t)d->heard.values[i];
		}
		qsort(out.refused, out.refused_count, sizeof *out.refused, by_refused);
		return out;
	}
	out.waiting = calloc(d->pending.count + 1, sizeof *out.waiting);
	out.refused = calloc(d->pending.count + d->refused.count + d->broken.count + 1, sizeof *out.refused);
	if (out.waiting == NULL || out.refused == NULL) abort();
	for (size_t i = 0; i < d->pending.slots; i++) {
		if (!d->pending.used[i]) continue;
		const pending_t *p = d->pending.values[i];
		if (p->waits) {
			tp_conformance_hook_waiting *w = &out.waiting[out.waiting_count++];
			memcpy(w->commit, p->key, 32);
			w->names = copy(p->waiting, p->waiting_length * 32);
			w->count = p->waiting_length;
		} else if (p->sticks) {
			tp_conformance_hook_refused *r = &out.refused[out.refused_count++];
			memcpy(r->id, p->key, 32);
			r->stuck = true;
			r->names = copy(p->stuck, p->stuck_length * 32);
			r->count = p->stuck_length;
		}
	}
	for (int k = 0; k < 2; k++) {
		const im_map *m = k == 0 ? &d->refused : &d->broken;
		for (size_t i = 0; i < m->slots; i++) {
			if (!m->used[i]) continue;
			tp_conformance_hook_refused *r = &out.refused[out.refused_count++];
			memcpy(r->id, m->keys[i], 32);
			r->fragment = k == 1;
			r->code = (tp_code)(uintptr_t)m->values[i];
		}
	}
	qsort(out.waiting, out.waiting_count, sizeof *out.waiting, by_waiting);
	qsort(out.refused, out.refused_count, sizeof *out.refused, by_refused);
	return out;
}

void tp_conformance_hook_taking_free(tp_conformance_hook_taking *taking) {
	for (size_t i = 0; i < taking->waiting_count; i++) free(taking->waiting[i].names);
	for (size_t i = 0; i < taking->refused_count; i++) free(taking->refused[i].names);
	free(taking->waiting);
	free(taking->refused);
	*taking = (tp_conformance_hook_taking){0};
}
