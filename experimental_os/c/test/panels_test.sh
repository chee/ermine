#!/bin/sh
# panels_test.sh: Control Panels (../../image/programs/panels.js) headless:
# the app opens; a choice, a number, a checkbox, a picture and a colour
# write their nodes; an edit from outside shows in the panel; a panel node
# placed live is listed and works; a card an older image made gets
# /etc/panels and /Applications/Control Panels at its next boot. What the
# window shows is read from its layer's access (the rows' labels and
# values). Build first (sh experimental_os/c/test/headless.sh), then, from
# the repository's root:
#   sh experimental_os/c/test/panels_test.sh
# BIN: another headless binary (a copy, while others rebuild it). SHOT: a
# .ppm path, the screenshots there (-desktop, -palette, -mac).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="${BIN:-$here/../../mac/build/test/headless}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-panels-test-XXXXXX")"
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
	if waitfor "$out" "$2" "$from" "${4:-100}"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
# boot sd [image]: the OS on that card, its serial line on fd 3
boot() {
	rm -f "$tmp/in"
	mkfifo "$tmp/in"
	: > "$out"
	"$bin" ${3:-} --sd "$1" ${2:+--image "$2"} < "$tmp/in" > "$out" 2>> "$err" &
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
	sleep 0.25
}
# the panels window's layer, as the shell prints it: its rows said. A layer is long, and the serial line
# writes the end of so long an answer only when another line comes: empty ones follow it till it is all there
said() {
	from=$(size "$out")
	echo "cat /dev/display/layers/$layer" >&3
	i=0
	while [ "$i" -lt 30 ]; do
		waitfor "$out" "$1" "$from" 3 && { ok "$2"; return 0; }
		echo >&3
		i=$((i + 1))
	done
	bad "$2 (wanted $1 in the layer)"
}
shot() {
	echo "!shot $tmp/shot.ppm" >&3
	sleep 0.6
	[ -n "$SHOT" ] && cp "$tmp/shot.ppm" "${SHOT%.ppm}-$1.ppm"
	return 0
}

# --- an older card: made by an image with no panels, then booted with this one
old="$tmp/image"
cp -R "$here/../../image" "$old"
python3 - "$old/image.json" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["nodes"] = [n for n in d["nodes"] if not (n["at"][:2] == ["etc", "panels"] or n["at"] == ["etc"] and n["name"] == "panels"
	or n["name"] == "Control Panels" or n["at"] in (["programs"], ["apps"]) and n["name"] == "panels")]
open(p, "w").write(json.dumps(d, indent=1))
EOF
boot "$tmp/old" "$old" --fresh
run "ls /etc" "keys" "an older image's card"
from=$(size "$out")
echo "ls /etc" >&3
sleep 1
tail -c +"$((from + 1))" "$out" | grep -q '^panels' && bad "panels on it already" || ok "with no panels"
off
boot "$tmp/old"
waitfor "$err" "the image brought the SD card up to date: [0-9]* made" 0 50 && ok "booted with this image: made what it lacked" || bad "no update said"
run "ls /etc/panels" "Desktop" "/etc/panels on the older card"
run "ls /Applications" "Control Panels" "Control Panels in /Applications"
off

# --- a fresh card
boot "$tmp/sd" "" --fresh
waitfor "$err" '^\[menus\] .*Applications {.* | Control Panels | ' 0 300 && ok "Control Panels in the world menu's Applications" || bad "not in the world menu"
run "wm run panels" "" "Control Panels"
sleep 1.5
run "ls /dev/display/layers" "panels-" "its window"
layer=$(perl -pe 's/\e\[[0-9;]*m//g' "$out" | perl -ne 'print "$1\n" if /^(panels-\S+)/' | tail -1)
said '"label":"Desktop, chosen"' "Desktop chosen first"
said '"label":"Fit, centre, /etc/desktop › fit"' "a row says its node and key"
said '"title":"Control Panels"' "titled"
shot desktop

# a row's path, clicked: the graph browser there (Fit's row: under the picture row's 40, its path at the right)
xy=$(perl -pe 's/\e\[[0-9;]*m//g' "$out" | perl -ne 'print "$1 $2\n" if /^panels-.*"x":(\d+),"y":(\d+)/' | tail -1)
echo "!click $(( ${xy% *} + 640 )) $(( ${xy#* } + 55 ))" >&3
sleep 1.5
run "ls /dev/display/layers" "graph-" "a row's path clicked: the graph browser"
from=$(size "$out")
echo "ls /apps/graph" >&3
sleep 0.5
g=$(tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | perl -ne 'print "$1\n" if /^(@\d+)\s/' | tail -1)
run "cat /apps/graph/$g/at" '"path":\["etc","desktop"\]' "at the row's node"
# closed, and Desktop clicked in the list: the keys the panels' again
echo "rm /apps/graph/$g" >&3
sleep 1
echo "!click $(( ${xy% *} + 40 )) $(( ${xy#* } + 61 ))" >&3
sleep 0.5

# a choice: Tab to the rows, Fit (its path clicked chose it), right to the next
key Tab
key ArrowRight
run "cat /etc/desktop" '"fit":"fit"' "a choice writes its node"
said '"label":"Fit, fit,' "and shows it"
# a number: down to Menu bar top, right steps it
key ArrowDown
key ArrowDown
key ArrowRight
run "cat /etc/desktop" '"top":4' "a number steps its node"
# a key under a key: the corner made a map
key ArrowDown
key ArrowDown
key ArrowLeft
run "cat /etc/desktop" '"corner":{"top":9}' "a key path makes the maps on its way"

# an edit from outside, shown
echo 'set /etc/desktop fit "stretch"' >&3
sleep 0.5
said '"label":"Fit, stretch,' "an outside edit shows in the panel"

# a picture: up to the top, right to the first picture
key ArrowUp
key ArrowUp
key ArrowUp
key ArrowUp
key ArrowUp
key ArrowRight
run "cat /etc/desktop/picture" '\["' "a picture chosen: its path on the desk"

# a checkbox: the list, down to Mac, its rows: Take Over runs takeover; Mirror apps is /etc/mac's on
key Tab
key ArrowDown
key ArrowDown
key Tab
said '"label":"Take Over, off' "Take Over: off, as /dev/display/mode says"
key Space
waitfor "$err" '^\[display\] takeover on' 0 50 && ok "Take Over runs the world menu's command" || bad "no takeover asked"
key ArrowDown
key ArrowDown
key Space
run "cat /etc/mac" '"on":false' "a checkbox writes its node"
shot mac

# Appearance: a colour, its hex typed
key Tab
key ArrowUp
key ArrowUp
key ArrowUp
key ArrowUp
key Tab
key Enter
said '"role":"textfield","label":"' "Enter edits a colour"
colour=$(perl -pe 's/\e\[[0-9;]*m//g' "$out" | perl -ne 'print "$1\n" if /"role":"textfield","label":"(\w+), #/' | tail -1)
echo "!type 123456" >&3
sleep 0.4
shot palette
key Enter
run "cat /etc/theme" "\"$colour\":1193046" "a hex written to its theme key ($colour)"

# a panel placed live: listed, and its row works
echo 'mk /etc/panels/Zoo {"kind":"panel","rows":[{"label":"Zap","at":"/etc/zoo","key":"on","control":"check"}]}' >&3
sleep 0.6
said '"label":"Zoo"' "a panel node placed live is listed"
run "cat /apps/panels/$(echo "$layer" | sed 's/^panels-//')/menus" '"label":"Zoo"' "and in the Panels menu"
key Tab
key ArrowDown
key ArrowDown
key ArrowDown
key ArrowDown
key ArrowDown
key ArrowDown
key Tab
key Space
run "cat /etc/zoo" '"on":true' "its checkbox places the node it names"

off
[ "$failed" -eq 0 ] && echo "panels_test: passed" || { echo "panels_test: $failed failed"; exit 1; }
