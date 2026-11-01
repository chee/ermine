#!/bin/sh
# builds processes' C harnesses (processes, guard, runs, status) with the root Makefile; CHECK=1:
# the harness-checks, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="processes/c/processes-harness processes/c/guard-harness processes/c/runs-harness processes/c/status-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
