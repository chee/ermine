#!/bin/sh
# builds the formats' C harnesses (pack, blop) with the root Makefile; CHECK=1:
# the harness-checks, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="playground/encoding/c/pack-harness playground/encoding/c/blop-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
