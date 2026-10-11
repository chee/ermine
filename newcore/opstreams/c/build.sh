#!/bin/sh
# builds opstreams's C harnesses (squish, mutate) with newcore's Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="opstreams/c/squish-harness opstreams/c/mutate-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
