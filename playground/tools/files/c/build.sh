#!/bin/sh
# builds files' C harnesses (diag, names, layout, manifest, store, program, sys) and the files tool with the root Makefile; CHECK=1: the harness-checks and
# playground/files/c/files-check, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
bins="playground/files/c/diag-harness playground/files/c/names-harness playground/files/c/layout-harness playground/files/c/manifest-harness playground/files/c/store-harness playground/files/c/program-harness playground/files/c/sys-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
if [ "$CHECK" = 1 ]; then make -s playground/files/c/files-check; else make -s playground/files/c/files; fi
