// A native runner (native.h), for conformance/native: it runs its code by writing its bytes as the
// process's result, through the harnesses' api, and writes "stop" as it stops. Built by the root
// Makefile into runner.so beside this file, and unsigned.so (macOS: not signed); never checked in.
#include "../native.h"

// the harnesses' api (typescript/start_harness.ts): ctx, and write, bytes as the process's result
typedef struct {
	void *ctx;
	void (*write)(void *ctx, const uint8_t *bytes, size_t n);
} api;

native_run run;
native_stop stop;

int run(const uint8_t *code, size_t n, void *given, void **state) {
	api *a = given;
	if (a == NULL) return 2;
	a->write(a->ctx, code, n);
	*state = a;
	return 0;
}

void stop(void *state) {
	api *a = state;
	a->write(a->ctx, (const uint8_t *)"stop", 4);
}
