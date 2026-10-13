// notify (newcore/notify/ts/notify.ts), in C. A patch and its facts (or the content before it), into fine-grained
// notifies on the reads of that content. Same shape as notify.ts.
// The content is op's (core/op/c/value.h), a patch and its facts op's (core/op/c/apply.h).
// Out of memory aborts: nothing here returns it.
#ifndef NOTIFY_H
#define NOTIFY_H

#include <stddef.h>

#include "../../op/c/apply.h"

typedef enum { NT_VALUE, NT_KEYS, NT_LENGTH, NT_MOVED, NT_GONE } nt_kind;
typedef enum { NT_OUT, NT_IN } nt_edge;
typedef enum { NT_KEEP, NT_DROP } nt_empty;

typedef struct {
	int deep;
	int chase;
	nt_edge edges[2];
	nt_empty empty;
} nt_options;

typedef struct nt_notify nt_notify;
typedef struct nt_read nt_read;

// get: the content now, NULL when absent
nt_notify *nt_create(const op_value *(*get)(void *), void *ctx);
// frees it and every read it made
void nt_destroy(nt_notify *n);

// path: keys, maybe a span last (copied); NULL options: all off
nt_read *nt_open(nt_notify *n, const op_key *path, size_t length, const nt_options *options);
void nt_on(nt_read *r, void (*f)(nt_kind kind, void *user), void *user);
void nt_off(nt_read *r, void (*f)(nt_kind kind, void *user), void *user);
void nt_stop(nt_read *r);
// the keys (not a span) it is at now; live until the next patched
const op_key *nt_keys(const nt_read *r, size_t *length);
// its span, or 0
int nt_span(const nt_read *r, long *a, long *b);
// what it sees: a new value to op_free, or NULL when absent
op_value *nt_value_of(const nt_read *r);

// the caller applied the patch; facts: about the content before it
void nt_patched_facts(nt_notify *n, const op_patch *patch, const op_facts *facts);
// the facts, from the whole content before the patch: for a caller that has it
op_facts nt_facts_of(const op_patch *patch, const op_value *before);
// nt_patched_facts with nt_facts_of(patch, before)
void nt_patched(nt_notify *n, const op_patch *patch, const op_value *before);

#endif
