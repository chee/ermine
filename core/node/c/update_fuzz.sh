#!/bin/sh
# coverage-guided fuzzing of node's update (update_fuzz.c) with libFuzzer (Homebrew LLVM: Apple's
# clang has no libFuzzer). Runs for FUZZ_SECONDS (default 60); finds land in crash-* here; the corpus is
# kept in update-corpus/. Leaks are checked (macOS leaves that off by default). Arguments go to
# libFuzzer.
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
op=../../op/c
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
	-o update-fuzz node.c update.c $op/value.c $op/apply.c $op/invert.c update_fuzz.c
mkdir -p update-corpus
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./update-fuzz -max_total_time="${FUZZ_SECONDS:-60}" -max_len=600 -print_final_stats=1 "$@" update-corpus
