#!/bin/sh
# builds scheduler's C harnesses (scheduler) with newcore's Makefile; CHECK=1: the harness-checks, with the
# address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../.."
bins="scheduler/c/scheduler-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
