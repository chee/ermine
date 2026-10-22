// jsc.h: JavaScript programs in the OS, in JavaScriptCore (jsc.c): the
// JavaScript runner, and a wasm module's setup for the wasm runner.

#ifndef ERMOS_JSC_H
#define ERMOS_JSC_H

#include "host.h"

#include "../../../playground/build/c/host.h"

/** the JavaScript runner (ermine/programs' hf_runner): code a program's source, its default export the setup, run with the process's api (api.h's ap_api); data the host */
hf_run jscRun(const op_value *code, void *api, void *data);
/** a wasm module's setup (ermine:wasm, js/wasm.ts): compiled at its first run, then instantiated; bytes copied */
ap_fn *jscWasm(Host *host, const unsigned char *bytes, size_t n, const char *url);

#endif
