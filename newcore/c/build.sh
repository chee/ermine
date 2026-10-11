#!/bin/sh
# builds the C harnesses (trackgraph, node, pack), the cbor test and the pack bench (-O2, no CHECK build); CHECK=1 builds harness-check, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")"
flags="-std=c11 -O2 -Wall -Wextra -Wpedantic"
out=harness
node=node-harness
pack=pack-harness
cbor=cbor-test
if [ "$CHECK" = 1 ]; then
	flags="-std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer"
	out=harness-check
	node=node-harness-check
	pack=pack-harness-check
	cbor=cbor-test-check
fi
cc $flags -o $out trackgraph.c harness.c
cc $flags -o $node node.c shown.c node_harness.c
cc $flags -o $pack node.c shown.c pack.c pack_harness.c json.c cbor.c -lm
cc $flags -o $cbor cbor_test.c cbor.c json.c -lm
[ "$CHECK" = 1 ] || cc -std=c11 -O2 -Wall -Wextra -Wpedantic -o pack-bench node.c pack.c pack_bench.c json.c cbor.c -lm
