#!/bin/sh
# builds encoding's C harnesses (pack, cbor, blop) with the root Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="ermine/encoding/c/pack-harness ermine/encoding/c/cbor-test ermine/encoding/c/blop-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
