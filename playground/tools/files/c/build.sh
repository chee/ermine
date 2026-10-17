#!/bin/sh
# builds files' C harnesses (diag, names, layout, manifest, store, program, sys) and the files tool with the root Makefile; CHECK=1: the harness-checks and
# playground/tools/files/c/files-check, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../../.."
bins="playground/tools/files/c/diag-harness playground/tools/files/c/names-harness playground/tools/files/c/layout-harness playground/tools/files/c/manifest-harness playground/tools/files/c/store-harness playground/tools/files/c/program-harness playground/tools/files/c/sys-harness"
[ "$CHECK" = 1 ] && bins=$(for b in $bins; do printf '%s-check ' "$b"; done)
make -s $bins
if [ "$CHECK" = 1 ]; then make -s playground/tools/files/c/files-check; else make -s playground/tools/files/c/files; fi
