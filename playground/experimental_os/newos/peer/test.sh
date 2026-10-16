#!/bin/sh
# test.sh: builds peer_test.c with today's subduction (the root Makefile's transport_src, with wiring.c and
# the files store), places, table, node, op and scheduler into OUT (default a temporary folder) and runs
# it (CFLAGS added); arguments go to it (a card's folder: that card read, say a copy, never one in use)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"
cd "$root"
# Subduction's own BLAKE3 exports the same symbols as ermine/encoding/c/blake3 (the Makefile's subduction_rename)
rename=""
for s in compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many; do
	rename="$rename -Dblake3_$s=ermc_blake3_$s"
done
cc -std=c11 -Wall -Wextra -O1 -g $CFLAGS $rename -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0 \
	-Iextensions/subduction/c/subduction -o "$out/peer_test" "$here/peer_test.c" "$here/peer.c" \
	extensions/subduction/c/transport.c extensions/subduction/c/id.c extensions/subduction/c/seal.c extensions/subduction/c/history.c \
	extensions/subduction/c/apply.c extensions/subduction/c/commit.c extensions/subduction/c/fragment.c extensions/subduction/c/wiring.c \
	ermine/encoding/c/blop.c ermine/encoding/c/json.c ermine/encoding/c/cbor.c \
	ermine/encoding/c/blake3/blake3.c ermine/encoding/c/blake3/blake3_dispatch.c ermine/encoding/c/blake3/blake3_portable.c \
	extensions/subduction/c/ed25519/ed25519.c extensions/subduction/c/ed25519/sha2.c \
	filesystem/places/c/places.c filesystem/places/c/cache.c filesystem/places/c/status.c core/scheduler/c/selector.c \
	core/table/c/table.c core/node/c/node.c core/node/c/update.c core/op/c/value.c core/op/c/apply.c core/op/c/invert.c \
	core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c \
	core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c \
	extensions/subduction/c/subduction/store_files.c extensions/subduction/c/subduction/platform_posix.c \
	extensions/subduction/c/subduction/lib/libsubduction_c.a -lc -liconv
"$out/peer_test" "$@"
