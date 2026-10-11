#!/bin/sh
# web_test.sh: /drivers/web (../drv_web.c), the compositor's web planes
# (../drv_display.c) and the browser (../../image/programs/browser.js),
# headless. No engine draws here: headless.c maps each page's plane file
# as the metal does, answers webshow with a whole frame of 0x3366cc, and
# !page paints a rectangle into a page's next frame, said with dirty, as
# the metal's snapshots would. The page's document comes as the metal's
# dom records, by !post. No window is opened, nothing is shown.
# Build first (sh experimental_os/c/test/headless.sh), then, from the
# repository's root:
#   sh experimental_os/c/test/web_test.sh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$here/../../mac/build/test/headless"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-web-test-XXXXXX")"
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
also() {
	if tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g' | grep -q -- "$1"; then ok "$2"; else bad "$2 (wanted $1)"; fi
}
# hand "line": typed, nothing to wait for but a moment
hand() {
	echo "$1" >&3
	sleep 0.3
}
metal() {
	from=$(size "$err")
	echo "$1" >&3
	if waitfor "$err" "$2" "$from"; then ok "$3"; else bad "$3 (wanted $2 after: $1)"; fi
}
last() { tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g; s/\r//g'; }
# pixels of a colour (rrggbb) in a shot
count() { perl -e 'local $/; open F, $ARGV[0] or die; $_ = <F>; s/^P6\s+\d+\s+\d+\s+255\s//; my $c = pack("H6", $ARGV[1]); my $n = 0; while (/\G(...)/gs) { $n++ if $1 eq $c } print $n' "$1" "$2"; }

waitfor "$out" "dev> " 0 300 || { echo "no shell"; cat "$err"; exit 1; }
ok "booted"

# one live tab, so a second one's page lets the first go, asleep, to be brought back from its state
run 'write /etc/browser {"live":1,"home":"https://example.org"}' "" "/etc/browser: live 1"
sleep 0.3

# --- a page: its view, its plane, its size, its first frame
from=$(size "$err")
echo "browse https://example.org" >&3
waitfor "$err" '"op":"web","id":"web-@*[0-9]*-0","path":"[^"]*ermine-[0-9]*.web.[0-9]*"' "$from" 100 && ok "web: a view made with its plane file" || bad "no web command with a plane"
name=$(perl -ne 'print "$1\n" if /"op":"web","id":"(web-\@?\d+-0)","path"/' "$err" | tail -1)
waitfor "$err" "\[webshow\] $name 720x[0-9]*" "$from" 100 && ok "webshow: the compositor tells the page its size" || bad "no webshow"
sleep 0.5
run "cat /dev/web/pages/$name" '"frame":{"h":[0-9]*,"n":1,"w":720,"plane":[0-9]*}' "the page's frame, in its node"
also '"title":"example.org"' "the page's title"
grep -q '"op":"overlay"\|"op":"webmirror"' "$err" && bad "an overlay or webmirror sent" || ok "no overlay, no webmirror"

# where the window is: its page's top left on the screen
run "cat /dev/display/windows" "browser-" "the window, in /dev/display/windows"
geo=$(last | perl -ne 'if (/"browser-\@?\d+":\{([^}]*)\}/) { my $g = $1; my ($x) = $g =~ /"x":(-?\d+)/; my ($y) = $g =~ /"y":(-?\d+)/; print "$x $y" }')
lx=${geo% *} ly=${geo#* }
[ -n "$lx" ] && ok "the window at $lx,$ly" || bad "no window place"

# --- frames as planes: drawn into the window, a dirty frame only where it changed
echo "!wait 300" >&3
echo "!shot $tmp/a.ppm" >&3
sleep 0.8
n=$(count "$tmp/a.ppm" 3366cc)
[ "$n" -gt 100000 ] && ok "the page's plane composed into its window ($n pixels)" || bad "the page's plane not shown ($n pixels of 3366cc)"
echo "!stats before" >&3
sleep 0.3
metal "!page $name cc0000 10 20 50 40" "\[webtook\] $name 2" "a frame with dirty: taken (webtook)"
sleep 0.5
echo "!stats page" >&3
echo "!shot $tmp/b.ppm" >&3
sleep 0.8
n=$(count "$tmp/b.ppm" cc0000)
[ "$n" = 2000 ] && ok "the dirty rectangle drawn: 50 × 40" || bad "the dirty rectangle: $n pixels of cc0000, wanted 2000"
painted=$(perl -ne 'print "$1\n" if /\[stats\] page (?:layers|flip): \d+, \d+ bytes, (\d+) pixels/' "$err" | tail -1)
[ -n "$painted" ] && [ "$painted" -le 4000 ] && ok "only the dirty rectangle painted ($painted pixels)" || bad "painted ${painted:-?} pixels for a 2000-pixel change"
run "cat /dev/web/pages/$name" '"dirty":{"h":40,"w":50,"x":10,"y":20}' "the frame's dirty, in the page's node"

# --- input: what the window is given over the page goes to the page, in its pixels
px=$((lx + 100)) py=$((ly + 200))
metal "!click $px $py" '"op":"webinput","id":"'"$name"'","events":\[{[^}]*"event":"down"' "a click on the page: webinput"
tail -c +"$((from + 1))" "$err" | grep -q '"op":"web","id":"'"$name"'","focus":true' && ok "a click gives the page the keyboard" || bad "no focus after a click"
dy=$(tail -c +"$((from + 1))" "$err" | perl -ne 'print "$1\n" if /"op":"webinput".*"x":100,"y":(\d+)[^}]*"event":"down"/' | head -1)
[ -n "$dy" ] && ok "in the page's pixels: 100, $dy" || bad "webinput not in the page's pixels"
metal "!move $((px + 5)) $((py + 5))" '"op":"webinput","id":"'"$name"'","events":\[{"x":105,[^}]*"event":"move"' "a move over the page (hover): webinput"
hand '!post {"irq": 49, "event": "focus", "id": "'"$name"'", "on": true}'
sleep 0.4
metal "!key a" '"op":"webinput","id":"'"$name"'","events":\[{[^}]*"key":"a","code":0,"down":true,"mods":\[\],"text":"a"' "a key while the page has the keyboard: the page's"
metal "!commit é" '"op":"webinput","id":"'"$name"'","events":\[{[^}]*"text":"é","event":"commit"' "an input method's text: the page's"
hand '!post {"irq": 49, "event": "cursor", "id": "'"$name"'", "cursor": "pointer"}'
run "cat /dev/web/pages/$name" '"cursor":"pointer"' "cursor, in the page's node"

# --- the document, as nodes
metal '!post {"irq": 49, "event": "dom", "id": "'"$name"'", "reset": true, "count": 4, "cut": 0, "items": [{"add": 1, "parent": 0, "name": "html-1", "value": {"tag": "html", "x": 0, "y": 0, "w": 720, "h": 900}}, {"add": 2, "parent": 1, "name": "body-1", "value": {"tag": "body", "x": 0, "y": 0, "w": 720, "h": 900}}, {"add": 3, "parent": 2, "name": "a-1", "value": {"tag": "a", "href": "https://iana.org", "text": "More", "x": 8, "y": 40, "w": 60, "h": 18}}, {"add": 4, "parent": 2, "name": "input-1", "value": {"tag": "input", "type": "text", "value": "", "x": 8, "y": 80, "w": 200, "h": 22}}]}' "a new document, 4 elements" "dom records: a new document, logged"
run "ls /dev/web/pages/$name/dom/html-1/body-1" "a-1 .*web/$name/3" "elements nested, ids web/<page>/<n>"
run "cat /dev/web/pages/$name/dom/html-1/body-1/a-1" '"href":"https://iana.org"' "an element's value"
hand '!post {"irq": 49, "event": "dom", "id": "'"$name"'", "reset": false, "count": 4, "cut": 0, "items": [{"set": 3, "value": {"tag": "a", "href": "https://iana.org", "text": "Less", "x": 8, "y": 40, "w": 60, "h": 18}}, {"drop": 4}, {"add": 5, "parent": 2, "name": "p-1", "value": {"tag": "p", "text": "hi", "x": 8, "y": 120, "w": 600, "h": 18}}]}'
sleep 0.4
run "cat /dev/web/pages/$name/dom/html-1/body-1/a-1" '"text":"Less"' "set: the value follows"
run "ls /dev/web/pages/$name/dom/html-1/body-1" "p-1 " "add: the new element"
case "$(last)" in *input-1*) bad "drop: input-1 still there" ;; *) ok "drop: gone" ;; esac
run "cat /dev/web/pages/$name/dom" '"count":4' "the document's count"

# --- acts, by a program's node in /dev/web/do (ephemeral: a small program places them as /home/asks says)
mirror="export default ({ effect, self }) => { const M = ['/', 'dev', 'web', 'do']; effect('mirror', ({ api }) => api.read({ address: ['/', 'home', 'asks'] })[0]?.value ?? {}, (asks, { api }) => { for (const [n, items] of api.directory({ address: M }).directory ?? []) for (const i of items) if (!(n in asks) && String(i.id).startsWith(self)) api.unplace({ address: M, name: n, id: i.id }); for (const [n, v] of Object.entries(asks)) { if (api.read({ address: [...M, n] }).length) api.write({ address: [...M, n], patches: [{ type: 'snapshot', value: v }] }); else api.place({ address: M, name: n, id: self + '.' + n, value: v, ephemeral: true }) } }) }"
run "mk /home/tests" "t=" "a folder for the test's program"
run "mk /home/tests/mirror $(perl -MJSON::PP -e 'print JSON::PP->new->canonical->encode({kind => "js", source => $ARGV[0]})' "$mirror")" "t=" "the test's program"
run 'mk /home/asks {}' "t=" "its asks"
run "start /home/tests home/tests/mirror" "in /home/tests" "it runs"
from=$(size "$err")
echo 'write /home/asks {"d1":{"at":"/dev/web/pages/'"$name"'/dom/html-1/body-1/a-1","n":1,"act":"click"}}' >&3
waitfor "$err" '"op":"webdo","id":"'"$name"'","req":1,"n":3,"act":"click"' "$from" && ok "do click, at an address: webdo" || bad "no webdo for a click"
sleep 0.5
run "cat /dev/web/do/d1" '"done":1' "done, in the do node"
also '"error":null' "done: no error"
from=$(size "$err")
echo 'write /home/asks {"d1":{"at":"web/'"$name"'/5","n":2,"act":"set","value":"x"}}' >&3
waitfor "$err" '"op":"webdo","id":"'"$name"'","req":2,"n":5,"act":"set","value":"x"' "$from" && ok "do set, at an id: webdo with its value" || bad "no webdo for a set"
echo 'write /home/asks {"d1":{"at":"web/'"$name"'/4","n":3,"act":"click"},"d2":{"at":"/dev/web/pages/'"$name"'/dom/nothing","n":1,"act":"click"}}' >&3
sleep 0.6
run "cat /dev/web/do/d1" '"error":"bad"' "an element gone: bad"
run "cat /dev/web/do/d2" '"error":"bad"' "an address naming nothing: bad"

# --- state: into the tab's document, and a page brought back from it
hand '!post {"irq": 49, "event": "state", "id": "'"$name"'", "state": "c3RhdGUx"}'
sleep 0.5
run "cat /dev/web/pages/$name" '"state":"c3RhdGUx"' "state, in the page's node"
run "ls /apps/browser/tabs" "" "the tabs' documents"
doc=$(last | perl -ne 'print "$1\n" if /^(\@?\d+)\s/' | head -1)
run "cat /apps/browser/tabs/$doc/0/state" '"c3RhdGUx"' "state kept beside the tab's document, its state"
# a second tab with a page, so the first (one live) is let go; selecting it again brings it back from its state
hand "!key t cmd"
sleep 0.4
echo "!type other.org" >&3
from=$(size "$err")
echo "!key Enter" >&3
waitfor "$err" '"op":"webclose","id":"'"$name"'"' "$from" && ok "one live: the first tab's page let go" || bad "the first page not let go"
from=$(size "$err")
echo "!key 1 cmd" >&3
waitfor "$err" "\[web\] $name brought back from its state" "$from" && ok "selected again: brought back from its state" || bad "not brought back from its state"

# --- history: each tab its own node, a navigation one change to it, its history the node's; back and forward move
# where the tab is (here, in the view) and write nothing
pid=${name#web-}
pid=${pid%-0}
run "cat /apps/browser/tabs/$doc" '"tabs":\[0,1\]' "the window's document: its tabs by id"
run "cat /apps/browser/tabs/$doc/0" '"url":"https://example.org"' "each tab a node of its own"
run "cat /dev/sync/want/browser-$pid" 'ermine://' "the tabs' histories asked for"
hand "!nav $name https://b.org"
hand "!nav $name https://c.org"
sleep 0.4
run "cat /apps/browser/tabs/$doc/0" '"url":"https://c.org"' "a link followed: the tab's node, an entry"
also '"from":null' "from the newest: null"
# the history of tab 0's node, served by the sync driver
hist=""
run "ls /dev/sync/history" "" "the histories served"
for h in $(last | perl -ne 'print "$1\n" if /^([0-9a-f]{64})\s/'); do
	from=$(size "$out")
	echo "cat /dev/sync/history/$h" >&3
	sleep 0.4
	last | grep -q 'https://c.org' && hist=$h
done
[ -n "$hist" ] && ok "/dev/sync/history/<hex>: the tab's node's history" || bad "no history with the tab's entries"
run "cat /dev/sync/history/$hist" '"key":"from"' "its changes, with their patches"
also '"commit":"[0-9a-f]\{64\}"' "each named by its commit"
also '"value":{[^}]*"url":"https://b.org"' "each with the value after it"
metal "!key [ cmd" '"op":"web","id":"'"$name"'","go":"back"' "back: WebKit's own back, its list going the same way"
sleep 0.4
run "cat /apps/browser/$pid/view" '"here":{"0":"[0-9a-f]\{64\}"}' "back: here, in the view"
run "cat /apps/browser/tabs/$doc/0" '"url":"https://c.org"' "back writes nothing: the tab's node as it was"
hand "!nav $name https://e.org"
sleep 0.4
run "cat /apps/browser/tabs/$doc/0" '"from":"[0-9a-f]\{64\}"' "a link from an earlier entry: a branch, from it"
also '"url":"https://e.org"' "the branch's entry"
run "cat /apps/browser/$pid/view" '"here":{}' "here: the newest again"
metal "!key [ cmd" '"op":"web","id":"'"$name"'","go":"back"' "back from the branch"
metal "!key ] cmd" '"op":"web","id":"'"$name"'","go":"forward"' "forward: the branch last on"
sleep 0.4
run "cat /apps/browser/$pid/view" '"here":{}' "forward: the newest, e"
# the popup: every tab's history, searched
hand "!key y cmd"
run "ls /dev/display/layers" "browser-$pid-history" "cmd-y: the history popup, a layer of its own"
echo "!type c.org" >&3
sleep 0.5
run "cat /dev/display/layers/browser-$pid-history" '"c.org"' "typed: the entries found"
case "$(last)" in *'"e.org"'*) bad "the search shows e.org" ;; *) ok "the search leaves out the rest" ;; esac
metal "!key Enter" '"op":"web","id":"'"$name"'","url":"https://c.org"' "return: c, off the line WebKit holds, loaded"
run "ls /dev/display/layers" "" "the layers"
case "$(last)" in *"browser-$pid-history"*) bad "the popup still there" ;; *) ok "chosen: the popup goes" ;; esac
run "cat /apps/browser/tabs/$doc/0" '"url":"https://e.org"' "moving to c writes nothing"
hand "!key y cmd"
echo "!type b.org" >&3
sleep 0.4
metal "!key Enter cmd" '"op":"web","id":"web-'"$pid"'-2"' "cmd-return: in a new tab"
sleep 0.4
run "cat /apps/browser/tabs/$doc/2" '"url":"https://b.org"' "the new tab at the entry's address"
hand "!replace web-$pid-2 https://b2.org"
sleep 0.4
run "cat /apps/browser/tabs/$doc/2" '"url":"https://b2.org"' "a redirect: the entry's address put right"
also '"from":null' "a redirect is no entry"
# a covering window: drawn over the page, as any window is
run "start /apps/inspect programs/inspect" "in /apps/inspect" "another window"
sleep 1
echo "!shot $tmp/c.ppm" >&3
sleep 0.8
m=$(count "$tmp/c.ppm" 3366cc)
[ "$m" -lt "$(count "$tmp/a.ppm" 3366cc)" ] && ok "a window above covers the page ($m pixels left)" || bad "a window above does not cover the page"

# History, the window
run "start /apps/history programs/history" "in /apps/history" "History, a window"
sleep 1
run "ls /dev/display/layers" "history-@" "its layer"
hl=$(last | perl -ne 'print "$1\n" if /^(history-\@\d+)\s/' | head -1)
run "cat /dev/display/layers/$hl" '"e.org"' "every tab's entries, the branch too"
also '"b2.org"' "the new tab's"
# an older browser's window: its tabs inside its document, made nodes of their own once
run 'mk /apps/browser/tabs/old {"tabs":[{"id":3,"url":"https://old.org","title":"Old","state":"c3Q="}],"at":0,"n":4,"closed":[{"url":"https://gone.org","title":"Gone","at":0}]}' "t=" "an older browser's window"
from=$(size "$err")
echo "start /apps/browser programs/browser old" >&3
waitfor "$err" '\[web\] web-@[0-9]*-3 brought back from its state' "$from" && ok "migrated: its tab brought back from its state" || bad "the old window's tab not brought back"
run "cat /apps/browser/tabs/old" '"tabs":\[3\]' "migrated: the tabs by id"
run "cat /apps/browser/tabs/old/3" '"url":"https://old.org"' "migrated: a tab's node"
run "cat /apps/browser/tabs/old/3/state" '"c3Q="' "migrated: its state"
run "cat /apps/browser/tabs/old/4" '"url":"https://gone.org"' "migrated: a closed tab, a node of its own"

echo "!wait 200" >&3
[ "$failed" = 0 ] && echo "all passed" || echo "$failed failed"
exit "$failed"
