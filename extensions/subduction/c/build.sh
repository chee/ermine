#!/bin/sh
# builds sync's C harnesses (id, seal, history, apply, commit, fragment, transport, wiring) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="extensions/subduction/c/id-harness extensions/subduction/c/seal-harness extensions/subduction/c/history-harness extensions/subduction/c/apply-harness extensions/subduction/c/commit-harness extensions/subduction/c/fragment-harness extensions/subduction/c/transport-harness extensions/subduction/c/wiring-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
