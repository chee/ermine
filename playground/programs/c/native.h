// The native ABI: what a shared library for this machine exports, to be loaded by the dlopen
// runner (dlopen.h in C, typescript/dlopen.ts through Deno.dlopen): a step whose by ends in it, its
// value the library's bytes. Its exports are found by name; each is optional, the step's use saying
// which it needs (start.h's loading: a compiler needs compile, a runner run).
//
//   compile  a compiler: in, n its input's bytes, borrowed for the call. done (0): *out its output's
//            bytes, malloc'd (the host's, let go with free), *outn their count. else failed (the int
//            in the step's Error), *out untouched
//   run      a runner: code, n the program's code's bytes, borrowed for the call; api what the
//            host's createProcessAPI gave, as a pointer (TypeScript: the dlopen runner's pointer
//            option; none: NULL), its shape the host's, not this ABI's. running (0): *state given
//            back to stop. else failed (the int in the process's Error)
//   stop     what run started stopped, once, as its process stops; none: nothing to stop. the
//            library is let go after (dlclose) once no process holds it
//
// A library declares its exports with these types, so its compiler checks them:
//
//   #include "native.h"
//   native_compile compile;
//   int compile(const uint8_t *in, size_t n, uint8_t **out, size_t *outn) { ... }
//
// Everything is called on the host's thread, while it waits. On Apple Silicon a library must be
// signed: clang's linker signs arm64 output ad hoc; the runner signs one that is not (codesign -s -).
#ifndef ERMINE_NATIVE_H
#define ERMINE_NATIVE_H

#include <stddef.h>
#include <stdint.h>

typedef int native_compile(const uint8_t *in, size_t n, uint8_t **out, size_t *outn);
typedef int native_run(const uint8_t *code, size_t n, void *api, void **state);
typedef void native_stop(void *state);

#endif
