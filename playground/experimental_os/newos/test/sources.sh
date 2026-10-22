# sources.sh: what newos's builds take of today's tree (core, filesystem,
# ermine, extensions) and newos's own libraries (fronts/, card/), sourced by
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
  $nc/core/scheduler/c/selector.c $nc/filesystem/places/c/places.c $nc/core/unread/c/unread.c $nc/filesystem/places/c/cache.c $nc/filesystem/places/c/status.c $nc/ermine/processes/c/runs.c \
  $nc/ermine/processes/c/processes.c $nc/ermine/processes/c/scopes.c $nc/ermine/boxes/c/boxes.c \
  $nc/extensions/build/c/host.c $nc/extensions/build/c/build.c $nc/filesystem/clingy/c/clingy.c $nc/ermine/types/c/types.c $nc/ermine/types/c/utis.c \
  $nc/ermine/processes/c/start.c $nc/ermine/sites/c/sites.c \
  $nc/extensions/programs/c/programs.c $nc/extensions/programs/c/programs_json.c $nc/extensions/programs/c/start.c $nc/extensions/programs/c/dlopen.c \
  $nc/ermine/encoding/c/json.c $nc/ermine/encoding/c/json_text.c $nc/ermine/encoding/c/cbor.c $nc/ermine/encoding/c/commit.c $nc/ermine/encoding/c/pack.c $nc/ermine/encoding/c/hash.c \
  $nc/playground/together/c/sync.c $nc/playground/together/c/transport.c $nc/playground/together/c/mailroom.c $nc/playground/together/stacks/subduction/c/subduction.c $nc/playground/together/c/ids.c $nc/playground/together/c/seal.c $nc/playground/together/c/history.c $nc/playground/together/c/replay.c $nc/playground/together/c/lists.c \
  $nc/playground/together/c/snapshot.c $nc/playground/together/c/packer.c $nc/playground/together/stacks/subduction/c/fragment.c \
  $nc/ermine/encoding/c/blake3/blake3.c $nc/ermine/encoding/c/blake3/blake3_dispatch.c $nc/ermine/encoding/c/blake3/blake3_portable.c $nc/core/ed25519/c/sha2.c \
  $nc/playground/together/stacks/subduction/c/subduction/store_files.c $nc/playground/together/stacks/subduction/c/subduction/platform_posix.c \
  $nc/playground/together/stacks/subduction/c/subduction/websocket.c $nc/playground/together/stacks/subduction/c/subduction/transport_openssl.c \
  $nc/playground/experimental_os/newos/fronts/fronts.c $nc/playground/experimental_os/newos/card/card.c $nc/playground/experimental_os/newos/card/net.c \
  $nc/playground/experimental_os/newos/card/drv_sync.c $nc/playground/experimental_os/newos/card/ed25519_openssl.c"
# newos/*.c not built: none
nc_skip=""
nc_cflags="$vt_cflags $way_cflags -I$openssl/include -I$nc/playground/together/stacks/subduction/c/subduction $rename -DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0"
nc_libs="$vt_libs $way_libs $nc/playground/together/stacks/subduction/c/subduction/lib/libsubduction_c.a $(tr -d '\033' < "$nc/playground/together/stacks/subduction/c/subduction/lib/link.txt" | sed 's/\[[0-9;]*m//g') -L$openssl/lib -lssl -lcrypto -framework JavaScriptCore -framework CoreText -framework CoreFoundation -lz -lpthread"

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

# --- compiling only what changed
# nc_object src: the object's name for a source, by its grandparent folder and name, so core/op/c/value.c
# is nc_op_value.o and newos/card/card.c nc_newos_card.o (no two sources share one)
nc_object() {
	echo "nc_$(basename "$(dirname "$(dirname "$1")")")_$(basename "$1" .c).o"
}
# nc_compile src obj flags...: compiles src to obj with the C compiler $NC_CC (cc) and the flags, unless
# obj is newer than src and every header the last compile read (obj.d, from -MMD) and the flags are the
# same as last time (obj.flags). Counts what it built in $nc_built
nc_built=0
nc_compile() {
	src="$1"
	obj="$2"
	shift 2
	flags="$*"
	if [ -f "$obj" ] && [ -f "$obj.d" ] && [ -f "$obj.flags" ] && [ "$(cat "$obj.flags")" = "$flags" ]; then
		fresh=1
		# shellcheck disable=SC2046
		for f in $(sed -e 's/^[^:]*: *//' -e 's/ *\\$//' "$obj.d"); do
			if [ ! -f "$f" ] || [ "$f" -nt "$obj" ]; then
				fresh=""
				break
			fi
		done
		[ -n "$fresh" ] && return 0
	fi
	[ -n "${QUIET:-}" ] || echo "  cc $(echo "$src" | sed "s|^$root/||")" >&2
	rm -f "$obj.flags"
	# shellcheck disable=SC2086
	"${NC_CC:-cc}" $flags -MMD -MF "$obj.d" -c "$src" -o "$obj" || return 1
	printf '%s' "$flags" > "$obj.flags"
	nc_built=$((nc_built + 1))
}
# nc_stale target deps...: true when target is missing or any dep is newer
nc_stale() {
	t="$1"
	shift
	[ -f "$t" ] || return 0
	for f in "$@"; do [ "$f" -nt "$t" ] && return 0; done
	return 1
}
