#!/bin/sh
# build.sh: catclock as wasm for a browser's canvas (web/catclock.wasm),
# and natively one frame, now, to look at (build/frame.ppm and .png).
#
#   sh playground/catclock/build.sh
#
# Needs deno (xbm.ts decodes the bitmaps) and Homebrew's lld for wasm-ld:
# Apple's clang compiles wasm32 but ships no wasm linker.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/build"

# the bitmaps, xbm/*.xbm, as C arrays: bitmaps.h
deno run --quiet --allow-read="$here" --allow-write="$here" "$here/xbm.ts"

# wasm: freestanding, no libc; cc_init, cc_frame and the memory exported
ld=""
for d in /opt/homebrew/opt/lld@22/bin /opt/homebrew/opt/lld@21/bin /opt/homebrew/opt/lld/bin /opt/homebrew/opt/llvm/bin; do
	if [ -x "$d/wasm-ld" ]; then
		ld="$d/wasm-ld"
		break
	fi
done
[ -n "$ld" ] || {
	echo "no wasm-ld: brew install lld" >&2
	exit 1
}
clang --target=wasm32 -std=c11 -O2 -Wall -Wextra -Werror -ffreestanding -nostdlib -c "$here/catclock.c" -o "$here/build/catclock.wasm.o"
"$ld" --no-entry --export=cc_init --export=cc_frame -o "$here/web/catclock.wasm" "$here/build/catclock.wasm.o"
echo "built $here/web/catclock.wasm ($(stat -f %z "$here/web/catclock.wasm") bytes)"

# natively: one frame, now
clang -std=c11 -O2 -Wall -Wextra -Werror -o "$here/build/frame" "$here/frame.c" "$here/catclock.c"
"$here/build/frame" "$here/build/frame.ppm" "$@"
sips -s format png "$here/build/frame.ppm" --out "$here/build/frame.png" >/dev/null
echo "built $here/build/frame.png"
