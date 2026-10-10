#!/bin/sh
# mac_test.sh: /drivers/mac (../drv_mac.c) headless, against a fake TextEdit
# at pid 15003 (mac/textedit.records: the metal's irq 51 records as !post
# lines, as `axprobe records <pid>` writes them). The OS's commands to the
# metal are headless.c's [metal] lines on stderr; the nodes are read through
# the serial shell. No Mac app is touched, no window opened, no input posted.
# Build first (sh experimental_os/c/test/headless.sh), then, from the
# repository's root:
#   sh experimental_os/c/test/mac_test.sh [records]
# records: another fixture of the same shape for the app checks (a probe's).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$here/../../mac/build/test/headless"
records="${1:-$here/mac/textedit.records}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-mac-test-XXXXXX")"
out="$tmp/out" err="$tmp/err"
mkfifo "$tmp/in"
"$bin" --fresh --sd "$tmp/sd" < "$tmp/in" > "$out" 2> "$err" &
os=$!
exec 3> "$tmp/in"
failed=0
trap 'exec 3>&-; wait $os 2>/dev/null; [ -n "$KEEP" ] || rm -rf "$tmp"' EXIT

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
plain() { perl -pe 's/\e\[[0-9;]*m//g; s/\r//g' "$1"; }
size() { wc -c < "$1" | tr -d ' '; }
# waitfor file pattern [from byte] [seconds]: the pattern in the file after that byte
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
# run "shell line" pattern what: the line typed, its output waited for
run() {
	from=$(size "$out")
	echo "$1" >&3
	if waitfor "$out" "$2" "$from"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
# also "pattern" what: in the shell's output since the last run
also() {
	if tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | grep -q -- "$1"; then ok "$2"; else bad "$2 (wanted $1)"; fi
}
# none "pattern" what: not in the shell's output since the last run
none() {
	if tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | grep -q -- "$1"; then bad "$2 (did not want $1)"; else ok "$2"; fi
}
# metal "command" pattern what: the line typed (or !post), then a command to the metal
metal() {
	from=$(size "$err")
	echo "$1" >&3
	if waitfor "$err" "$2" "$from"; then ok "$3"; else bad "$3 (wanted [metal] $2 after: $1)"; fi
}
# the shell's last output, after a run
last() { tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g; s/\r//g'; }

waitfor "$out" "dev> " 0 300 || { echo "no shell"; cat "$err"; exit 1; }
ok "booted"
waitfor "$err" '"op":"mac","on":true,"depth":24' 0 50 && ok "mac at boot: /etc/mac's bounds" || bad "no mac command at boot"
waitfor "$err" '"op":"mac",.*"sync":true' 0 10 && ok "the driver's first mac asks for everything (sync)" || bad "no sync in the first mac command"

# --- the app's records into nodes
[ "$(awk 'length > 4095' "$records" | wc -l | tr -d ' ')" = 0 ] && ok "the fixture's lines fit headless's 4096" || bad "a fixture line over 4095 characters"
from=$(size "$err")
cat "$records" >&3
waitfor "$err" "mac: 15003 TextEdit +9 ~0 -0" "$from" && ok "tree records applied, logged" || bad "no tree log line"
waitfor "$err" '"op":"mactook","items":9' "$from" && ok "each tree record answered: mactook" || bad "no mactook"
run "ls /dev/mac/apps/15003" "window-1 .*mac/11" "an app's elements: names, ids mac/<n>"
also "menubar-1 .*mac/2" "the menu bar, mac/2"
run "ls /dev/mac/apps" "15003 .*mac/1" "the app: named by pid, id mac/<n>"
run "cat /dev/mac/apps/15003" '"state":"running"' "the app's state"
also '"elements":18' "the app's elements counted"
run "cat /dev/mac/apps/15003/window-1/scrollarea-1/textarea-1" '"length":9000' "a cut value says its length"
also '"role":"AXTextArea"' "roles verbatim"
run "ls /dev/mac/apps/15003/menubar-1/menubaritem-3/menu-1" "menuitem-3 .*mac/9" "menus: their items"
run "cat /dev/mac/apps/15003/window-1/group-1/webarea-1" '"cut":"web","more":212' "a web area: cut web, more"
run "cat /dev/mac/status" '"apps":1' "/dev/mac/status: apps"
also '"elements":18' "/dev/mac/status: elements"
also '"cut":1' "/dev/mac/status: cut"
also '"ax":true' "/dev/mac/status: ax"
also '"capture":true' "/dev/mac/status: capture"
run "ls /dev/mac" "status " "/dev/mac/status listed"
metal '!post {"irq": 51, "event": "tree", "pid": 15003, "items": [{"set": 1, "value": {"order": ["menubar-1", "window-1"]}}]}' "mac: 15003 TextEdit +0 ~1 -0" "a set of the app's own n"
run "cat /dev/mac/apps/15003" '"order":\["menubar-1","window-1"\]' "the app's order, in its node"
run "cat /dev/mac/focus" 'textarea-1' "the focus: an address"

# --- set, drop, add
metal '!post {"irq": 51, "event": "tree", "pid": 15003, "items": [{"set": 16, "value": {"value": "hello", "length": null}}, {"drop": 17}, {"add": 20, "parent": 15, "name": "scrollbar-2", "value": {"role": "AXScrollBar", "x": 405, "y": 128, "w": 15, "h": 140}}, {"set": 15, "value": {"order": ["textarea-1", "scrollbar-2"]}}]}' \
	"mac: 15003 TextEdit +1 ~2 -1" "set, drop, add: logged"
run "cat /dev/mac/apps/15003/window-1/scrollarea-1/textarea-1" '"value":"hello"' "set: the value follows"
none '"length"' "set: a null key removed"
run "ls /dev/mac/apps/15003/window-1/scrollarea-1" "scrollbar-2 .*mac/20" "add: the new element"
none "scrollbar-1" "drop: the old one gone"
run "cat /dev/mac/apps/15003/window-1/scrollarea-1" '"order":\["textarea-1","scrollbar-2"\]' "the parent's order"

# A program's nodes in /dev/mac/do, open and views are ephemeral, and the
# shell's mk makes documents, which an ephemeral folder refuses: so a small
# program, written into the graph here and run, places them as /home/asks
# says, {do: {name: value}, open: {...}, views: {...}}, and unplaces its own
# that it no longer names.
mirror="export default ({ effect, self }) => { const M = ['/', 'dev', 'mac']; effect('mirror', ({ api }) => api.read({ address: ['/', 'home', 'asks'] })[0]?.value ?? {}, (asks, { api }) => { for (const f of ['do', 'open', 'views']) { const want = asks[f] ?? {}; for (const [n, items] of api.directory({ address: [...M, f] }).directory ?? []) for (const i of items) if (!(n in want) && String(i.id).startsWith(self)) api.unplace({ address: [...M, f], name: n, id: i.id }); for (const [n, v] of Object.entries(want)) { if (api.read({ address: [...M, f, n] }).length) api.write({ address: [...M, f, n], patches: [{ type: 'snapshot', value: v }] }); else api.place({ address: [...M, f], name: n, id: self + '.' + f + '.' + n, value: v, ephemeral: true }) } } }) }"
run "mk /home/tests" "t=" "a folder for the test's program"
run "mk /home/tests/mirror $(perl -MJSON::PP -e 'print JSON::PP->new->canonical->encode({kind => "js", source => $ARGV[0]})' "$mirror")" "t=" "the test's program, in the graph"
run 'mk /home/asks {}' "t=" "its asks"
run "start /home/tests home/tests/mirror" "in /home/tests" "it runs"
ask() { echo "write /home/asks $1" >&3; }

# --- acts
from=$(size "$err")
ask '{"do":{"d1":{"at":"/dev/mac/apps/15003/window-1/button-1","n":1,"act":"AXPress"}}}'
waitfor "$err" '"op":"macdo","req":1,"pid":15003,"n":12,"act":"AXPress"' "$from" && ok "do AXPress: macdo" || bad "do AXPress: no macdo"
from=$(size "$err")
ask '{"do":{"d1":{"at":["/","dev","mac","apps","15003","window-1","scrollarea-1","textarea-1"],"n":2,"act":"set","to":{"value":"hi"}}}}'
waitfor "$err" '"op":"macdo","req":2,"pid":15003,"n":16,"act":"set","to":{"value":"hi"}' "$from" && ok "do set, at a list: macdo" || bad "do set: no macdo"
echo '!post {"irq": 51, "event": "done", "req": 2}' >&3
sleep 0.5
run "cat /dev/mac/do/d1" '"done":2' "done reaches its node"
also '"error":null' "done: error null"
from=$(size "$err")
ask '{"do":{"d1":{"at":["/","dev","mac","apps","15003","window-1","scrollarea-1","textarea-1"],"n":2,"act":"set","to":{"value":"hi"}}}}'
sleep 0.5
tail -c +"$((from + 1))" "$err" | grep -q '"op":"macdo"' && bad "the same n sent again" || ok "the same n is not sent again"
ask '{"do":{"d1":{"at":"/dev/mac/apps/15003/window-1/button-1","n":3,"act":"AXPress"},"d2":{"at":"/dev/mac/apps/15003/window-9","n":1,"act":"AXPress"}}}'
sleep 0.5
run "cat /dev/mac/do/d2" '"error":"bad"' "do at nothing: bad, at once"
also '"done":1' "do at nothing: done"
run "cat /dev/mac/do/d1" '"sent":3' "a do sent says so"
from=$(size "$err")
ask '{"do":{"d3":{"at":"mac/13","n":1,"act":"AXPress"}}}'
waitfor "$err" '"op":"macdo","req":[0-9]*,"pid":15003,"n":13,"act":"AXPress"' "$from" && ok "do at an id, mac/<n>" || bad "do at an id: no macdo"
ask '{"do":{"d3":{"at":"/dev/mac/apps/15003/window-1/button-1","id":"mac/13","n":2,"act":"AXPress"}}}'
sleep 0.5
run "cat /dev/mac/do/d3" '"error":"gone"' "do with an id the address no longer names: gone"
ask '{"do":{"d3":{"at":"mac/99999","n":3,"act":"AXPress"}}}'
sleep 0.5
run "cat /dev/mac/do/d3" '"error":"bad"' "do at an id not here: bad"

# --- open
from=$(size "$err")
ask '{"open":{"o1":{"at":"/dev/mac/apps/15003/window-1/group-1/webarea-1"}}}'
waitfor "$err" '"op":"macopen","pid":15003,"n":19,"depth":12' "$from" && ok "open: macopen" || bad "open: no macopen"
run "cat /dev/mac/open/o1" '"n":"mac/19"' "open: answered with the id it took"
from=$(size "$err")
ask '{"open":{"o1":{"at":"/dev/mac/apps/15003/window-1/group-1/webarea-1"},"o2":{"at":"mac/19","depth":20},"o3":{"at":"/dev/mac/apps/15003/window-2"}}}'
waitfor "$err" '"op":"macopen","pid":15003,"n":19,"depth":20' "$from" && ok "two opens of one element: the deeper" || bad "two opens: no macopen depth 20"
run "cat /dev/mac/open/o3" '"error":"bad"' "an open of what is not here yet: bad"
from=$(size "$err")
ask '{"open":{"o1":{"at":"/dev/mac/apps/15003/window-1/group-1/webarea-1"},"o3":{"at":"/dev/mac/apps/15003/window-2"}}}'
waitfor "$err" '"op":"macopen","pid":15003,"n":19,"depth":12' "$from" && ok "one of two opens gone: the other's depth" || bad "one of two gone: no macopen depth 12"
tail -c +"$((from + 1))" "$err" | grep -q '"n":19,"depth":0' && bad "depth 0 while another open holds it" || ok "no depth 0 while another open holds it"
from=$(size "$err")
echo '!post {"irq": 51, "event": "tree", "pid": 15003, "items": [{"add": 30, "parent": 0, "name": "window-2", "value": {"role": "AXWindow", "title": "Two"}}]}' >&3
waitfor "$err" '"op":"macopen","pid":15003,"n":30,"depth":12' "$from" && ok "an open placed early: sent when its element comes" || bad "early open: no macopen"
run "cat /dev/mac/open/o3" '"n":"mac/30"' "the early open: answered"
from=$(size "$err")
ask '{}'
waitfor "$err" '"op":"macopen","pid":15003,"n":19,"depth":0' "$from" && ok "open gone: macopen depth 0" || bad "open gone: no macopen depth 0"
run "ls /dev/mac/do" "dev> " "do listed"
none "d1" "do gone with its asks"

# --- a view: capture, the plane, the layer, input
from=$(size "$err")
ask '{"views":{"v1":{"window":"/dev/mac/apps/15003/window-1"}}}'
waitfor "$err" '"op":"capture","view":"v1","pid":15003,"window":11' "$from" && ok "view: capture" || bad "view: no capture"
waitfor "$err" '"op":"took","view":"v1","n":1' "$from" && ok "a frame: took" || bad "no took"
run "cat /dev/display/layers/mac-v1" '"source":"mac"' "the layer: plane source mac"
also '"title":"Untitled"' "the layer's title: the window's"
also '"drags":true' "the layer takes drags"
xy=$(last | grep -o '"x":[0-9]*' | head -1 | cut -d: -f2) lx=$xy
ly=$(last | grep -o '"y":[0-9]*' | head -1 | cut -d: -f2)
run "cat /dev/mac/windows/v1" '"state":"live"' "the owner: live"
also '"app":\["/","dev","mac","apps","15003"\]' "the owner: its app"
# raised over the terminal wmiirc opens: a click on its title bar
echo "!click $((lx + 100)) $((ly - 5))" >&3
metal "!click $((lx + 200)) $((ly + 60))" '"op":"macinput","view":"v1"' "a click: macinput"
echo "!wait 300" >&3
echo "!shot $tmp/shot.ppm" >&3
sleep 1
if [ -n "$lx" ] && [ -n "$ly" ] && [ -s "$tmp/shot.ppm" ]; then
	px=$(perl -e 'open F, "<", $ARGV[0] or die; binmode F; local $/; $d = <F>; $d =~ s/^P6\s+(\d+)\s+(\d+)\s+255\s//s or die; $w = $1; $o = (($ARGV[2] + 100) * $w + $ARGV[1] + 160) * 3; printf "%02x%02x%02x", unpack("C3", substr($d, $o, 3))' "$tmp/shot.ppm" "$lx" "$ly")
	[ "$px" = "cc6633" ] && ok "the shot shows the plane in the layer ($px at $lx+160, $ly+100)" || bad "the shot shows $px at $lx+160, $ly+100, not cc6633"
else
	bad "no shot or no layer place ($lx, $ly)"
fi
ask '{"views":{"v1":{"window":"/dev/mac/apps/15003/window-1","input":"press"}}}'
sleep 0.5
run "cat /dev/mac/windows/v1" '"input":"press"' "the owner says press"
run "cat /dev/display/layers/mac-v1" '"source":"mac"' "the layer, again"
lx=$(last | grep -o '"x":[0-9]*' | head -1 | cut -d: -f2)
ly=$(last | grep -o '"y":[0-9]*' | head -1 | cut -d: -f2)
metal "!click $((lx + 15)) $((ly + 11))" '"op":"macdo","req":[0-9]*,"pid":15003,"n":12,"act":"AXPress","point":{"x":115,"y":111}' "press: a click on button-1's frame is AXPress, with the point"
metal "!click $((lx + 200)) $((ly + 60))" '"n":16,"act":"focus"' "press: a click on the text area, which has no AXPress, is focus"

# --- the programs
run "start /apps/macapps programs/macapps" "in /apps/macapps" "macapps starts"
sleep 1.5
run "ls /dev/display/layers" "macapps-" "macapps: its window"
echo "!key ArrowDown" >&3
metal "!key Enter" '"op":"capture","view":"view-' "macapps: Enter shows the window chosen, through macview"
sleep 0.5
run "ls /dev/mac/views" "view-" "macview's view node"
mv=$(last | grep -o 'view-[0-9]*' | head -1)
metal 'set /dev/display/layers/mac-v1 want {"w":400,"h":300}' '"op":"macdo","req":[0-9]*,"pid":15003,"n":11,"act":"set","to":{"w":400,"h":300}' "wmii's want: set w, h on the window"
# wmii closing a window unplaces its owner
metal "rm /dev/mac/windows/$mv" "\"op\":\"uncapture\",\"view\":\"$mv\"" "closed: uncapture"
sleep 1
run "ls /dev/display/layers" "dev> " "layers listed"
none "mac-$mv" "closed: its layer gone"
run "ls /dev/mac/views" "dev> " "views listed"
none "$mv" "closed: macview ended, its view node with it"

# --- quit
echo '!post {"irq": 51, "event": "quit", "pid": 15003}' >&3
sleep 1
run "ls /dev/mac/apps" "dev> " "quit: listed"
none "15003" "quit: /dev/mac/apps empty"
run "cat /dev/mac/windows/v1" '"state":"gone"' "quit: the owner says gone"
run "cat /dev/mac/focus" '"app":null' "quit: the focus let go"
sleep 1
run "ls /dev/display/layers" "dev> " "layers listed"
none "mac-v1" "quit: the layer gone"
from=$(size "$err")
ask '{}'
waitfor "$err" '"op":"uncapture","view":"v1"' "$from" 20 && ok "the view's node gone: uncapture" || bad "no uncapture"
sleep 0.5
run "ls /dev/mac/windows" "dev> " "windows listed"
none "v1" "its owner unplaced"

# --- cost: an app of 5000 elements, placed
perl -e '
	my $pid = 20000; my $n = 100000; my @items; my @recs;
	print qq(!post {"irq": 51, "event": "app", "pid": $pid, "n": $n, "name": "Big", "bundle": "test.big", "path": "/x", "policy": "regular", "active": false, "hidden": false, "state": "running", "electron": false}\n);
	push @items, qq({"add": 100001, "parent": 0, "name": "window-1", "value": {"role": "AXWindow", "title": "Big", "x": 0, "y": 0, "w": 800, "h": 600}});
	for my $g (1..99) { my $gn = 100001 + $g; push @items, qq({"add": $gn, "parent": 100001, "name": "group-$g", "value": {"role": "AXGroup", "x": 0, "y": $g, "w": 800, "h": 6}}); }
	my $k = 100101;
	for my $g (1..99) { for my $b (1..50) { last if $k > 100000 + 5000; push @items, qq({"add": $k, "parent": ) . (100001 + $g) . qq(, "name": "button-$b", "value": {"role": "AXButton", "title": "b$b", "x": $b, "y": $g, "w": 10, "h": 6, "actions": ["AXPress"]}}); $k++; } }
	while (@items) { my @c = splice(@items, 0, 20); print qq(!post {"irq": 51, "event": "tree", "pid": $pid, "items": [) . join(", ", @c) . qq(]}\n); }
' > "$tmp/big.records"
count=$(grep -c '"event": "tree"' "$tmp/big.records")
[ "$(awk 'length > 4095' "$tmp/big.records" | wc -l | tr -d ' ')" = 0 ] || bad "a generated line over 4095 characters"
from=$(size "$err")
t0=$(now)
cat "$tmp/big.records" >&3
t=0
while [ "$(tail -c +"$((from + 1))" "$err" | grep -c 'mac: 20000 Big')" -lt "$count" ] && [ $t -lt 1200 ]; do
	sleep 0.05
	t=$((t + 1))
done
t1=$(now)
placed=$(tail -c +"$((from + 1))" "$err" | grep 'mac: 20000 Big' | sed 's/.*+\([0-9]*\) .*/\1/' | paste -sd+ - | bc)
echo "cost: $placed elements placed in $(echo "$t1 - $t0" | bc) s ($count tree records)"
[ "$placed" -ge 5000 ] && ok "5000 elements placed" || bad "only $placed elements placed"
run "cat /dev/mac/status" '"elements":5000[,}]' "/dev/mac/status counts them"

echo "!wait 200" >&3
exec 3>&-
wait $os 2>/dev/null || true
if grep -q "driver: \|irq 51 to" "$err"; then
	echo "-- the driver's errors:"
	grep "driver: \|irq 51 to" "$err" | head -20
fi
[ "$failed" -eq 0 ] && echo "mac_test: passed" || { echo "mac_test: $failed failed (log: $err)"; trap - EXIT; exit 1; }
