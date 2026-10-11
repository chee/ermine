#!/bin/sh
# builds notify.wasm: ../c/notify.c and bench.c on libc.c, freestanding, importing nothing
set -e
cd "$(dirname "$0")"
zig cc -target wasm32-freestanding -O2 -std=c11 -Wall -Wextra -Wpedantic -mbulk-memory \
	-nostdlib -Iinclude -Wl,--no-entry -Wl,--export=init -Wl,--export=cases -Wl,--export=setup -Wl,--export=run -Wl,--strip-all \
	-o notify.wasm ../c/notify.c bench.c libc.c
