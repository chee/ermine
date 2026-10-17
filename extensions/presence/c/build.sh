#!/bin/sh
# builds presence's C harness with the root Makefile; CHECK=1: the harness-check, with the address and
# undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bin="extensions/presence/c/presence-harness"
[ "$CHECK" = 1 ] && bin="$bin-check"
make -s $bin
