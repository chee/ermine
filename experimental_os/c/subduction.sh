# subduction.sh: what ermineOS's builds take of sync (../ERMINEOS.md, Sync),
# sourced by mac/metal/build.sh and test/headless.sh after they set $mac (the
# mac folder). Everything is read in place and never written: the sync layer
# (layers/subduction/c), the cache layer's BLAKE3, and the peer's WebSocket,
# store and platform (layers/subduction/c/peer); the peer's Rust library,
# libsubduction_c.a, is built by cargo into $mac/build/subduction, once (it
# takes minutes), its Cargo.lock as it is. OpenSSL is Homebrew's openssl@3.
#
# The link (layers/link/c) goes over the same connection (drv_link.c).
#
# Gives: $sync_sources, $sync_cflags (for the C), $sync_libs (to link).

# the layers as tree.sh staged them, beside core as committed; else in place
if [ -n "${tree:-}" ]; then layers="$tree/layers"; else layers="$(cd "$mac/../../layers" && pwd)"; fi
peer="$layers/subduction/c/peer"
crate="$(cd "$mac/../../layers/subduction/c/peer" && pwd)" # cargo builds the crate where it is
sync_sources="$layers/subduction/c/sync.c $layers/subduction/c/blob.c $layers/subduction/c/sha2.c $layers/link/c/link.c \
$layers/cache/c/hash.c $peer/websocket.c $peer/transport_openssl.c $peer/store_files.c $peer/platform_posix.c"

openssl="${OPENSSL:-$(brew --prefix openssl@3 2>/dev/null)}"
if [ -z "$openssl" ] || [ ! -d "$openssl/include/openssl" ]; then
  echo "no OpenSSL: brew install openssl@3, or OPENSSL=<prefix>" >&2
  exit 1
fi

# The Rust library has a BLAKE3 of its own, which exports the C one's names
# (peer/Makefile): the vendored C's, used only by the cache's hash.c, are renamed.
blake3=""
for name in blake3_compress_in_place blake3_compress_in_place_portable blake3_compress_subtree_wide \
  blake3_compress_xof blake3_compress_xof_portable blake3_hash_many blake3_hash_many_portable \
  blake3_hasher_finalize blake3_hasher_finalize_seek blake3_hasher_init blake3_hasher_init_derive_key \
  blake3_hasher_init_derive_key_raw blake3_hasher_init_keyed blake3_hasher_reset blake3_hasher_update \
  blake3_simd_degree blake3_version blake3_xof_many; do
  blake3="$blake3 -D$name=ermc_$name"
done
sync_cflags="-I$openssl/include $blake3"

rust="$mac/build/subduction/release/libsubduction_c.a"
if [ ! -f "$rust" ]; then
  echo "building Subduction's library (cargo, a few minutes) into $mac/build/subduction" >&2
  (cd "$crate" && cargo rustc --release --lib --locked --color never --target-dir "$mac/build/subduction" -- --print native-static-libs) >&2
fi
sync_libs="$rust -L$openssl/lib -lssl -lcrypto -liconv -lm"
