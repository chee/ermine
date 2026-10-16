// cc.h: C compiled to wasm (cc.c; CLOADER.md, The cache, How it runs), or to
// a library for this machine (native; CLOADER.md, Native): a compile, run on
// a thread of the loader's, and the keys of the cache's trace, as CACHE.tex's
// (BLAKE3 over canonical CBOR, chained from a root).

#ifndef ERMOS_CC_H
#define ERMOS_CC_H

#include "../../../ermine/encoding/c/json.h"

#include <stdbool.h>
#include <stdint.h>

/** a header the finder copied out of the graph: its include name ("x.h", "sub/x.h") and its text */
typedef struct CcFile {
	char *name;
	char *text;
	size_t n;
} CcFile;

/** where an include was found: beside the program, in /lib/c, nowhere */
typedef enum { CC_HERE, CC_LIB, CC_NONE } CcWhere;

/** an include, as clang took it: its name, where it was found */
typedef struct CcStep {
	char *name;
	CcWhere where;
} CcStep;

typedef struct CcJob {
	// in: fresh, the job's own
	char *source;
	size_t nsource;
	char *compiler, *linker; // /c's value's: a tool's name ("clang", "wasm-ld") or a path
	char **flags;            // /c's value's, after cc.c's own
	int nflags;
	CcFile *here, *lib; // the headers beside the program, and in /lib/c
	int nhere, nlib;
	bool native;        // an arm64 dylib for this machine (clang -dynamiclib, ad hoc signed by its linker), not wasm
	// out
	bool ok;               // a module was made
	unsigned char *wasm;   // the module (native: the library)
	size_t nwasm;
	Json *exports;         // its exported functions' names
	Json *diagnostics;     // [{level, message, line?, column?, file?}]: clang's (SARIF), then wasm-ld's
	CcStep *steps;         // each header clang entered, in order (-MMD), then each it could not find
	int nsteps;
	int64_t ms;            // how long it took
	char *compiler_is;     // the compiler that ran: its version, as it says it
} CcJob;

/** compiles: blocking, for a thread. Never fails as a call: what went wrong is in diagnostics */
void ccRun(CcJob *job);
/** a job let go of, in and out */
void ccFree(CcJob *job);

/** the first key: the cache's root for /c's value (a Json, NULL: null) */
void ccRoot(const Json *c, uint8_t out[32]);
/** a text's hash: BLAKE3 of its CBOR */
void ccText(const char *text, size_t n, uint8_t out[32]);
/** an include's answer, as a step's is hashed: [where, its text's hash] ("here", "lib"), or ["none", null]: fresh */
Json *ccAnswer(CcWhere where, const uint8_t *hash);
/** the next key: BLAKE3(CBOR([key, answer])) */
void ccNext(const uint8_t key[32], const Json *answer, uint8_t out[32]);
/** a key as 64 hex digits, a cache entry's name */
void ccHex(const uint8_t key[32], char out[65]);

#endif
