#!/bin/sh
# coverage-guided fuzzing of places (places_fuzz.c) with libFuzzer (Homebrew LLVM: Apple's clang
# has no libFuzzer). Runs for SECONDS (default 60); finds land in crash-* here; the corpus is kept
# in places-corpus/. Leaks are checked (macOS leaves that off by default). Arguments go to libFuzzer.
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
op=../../op/c
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
	-o places-fuzz places.c trie.c ../../graph/c/table.c ../../node/c/node.c ../../node/c/update.c \
	$op/value.c $op/apply.c places_fuzz.c
mkdir -p places-corpus
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./places-fuzz -max_total_time="${SECONDS:-60}" -max_len=800 -print_final_stats=1 "$@" places-corpus
