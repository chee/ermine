#!/bin/sh
# coverage-guided fuzzing of the encoding with libFuzzer (Homebrew LLVM: Apple's clang has no
# libFuzzer), under the address and undefined-behaviour sanitizers.
#   fuzz.sh <target> [libFuzzer arguments]   targets: cbor cbor-model
# (hash, commit, blop, pack, deflate: playground/encoding/c/fuzz.sh)
# runs for FUZZ_SECONDS (default 60; not SECONDS, which the shell counts up itself); finds land in crash-* here; the corpus is kept in <target>-corpus/.
# leaks are checked (macOS leaves that off by default). -fork=1 -ignore_crashes=1: keep going past
# a crash
set -e
cd "$(dirname "$0")"
clang=/opt/homebrew/opt/llvm/bin/clang
target=$1
[ -n "$target" ] || { echo "fuzz.sh <target>: cbor cbor-model" >&2; exit 2; }
shift
case $target in
cbor) src="cbor_fuzz.c cbor.c json.c" ;;
cbor-model) src="cbor_model_fuzz.c cbor.c json.c" ;;
*) echo "no target $target" >&2; exit 2 ;;
esac
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined \
	-fno-omit-frame-pointer -o "$target-fuzz" $src -lm
mkdir -p "$target-corpus"
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./"$target-fuzz" -max_total_time="${FUZZ_SECONDS:-60}" -max_len=4096 \
	-print_final_stats=1 "$@" "$target-corpus"
