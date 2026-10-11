#!/bin/sh
# builds the C harness; CHECK=1 builds harness-check, with the address and undefined-behaviour sanitizers
set -e
cd "$(dirname "$0")"
flags="-std=c11 -O2 -Wall -Wextra -Wpedantic"
out=harness
if [ "$CHECK" = 1 ]; then
	flags="-std=c11 -g -O1 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer"
	out=harness-check
fi
cc $flags -o $out scheduler.c steps.c harness.c ../../graph/places/c/places.c ../../notify/c/notify.c \
	../../c/trackgraph.c ../../protect/c/protect.c ../../opstreams/mutate/c/mutate.c -lm
