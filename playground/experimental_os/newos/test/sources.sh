# sources.sh: what newos's builds take of today's tree (core, filesystem,
# ermine, extensions) and newos's own libraries (fronts/, peer/), sourced by
# build.sh, boot.sh and headless.sh once they have set $root (the repository)
# and $mac (playground/experimental_os/mac). Gives $nc_sources, $nc_skip (the
# newos/*.c not built), $nc_cflags and $nc_libs.
nc="$root"
openssl="${OPENSSL:-$(brew --prefix openssl@3 2>/dev/null)}"
. "$root/playground/experimental_os/newos/vterm.sh"
. "$root/playground/experimental_os/newos/wayland.sh"
# Subduction's own BLAKE3 exports the same symbols as ermine/encoding's blake3: encoding's are renamed (Makefile)
rename=""
for s in compress_in_place compress_in_place_portable compress_subtree_wide compress_xof compress_xof_portable hash_many hash_many_portable hasher_finalize hasher_finalize_seek hasher_init hasher_init_derive_key hasher_init_derive_key_raw hasher_reset hasher_update simd_degree version xof_many; do
	rename="$rename -Dblake3_$s=ermc_blake3_$s"
done
nc_sources="$nc/core/op/c/value.c $nc/core/op/c/apply.c $nc/core/op/c/invert.c $nc/core/op/c/json.c $nc/core/node/c/node.c $nc/core/node/c/update.c \
  $nc/core/table/c/table.c $nc/core/scheduler/c/scheduler.c $nc/core/scheduler/c/order.c $nc/core/scheduler/c/rank.c \
  $nc/core/scheduler/c/causes.c $nc/core/scheduler/c/ptrmap.c $nc/core/scheduler/c/tracker.c $nc/core/scheduler/c/paths.c \
  $nc/core/scheduler/c/selector.c $nc/filesystem/places/c/places.c $nc/filesystem/places/c/cache.c $nc/filesystem/places/c/status.c $nc/filesystem/places/c/runs.c \
  $nc/ermine/processes/c/processes.c $nc/ermine/processes/c/scopes.c $nc/ermine/boxes/c/boxes.c \
  $nc/ermine/programs/c/host.c $nc/ermine/programs/c/build.c $nc/ermine/clingy/c/clingy.c $nc/ermine/types/c/types.c $nc/ermine/types/c/utis.c \
  $nc/ermine/processes/c/start.c $nc/ermine/sites/c/sites.c \
  $nc/extensions/programs/c/programs.c $nc/extensions/programs/c/programs_json.c $nc/extensions/programs/c/start.c $nc/extensions/programs/c/dlopen.c \
  $nc/ermine/encoding/c/json.c $nc/ermine/encoding/c/json_text.c $nc/ermine/encoding/c/cbor.c $nc/ermine/encoding/c/blop.c $nc/ermine/encoding/c/pack.c $nc/ermine/encoding/c/hash.c \
  $nc/extensions/subduction/c/wiring.c $nc/extensions/subduction/c/transport.c $nc/extensions/subduction/c/id.c $nc/extensions/subduction/c/seal.c $nc/extensions/subduction/c/history.c $nc/extensions/subduction/c/apply.c \
  $nc/extensions/subduction/c/commit.c $nc/extensions/subduction/c/fragment.c \
  $nc/ermine/encoding/c/blake3/blake3.c $nc/ermine/encoding/c/blake3/blake3_dispatch.c $nc/ermine/encoding/c/blake3/blake3_portable.c $nc/extensions/subduction/c/ed25519/ed25519.c $nc/extensions/subduction/c/ed25519/sha2.c \
  $nc/extensions/subduction/c/subduction/store_files.c $nc/extensions/subduction/c/subduction/platform_posix.c \
  $nc/extensions/subduction/c/subduction/websocket.c $nc/extensions/subduction/c/subduction/transport_openssl.c \
  $nc/playground/experimental_os/newos/fronts/fronts.c $nc/playground/experimental_os/newos/peer/peer.c"
# newos/*.c not built: none
nc_skip=""
nc_cflags="$vt_cflags $way_cflags -I$openssl/include -I$nc/extensions/subduction/c/subduction $rename -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0"
nc_libs="$vt_libs $way_libs $nc/extensions/subduction/c/subduction/lib/libsubduction_c.a $(tr -d '\033' < "$nc/extensions/subduction/c/subduction/lib/link.txt" | sed 's/\[[0-9;]*m//g') -L$openssl/lib -lssl -lcrypto -framework JavaScriptCore -framework CoreText -framework CoreFoundation -lz -lpthread"

# the runner, js/runner.js: bundled again when it is missing or one of js/*.ts is newer
# (deno bundle); the header says it is made, not edited, linted or formatted
nc_runner() {
	js="$root/playground/experimental_os/newos/js"
	for f in "$js"/*.ts; do
		if [ ! -f "$js/runner.js" ] || [ "$f" -nt "$js/runner.js" ]; then
			[ -n "${QUIET:-}" ] || echo "  bundling js/runner.js again ($(basename "$f") is newer)" >&2
			{
				printf '%s\n' "// runner.js: made from runner.ts (deno bundle); not edited by hand." "// deno-lint-ignore-file" "// deno-fmt-ignore-file"
				(cd "$root" && deno bundle --quiet --format iife playground/experimental_os/newos/js/runner.ts)
			} > "$js/runner.js.$$" && mv "$js/runner.js.$$" "$js/runner.js"
			break
		fi
	done
}
