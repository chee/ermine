#!/bin/sh
# builds the C harnesses (trackgraph, node, pack); CHECK=1 builds harness-check, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")"
flags="-std=c11 -O2 -Wall -Wextra -Wpedantic"
out=harness
node=node-harness
pack=pack-harness
if [ "$CHECK" = 1 ]; then
	flags="-std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer"
	out=harness-check
	node=node-harness-check
	pack=pack-harness-check
fi
cc $flags -o $out trackgraph.c harness.c
cc $flags -o $node node.c shown.c node_harness.c
cc $flags -o $pack node.c shown.c pack.c pack_harness.c -lm
