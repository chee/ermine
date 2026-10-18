// The transport's conformance hooks (transport_conformance_hook.h), in C. transport.c includes this
// file, with CONFORMANCE_HOOK defined: put is the kit's (subduction_conformance_hook.h), taking the
// device's
#include "transport_conformance_hook.h"
#include "subduction_conformance_hook.h"

bool tp_conformance_hook_put(tp_device *t, const char *id, const uint8_t head[32], const uint8_t (*parents)[32], size_t count,
	const uint8_t *blob, size_t length) {
	return sb_conformance_hook_put(t->kit, id, head, parents, count, blob, length);
}

bool tp_conformance_hook_put_fragment(tp_device *t, const char *id, const uint8_t head[32], const uint8_t (*boundary)[32], size_t count,
	const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length) {
	return sb_conformance_hook_put_fragment(t->kit, id, head, boundary, count, checkpoints, checks, blob, length);
}

size_t tp_conformance_hook_putting(const tp_device *t) {
	return sb_conformance_hook_putting(t->kit);
}

tp_conformance_hook_taking tp_conformance_hook_taking_of(tp_device *t, const char *id, tp_layer layer) {
	return tp_taking_of(t, id, layer);
}

void tp_conformance_hook_taking_free(tp_conformance_hook_taking *taking) {
	tp_taking_free(taking);
}
