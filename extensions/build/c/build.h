// Build (typescript/build.ts), in C: steps cached with verifying traces, and compile, a step. Same
// rules as build.ts (its header says them once), which the scenarios in
// extensions/build/conformance/build hold both to.
//
//   bd *b = bd_new(&(bd_setup){ .places = p, .table = t, .scheduler = s, .cache = "CACHE", .functions = fs });
//   bd_result r = bd_step(b, name, code, run, data, 0); // in a run: the output, PENDING, refused or failed
//   bd_result r = bd_compile(b, "UP", input);          // the step (UP's identity, input)
//   bd_stop(b);                                        // before sc_free: listeners and steps
//   bd_free(b);                                        // after sc_free, tb_free and pl_free
//
// A step: a name and its code, any values; its key hex of hash([name, code]) (encoding's
// hashValue). The cache folder: cache/<key> the step's node (its value the output kept last, typed),
// cache/<key>/<n> an entry (its value the output, its attribute ermine.programs.trace the reads, each
// [part, id, path, hash]). A lookup reads each entry's trace again, newest first, stopping at the
// first read that differs; a hit gives its output. A miss: run in a computer of its own, one per key,
// its reads recorded through sc_on_track and named by pl_spot as its output is kept; its status
// (status.h) on a node of its own while out. A read pl_spot can't name, a value canonical CBOR
// cannot encode (the name, the code, a read, the output, a function among them): refused
// uncacheable. never: run called in the reader's run, its result as it is, nothing kept.
//
// A compiler is a node whose value is a function from the host (host.h): the registry's hf_compiler.
// What it is: its attribute ermine.programs.compiler, a plain value; none: its id. A node whose value
// is no compiler, on a miss: not-a-compiler. A BuildError of the reference is a message starting with
// its code here (a failed step's status has only the text).
//
// bd_step and bd_compile are reads, tracked in a run. In a run, a result of BD_STOP means a read told
// the run to end now: return at once.
//
// MEMORY. A result's value and text are borrowed from the table: good until the node changes; a
// never step's are the caller's (owned: op_free the value, free the text; its promise, the
// reader's to return). A step's name and code are held (op_ref) while it is out, and data must
// live as long. Out of memory aborts.
#ifndef PROGRAMS_BUILD_H
#define PROGRAMS_BUILD_H

#include "../../../filesystem/places/c/places.h"
#include "../../../filesystem/places/c/status.h"
#include "host.h"

#define BD_COMPILER "ermine.programs.compiler"
#define BD_TRACE "ermine.programs.trace"

typedef struct bd bd;

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	// the cache folder: each step a node in it at its key
	const char *cache;
	const hf *functions;
	// told every write's changed entries (commit them to every places that must know; none: pl_commit(places))
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
} bd_setup;

typedef enum {
	// value: the output
	BD_VALUE,
	// pending; a never step's run gave promise (not NULL), for the reader to return
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
	sc_promise *promise;
	// a never step's value and text: the caller's
	int owned;
} bd_result;

// a step's run: its code (borrowed), the data given; in a computer of its own (never: the reader's)
typedef hf_out (*bd_run)(const op_value *code, void *data);

// what a lookup found, told in the reader's run: found "hit" (entry its name), "miss" or "never";
// key NULL for never; checked: the entries checked; entries: how many the step keeps. Borrowed
typedef struct {
	const op_value *name;
	const char *key;
	const char *found;
	const char *entry;
	size_t checked, entries;
} bd_found;
typedef void (*bd_found_fn)(const bd_found *found, void *ctx);

// with a scope open (the steps' owner is made under it); listens to the scheduler from here on
bd *bd_new(const bd_setup *setup);
bd_result bd_step(bd *b, const op_value *name, const op_value *code, bd_run run, void *data, int never);
bd_result bd_compile(bd *b, const char *compiler, const op_value *input);
// told what each lookup finds (one listener; NULL: none)
void bd_on_step(bd *b, bd_found_fn f, void *ctx);
// steps torn down, listeners gone (the scheduler lives still)
void bd_stop(bd *b);
void bd_free(bd *b);

// hex of the hash of a value's canonical CBOR; false: it has no encoding
int bd_hash_hex(const op_value *v, char out[65]);

#endif
