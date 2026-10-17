// unread's conformance hooks (unread_conformance_hook.h), in C. unread.c includes this file, with
// CONFORMANCE_HOOK defined, so these reach its own statics
#include "unread_conformance_hook.h"

size_t un_conformance_hook_owned(const un_unread *u, const nd_entry *entry) {
	record *r = find(u, entry);
	return r == NULL ? 0 : r->owned->count;
}
