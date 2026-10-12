#!/bin/sh
# builds graph's C harnesses (node, change, because, places, graph, trackgraph) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="core/graph/c/node-harness core/graph/c/change-harness core/graph/c/because-harness core/graph/c/places-harness core/graph/c/graph-harness core/graph/c/trackgraph-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
