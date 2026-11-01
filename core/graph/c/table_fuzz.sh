#!/bin/sh
# coverage-guided fuzzing of the table (table_fuzz.c) with libFuzzer (Homebrew LLVM: Apple's clang
# has no libFuzzer). Runs for FUZZ_SECONDS (default 60); finds land in crash-* here; the corpus is kept
# in table-corpus/. Leaks are checked (macOS leaves that off by default). Arguments go to libFuzzer.
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
	-o table-fuzz table.c table_fuzz.c
mkdir -p table-corpus
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./table-fuzz -max_total_time="${FUZZ_SECONDS:-60}" -max_len=600 -print_final_stats=1 "$@" table-corpus
