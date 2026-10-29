#!/bin/sh
# builds the graph's C harnesses (node, table) with the root Makefile; CHECK=1: the harness-checks,
# with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="graph/c/node-harness graph/c/table-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
