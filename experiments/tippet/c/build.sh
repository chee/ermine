#!/bin/sh
# builds tippet's C: tippet-harness (the conformance suite's: conformance/tippet/), tippet-harness-check
# (the same with the address and undefined-behaviour sanitizers), tippet-test (the stores),
# tippet-http-test (the http client), tippet-review-test-check (check_c_review_test.c, with the
# sanitizers), and on macOS tippet-catchup-bench (a device's heap, catching up). tippet's own
# files build as C99 with every warning an error, but history.c and the harness's adapter, on the
# graph, as C11 (op's value.h is), every warning an error; what it reuses (encoding's cbor
# and blake3, ed25519, the graph, the harness loop) as C11, as the root Makefile builds them.
#   sh experiments/tippet/c/build.sh          all of them
#   SIZE=1 sh experiments/tippet/c/build.sh   and each object's size, at -Os
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out="$here/.build"
CC=${CC:-cc}
mkdir -p "$out"

own="wire step pack sign log store store_file sync http"
# on the graph: C11
graph="history elements"
reused="encoding/ed25519/c/ed25519 encoding/ed25519/c/sha2 encoding/c/cbor encoding/c/json encoding/c/blake3/blake3 encoding/c/blake3/blake3_dispatch encoding/c/blake3/blake3_portable"
# the graph: table, node, op, places, scheduler (the root Makefile's places_src, but its harnesses)
places="places/c/places crow/c/crow places/c/crowify processes/c/status graph/c/table graph/c/node graph/c/update changeable/c/value changeable/c/frame changeable/c/apply changeable/c/invert reactivity/c/paths reactivity/c/scheduler reactivity/c/order reactivity/c/rank reactivity/c/causes changeable/c/ptrmap reactivity/c/tracker"
harness="conformance/c/harness conformance/c/protocol_harness changeable/c/json"
STRICT="-std=c99 -Wall -Wextra -Wpedantic -Werror"
LOOSE="-std=c11 -Wall -Wextra -Wpedantic"
BLAKE3="-DBLAKE3_NO_SSE2 -DBLAKE3_NO_SSE41 -DBLAKE3_NO_AVX2 -DBLAKE3_NO_AVX512 -DBLAKE3_USE_NEON=0"

# objects of one kind (name: plain, check, size), each file once
objects() {
	kind=$1
	shift
	opt=$1
	shift
	list=""
	for f in $own; do
		o="$out/$kind/$(echo "$f" | tr / _).o"
		mkdir -p "$out/$kind"
		$CC $STRICT $opt -c "$here/$f.c" -o "$o"
		list="$list $o"
	done
	for f in $graph; do
		o="$out/$kind/$(echo "$f" | tr / _).o"
		$CC $LOOSE -Werror $opt -c "$here/$f.c" -o "$o"
		list="$list $o"
	done
	for f in $reused $places $harness; do
		o="$out/$kind/$(echo "$f" | tr / _).o"
		$CC $LOOSE $BLAKE3 $opt -c "$root/$f.c" -o "$o"
		list="$list $o"
	done
	echo "$list"
}

# each kind's objects, made once
PLAIN="-O2"
CHECK="-g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer"
plain=$(objects plain "$PLAIN")
check=$(objects check "$CHECK")

link() {
	kind=$1 opt=$2 bin=$3 main=$4
	if [ "$kind" = plain ]; then objs=$plain; else objs=$check; fi
	mainobj="$out/$kind/$(basename "$main" .c).o"
	$CC $LOOSE -Werror $opt -c "$here/$main" -o "$mainobj"
	# the graph and the harness loop only where the harness is
	case "$main" in
		*harness*) $CC $opt -o "$here/$bin" $objs "$mainobj" ;;
		catchup* | check_c_review*) $CC $opt -o "$here/$bin" $(echo "$objs" | tr ' ' '\n' | grep -v -e conformance_c_) "$mainobj" ;;
		*) $CC $opt -o "$here/$bin" $(echo "$objs" | tr ' ' '\n' | grep -vE 'conformance_c_|/core_(op|node|table|scheduler|crow|places|protect)_|history|elements') "$mainobj" ;;
	esac
}

link plain "$PLAIN" tippet-harness tippet_harness.c
link check "$CHECK" tippet-harness-check tippet_harness.c
link plain "$PLAIN" tippet-test store_test.c
link check "$CHECK" tippet-test-check store_test.c
link plain "$PLAIN" tippet-http-test http_test.c
link check "$CHECK" tippet-http-test-check http_test.c
link check "$CHECK" tippet-review-test-check check_c_review_test.c
# what a device holds catching up (macOS: it reads malloc's zone)
[ "$(uname)" = Darwin ] && link plain "$PLAIN" tippet-catchup-bench catchup_bench.c

if [ "$SIZE" = 1 ]; then
	for f in $own; do
		$CC $STRICT -Os -c "$here/$f.c" -o "$out/size_$(echo "$f" | tr / _).o"
	done
	for f in $vendored; do
		$CC $LOOSE -Os -c "$here/$f.c" -o "$out/size_$(echo "$f" | tr / _).o"
	done
	for f in $reused; do
		$CC $LOOSE $BLAKE3 -Os -c "$root/$f.c" -o "$out/size_$(echo "$f" | tr / _).o"
	done
	size "$out"/size_*.o
fi
