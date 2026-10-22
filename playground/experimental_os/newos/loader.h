// loader.h: C programs (loader.c; CLOADER.md): the compilers "clang" (to wasm)
// and "clang-native" (to a dylib), host compilers for ermine/programs' build,
// and the runner "wasm".

#ifndef ERMOS_LOADER_H
#define ERMOS_LOADER_H

#include "host.h"

#include "../../../playground/build/c/host.h"

/** the irq line a compile done posts on: only a wake, the turn takes what is done (loaderTurn) */
#define LOADER_IRQ 67

/** the compiler (ermine/programs' hf_compiler): C source to a wasm module, on a thread; data the host */
hf_out loaderCompile(const op_value *input, const hf_context *ctx, void *data);
/** the compiler "clang-native": C source to an arm64 dylib for this machine (dylib.c runs it), on a thread */
hf_out loaderCompileNative(const op_value *input, const hf_context *ctx, void *data);
/** the runner (hf_runner): a wasm module run in the JavaScript runner (jsc.c's jscWasm); data the host */
hf_run loaderRun(const op_value *code, void *api, void *data);
/** each turn: the compiles done, their promises settled */
void loaderTurn(Host *host);

#endif
