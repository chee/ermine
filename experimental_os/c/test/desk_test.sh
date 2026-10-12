#!/bin/sh
# desk_test.sh: the desk's icons (../../image/programs/desk.js) and the
# layouts My Computer shares with it, headless: an icon for each node in
# /home/desktop, live; a click selects, shift-click and a rectangle add,
# a double click opens; a drag moves an icon, kept across a boot (not
# --fresh); dropped on a folder, into it; arrows, typing and cmd-o with no
# window focused; Clean Up; My Computer's icons dragged and kept, and its
# window opening where the folder's was closed. What is drawn is read from
# the layers' access (each icon's label and box). Build first (sh
# experimental_os/c/test/headless.sh), then, from the repository's root:
#   sh experimental_os/c/test/desk_test.sh
# BIN: another headless binary (a copy, while others rebuild it). SHOT: a
# .ppm path, the screenshots there (-desk, -dragged, -computer).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="${BIN:-$here/../../mac/build/test/headless}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-desk-test-XXXXXX")"
out="$tmp/out" err="$tmp/err"
failed=0
os=
trap 'exec 3>&- 2>/dev/null; [ -n "$os" ] && wait $os 2>/dev/null || true; [ -n "$KEEP" ] || rm -rf "$tmp"' EXIT

size() { wc -c < "$1" | tr -d ' '; }
waitfor() {
	t=0
	while [ "$t" -lt "${4:-100}" ]; do
		tail -c +"$(( ${3:-0} + 1 ))" "$1" | perl -pe 's/\e\[[0-9;]*m//g' | grep -q -- "$2" && return 0
		sleep 0.1
		t=$((t + 1))
	done
	return 1
}
ok() { echo "ok   $1"; }
bad() {
	echo "FAIL $1"
	failed=$((failed + 1))
}
run() {
	from=$(size "$out")
	echo "$1" >&3
	# the serial line writes an answer's last line when another comes
	echo >&3
	if waitfor "$out" "$2" "$from" "${4:-100}"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
boot() {
	rm -f "$tmp/in"
	mkfifo "$tmp/in"
	: > "$out"
	"$bin" ${2:-} --sd "$1" < "$tmp/in" > "$out" 2>> "$err" &
	os=$!
	exec 3> "$tmp/in"
	waitfor "$out" "dev> " 0 300 || { echo "no shell"; cat "$err"; exit 1; }
}
off() {
	echo "off" >&3
	exec 3>&-
	wait $os 2>/dev/null || true
	os=
}
key() {
	echo "!key $*" >&3
	sleep 0.3
}
# a layer as the shell prints it, into $tmp/layer: a layer is long, and the serial line writes the end of so long
# an answer only when another line comes: empty ones follow it till it is all there
layer() {
	from=$(size "$out")
	echo "cat /dev/display/layers/$1" >&3
	i=0
	while [ "$i" -lt 30 ]; do
		echo >&3
		sleep 0.1
		tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' > "$tmp/layer"
		grep -q '"access"' "$tmp/layer" && grep -q '}]}]' "$tmp/layer" && return 0
		i=$((i + 1))
	done
}
said() {
	layer "$1"
	if grep -q -- "$2" "$tmp/layer"; then ok "$3"; else bad "$3 (wanted $2 in $1)"; fi
}
# where a layer's access puts the icon named $2: "x y", the icon's top left in the layer
where() {
	layer "$1"
	perl -ne 'print "$1 $2\n" if /"x":(\d+),"y":(\d+),"role":"button","label":"\Q'"$2"'\E,/' "$tmp/layer" | tail -1
}
shot() {
	echo "!shot $tmp/shot.ppm" >&3
	sleep 0.6
	[ -n "$SHOT" ] && cp "$tmp/shot.ppm" "${SHOT%.ppm}-$1.ppm"
	return 0
}
# a value's last line, as the shell prints it
said_by() {
	from=$(size "$out")
	echo "$1" >&3
	sleep 0.5
	tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g'
}

boot "$tmp/sd" --fresh
sleep 1
# no window: the desk is what is focused
run "wm kill" "" "the terminal closed"
sleep 0.5
run "cat /dev/display/windows/desk" '"owner":\["/","apps","desk","desk"\]' "the desk's layer, owned"
said desk '"label":"Trash, the Trash, empty' "the Trash on the desk"

# --- an icon for each node in /home/desktop, live
run 'mk /home/desktop/hello "hi"' "id ermine" "a note placed"
run 'mk /home/desktop/stuff' "id ermine" "a folder placed"
run 'mk /home/desktop/temp 1' "id ermine" "data placed"
sleep 0.5
said desk '"label":"hello, note, 2 characters"' "the note's icon, at once"
said desk '"label":"stuff, folder, 0 items"' "the folder's"
said desk '"label":"temp, data"' "the data's"
run 'rm /home/desktop/temp' "" "one let go"
sleep 0.5
layer desk
grep -q '"label":"temp,' "$tmp/layer" && bad "its icon stays" || ok "its icon goes"
shot desk

# --- click, shift-click, a rectangle
xy=$(where desk hello)
hx=$(( ${xy% *} + 16 )) hy=$(( ${xy#* } + 16 ))
echo "!click $hx $hy" >&3
sleep 0.4
said desk '"label":"hello, note, 2 characters, selected"' "a click selects"
xy=$(where desk stuff)
sx=$(( ${xy% *} + 16 )) sy=$(( ${xy#* } + 16 ))
echo '!post {"irq": 35, "event": "down", "x": '$sx', "y": '$sy', "button": 0, "buttons": [0], "mods": ["shift"]}' >&3
echo '!post {"irq": 35, "event": "up", "x": '$sx', "y": '$sy', "button": 0, "buttons": [], "mods": ["shift"]}' >&3
sleep 0.4
layer desk
grep -q '"label":"hello, note, 2 characters, selected"' "$tmp/layer" && grep -q '"label":"stuff, folder, 0 items, selected"' "$tmp/layer" && ok "shift-click adds" || bad "shift-click adds"
echo "!click 200 300" >&3
sleep 0.4
layer desk
grep -q 'selected' "$tmp/layer" && bad "a click on the empty desk lets go" || ok "a click on the empty desk lets go"
echo "!drag $((hx - 60)) $((hy - 20)) $((sx + 30)) $((sy + 30))" >&3
sleep 0.5
layer desk
grep -q '"label":"hello, note, 2 characters, selected"' "$tmp/layer" && grep -q '"label":"stuff, folder, 0 items, selected"' "$tmp/layer" && ok "a rectangle selects what it crosses" || bad "a rectangle selects"

# --- keys, with no window focused: Escape, arrows, a name typed
key Escape
key ArrowDown
said desk '"label":"hello, note, 2 characters, selected"' "an arrow selects the first"
key ArrowDown
said desk '"label":"stuff, folder, 0 items, selected"' "down, the next"
key t
said desk '"label":"Trash, the Trash, empty, selected"' "typing selects by name"

# --- double click opens: a note in the editor
echo "!click $hx $hy" >&3
echo "!click $hx $hy" >&3
sleep 1.5
run "ls /dev/display/layers" "edit-" "a double click opens the note in the editor"
run "wm kill" "" "the editor closed"
sleep 0.5

# --- a drag moves it, written once, kept
echo "!drag $hx $hy 300 200" >&3
sleep 0.6
xy=$(where desk hello)
[ "$xy" = "$(( 300 - 16 )) $(( 200 - 16 ))" ] && ok "a drag moves the icon ($xy)" || bad "a drag moves the icon (at $xy)"
run "ls /apps/computer/layout" '"desk":{' "the layout written"
shot dragged
off

boot "$tmp/sd"
sleep 1
xy2=$(where desk hello)
[ "$xy2" = "$xy" ] && ok "where it was after a boot ($xy2)" || bad "after a boot at $xy2, not $xy"
run "wm kill" "" "the terminal closed"
sleep 0.5

# --- a new node in a folder arranged: the next free place, written; Clean Up
run 'mk /home/desktop/later "x"' "id ermine" "a node come since"
sleep 0.6
xy3=$(where desk later)
[ -n "$xy3" ] && [ "$xy3" != "$xy" ] && ok "a free place ($xy3)" || bad "no free place ($xy3)"
run "/apps/desk/desk/on/menu clean" "" "Clean Up Desktop, as the world menu runs it"
sleep 0.6
xy4=$(where desk hello)
[ "$xy4" != "$xy" ] && ok "Clean Up puts it on the grid ($xy4)" || bad "Clean Up left it at $xy4"

# --- dropped on a folder: into it
xy=$(where desk hello)
hx=$(( ${xy% *} + 16 )) hy=$(( ${xy#* } + 16 ))
xy=$(where desk stuff)
sx=$(( ${xy% *} + 16 )) sy=$(( ${xy#* } + 16 ))
echo "!click $hx $hy" >&3
sleep 0.6
echo "!drag $hx $hy $sx $sy" >&3
sleep 0.6
run "ls /home/desktop/stuff" "hello" "dropped on a folder: into it"
said desk '"label":"stuff, folder, 1 item"' "and the folder says so"

# --- Make Link (cmd-l): the same node again beside it; option-cmd-drag onto a folder: a link there
xy=$(where desk later)
lx=$(( ${xy% *} + 16 )) ly=$(( ${xy#* } + 16 ))
echo "!click $lx $ly" >&3
sleep 0.4
key l cmd
sleep 0.4
id=$(said_by "ls /home/desktop" | perl -ne 'print "$1\n" if /^later\s+(ermine:\/\/[0-9a-f]+)/' | head -1)
run "ls /home/desktop" "^later link .*${id%…}" "Make Link: \"later link\", the same node"
said desk '"label":"later link, note' "its icon"
sleep 0.6
echo '!post {"irq": 35, "event": "down", "x": '$lx', "y": '$ly', "button": 0, "buttons": [0], "mods": ["alt", "cmd"]}' >&3
echo '!post {"irq": 35, "event": "move", "x": '$sx', "y": '$sy', "buttons": [0], "mods": ["alt", "cmd"]}' >&3
echo '!post {"irq": 35, "event": "up", "x": '$sx', "y": '$sy', "button": 0, "buttons": [], "mods": ["alt", "cmd"]}' >&3
sleep 0.6
run "ls /home/desktop/stuff" "^later " "option-cmd-drag onto a folder: a link in it"
run "ls /home/desktop" "^later " "and the node stays"

# --- cmd-o: the folder opens in a My Computer window of its own
echo "!click $sx $sy" >&3
sleep 0.3
key o cmd
sleep 1
run "ls /dev/display/layers" "computer-" "cmd-o opens the folder in My Computer"
from=$(size "$out")
echo "ls /apps/computer/at" >&3
sleep 0.5
at=$(tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | perl -ne 'print "$1\n" if /^(@\d+)\s/' | tail -1)
run "cat /apps/computer/at/$at" '"path":\["home","desktop","stuff"\]' "at the folder"

# --- My Computer: an icon dragged, kept; its window where the folder's was closed
from=$(size "$out")
echo "ls /dev/display/layers" >&3
sleep 0.4
cl=$(tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | perl -ne 'print "$1\n" if /^(computer-\S+)/' | tail -1)
echo "write /apps/computer/at/$at {\"path\":[\"home\"]}" >&3
sleep 0.8
wx=$(said_by "cat /dev/display/windows/$cl" | perl -ne 'print "$1 $2\n" if /"x":(\d+),"y":(\d+),"z"/' | tail -1)
xy=$(where "$cl" Welcome)
mx=$(( ${wx% *} + ${xy% *} + 48 )) my=$(( ${wx#* } + ${xy#* } + 16 ))
echo "!click $mx $my" >&3
sleep 0.6
echo "!drag $mx $my $((mx + 150)) $((my + 120))" >&3
sleep 0.6
xy2=$(where "$cl" Welcome)
[ "$xy2" = "$(( ${xy% *} + 150 )) $(( ${xy#* } + 120 ))" ] && ok "My Computer: a drag moves an icon ($xy2)" || bad "My Computer: the icon at $xy2, not moved from $xy"
run "ls /apps/computer/layout" '"icons":{' "My Computer's layout written"
shot computer
# dragged out of the window onto the desk: into /home/desktop, where it was let go
echo "wm move 300 150" >&3
sleep 0.6
xy=$(where "$cl" Notes)
nx=$(( 300 + ${xy% *} + 48 )) ny=$(( 150 + ${xy#* } + 16 ))
echo "!click $nx $ny" >&3
sleep 0.6
echo "!drag $nx $ny 100 300" >&3
sleep 0.8
run "ls /home/desktop" "^Notes " "dragged from My Computer onto the desk: into /home/desktop"
xy=$(where desk Notes)
[ -n "$xy" ] && [ "${xy% *}" -lt 150 ] && ok "where it was let go ($xy)" || bad "not where it was let go ($xy)"
echo "wm resize 400 300" >&3
sleep 0.3
echo "wm move 120 90" >&3
sleep 0.5
run "wm kill" "" "My Computer closed"
sleep 0.5
run "wm run computer" "" "My Computer again, at /home"
sleep 1.5
from=$(size "$out")
echo "ls /dev/display/layers" >&3
sleep 0.4
cl=$(tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | perl -ne 'print "$1\n" if /^(computer-\S+)/' | tail -1)
run "cat /dev/display/windows/$cl" '"h":300,"w":400,"x":120,"y":90,' "it opens where the folder's was closed"
off

boot "$tmp/sd"
sleep 2
from=$(size "$out")
echo "ls /dev/display/layers" >&3
sleep 0.4
cl=$(tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | perl -ne 'print "$1\n" if /^(computer-\S+)/' | tail -1)
xy3=$(where "$cl" Welcome)
[ "$xy3" = "$xy2" ] && ok "My Computer keeps it there across a boot ($xy3)" || bad "My Computer after a boot: at $xy3, not $xy2"
off

[ "$failed" -eq 0 ] && echo "desk_test: passed" || { echo "desk_test: $failed failed"; exit 1; }
