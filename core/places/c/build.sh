#!/bin/sh
# builds places' C harnesses (places, crowify) with the root Makefile; CHECK=1: the harness-checks,
# with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="core/places/c/places-harness core/places/c/crowify-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
