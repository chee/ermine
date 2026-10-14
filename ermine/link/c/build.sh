#!/bin/sh
# builds link's and guard's C harnesses with the root Makefile; CHECK=1: the harness-check, with the address and
# undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="ermine/link/c/link-harness ermine/link/c/guard-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
