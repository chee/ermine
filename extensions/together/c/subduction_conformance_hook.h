// The Subduction kit's conformance hooks, in C: what only the harnesses call (transport_conformance_hook.h
// has them under the device's names). Built only where CONFORMANCE_HOOK is defined (the harnesses'
// builds: the Makefile's), from subduction_conformance_hook.c, which subduction.c includes then
#ifndef SUBDUCTION_CONFORMANCE_HOOK_H
#define SUBDUCTION_CONFORMANCE_HOOK_H

#include "subduction.h"

#ifndef CONFORMANCE_HOOK
#error "subduction_conformance_hook.h: the hooks are built only with CONFORMANCE_HOOK defined"
#endif

// addCommit as given: nothing checked or taken in first (taken in as a save is)
bool sb_conformance_hook_put(sb_kit *t, const char *doc, const uint8_t head[32], const uint8_t (*parents)[32],
	size_t count, const uint8_t *blob, size_t length);
// addFragment as given, likewise
bool sb_conformance_hook_put_fragment(sb_kit *t, const char *doc, const uint8_t head[32],
	const uint8_t (*boundary)[32], size_t count, const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob,
	size_t length);
// how many puts Subduction has not answered
size_t sb_conformance_hook_putting(const sb_kit *t);

#endif
