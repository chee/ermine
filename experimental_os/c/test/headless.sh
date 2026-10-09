#!/bin/sh
# headless.sh: builds the OS with no window (headless.c), core read in place,
# into ../../mac/build/test/headless. Run it from the repository's root:
#   experimental_os/mac/build/test/headless --fresh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
c="$here/.."
core="$here/../../../core"
out="$here/../../mac/build/test"
mac="$here/../../mac"
mkdir -p "$out"
. "$c/subduction.sh"
os=""
for f in "$c"/*.c; do
	case "$(basename "$f")" in host_stub.c) ;; *) os="$os $f" ;; esac
done
# shellcheck disable=SC2086
cc -std=c11 -Wall -Wextra -Werror -O1 -g ${SANITIZE:-} $sync_cflags -o "$out/headless" "$here/headless.c" $os \
	"$core/graph/c/json.c" "$core/graph/c/cbor.c" "$core/graph/c/ermine.c" "$core/graph/c/graph.c" "$core/graph/c/entry.c" \
	"$core/protect/c/protect.c" "$core/scheduler/c/schedule.c" "$core/scheduler/c/steps.c" $sync_sources $sync_libs -lpthread
echo "built $out/headless"
# the programs loaders/exec runs, as ermineOS's build makes them
mkdir -p "$out/../programs"
cc -std=c11 -Wall -Wextra -Werror -O2 -o "$out/../programs/catclock" "$c/programs/catclock/catclock.c" "$c/lib/libermine.c" "$c/abi.c" \
	"$core/graph/c/json.c" "$core/graph/c/cbor.c" -lm
echo "built $out/../programs/catclock"
