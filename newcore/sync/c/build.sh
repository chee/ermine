#!/bin/sh
# builds sync's C harnesses (id, seal, chain, apply, commit, fragment, transport, wiring) with newcore's Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="sync/c/id-harness sync/c/seal-harness sync/c/chain-harness sync/c/apply-harness sync/c/commit-harness sync/c/fragment-harness sync/c/transport-harness sync/c/wiring-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
