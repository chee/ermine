#!/bin/sh
# headless.sh: builds the OS with no window (headless.c), with core as
# committed (../tree.sh), into ../../mac/build/test/headless. Run it from
# the repository's root:
#   experimental_os/mac/build/test/headless --fresh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../mac/build/test"
mac="$(cd "$here/../../mac" && pwd)"
mkdir -p "$out"
. "$here/../tree.sh"
c="$tree/experimental_os/c"
core="$tree/core"
. "$c/subduction.sh"
. "$c/wayland.sh"
os=""
for f in "$c"/*.c; do
	case "$(basename "$f")" in host_stub.c) ;; *) os="$os $f" ;; esac
done
# shellcheck disable=SC2086
cc -std=c11 -Wall -Wextra -Werror -O1 -g ${SANITIZE:-} $sync_cflags $way_cflags -o "$out/headless" "$c/test/headless.c" $os \
	$core_sources $sync_sources $sync_libs $way_libs -lpthread
echo "built $out/headless"
# the programs loaders/exec runs, as ermineOS's build makes them
mkdir -p "$out/../programs"
cc -std=c11 -Wall -Wextra -Werror -O2 -o "$out/../programs/catclock" "$c/programs/catclock/catclock.c" "$c/lib/libermine.c" "$c/abi.c" \
	"$core/graph/c/json.c" "$core/graph/c/cbor.c" -lm
echo "built $out/../programs/catclock"
