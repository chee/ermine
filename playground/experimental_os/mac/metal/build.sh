#!/bin/sh
# build.sh: ermineOS, the metal and the OS in one binary, ../ermineOS. The OS is
# newos (../../newos): this is its build.sh, kept here so the old way in still works.
#
#   sh build.sh       says each step
#   sh build.sh -q    only what it built and what went wrong
exec sh "$(cd "$(dirname "$0")" && pwd)/../../newos/build.sh" "$@"
