#!/bin/sh
# coverage-guided fuzzing of op's apply and invert (apply_fuzz.c) with libFuzzer (Homebrew LLVM:
# Apple's clang has no libFuzzer). Runs for FUZZ_SECONDS (default 60); finds land in crash-* here; the
# corpus is kept in apply-corpus/. Leaks are checked (macOS leaves that off by default). Arguments go
# to libFuzzer (-fork=1 -ignore_crashes=1: keep going past a crash).
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer \
	-o apply-fuzz value.c apply.c invert.c apply_fuzz.c
mkdir -p apply-corpus
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./apply-fuzz -max_total_time="${FUZZ_SECONDS:-60}" -max_len=400 -print_final_stats=1 "$@" apply-corpus
