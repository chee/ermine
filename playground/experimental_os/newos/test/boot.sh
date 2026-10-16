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
os=""
for src in "$here"/../*.c; do
	case " $nc_skip " in *" $(basename "$src") "*) continue ;; esac
	os="$os $src"
done
# shellcheck disable=SC2086
cc -std=c11 -Wall -Wextra -O1 -g ${SANITIZE:-} $nc_cflags -o "$out/newos-boot" "$here/boot.c" $os $nc_sources $nc_libs
echo "built $out/newos-boot"
