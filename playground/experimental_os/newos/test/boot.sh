#!/bin/sh
# boot.sh: builds newos/test/boot (boot.c) against today's C, into
# mac/build/test/newos-boot. Run it from the repository's root.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
mac="$root/playground/experimental_os/mac"
out="$mac/build/test"
mkdir -p "$out"
. "$here/sources.sh"
mkdir -p "$out/obj"
cflags="-std=c11 -Wall -Wextra -O1 -g ${SANITIZE:-} $nc_cflags"
objs=""
for src in "$here/boot.c" $nc_sources; do
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
cc -O1 -g ${SANITIZE:-} -o "$out/newos-boot" $objs $nc_libs
echo "built $out/newos-boot ($nc_built compiled)"
