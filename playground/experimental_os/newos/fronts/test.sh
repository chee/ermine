#!/bin/sh
# test.sh: builds fronts_test.c with today's places, table, node, op and scheduler (the root Makefile's
# places_src, less its harness) into OUT (default a temporary folder) and runs it
set -e
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${OUT:-$(mktemp -d)}"
cd "$root"
cc -std=c11 -Wall -Wextra -O1 -g -o "$out/fronts_test" "$here/fronts_test.c" "$here/fronts.c" \
	core/places/c/places.c core/unread/c/unread.c core/places/c/cache.c core/clingy/c/clingy.c core/places/c/status.c core/scheduler/c/selector.c \
	core/table/c/table.c core/node/c/node.c core/node/c/update.c core/changeable/c/value.c core/changeable/c/apply.c core/changeable/c/invert.c \
	core/scheduler/c/paths.c core/scheduler/c/scheduler.c core/scheduler/c/order.c core/scheduler/c/rank.c \
	core/scheduler/c/causes.c core/scheduler/c/ptrmap.c core/scheduler/c/tracker.c
"$out/fronts_test"
