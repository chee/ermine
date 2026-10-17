#!/bin/sh
# build.sh: ermineOS, the metal and the OS in one binary, ../mac/ermineOS (../mac/ermine-mac
# a link to it). The metal is ../mac/metal (METAL.md), seeing the OS through os.h; the OS is
# newos/*.c over today's core, filesystem, ermine and extensions (test/sources.sh); the
# JavaScript runner, js/runner.js, is bundled again when one of its sources is newer. The
# programs exec runs (programs/) go to ../mac/build/newos/programs. ../mac/app.sh bundles it all.
#
#   sh playground/experimental_os/newos/build.sh       # says each step; -q only what it built and what went wrong
#   rm -rf playground/experimental_os/mac/build/newos   # to build everything again (else only what changed is compiled)
#   playground/experimental_os/mac/ermineOS            # from a terminal, which is then the serial line
#   playground/experimental_os/mac/ermineOS -- --fresh # a fresh card: the image makes it again
#
# The metal gives the OS newos's image (image/), runner (js/runner.js) and card
# (~/.ermine/disk), or the app's (mac/metal/main.swift, osPath).
# The notes (ERMINEOS.md, PORT.md, AFFORDANCES.md, mac/METAL.md, wayland/NOTES.md) are in
# ../ermine-plans/playground/experimental_os/, as every plan is.
set -e
case "${1:-}" in -q | --quiet) QUIET=1 ;; esac
say() { [ -n "${QUIET:-}" ] || echo "$@" >&2; }
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
mac="$root/playground/experimental_os/mac"
build="${BUILD:-$mac/build/newos}" # BUILD=dir APP=file: elsewhere, so builds side by side don't clash
out="${APP:-$mac/ermineOS}"
sdk="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
target=arm64-apple-macos14.0

say "libraries: today's tree, Subduction, libwayland, libvterm"
. "$here/test/sources.sh"

say "the runner: js/runner.js"
nc_runner

mkdir -p "$build"
NC_CC=clang
cflags="-std=c11 -Wall -Wextra -O2 -target $target -isysroot $sdk $nc_cflags"
set -- # the objects to link
say "compiling what changed of today's core, filesystem, ermine, extensions, newos's libraries and newos"
for src in $nc_sources; do
	obj="$build/$(nc_object "$src")"
	# shellcheck disable=SC2086
	nc_compile "$src" "$obj" $cflags
	set -- "$@" "$obj"
done
for src in "$here"/*.c; do
	case " $nc_skip " in *" $(basename "$src") "*) continue ;; esac
	obj="$build/os_$(basename "$src" .c).o"
	# shellcheck disable=SC2086
	nc_compile "$src" "$obj" $cflags
	set -- "$@" "$obj"
done

# the programs exec runs (programs/), each with libermine (lib/), into $build/programs: by default
# build/newos/programs beside $mac/ermineOS, where exec.c finds them
mkdir -p "$build/programs" "$build/lib"
libflags="-std=c11 -Wall -Wextra -O2 -target $target -isysroot $sdk"
libobjs=""
for src in "$here/lib/libermine.c" "$here/abi.c" "$root/ermine/encoding/c/json.c" "$root/ermine/encoding/c/json_text.c" "$root/ermine/encoding/c/cbor.c"; do
	obj="$build/lib/$(basename "$src" .c).o"
	# shellcheck disable=SC2086
	nc_compile "$src" "$obj" $libflags
	libobjs="$libobjs $obj"
done
# shellcheck disable=SC2086
if nc_stale "$build/lib/libermine.a" $libobjs; then
	rm -f "$build/lib/libermine.a"
	# shellcheck disable=SC2086
	ar rcs "$build/lib/libermine.a" $libobjs
fi
if nc_stale "$build/programs/catclock" "$here/programs/catclock/catclock.c" "$here/blit.c" "$here/blit.h" "$here/lib/libermine.h" "$build/lib/libermine.a"; then
	say "  the programs exec runs: catclock, with libermine"
	# shellcheck disable=SC2086
	clang $libflags -o "$build/programs/catclock" "$here/programs/catclock/catclock.c" "$here/blit.c" "$build/lib/libermine.a" -lm
	echo "built $build/programs/catclock"
fi

# the metal, as one object (whole module), compiled again only when a Swift file or the bridging header is newer
metal="$build/metal.o"
# shellcheck disable=SC2046
if nc_stale "$metal" "$mac"/metal/*.swift "$here/os.h" $(grep -o '#include "[^"]*"' "$here/os.h" | sed 's/#include "//;s/"$//' | sed "s|^|$here/|"); then
	say "compiling the metal ($(ls "$mac"/metal/*.swift | wc -l | tr -d ' ') files)"
	swiftc -O -swift-version 5 -whole-module-optimization -emit-object \
		-sdk "$sdk" \
		-target "$target" \
		-import-objc-header "$here/os.h" \
		-o "$metal" \
		"$mac"/metal/*.swift 2> "$build/metal.err" || { cat "$build/metal.err" >&2; exit 1; }
	nc_built=$((nc_built + 1))
fi

if ! nc_stale "$out" "$metal" "$@"; then
	say "nothing changed: $out is up to date"
	[ -n "${APP:-}" ] || ln -sf ermineOS "$mac/ermine-mac"
	exit 0
fi
say "linking $out ($nc_built compiled)"
# shellcheck disable=SC2086
swiftc -O -swift-version 5 \
	-sdk "$sdk" \
	-target "$target" \
	-framework AppKit -framework QuartzCore -framework CoreText -framework IOKit \
	-framework Network -framework AVFoundation -framework CoreAudio -framework WebKit \
	-framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo \
	-o "$out" \
	"$metal" "$@" $nc_libs 2> "$build/link.err" || { cat "$build/link.err" >&2; exit 1; }
# quiet: not the linker's word that a library was built for a newer macOS than the target (harmless)
if [ -n "${QUIET:-}" ]; then
	grep -v -e "was built for newer 'macOS' version" -e "but linking with dylib .* which was built for newer version" "$build/link.err" >&2 || true
else
	cat "$build/link.err" >&2
fi
echo "built $out ($(($(stat -f %z "$out") / 1024)) KB)"
# the old name for it
[ -n "${APP:-}" ] || ln -sf ermineOS "$mac/ermine-mac"
