#!/bin/sh
# builds graph's C harnesses (main, table) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="core/graph/c/main-harness core/graph/c/table-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
