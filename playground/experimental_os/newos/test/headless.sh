#!/bin/sh
# headless.sh: builds newos/test/headless.c (a test metal, no window) into
# mac/build/test/newos-headless, compiling only what changed (rm -rf the OUT dir for everything again). Run it from the repository's
# root (OUT=dir builds into dir instead, so builds side by side don't clash); then, for example:
#   playground/experimental_os/mac/build/test/newos-headless --image playground/experimental_os/newos/image \
#     --runner playground/experimental_os/newos/js/runner.js < script
# where each line of script is "!key Enter", "!type text", "!click x y", "!wait ms",
# "!shot /path/to/file.ppm" and so on (headless.c's header). HEADLESS_FONTS=1 draws
# the type with CoreText, as the Mac does, so a shot shows the theme's fonts; else boxes.
# The first frame takes some seconds (about 10 at 1400x900 on a loaded machine): !wait long
# enough before the first !shot, or it is black.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
nc="$root"
out="${OUT:-$root/playground/experimental_os/mac/build/test}"
mkdir -p "$out"
mac="$root/playground/experimental_os/mac"
. "$here/sources.sh"
nc_runner
# each source to its own object, compiled again only when it, a header it read, or the flags changed
mkdir -p "$out/obj"
cflags="-std=c11 -Wall -Wextra -O1 -g ${SANITIZE:-} $nc_cflags"
objs=""
for src in "$here/headless.c" $nc_sources; do
	obj="$out/obj/$(nc_object "$src")"
	# shellcheck disable=SC2086
	nc_compile "$src" "$obj" $cflags
	objs="$objs $obj"
done
for src in "$here"/../*.c; do
	case " $nc_skip " in *" $(basename "$src") "*) continue ;; esac
	obj="$out/obj/os_$(basename "$src" .c).o"
	# shellcheck disable=SC2086
	nc_compile "$src" "$obj" $cflags
	objs="$objs $obj"
done
# shellcheck disable=SC2086
if nc_stale "$out/newos-headless" $objs; then
	# shellcheck disable=SC2086
	cc -O1 -g ${SANITIZE:-} -o "$out/newos-headless" $objs $nc_libs -framework CoreGraphics
	echo "built $out/newos-headless ($nc_built compiled)"
else
	echo "$out/newos-headless is up to date"
fi
# the programs exec runs (../programs), each with libermine (../lib), into $out/programs, where exec.c finds them
mkdir -p "$out/programs" "$out/lib"
libflags="-std=c11 -Wall -Wextra -O2 -g ${SANITIZE:-}"
libobjs=""
for f in "$here/../lib/libermine.c" "$here/../abi.c" "$nc/ermine/encoding/c/json.c" "$nc/ermine/encoding/c/json_text.c" "$nc/ermine/encoding/c/cbor.c"; do
	obj="$out/lib/$(basename "$f" .c).o"
	# shellcheck disable=SC2086
	nc_compile "$f" "$obj" $libflags
	libobjs="$libobjs $obj"
done
# shellcheck disable=SC2086
if nc_stale "$out/lib/libermine.a" $libobjs; then
	rm -f "$out/lib/libermine.a"
	# shellcheck disable=SC2086
	ar rcs "$out/lib/libermine.a" $libobjs
fi
if nc_stale "$out/programs/catclock" "$here/../programs/catclock/catclock.c" "$here/../blit.c" "$here/../blit.h" "$here/../lib/libermine.h" "$out/lib/libermine.a"; then
	# shellcheck disable=SC2086
	cc $libflags -o "$out/programs/catclock" "$here/../programs/catclock/catclock.c" "$here/../blit.c" "$out/lib/libermine.a" -lm
	echo "built $out/programs/catclock"
fi
