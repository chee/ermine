#!/bin/sh
# coverage-guided fuzzing of the formats with libFuzzer (Homebrew LLVM: Apple's clang has no
# libFuzzer), under the address and undefined-behaviour sanitizers.
#   fuzz.sh <target> [libFuzzer arguments]   targets: hash commit pack deflate
# (cbor, cbor-model: ermine/encoding/c/fuzz.sh)
# runs for FUZZ_SECONDS (default 60; not SECONDS, which the shell counts up itself); finds land in crash-* here; the corpus is kept in <target>-corpus/.
# leaks are checked (macOS leaves that off by default). -fork=1 -ignore_crashes=1: keep going past
# a crash
set -e
cd "$(dirname "$0")"
root=../../..
clang=/opt/homebrew/opt/llvm/bin/clang
enc=$root/ermine/encoding/c
cbor="$enc/cbor.c $enc/json.c"
blake3="$enc/blake3/blake3.c $enc/blake3/blake3_dispatch.c $enc/blake3/blake3_portable.c"
blake3flags="-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0"
graph="$root/core/node/c/node.c $root/core/changeable/c/value.c $root/core/changeable/c/apply.c $root/core/changeable/c/invert.c"
target=$1
[ -n "$target" ] || { echo "fuzz.sh <target>: hash commit pack deflate" >&2; exit 2; }
shift
case $target in
hash) src="hash_fuzz.c hash.c $cbor $blake3" ;;
commit) src="commit_fuzz.c commit.c pack.c $cbor $blake3 $graph" ;;
pack) src="pack_fuzz.c pack.c $cbor $blake3 $graph" ;;
deflate) src="deflate_fuzz.c deflate.c" ;;
*) echo "no target $target" >&2; exit 2 ;;
esac
$clang -std=c11 -g -O1 -Wall -Wextra -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined \
	-fno-omit-frame-pointer $blake3flags -o "$target-fuzz" $src -lm
mkdir -p "$target-corpus"
ASAN_OPTIONS=detect_leaks=1:leak_check_at_exit=0 ./"$target-fuzz" -max_total_time="${FUZZ_SECONDS:-60}" -max_len=4096 \
	-print_final_stats=1 "$@" "$target-corpus"
