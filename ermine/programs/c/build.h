// Build (typescript/build.ts), in C: the cached compile step, generic. Same rules as build.ts (its
// header says them once), which the scenarios in ermine/programs/conformance/build hold both to.
//
//   bd *b = bd_new(&(bd_setup){ .places = p, .table = t, .scheduler = s, .cache = "CACHE", .functions = fs });
//   bd_result r = bd_compile(b, "UP", input);     // in a run: the output, PENDING, refused or failed
//   bd_stop(b);                                   // before sc_free: listeners and steps
//   bd_free(b);                                   // after sc_free, tb_free and pl_free
//
// A compiler is a node whose value is a function from the host (host.h): the registry's hf_compiler.
// What it is: its attribute ermine.programs.compiler, a plain value; none: its id. The key: hex of
// hash([identity, input]) (encoding's hashValue). The result: a node placed in the cache folder at
// <key>; a key there is never compiled again. A miss: a computer of its own, one per key, shared by
// every compile wanting it; its status (status.h) on a node of its own, PENDING while it is, the error
// when it failed. A value canonical CBOR cannot encode (the input, the identity, the result, a function
// among them) is refused uncacheable; a node whose value is no compiler, not-a-compiler. Errors and
// refusals are never cached: a failed step goes once no run reads it. A BuildError of the reference is
// a message starting with its code here (a failed step's status has only the text).
//
// bd_compile is a read, tracked in a run: its reads are the compiler's identity, the cache folder's
// name for the key and the value there, and the step's status while it is not cached. In a run, a
// result of BD_STOP means a read told the run to end now: return at once.
//
// MEMORY. A result's value and text are borrowed from the table: good until the node changes. The
// function stand-in's results are the scheduler's once given. Out of memory aborts.
#ifndef PROGRAMS_BUILD_H
#define PROGRAMS_BUILD_H

#include "../../../filesystem/places/c/places.h"
#include "../../../filesystem/places/c/status.h"
#include "host.h"

#define BD_COMPILER "ermine.programs.compiler"

typedef struct bd bd;

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	// the cache folder: each result a node in it at its key
	const char *cache;
	const hf *functions;
	// told every write's changed entries (commit them to every places that must know; none: pl_commit(places))
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
} bd_setup;

typedef enum {
	// value: the output
	BD_VALUE,
	BD_PENDING,
	// refused: text is the code, "not-a-compiler" or "uncacheable"
	BD_REFUSED,
	// failed: text is the error's message
	BD_FAILED,
	// a read told the run to end now
	BD_STOP,
} bd_kind;

typedef struct {
	bd_kind kind;
	const op_value *value;
	const char *text;
} bd_result;

// with a scope open (the steps' owner is made under it); listens to the scheduler from here on
bd *bd_new(const bd_setup *setup);
bd_result bd_compile(bd *b, const char *compiler, const op_value *input);
// steps torn down, listeners gone (the scheduler lives still)
void bd_stop(bd *b);
void bd_free(bd *b);

// hex of the hash of a value's canonical CBOR; false: it has no encoding
int bd_hash_hex(const op_value *v, char out[65]);

#endif
