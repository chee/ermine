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

// what the transport holds back or refused before the histories: tp_taking_of's (transport.h)
typedef tp_waiting_row tp_conformance_hook_waiting;
typedef tp_refused_row tp_conformance_hook_refused;
typedef tp_taking tp_conformance_hook_taking;
tp_conformance_hook_taking tp_conformance_hook_taking_of(tp_device *t, const char *doc, tp_layer layer);
void tp_conformance_hook_taking_free(tp_conformance_hook_taking *taking);

#endif
