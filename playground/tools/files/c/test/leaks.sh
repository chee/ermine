#!/bin/sh
# the files tool under macOS's leaks (leaks --atExit): each one-shot command (init, put, rm, mv, ls, diff, mend) must leak
# nothing; then a short sync session, a new document and a host joining it through a local Subduction server (as sync.sh
# finds one; skipped without), a few edits each way, then C-c: each host must leak nothing at its end. Skipped where leaks
# is not there. Temp folders and homes. MallocStackLogging gives the stacks of what leaked, printed on a failure.
#   sh playground/files/c/test/leaks.sh   (builds the tool first; FILES=path tries another build)
set -e
if ! command -v leaks >/dev/null 2>&1; then
	echo "skipped: no leaks (macOS only)"
	exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
newcore=$(cd "$here/../../../.." && pwd)
if [ -z "$FILES" ]; then
	(cd "$newcore" && make -s playground/files/c/files)
	FILES="$newcore/playground/files/c/files"
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/files-leaks.XXXXXX")
tmp=$(cd "$tmp" && pwd -P)
pids=""
server=""
cleanup() {
	for p in $pids; do pkill -INT -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; done
	[ -n "$server" ] && kill "$server" 2>/dev/null || true
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
own=$HOME
export HOME="$tmp/home" FILES_HOME="$tmp/home"
mkdir -p "$HOME"
failed=0

# checks a leaks report: "0 leaks for 0 total leaked bytes"
judge() {
	what=$1 report=$2
	line=$(grep -aE "leaks? for" "$report" | head -1)
	# a live value (scheduler.h: sc_live, the program's handler) is pinned by design, never freed: one a program start
	pinned=$(awk '/^STACK OF/ { n = $3 + 0; live = 0; next } /sc_live \+/ { live = 1 } /^====/ { if (live) sum += n; n = 0 }
		END { print sum + 0 }' "$report")
	count=$(printf '%s\n' "$line" | sed -n 's/.*: \([0-9]*\) leaks* for.*/\1/p')
	case "$line" in
	*" 0 leaks for"*) echo "ok: $what" ;;
	*) [ -n "$count" ] && [ "$count" = "$pinned" ] && { echo "ok: $what ($pinned pinned live value, by design)"; return; } ;;
	esac
	case "$line" in
	*" 0 leaks for"*) ;;
	"") echo "FAIL: $what: no leaks report" >&2; tail -20 "$report" >&2; failed=1 ;;
	*) echo "FAIL: $what: $line" >&2; grep -a -A16 "^STACK OF" "$report" | grep -av "dyld\|libsystem" >&2; failed=1 ;;
	esac
}
# leaks of a one-shot command
one() {
	what=$1
	shift
	MallocStackLogging=1 leaks --atExit -- "$FILES" "$@" >"$tmp/report" 2>&1 || true
	judge "$what" "$tmp/report"
}

store="$tmp/store"
printf '\000\001\377' >"$tmp/bytes"
one init init "$store"
one "put text" put "$store" a/b.txt hello
one "put diag" put "$store" c --diag '{"x": 1}'
one "put bytes" put "$store" a/bytes --file "$tmp/bytes"
one "put nothing" put "$store" e
one mv mv "$store" a/b.txt d.txt
one rm rm "$store" c
one ls ls "$store"
echo edited >"$store/d.txt"
one diff diff "$store"
one "mend a path" mend "$store" d.txt
echo again >"$store/d.txt"
one mend mend "$store"

# a sync session
cli=""
for c in "$SUBDUCTION_CLI" $(printf '%s\n' "$PATH" | tr : ' ' | sed 's|\([^ ]*\)|\1/subduction_cli|g') \
	"$own/soft/inkandswitch/subduction/target/release/subduction_cli" \
	"$own/soft/inkandswitch/subduction/target/debug/subduction_cli"; do
	if [ -n "$c" ] && [ -x "$c" ]; then cli=$c; break; fi
done
if [ -z "$cli" ]; then
	echo "skipped: the sync session (no subduction_cli)"
	exit $failed
fi
until_() {
	n=$(( ${2:-20} * 5 ))
	while [ $n -gt 0 ]; do
		if eval "$1"; then return 0; fi
		sleep 0.2
		n=$((n - 1))
	done
	return 1
}
port=$((20000 + ($$ + 7) % 20000))
mkdir -p "$tmp/server" "$tmp/hA" "$tmp/hB"
"$cli" server --auth open --socket "127.0.0.1:$port" --data-dir "$tmp/server" --ephemeral-key --longpoll=false \
	>/dev/null 2>&1 &
server=$!
url="ws://127.0.0.1:$port"
until_ "nc -z 127.0.0.1 $port 2>/dev/null" 20 || { echo "FAIL: subduction_cli did not listen" >&2; exit 1; }
MallocStackLogging=1 leaks --atExit -- "$FILES" new "$tmp/A" --server "$url" --home "$tmp/hA" >"$tmp/A.report" 2>"$tmp/A.log" &
a=$!
pids="$pids $a"
until_ "grep -q 'is laid out' '$tmp/A.log'" 60 || { echo "FAIL: A was not laid out" >&2; cat "$tmp/A.log" >&2; exit 1; }
doc=$(grep -ao 'ermine://[0-9a-f]*' "$tmp/A.log" | head -1)
echo one >"$tmp/A/one.txt"
mkdir "$tmp/A/dir" && echo two >"$tmp/A/dir/two.txt"
MallocStackLogging=1 leaks --atExit -- "$FILES" "$doc" "$tmp/B" --server "$url" --home "$tmp/hB" >"$tmp/B.report" 2>"$tmp/B.log" &
b=$!
pids="$pids $b"
until_ "[ -f '$tmp/B/dir/two.txt' ]" 60 || { echo "FAIL: B did not show A's" >&2; cat "$tmp/B.log" >&2; exit 1; }
echo three >"$tmp/B/three.txt"
mv "$tmp/A/one.txt" "$tmp/A/uno.txt"
rm "$tmp/A/dir/two.txt"
until_ "[ -f '$tmp/A/three.txt' ] && [ -f '$tmp/B/uno.txt' ] && [ ! -e '$tmp/B/dir/two.txt' ]" 30 ||
	{ echo "FAIL: the edits did not sync" >&2; exit 1; }
sleep 1
# C-c to the hosts, not to leaks, which waits for them to end
pkill -INT -P "$a"
pkill -INT -P "$b"
n=300
while { kill -0 "$a" || kill -0 "$b"; } 2>/dev/null && [ $n -gt 0 ]; do sleep 0.1; n=$((n - 1)); done
wait "$a" || true
wait "$b" || true
pids=""
judge "host: new" "$tmp/A.report"
judge "host: joined" "$tmp/B.report"
exit $failed
