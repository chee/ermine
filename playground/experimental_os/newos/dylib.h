// dylib.h: native programs (dylib.c; CLOADER.md, Native): the runner "dlopen", which runs a library
// for this machine (extensions/programs/c/native.h's ABI), the dlopen runner of extensions/programs
// (dlopen.h) with its pieces wrapped, so a library's run is given as its api the table of
// image/lib/c/ermine_host.h: ermine.h's entry points, done against newOS's API here. The compiler
// that makes such a library from C is loader.c's ("clang-native").

#ifndef ERMOS_DYLIB_H
#define ERMOS_DYLIB_H

#include "host.h"

#include "../../../extensions/build/c/host.h"

/** the type of a library for this machine, as the loaders say it */
#define DYLIB_TYPE "com.apple.mach-o-dylib"

/** the runner, with its load, in the registry by name; the host's. Its files in a folder of its own in $TMPDIR */
void dylibAdd(Host *host, hf *functions, const char *name);
/** each turn: the libraries whose processes stopped let go, their cleanups run */
void dylibTurn(Host *host);
/** at power off: the libraries' files gone, and their folder (the libraries stay loaded till the OS ends) */
void dylibStop(Host *host);

#endif
