#!/bin/sh
# builds scheduler's C harnesses (paths, scheduler, tracker) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="reactivity/c/paths-harness reactivity/c/scheduler-harness reactivity/c/tracker-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
