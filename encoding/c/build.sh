#!/bin/sh
# builds encoding's C harness (cbor's test) with the root Makefile; CHECK=1: the harness-check,
# with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="encoding/c/cbor-test"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
