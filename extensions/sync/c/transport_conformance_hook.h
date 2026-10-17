// The transport's conformance hooks, in C (extensions/sync/typescript/transport_conformance_hook.ts
// in TypeScript): what only the harnesses call. Built only where CONFORMANCE_HOOK is defined (the
// harnesses' builds: the Makefile's), from transport_conformance_hook.c, which transport.c includes then
#ifndef TRANSPORT_CONFORMANCE_HOOK_H
#define TRANSPORT_CONFORMANCE_HOOK_H

#include "transport.h"

#ifndef CONFORMANCE_HOOK
#error "transport_conformance_hook.h: the hooks are built only with CONFORMANCE_HOOK defined"
#endif

// addCommit as given: nothing checked or taken in first (taken in as a save is)
bool tp_conformance_hook_put(tp_device *t, const char *doc, const uint8_t head[32], const uint8_t (*parents)[32],
	size_t count, const uint8_t *blob, size_t length);
// addFragment as given, likewise
bool tp_conformance_hook_put_fragment(tp_device *t, const char *doc, const uint8_t head[32],
	const uint8_t (*boundary)[32], size_t count, const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob,
	size_t length);
// how many puts Subduction has not answered
size_t tp_conformance_hook_putting(const tp_device *t);

// what the transport holds back or refused before the histories. waiting: a loose commit (by its
// head), or a fragment's member (by its seal's stored id), and the names of its parents not here.
// refused, by id: a commit (code), a fragment refused whole (fragment, code), or one stuck on a parent
// refused or stuck here (stuck, the names of those parents). Each list sorted by id. The ephemeral
// layer: no waiting, the refused ephemeral commits by name
typedef struct {
	uint8_t commit[32];
	uint8_t (*names)[32];
	size_t count;
} tp_conformance_hook_waiting;
typedef struct {
	uint8_t id[32];
	bool fragment, stuck;
	tp_code code;
	uint8_t (*names)[32];
	size_t count;
} tp_conformance_hook_refused;
typedef struct {
	tp_conformance_hook_waiting *waiting;
	size_t waiting_count;
	tp_conformance_hook_refused *refused;
	size_t refused_count;
} tp_conformance_hook_taking;
tp_conformance_hook_taking tp_conformance_hook_taking_of(tp_device *t, const char *doc, tp_layer layer);
void tp_conformance_hook_taking_free(tp_conformance_hook_taking *taking);

#endif
