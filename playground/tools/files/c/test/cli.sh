#!/bin/sh
# a session with the files tool (files.c) on a real folder: init, put text/diag/bytes at nested paths, ls, the folder on disk,
# mv, rm, an edit by hand, diff, mend. A temp folder and a temp home, so your own Trash and store list are never touched.
# Exits non-zero at the first thing that is not as expected.   sh playground/files/c/test/cli.sh   (builds the tool first)
set -e
here=$(cd "$(dirname "$0")" && pwd)
(cd "$here/../../../.." && make -s playground/files/c/files)
files="$here/../files"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/files-cli.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home" FILES_HOME="$tmp/home"
mkdir -p "$HOME"
store="$tmp/store"

fail() { echo "FAIL: $*" >&2; exit 1; }
# ok <what> <text it must hold> <command...>: the command's output (stdout and stderr) holds the text
ok() {
	what=$1 want=$2
	shift 2
	out=$("$@" 2>&1) || fail "$what: exited $? ($out)"
	printf '%s\n' "$out" | grep -qF -- "$want" || fail "$what: wanted '$want' in: $out"
}
# no <what> <text> <command...>: the output does not hold the text
no() {
	what=$1 want=$2
	shift 2
	out=$("$@" 2>&1) || fail "$what: exited $? ($out)"
	if printf '%s\n' "$out" | grep -qF -- "$want"; then fail "$what: did not want '$want' in: $out"; fi
}
# code <what> <code> <command...>
code() {
	what=$1 want=$2
	shift 2
	set +e
	"$@" >/dev/null 2>&1
	got=$?
	set -e
	[ "$got" = "$want" ] || fail "$what: exit $got, wanted $want"
}

# init, and not twice
root=$("$files" init "$store")
[ ${#root} = 16 ] || fail "init: root id '$root'"
[ -d "$store/.ermine" ] || fail "init: no .ermine"
code "init again" 1 "$files" init "$store"
code "ls of a folder that is no store" 1 "$files" ls "$tmp/home"
ok "ls root" "$root" "$files" ls "$store"

# put: text, markdown nested, diag, bytes from a file, text from a file
"$files" put "$store" hello.txt "hello world"
"$files" put "$store" notes/todo.md "# todo"
"$files" put "$store" notes/deep/er/idea.txt "nested"
"$files" put "$store" config --diag '{"a": 1, "list": [1, 2, h'"'"'00ff'"'"'], "t": "x"}'
printf '\211PNG\r\n\032\n\000\377' > "$tmp/pic.png"
"$files" put "$store" img.png --file "$tmp/pic.png"
printf 'plain file\n' > "$tmp/plain.txt"
"$files" put "$store" plain.txt --file "$tmp/plain.txt"
ls_out=$("$files" tree "$store")
for want in '"hello world"' '"# todo"' '"nested"' '"a": 1.0' "h'00ff'" '<10 bytes>' '"plain file\n"' deep; do
	printf '%s\n' "$ls_out" | grep -qF -- "$want" || fail "ls: wanted $want in: $ls_out"
done

# on disk
[ "$(cat "$store/hello.txt")" = "hello world" ] || fail "hello.txt on disk"
[ -f "$store/notes/todo.md" ] || fail "notes/todo.md on disk"
[ -f "$store/notes/deep/er/idea.txt" ] || fail "nested file on disk"
[ -f "$store/config.text" ] || fail "config.text (diagnostic notation) on disk"
cmp -s "$store/img.png" "$tmp/pic.png" || fail "img.png bytes on disk"
if command -v xattr >/dev/null 2>&1; then
	xattr -l "$store/hello.txt" | grep -q "ermine.id" || fail "hello.txt has no id attribute"
fi

# put again: a new value for the same node (same id)
before=$("$files" ls "$store" | grep hello.txt)
"$files" put "$store" hello.txt "hello again"
after=$("$files" ls "$store" | grep hello.txt)
[ "${before%%\"*}" = "${after%%\"*}" ] || fail "put again changed the id: $before / $after"
[ "$(cat "$store/hello.txt")" = "hello again" ] || fail "hello.txt not rewritten"

# mv, rm
"$files" mv "$store" hello.txt archive/old/hi.txt
[ ! -e "$store/hello.txt" ] && [ -f "$store/archive/old/hi.txt" ] || fail "mv on disk"
ok "ls after mv" "hi.txt" "$files" ls "$store"
no "ls after mv" "hello.txt" "$files" ls "$store"
code "mv onto a taken slot" 1 "$files" mv "$store" plain.txt notes/todo.md
code "mv of nothing" 1 "$files" mv "$store" nothing here
"$files" rm "$store" config
[ ! -e "$store/config.text" ] || fail "rm left config.text"
no "ls after rm" "config" "$files" ls "$store"
code "rm of nothing" 1 "$files" rm "$store" config

# the store is the same after a fresh run: nothing differs
ok "diff clean" "no differences" "$files" diff "$store"

# an edit by hand: diff sees it, ls does not change, mend lays the graph's value again and the edit goes to the Trash
echo "edited in Finder" > "$store/notes/todo.md"
echo "stray" > "$store/stray.txt"
ok "diff edit" "notes/todo.md" "$files" diff "$store"
ok "diff edit" "edited in Finder" "$files" diff "$store"
ok "diff stray" "stray.txt" "$files" diff "$store"
ok "ls keeps the graph" '"# todo"' "$files" ls "$store"
"$files" mend "$store" notes/todo.md 2>/dev/null
[ "$(cat "$store/notes/todo.md")" = "# todo" ] || fail "mend did not lay todo.md again"
[ "$(cat "$HOME/.Trash/todo.md")" = "edited in Finder" ] || fail "the edit is not in the Trash"
no "diff after mend of one" "notes/todo.md" "$files" diff "$store"
ok "diff after mend of one" "stray.txt" "$files" diff "$store"
"$files" mend "$store" 2>/dev/null
[ ! -e "$store/stray.txt" ] || fail "mend left stray.txt"
[ -f "$HOME/.Trash/stray.txt" ] || fail "stray.txt not in the Trash"
ok "diff clean" "no differences" "$files" diff "$store"

# a file deleted by hand comes back with mend
rm "$store/img.png"
ok "diff deleted" "img.png" "$files" diff "$store"
"$files" mend "$store"
cmp -s "$store/img.png" "$tmp/pic.png" || fail "mend did not bring img.png back"

# usage
code "no arguments" 2 "$files"
code "unknown command" 2 "$files" frob "$store"
code "put with too many" 2 "$files" put "$store" a b c d e
code "bad diag" 1 "$files" put "$store" bad --diag '{'
echo "ok"
