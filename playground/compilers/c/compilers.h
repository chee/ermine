// compilers (typescript/compilers.ts) in C: steps cached with verifying traces, and compile, a
// step. same rules as compilers.ts, held to by the scenarios in
// playground/compilers/conformance/compilers.
//
//   bd *b = bd_new(&(bd_setup){ .places = p, .table = t, .scheduler = s, .cache = "CACHE", .functions = fs });
//   bd_result r = bd_step(b, name, code, run, data, 0); // in a run: the output, PENDING, refused or failed
//   bd_result r = bd_compile(b, "UP", input);          // the step (UP's identity, input)
//   bd_folded f = bd_fold(&(bd_folding){b, t, next, ctx}, n, input); // n compilers over input
//   bd_stop(b);                                        // before sc_free: listeners and steps
//   bd_free(b);                                        // after sc_free, tb_free and pl_free
//
// bd_fold (compilers.ts' fold): the input through a chain's compilers in turn, next(i, ctx) giving
// each: a host's by bd_compile; a loaded one's by bd_step, named by bd_identity_of, its live form's
// compile its run (a live form let go by then: failed "unloaded").
// refused uncacheable: a read pl_spot can't name, or a value canonical CBOR can't encode.
// a compiler's function: the registry's hf_compiler (experiments/software functions.h). a BuildError of the reference is a
// message starting with its code here (a failed step's status has only the text).
// a step's computer is made with [[PL_NODE, its status node (step:<uuid>)]]: its writes' metadata
// stops there. bd_step and bd_compile are tracked reads. in a run, BD_STOP: a read ended the run; return now.
// memory: a result's value and text are borrowed from the table, good until the node changes; a
// never step's are the caller's (op_free the value, free the text; its promise the reader's to
// return). a step's name and code are held (op_ref) while it is out; data must live as long. out of
// memory aborts.
#ifndef COMPILERS_H
#define COMPILERS_H

#include "../../../core/places/c/places.h"
#include "../../../core/places/c/status.h"
#include "../../../experiments/software/c/functions.h"

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

// a loaded compiler's live form, as its load gave it; closed: let go (its compile is called no more)
typedef struct {
	hf_live live;
	int closed;
} bd_loaded;

// a chain's compiler, as bd_fold's next gives it. BD_VALUE: here, its node's id; a loaded one's
// load (NULL: a host's) and its value as read at start (what its identity hashes; NULL: none).
// BD_PENDING, BD_STOP, or BD_FAILED (error malloc'd, handed on): the fold ends so
typedef struct {
	bd_kind kind;
	const char *id;
	const bd_loaded *load;
	const op_value *value;
	char *error;
} bd_compiler;
typedef bd_compiler (*bd_next)(size_t i, void *ctx);

typedef struct {
	bd *builds;
	// where a loaded compiler's attributes are read
	tb_table *table;
	bd_next next;
	void *ctx;
} bd_folding;

// a fold's end: BD_VALUE, value the output (borrowed, as bd_result's); BD_PENDING; BD_STOP; or
// BD_FAILED, a step refused or failed, or next's failure (error malloc'd, the caller's)
typedef struct {
	bd_kind kind;
	const op_value *value;
	char *error;
} bd_folded;

// a loaded compiler's identity: its ermine.programs.compiler; none, { id, hash } of its value; no
// value, or one with no encoding, its id. new, the caller's (op_free)
op_value *bd_identity_of(tb_table *table, const char *id, const op_value *value);
// the input through n compilers in turn, PENDING, STOP or failed where one is (header, bd_fold)
bd_folded bd_fold(const bd_folding *f, size_t n, const op_value *input);

#endif
