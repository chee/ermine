#!/bin/sh
# builds processes' C harnesses (processes, guard, runs, status) with the root Makefile; CHECK=1:
# the harness-checks, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="system/processes/c/processes-harness system/processes/c/guard-harness system/processes/c/runs-harness system/processes/c/status-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
