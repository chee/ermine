#!/bin/sh
# builds node's C harnesses (node, update) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="core/node/c/node-harness core/node/c/update-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
