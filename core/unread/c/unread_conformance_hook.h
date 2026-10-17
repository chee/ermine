// unread's conformance hooks, in C (core/unread/typescript/unread_conformance_hook.ts in TypeScript):
// what only the harnesses and tests call. Built only where CONFORMANCE_HOOK is defined (the
// harnesses' builds: the Makefile's), from unread_conformance_hook.c, which unread.c includes then
#ifndef UNREAD_CONFORMANCE_HOOK_H
#define UNREAD_CONFORMANCE_HOOK_H

#include "unread.h"

#ifndef CONFORMANCE_HOOK
#error "unread_conformance_hook.h: the hooks are built only with CONFORMANCE_HOOK defined"
#endif

// how many containers of the entry's value are owned now
size_t un_conformance_hook_owned(const un_unread *u, const nd_entry *entry);

#endif
