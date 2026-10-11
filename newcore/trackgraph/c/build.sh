#!/bin/sh
# builds trackgraph's C harnesses (trackgraph) with newcore's Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="trackgraph/c/trackgraph-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
