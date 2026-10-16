#!/bin/sh
# the files tool's sync (host.c), on real folders, through a Subduction server on this machine (subduction_cli: SUBDUCTION_CLI,
# the PATH, or ~/soft/inkandswitch/subduction/target/{release,debug}; without one, wss://galaxy.observer, said so):
#   1. C and C: C makes a document in A, C joins it in B; edits each way (a file written, renamed, a folder made, a file
#      deleted); B stopped, A edited, B started again; A started again
#   2. C makes, TypeScript (files/ts/host.ts) joins; edits each way
#   3. TypeScript makes, C joins; edits each way; then each host started on the other's home and folder (one device
#      layout shared by both)
#   4. the server away (local server only): B started while it is down lays its folder out and takes edits in; once the
#      server is up, A sees them. Then the server killed mid-session, edits on both sides, the server started again: both
#      folders the same
# Temp folders and homes (so no Trash or device of yours is touched); every wait has a timeout. Exits non-zero at the first
# thing that is not as expected.   sh files/c/test/sync.sh   (builds the tool first; FILES=path tries another build of it,
# as files/c/files-check)
set -e
here=$(cd "$(dirname "$0")" && pwd)
newcore=$(cd "$here/../.." && pwd)
if [ -z "$FILES" ]; then
	(cd "$newcore" && make -s files/c/files)
	FILES="$newcore/files/c/files"
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/files-sync.XXXXXX")
tmp=$(cd "$tmp" && pwd -P)
pids=""
server=""
cleanup() {
	for p in $pids; do kill -INT "$p" 2>/dev/null || true; done
	sleep 1
	for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
	[ -n "$server" ] && kill "$server" 2>/dev/null || true
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
own=$HOME
export HOME="$tmp/home"
mkdir -p "$HOME"

fail() {
	echo "FAIL: $*" >&2
	for log in "$tmp"/*.log; do [ -f "$log" ] && { echo "--- $log" >&2; tail -20 "$log" >&2; }; done
	exit 1
}
# waits up to $2 seconds (20) for the shell test $1 to hold
until_() {
	n=$(( ${2:-20} * 5 ))
	while [ $n -gt 0 ]; do
		if eval "$1"; then return 0; fi
		sleep 0.2
		n=$((n - 1))
	done
	return 1
}
# what a folder shows, .ermine left out: each path, and each file's text
shown() {
	(cd "$1" && find . -path ./.ermine -prune -o -print | sort | while read -r p; do
		if [ -f "$p" ]; then printf '%s: %s\n' "$p" "$(cat "$p" 2>/dev/null)"; else printf '%s/\n' "$p"; fi
	done)
}
same() { [ "$(shown "$1")" = "$(shown "$2")" ]; }
# the folders show the same, within a time
step() {
	until_ "same '$tmp/$2' '$tmp/$3'" "${4:-20}" || fail "$1: $2 and $3 differ:
$(shown "$tmp/$2")
---
$(shown "$tmp/$3")"
	echo "ok: $1"
}
# a host in the background: c|ts, the document or new, a folder, a home; its pid in $last, its log name.log
start() {
	kind=$1 doc=$2 folder=$3 home=$4
	mkdir -p "$tmp/$home"
	if [ "$kind" = c ]; then
		"$FILES" "$doc" "$tmp/$folder" --server "$url" --home "$tmp/$home" >"$tmp/$folder.id" 2>"$tmp/$folder.log" &
	else
		deno run -A "$newcore/files/ts/host.ts" "$doc" "$tmp/$folder" --server "$url" --home "$tmp/$home" >"$tmp/$folder.id" 2>"$tmp/$folder.log" &
	fi
	last=$!
	pids="$pids $last"
}
# stops a host as C-c does: it must exit 0
stop() {
	kill -INT "$1"
	n=150
	while kill -0 "$1" 2>/dev/null && [ $n -gt 0 ]; do sleep 0.1; n=$((n - 1)); done
	kill -0 "$1" 2>/dev/null && fail "a host did not stop in 15 s"
	wait "$1" || fail "a host exited $? on SIGINT"
}
laid() { until_ "grep -q 'is laid out' '$tmp/$1.log'" 40 || fail "$1 was not laid out"; }
idof() {
	until_ "[ -s '$tmp/$1.id' ]" 40 || fail "no id printed for $1"
	head -1 "$tmp/$1.id"
}

# the server
cli=""
for c in "$SUBDUCTION_CLI" $(printf '%s\n' "$PATH" | tr : ' ' | sed 's|\([^ ]*\)|\1/subduction_cli|g') \
	"$own/soft/inkandswitch/subduction/target/release/subduction_cli" \
	"$own/soft/inkandswitch/subduction/target/debug/subduction_cli"; do
	if [ -n "$c" ] && [ -x "$c" ]; then cli=$c; break; fi
done
# the server up, on the same port and data each time; down
serve() {
	"$cli" server --auth open --socket "127.0.0.1:$port" --data-dir "$tmp/server" --ephemeral-key --longpoll=false \
		>>"$tmp/server.out" 2>&1 &
	server=$!
	until_ "nc -z 127.0.0.1 $port 2>/dev/null" 20 || fail "subduction_cli did not listen on $port"
}
unserve() {
	kill "$server"
	wait "$server" 2>/dev/null || true
	server=""
	until_ "! nc -z 127.0.0.1 $port 2>/dev/null" 10 || fail "subduction_cli did not stop"
}
if [ -n "$cli" ]; then
	port=$((20000 + $$ % 20000))
	mkdir -p "$tmp/server"
	url="ws://127.0.0.1:$port"
	serve
	echo "server: $cli on $url"
else
	url="wss://galaxy.observer"
	echo "no subduction_cli: using $url"
fi

# 1. C and C ---------------------------------------------------------------------------------------------------------------
start c new A hA
a=$last
doc=$(idof A)
laid A
echo hello >"$tmp/A/note.txt"
mkdir "$tmp/A/sub" && echo inside >"$tmp/A/sub/b.txt"
start c "$doc" B hB
b=$last
grep -q "waiting for $doc to arrive" "$tmp/B.log" || until_ "grep -q 'waiting for' '$tmp/B.log'" 5 || fail "B did not say it was waiting"
laid B
step "C makes, C joins: B shows what A has" A B
echo more >"$tmp/B/from-b.txt"
step "a file written in B" A B
mv "$tmp/A/note.txt" "$tmp/A/renamed.txt"
step "a file renamed in A" A B
mkdir -p "$tmp/B/made/deeper" && echo deep >"$tmp/B/made/deeper/c.txt"
step "folders made in B" A B
rm "$tmp/A/sub/b.txt"
step "a file deleted in A" A B
echo changed >"$tmp/B/renamed.txt"
step "a file's text changed in B" A B
[ ! -e "$tmp/A/@files" ] && [ ! -e "$tmp/B/@files" ] || fail "the files program's slot was laid out"
stop "$b"
echo "while B was away" >"$tmp/A/away.txt"
rmdir "$tmp/A/sub"
sleep 1
start c "$doc" B hB
b=$last
laid B
step "B started again picks up what A did" A B
stop "$a"
start c "$doc" A hA
a=$last
laid A
echo again >"$tmp/A/again.txt"
step "A started again" A B
stop "$a"
stop "$b"

# 2. C makes, TypeScript joins ----------------------------------------------------------------------------------------------
start c new C hC
c=$last
doc=$(idof C)
laid C
echo one >"$tmp/C/one.txt"
mkdir "$tmp/C/dir" && echo two >"$tmp/C/dir/two.txt"
start ts "$doc" T hT
t=$last
laid T
step "C makes, TypeScript joins" C T 40
echo three >"$tmp/T/three.txt"
step "a file written in TypeScript's folder" C T
mv "$tmp/C/one.txt" "$tmp/C/uno.txt"
step "a file renamed in C's" C T
rm "$tmp/T/dir/two.txt"
step "a file deleted in TypeScript's" C T
mkdir "$tmp/C/new-dir" && echo four >"$tmp/C/new-dir/four.txt"
step "a folder made in C's" C T
stop "$t"
echo "while TypeScript was away" >"$tmp/C/away.txt"
start ts "$doc" T hT
t=$last
laid T
step "TypeScript started again" C T 40
stop "$c"
stop "$t"

# 3. TypeScript makes, C joins; then each on the other's device -------------------------------------------------------------
start ts new U hU
u=$last
doc=$(idof U)
laid U
echo uno >"$tmp/U/uno.txt"
start c "$doc" V hV
v=$last
laid V
step "TypeScript makes, C joins" U V 40
echo dos >"$tmp/V/dos.txt"
mkdir "$tmp/V/carpeta" && echo tres >"$tmp/V/carpeta/tres.txt"
step "a file and a folder made in C's folder" U V
mv "$tmp/U/uno.txt" "$tmp/U/one.txt"
step "a file renamed in TypeScript's" U V
rm "$tmp/V/dos.txt"
step "a file deleted in C's" U V
stop "$u"
stop "$v"
# the hosts swapped: C on TypeScript's device and folder, TypeScript on C's
start c "$doc" U hU
u=$last
start ts "$doc" V hV
v=$last
laid U
laid V
echo swapped >"$tmp/U/swapped.txt"
step "C on TypeScript's device, TypeScript on C's" U V 40
echo back >"$tmp/V/back.txt"
step "and back" U V
stop "$u"
stop "$v"

# 4. the server away ---------------------------------------------------------------------------------------------------------
if [ -z "$cli" ]; then
	echo "skipped: the server away (no subduction_cli)"
	echo "all passed"
	exit 0
fi
start c new P hP
p=$last
doc=$(idof P)
laid P
echo first >"$tmp/P/first.txt"
start c "$doc" Q hQ
q=$last
laid Q
step "a document for the server away" P Q
stop "$q"
unserve
start c "$doc" Q hQ
q=$last
laid Q
until_ "grep -q 'offline' '$tmp/Q.log'" 20 || fail "Q did not say it was offline"
echo "made offline" >"$tmp/Q/offline.txt"
mkdir "$tmp/Q/away" && echo "in a folder" >"$tmp/Q/away/inside.txt"
until_ "xattr -l '$tmp/Q/offline.txt' 2>/dev/null | grep -q party.chee.ermine.id" 20 || fail "Q did not take its edit in while offline"
echo ok: "Q laid out and took edits in with the server down"
serve
step "the server up: P sees what Q did offline" P Q 60
grep -q "joined" "$tmp/Q.log" || fail "Q did not say it joined"
[ "$(grep -c offline "$tmp/Q.log")" = 1 ] || fail "Q said it was offline more than once: $(grep offline "$tmp/Q.log")"
unserve
echo "from P while down" >"$tmp/P/p-down.txt"
echo "from Q while down" >"$tmp/Q/q-down.txt"
rm "$tmp/Q/first.txt"
sleep 2
serve
step "the server killed mid-session and started again" P Q 60
stop "$p"
stop "$q"
echo "all passed"
