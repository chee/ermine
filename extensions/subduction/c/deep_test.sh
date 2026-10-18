#!/bin/sh
# the deep-nesting test of apply.c, under the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")/../../.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cc -w -g -DBLAKE3_USE_NEON=0 -fsanitize=address,undefined -I. extensions/subduction/c/deep_test.c \
	extensions/subduction/c/apply.c extensions/subduction/c/history.c ermine/encoding/c/json.c ermine/encoding/c/blop.c \
	ermine/encoding/c/cbor.c ermine/encoding/c/blake3/blake3.c ermine/encoding/c/blake3/blake3_dispatch.c \
	ermine/encoding/c/blake3/blake3_portable.c core/op/c/value.c core/op/c/apply.c core/node/c/update.c core/node/c/node.c \
	-o "$out/deep"
"$out/deep"
