#!/bin/sh
# cc.sh: builds test/cctest.c (cc.c on its own) into mac/build/test/newos-cctest, or
# OUT=dir, and runs it from the repository's root.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
nc="$root"
out="${OUT:-$root/playground/experimental_os/mac/build/test}"
mkdir -p "$out"
cc -std=c11 -Wall -Wextra -O1 -g ${SANITIZE:-} -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 \
	-o "$out/newos-cctest" "$here/cctest.c" "$here/../cc.c" "$nc/ermine/encoding/c/json.c" "$nc/ermine/encoding/c/cbor.c" \
	"$nc/ermine/encoding/c/blake3/blake3.c" "$nc/ermine/encoding/c/blake3/blake3_dispatch.c" "$nc/ermine/encoding/c/blake3/blake3_portable.c"
cd "$root" && "$out/newos-cctest" playground/experimental_os/newos/image/lib/c/ermine.h
