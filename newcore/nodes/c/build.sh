#!/bin/sh
# builds nodes's C harnesses (node, change, because) with newcore's Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="nodes/c/node-harness nodes/c/change-harness nodes/c/because-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
