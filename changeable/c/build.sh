#!/bin/sh
# builds changeable's C harnesses (squish, apply, update) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="changeable/c/squish-harness changeable/c/apply-harness graph/c/update-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
