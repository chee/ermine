#!/bin/sh
# builds scheduler's C harnesses (notify, paths, scheduler, tracker) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="core/scheduler/c/notify-harness core/scheduler/c/paths-harness core/scheduler/c/scheduler-harness core/scheduler/c/tracker-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
