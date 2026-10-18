// Host functions, in C: what typescript/build.ts' compilers and @ermine/programs' runners are, live
// functions a host holds and never saves. C has no live values, so a node holding one holds a
// stand-in (value.h): a stand-in whose kind is { "function": name }, the name looked up in the
// host's registry (hf) for the function pointer and its context. A node's value that is no such
// stand-in is no function. Same rules as the TypeScript: a compiler node holds a function, a runner
// node holds a function; one holding the other kind is neither's.
//
//   hf *fs = hf_new();
//   hf_add_compiler(fs, "upper", upper, ctx);      // a compiler: input -> output
//   hf_add_runner(fs, "runner", run, ctx);         // a runner: code, api -> a stop
//   op_value *v = hf_value("upper");               // the node's value: a function as data
//
// A function stand-in is no encodable value: build.c refuses one as an input, an identity or a result
// (uncacheable), as the reference refuses a function.
//
// A runner may also load (playground/programs' start.h's loading; start.ts' Runner.load):
// hf_add_loader. Its load gives a step's live form from its code (start.ts' Loaded, a module's
// exports): compile, a compiler's; run, a runner's; load, a loader's (each NULL: not that), each
// handed the live form's data; close, called once, as the last process holding it stops (NULL:
// nothing to let go). Loads here are synchronous.
//
//   hf_add_loader(fs, "dlopen", run, load, ctx);   // a runner that loads: dlopen.h's
//
// A run's stop may be given a reason (dens.ts' Handle.stop(reason)): hf_run.stop_reason, which a
// starter that gives reasons calls in place of the handle's stop. One that gives none (programs'
// start.c) calls handle.stop, so a runner setting it sets both.
//
// MEMORY. The registry copies the names; it is let go of with hf_free (no node's value refers to it).
#ifndef PROGRAMS_HOST_H
#define PROGRAMS_HOST_H

#include <stdbool.h>
#include <stddef.h>

#include "../../../core/op/c/value.h"
#include "../../../core/scheduler/c/scheduler.h"

// what a compiler is handed beside its input: its key (hex), its node's id, its identity (the
// attribute ermine.programs.compiler, a plain value; none: its id as a string)
typedef struct {
	const char *key;
	const char *id;
	const op_value *identity;
} hf_context;

typedef enum {
	// a value: the output, given to the scheduler (op_free'd by it)
	HF_VALUE,
	// pending
	HF_PENDING,
	// failed: error is a malloc'd message, the scheduler's
	HF_FAILED,
	// not done: its promise settles it (sc_resolve with an op_value; sc_reject with a malloc'd message)
	HF_AWAIT,
} hf_kind;

typedef struct {
	hf_kind kind;
	op_value *value;
	char *error;
	sc_promise *promise;
} hf_out;

// a compiler's function: the input (borrowed), its context, the data given at hf_add_compiler
typedef hf_out (*hf_compiler)(const op_value *input, const hf_context *ctx, void *data);

// how to stop what a runner started: stop(ctx), once; none (NULL): nothing to stop
typedef struct {
	void (*stop)(void *ctx);
	void *ctx;
} hf_handle;

typedef struct {
	hf_handle handle;
	// a malloc'd message: the runner failed (no handle)
	char *error;
	// a stop with a reason (dens' stop and its cascades): when set, a starter that gives reasons
	// calls this with handle.ctx in place of handle.stop, once; reason borrowed for the call, NULL:
	// none. handle.stop must still be set: a starter that gives none (programs' start.c) calls it.
	// NULL: every stop is handle.stop
	void (*stop_reason)(void *ctx, const op_value *reason);
} hf_run;

// a runner's function: the code (borrowed), the api createProcessAPI gave, the data given at hf_add_runner
typedef hf_run (*hf_runner)(const op_value *code, void *api, void *data);

// a loaded compiler's compile: the input (borrowed), the live form's data. as hf_compiler's out
typedef hf_out (*hf_compile)(const op_value *input, void *data);

typedef struct hf_loaded hf_loaded;
// a load: the code (borrowed), the data given at hf_add_loader (or the live form's)
typedef hf_loaded (*hf_loader)(const op_value *code, void *data);

// a step's live form, as a load gave it
typedef struct {
	hf_compile compile;
	hf_runner run;
	hf_loader load;
	void (*close)(void *data);
	void *data;
} hf_live;

// how a load landed: its live form; or error, a malloc'd message (the caller's), nothing to close
struct hf_loaded {
	hf_live live;
	char *error;
};

typedef struct hf hf;
hf *hf_new(void);
void hf_free(hf *fs);
void hf_add_compiler(hf *fs, const char *name, hf_compiler fn, void *data);
void hf_add_runner(hf *fs, const char *name, hf_runner fn, void *data);
// a runner with a load: fn may be NULL (it runs nothing itself)
void hf_add_loader(hf *fs, const char *name, hf_runner fn, hf_loader load, void *data);

// a function as a node's value: new. name "" is a function no registry has (a host runner by mark
// alone: it is run by nothing, called by nothing)
op_value *hf_value(const char *name);
// the name a value is a function of; NULL: not a function
const char *hf_name(const op_value *v);
// whether the value is, or holds anywhere inside it, a function
bool hf_holds(const op_value *v);

typedef struct {
	hf_compiler compiler;
	hf_runner runner;
	hf_loader load;
	void *data;
} hf_entry;
// the registry's entry for the value, a function of a registered name; NULL: none
const hf_entry *hf_find(const hf *fs, const op_value *v);

#endif
