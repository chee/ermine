#!/bin/sh
# menu_test.sh: the world menu headless: /Applications as its Applications
# submenu, live; the Mac menu bar's copy of it ([menus] lines, a submenu's
# items in { }, (on) a ticked one) and a choice made there (irq 33 with sub);
# the submenu pulled down in wmii's own menu bar; My Computer's apps. Build
# first (sh experimental_os/c/test/headless.sh), then, from the repository's
# root:
#   sh experimental_os/c/test/menu_test.sh
# BIN: another headless binary (a copy, while others rebuild it).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="${BIN:-$here/../../mac/build/test/headless}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-menu-test-XXXXXX")"
out="$tmp/out" err="$tmp/err"
mkfifo "$tmp/in"
"$bin" --fresh --sd "$tmp/sd" < "$tmp/in" > "$out" 2> "$err" &
os=$!
exec 3> "$tmp/in"
failed=0
trap 'exec 3>&-; wait $os 2>/dev/null || true; [ -n "$KEEP" ] || rm -rf "$tmp"' EXIT

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
	if waitfor "$out" "$2" "$from"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
metal() {
	from=$(size "$err")
	echo "$1" >&3
	if waitfor "$err" "$2" "$from"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
# the last [menus] line, and its n
menus() { grep '^\[menus\]' "$err" | tail -1; }
n() { menus | perl -ne 'print $1 if /^\[menus\] (\d+)/'; }

waitfor "$out" "dev> " 0 300 || { echo "no shell"; cat "$err"; exit 1; }
ok "booted"
waitfor "$err" '^\[menus\] .*Applications {' 0 100 && ok "the world menu: an Applications submenu" || bad "no Applications submenu: $(menus)"

# the image's world menu, in order: the apps, by name, then the commands, grouped
m=$(menus)
echo "$m" | grep -q 'ermine: | Applications { | Browser A-b | Cat Clock | Control Panels | Ermine | Graph A-g | Inspector s-i | Keys | Mac Apps | My Computer A-f | Paint | Plasma | Shell A-return | VNC | Workspace A-e } | - | Edit Window Policy | Edit Cursor | Point at… S-s-slash | Clean Up Desktop | - | Mac Windows M-C-w | Take Over | - | Power Off' \
	&& ok "apps by name with their chords, then the commands" || bad "the world menu: $m"
echo "$m" | grep -q 'History' && bad "History in the world menu" || ok "no History: the browser's"

run "ls /Applications" "Shell" "/Applications, one node an app"
run "cat /Applications/Shell" '"run":"term","icon":{"kind":"picture".*"kind":"app"' "an app: {kind: app, run, icon}"

# live: a node placed there is an item, in order; one let go, gone
from=$(size "$err")
echo 'mk /Applications/Bunny {"kind":"app","run":"term"}' >&3
waitfor "$err" '^\[menus\] .*| Browser A-b | Bunny A-return | Cat Clock' "$from" && ok "a node placed: an item, live" || bad "no Bunny: $(menus)"
from=$(size "$err")
echo 'rm /Applications/Bunny' >&3
waitfor "$err" '^\[menus\] .*| Browser A-b | Cat Clock' "$from" && ok "let go: gone" || bad "Bunny stays: $(menus)"

# a check: ticked while what it reads is true, read as the menu is
from=$(size "$err")
echo '!post {"irq": 33, "event": "mode", "w": 1280, "h": 800, "scale": 1, "unit": 1, "takeover": true}' >&3
waitfor "$err" '^\[menus\] .*Take Over (on)' "$from" && ok "Take Over ticked while taking over" || bad "no tick: $(menus)"
from=$(size "$err")
echo '!post {"irq": 33, "event": "mode", "w": 1280, "h": 800, "scale": 1, "unit": 1, "takeover": false}' >&3
waitfor "$err" '^\[menus\] .*| Take Over | -' "$from" && ok "and not, after" || bad "still ticked: $(menus)"

# chosen in the Mac's menu bar: Applications › Plasma (item 0, sub 10), as the metal says it
k=$(n)
echo '!post {"irq": 33, "event": "menu", "n": '"$k"', "menu": 0, "item": 0, "sub": [10]}' >&3
sleep 1
run "cat /dev/display/chosen" '"sub":\[10\]' "chosen keeps sub"
run "ls /apps/plasma" "@[0-9]" "Applications › Plasma, from the Mac's menu bar: started"

# in wmii's own menu bar: the rabbit pressed, its menu down; the Applications row hovered, its submenu beside it
echo "!click 25 8" >&3
sleep 0.4
run "cat /dev/wm/menu" '"menu":0' "the world menu pulled down"
echo "!move 60 30" >&3
sleep 0.4
run "cat /dev/wm/menu/at" '\[0\]' "Applications lit, its submenu open"
echo "!shot $tmp/menu.ppm" >&3
sleep 0.6
[ -n "$SHOT" ] && cp "$tmp/menu.ppm" "$SHOT"
run "cat /dev/display/layers/pull-1" '"role":"menu","label":"Applications"' "the submenu, to VoiceOver"
echo "!key Escape" >&3
sleep 0.3

# My Computer: an app's kind, and Go › Applications
run "wm run computer" "" "My Computer"
sleep 1
echo "ls /apps/computer" >&3
sleep 0.4
name=$(perl -pe 's/\e\[[0-9;]*m//g' "$out" | perl -ne 'print "$1\n" if /^(@\d+)\s/' | tail -1)
run 'write /apps/computer/at/'"$name"' {"path":["Applications"]}' "" "My Computer sent to /Applications"
sleep 0.6
run "ls /dev/display/layers" "computer-" "its window"
layer=$(perl -pe 's/\e\[[0-9;]*m//g' "$out" | perl -ne 'print "$1\n" if /^(computer-\S+)/' | tail -1)
run "cat /dev/display/layers/$layer" 'Shell, application, runs term' "an app, said as one"
echo "!shot $tmp/computer.ppm" >&3
sleep 0.6
[ -n "$SHOT" ] && cp "$tmp/computer.ppm" "${SHOT%.ppm}-computer.ppm"

[ "$failed" -eq 0 ] && echo "menu_test: passed" || { echo "menu_test: $failed failed"; exit 1; }
