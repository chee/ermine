// The dlopen runner, in C (typescript/dlopen.ts is the TypeScript's): a host runner whose load
// treats the code as a shared library for this machine (native.h's ABI). Same rules as dlopen.ts
// (its header says them once), which conformance/native holds both to.
//
//   dlr *d = dlr_new(&(dlr_setup){.dir = NULL});   // temp files in $TMPDIR (none: /tmp)
//   hf_add_loader(functions, "dlopen", dlr_run, dlr_load, d);   // a runner with a load (host.h)
//   ...                                            // its node's value: hf_value("dlopen")
//   dlr_free(d);                                   // after the last process holding a library stops
//
// C's own: the file made by mkstemps (dir/ermine-XXXXXX.so), opened with dlopen (RTLD_NOW |
// RTLD_LOCAL), its exports found by dlsym; signing runs /usr/bin/codesign (posix_spawn). Errors are
// texts: dlopen.ts' Errors' messages.
//
// MEMORY. A live form's data is the library's, let go of by its close; a run's handle by its stop.
#ifndef PROGRAMS_DLOPEN_H
#define PROGRAMS_DLOPEN_H

#include "../../build/c/host.h"

typedef struct dlr dlr;

typedef struct {
	// where the files go (copied); NULL: $TMPDIR, else /tmp
	const char *dir;
	// told what is worth telling: what ("signed", "not written", "dlopen failed") and its detail;
	// NULL: a line to stderr
	void (*note)(const char *what, const char *detail, void *ctx);
	void *ctx;
} dlr_setup;

dlr *dlr_new(const dlr_setup *setup);
void dlr_free(dlr *d);
// the runner and its load, for a host's registry: data is the dlr
hf_run dlr_run(const op_value *code, void *api, void *data);
hf_loaded dlr_load(const op_value *code, void *data);

#endif
