#!/bin/sh
# build.sh: ermineOS, the metal and the OS in one binary, ../mac/ermineOS (../mac/ermine-mac
# a link to it). The metal is ../mac/metal (METAL.md), seeing the OS through os.h; the OS is
# newos/*.c over today's core, filesystem, ermine and extensions (test/sources.sh); the
# JavaScript runner, js/runner.js, is bundled again when one of its sources is newer. The
# programs exec runs (programs/) go to ../mac/build/newos/programs. ../mac/app.sh bundles it all.
#
#   sh playground/experimental_os/newos/build.sh       # says each step; -q only what it built and what went wrong
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
rm -f "$build"/*.o
set -- # the objects to link
compile() {
	say "  cc $(echo "$1" | sed "s|^$root/||")"
	# shellcheck disable=SC2086
	clang -std=c11 -Wall -Wextra -O2 -target "$target" -isysroot "$sdk" $nc_cflags -c "$1" -o "$2"
}
say "compiling today's core, filesystem, ermine and extensions, and newos's own libraries"
for src in $nc_sources; do
	obj="$build/nc_$(basename "$(dirname "$(dirname "$src")")")_$(basename "$src" .c).o"
	compile "$src" "$obj"
	set -- "$@" "$obj"
done
say "compiling newos"
for src in "$here"/*.c; do
	case " $nc_skip " in *" $(basename "$src") "*) continue ;; esac
	obj="$build/os_$(basename "$src" .c).o"
	compile "$src" "$obj"
	set -- "$@" "$obj"
done

# the programs exec runs (programs/), each with libermine (lib/), into $build/programs: by default
# build/newos/programs beside $mac/ermineOS, where exec.c finds them
say "compiling the programs exec runs: catclock, with libermine"
mkdir -p "$build/programs" "$build/lib"
for src in "$here/lib/libermine.c" "$here/abi.c" "$root/ermine/encoding/c/json.c" "$root/ermine/encoding/c/cbor.c"; do
	clang -std=c11 -Wall -Wextra -O2 -target "$target" -isysroot "$sdk" -c "$src" -o "$build/lib/$(basename "$src" .c).o"
done
rm -f "$build/lib/libermine.a"
ar rcs "$build/lib/libermine.a" "$build/lib/libermine.o" "$build/lib/abi.o" "$build/lib/json.o" "$build/lib/cbor.o"
clang -std=c11 -Wall -Wextra -O2 -target "$target" -isysroot "$sdk" -o "$build/programs/catclock" "$here/programs/catclock/catclock.c" "$here/blit.c" "$build/lib/libermine.a" -lm
echo "built $build/programs/catclock"

say "compiling the metal ($(ls "$mac"/metal/*.swift | wc -l | tr -d ' ') files) and linking $# objects"
# shellcheck disable=SC2086
swiftc -O -swift-version 5 \
	-sdk "$sdk" \
	-target "$target" \
	-import-objc-header "$here/os.h" \
	-framework AppKit -framework QuartzCore -framework CoreText -framework IOKit \
	-framework Network -framework AVFoundation -framework CoreAudio -framework WebKit \
	-framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo \
	-o "$out" \
	"$mac"/metal/*.swift "$@" $nc_libs 2> "$build/link.err" || { cat "$build/link.err" >&2; exit 1; }
# quiet: not the linker's word that a library was built for a newer macOS than the target (harmless)
if [ -n "${QUIET:-}" ]; then
	grep -v -e "was built for newer 'macOS' version" -e "but linking with dylib .* which was built for newer version" "$build/link.err" >&2 || true
else
	cat "$build/link.err" >&2
fi
echo "built $out ($(($(stat -f %z "$out") / 1024)) KB)"
# the old name for it
[ -n "${APP:-}" ] || ln -sf ermineOS "$mac/ermine-mac"
