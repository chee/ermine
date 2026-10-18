// The stack's conformance hooks (subduction_conformance_hook.h), in C. subduction.c includes this
// file, with CONFORMANCE_HOOK defined, so these reach its own statics: put is Subduction's addCommit
// or addFragment as given, nothing checked or taken in first; what Subduction answers is taken in as
// any save is (subduction.c's C_PUT and C_PUT_FRAGMENT calls)
#include "subduction_conformance_hook.h"

static bool put(sb_stack *t, const char *id, call_kind kind, const uint8_t head[32], const uint8_t (*list)[32],
	size_t count, const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length) {
	mr_doc *d = mr_named(t->mailroom, id);
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
	p->list = mr_copy(list, count * 32);
	p->count = count;
	p->blob = mr_copy(blob, length);
	p->length = length;
	p->checks = malloc(checks * 12 + 1);
	if (p->checks == NULL) abort();
	for (size_t i = 0; i < checks; i++) memcpy(p->checks + 12 * i, checkpoints[i], 12);
	p->checks_count = checks;
	call(t, c, kind, p);
	t->putting++;
	return true;
}

bool sb_conformance_hook_put(sb_stack *t, const char *id, const uint8_t head[32], const uint8_t (*parents)[32], size_t count,
	const uint8_t *blob, size_t length) {
	return put(t, id, C_PUT, head, parents, count, NULL, 0, blob, length);
}

bool sb_conformance_hook_put_fragment(sb_stack *t, const char *id, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length) {
	return put(t, id, C_PUT_FRAGMENT, head, boundary, count, checkpoints, checks, blob, length);
}

size_t sb_conformance_hook_putting(const sb_stack *t) {
	return t->putting;
}
