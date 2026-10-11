// abort_returns.c: a port whose erm_host_abort returns. The library calls it
// as Rust's `-> !` (a panic, out of memory), so returning is undefined
// behaviour: platform.h must make this fail to compile. make test expects
// the compile to fail.
#include "platform.h"

void erm_host_abort(void) {
}
