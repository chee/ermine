#!/bin/sh
# builds protect's C harness with the root Makefile; CHECK=1: the harness-check, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="filesystem/protect/c/protect-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
