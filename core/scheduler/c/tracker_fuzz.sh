#!/bin/sh
# coverage-guided fuzzing with libFuzzer (Homebrew LLVM: Apple's clang has no libFuzzer).
# Runs for SECONDS (default 60); finds land in crash-* here; the corpus is kept in corpus/.
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
	-o tracker-fuzz tracker.c tracker_fuzz.c
mkdir -p tracker-corpus
./tracker-fuzz -max_total_time="${SECONDS:-60}" -max_len=800 -print_final_stats=1 tracker-corpus
