#!/bin/sh
# vnc_test.sh: /drivers/vnc (../drv_vnc.c) and /programs/vnc
# (../../image/programs/vnc.js), headless, against test/vnc/server.py, a
# small RFB server on 127.0.0.1 at a port of the system's choosing: never a
# real screen. It speaks 3.3, 3.7, 3.8 and Apple's 3.889; None, VNC
# authentication and Apple Remote Desktop's (its own DH and MD5, DES and
# AES through the openssl command); Raw, CopyRect, RRE, Hextile, Zlib and
# ZRLE, Cursor, DesktopSize and ExtendedDesktopSize. Each frame is checked
# against the server's own screen, pixel for pixel (test/vnc/check.py), in
# Actual Size; what the client sends, keys, the pointer and the clipboard,
# from the server's log. Nothing is shown.
# Build first (sh experimental_os/c/test/headless.sh), then, from the
# repository's root:
#   sh experimental_os/c/test/vnc_test.sh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="${HEADLESS:-$here/../../mac/build/test/headless}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ermine-vnc-test-XXXXXX")"
out="$tmp/out" err="$tmp/err"
OPENSSL="${OPENSSL:-$(brew --prefix openssl@3 2>/dev/null)/bin/openssl}"
[ -x "$OPENSSL" ] || OPENSSL=openssl
export OPENSSL
mkfifo "$tmp/in"
"$bin" --fresh --sd "$tmp/sd" < "$tmp/in" > "$out" 2> "$err" &
os=$!
exec 3> "$tmp/in"
failed=0
servers=""
trap 'exec 3>&-; for p in $servers; do kill $p 2>/dev/null || true; done; wait $os 2>/dev/null || true; [ -n "$KEEP" ] || rm -rf "$tmp"' EXIT

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
last() { tail -c +"$((from + 1))" "$out" | perl -pe 's/\e\[[0-9;]*m//g; s/\r//g'; }
hand() {
	echo "$1" >&3
	sleep 0.3
}

# a server, its own folder: started, its port read; $port and $ctl and $log after
serve() {
	d="$tmp/server-$1"
	shift
	mkdir -p "$d"
	mkfifo "$d/ctl"
	python3 "$here/vnc/server.py" --port-file "$d/port" --control "$d/ctl" --log "$d/log" "$@" &
	servers="$servers $!"
	t=0
	while [ ! -f "$d/port" ] && [ "$t" -lt 50 ]; do
		sleep 0.1
		t=$((t + 1))
	done
	port=$(cat "$d/port")
	ctl="$d/ctl" log="$d/log"
	exec 4> "$ctl"
}
# a line to the server, then the line its log says it was sent with
tell() {
	sent=$(size "$log")
	echo "$1" >&4
	waitfor "$log" "sent $1" "$sent" 100 || bad "the server did not send: $1"
	sleep 0.4
}
heard() {
	if waitfor "$log" "$1" "${3:-0}" 50; then ok "$2"; else bad "$2 (wanted $1 in the server's log)"; fi
}
# the newest session listed: its name (the process's number, which grows), and the program's pid
newest() {
	name=$(last | perl -ne 'print "$1\n" if /^(vnc-\d+)\s/' | sort -t- -k2 -n | tail -1)
	pid="@${name#vnc-}"
}
# the screen's top left in a shot: the window's content, the session's picture in it
origin() {
	from=$(size "$out")
	echo "cat /dev/display/windows/$name" >&3
	waitfor "$out" '"x":' "$from" 50
	geo=$(last | perl -ne '1 while s/(?<=.)\{[^{}]*\}/0/; if (/"x":(-?\d+)/) { my $x = $1; my ($y) = /"y":(-?\d+)/; print "$x $y" }')
	from=$(size "$out")
	echo "cat /dev/vnc/sessions/$name" >&3
	waitfor "$out" '"state"' "$from" 50
	sx=$(last | perl -ne 'print $1 if /"x":(-?\d+)/') sy=$(last | perl -ne 'print $1 if /"y":(-?\d+)/')
	ox=$(( ${geo% *} + sx )) oy=$(( ${geo#* } + sy ))
}
# the shot against the server's screen, pixel for pixel
same() {
	echo "dump $tmp/dump.ppm" >&4
	echo "!wait 300" >&3
	echo "!shot $tmp/shot.ppm" >&3
	sleep 0.9
	origin
	got=$(python3 "$here/vnc/check.py" "$tmp/shot.ppm" "$tmp/dump.ppm" "$ox" "$oy")
	[ "$got" = same ] && ok "$1: the window shows the server's screen, pixel for pixel" || bad "$1: $got"
}

waitfor "$out" "dev> " 0 300 || { echo "no shell"; cat "$err"; exit 1; }
ok "booted"

# --- RFB 3.8, no security: a window, a session, the plane
serve a --version 3.8 --security none --name "far away" --w 320 --h 200
run "wm run vnc 127.0.0.1:$port" "" "vnc, started"
heard "encodings 1,16,6,5,2,0,-239,-223,-308,-224" "SetEncodings: CopyRect, ZRLE, Zlib, Hextile, RRE, Raw, Cursor, DesktopSize, ExtendedDesktopSize, LastRect"
heard "format bpp=32 depth=24 big=0 true=1 shifts=16,8,0" "SetPixelFormat: 32 bits, little-endian, 0x00RRGGBB"
heard "request whole 0 0 320 200" "the whole screen asked for first"
sleep 0.5
run "ls /dev/vnc/sessions" "vnc-" "a session"
name=$(last | perl -ne 'print "$1\n" if /^(vnc-\d+)\s/' | head -1)
pid="@${name#vnc-}"
run "cat /dev/vnc/sessions/$name" '"state":"live"' "live"
case "$(last)" in *'"w":320'*'"h":200'*|*'"h":200'*'"w":320'*) ok "its size: 320 × 200" ;; *) bad "its size" ;; esac
case "$(last)" in *'"desktop":"far away"'*) ok "the desktop's name" ;; *) bad "no desktop name" ;; esac
case "$(last)" in *'"version":"3.8"'*) ok "version 3.8" ;; *) bad "version" ;; esac
case "$(last)" in *'"security":"none"'*) ok "security none" ;; *) bad "security" ;; esac
run "cat /dev/display/layers/$name" '"plane":{[^}]*"source":"vnc"' "the window's layer shows the driver's plane"
run "cat /apps/vnc/connections/$pid" '"host":"127.0.0.1"' "the connection, a document beside it"

# --- Actual Size: each encoding, checked against the server's screen
run "call /apps/vnc/$pid/on/menu \"actual\"" "" "View › Actual Size"
sleep 0.5
run "cat /dev/vnc/views/$name" '"view":"actual"' "the view says actual"
tell "fill raw 10 10 50 40 cc0000"
same "Raw"
tell "fill rre 70 10 40 30 00aa00"
same "RRE"
tell "fill hextile 120 10 60 50 0000bb"
tell "pattern hextile 0 70 100 40 stripes"
same "Hextile"
tell "fill zlib 190 10 50 40 aaaa00"
tell "pattern zlib 200 60 30 30 noise"
same "Zlib"
tell "pattern zrle 0 120 130 70 stripes"
tell "pattern zrle 140 120 70 70 bands"
tell "pattern zrle 220 120 90 70 many"
tell "pattern zrle 250 10 60 50 noise"
tell "fill zrle 120 70 60 40 ff00ff"
same "ZRLE: solid, packed palettes, palette RLE, plain RLE, raw tiles"
tell "copy 150 130 60 50 10 10"
same "CopyRect"

# only what changed is copied: a 20 × 10 rectangle
echo "!stats before" >&3
sleep 0.3
tell "fill zrle 30 30 20 10 123456"
echo "!wait 200" >&3
echo "!stats small" >&3
sleep 0.5
painted=$(perl -ne 'print "$1\n" if /\[stats\] small (?:layers|flip): \d+, \d+ bytes, (\d+) pixels/' "$err" | tail -1)
[ -n "$painted" ] && [ "$painted" -le 1000 ] && ok "only the rectangle painted ($painted pixels for 200)" || bad "painted ${painted:-?} pixels for a 200-pixel change"
run "cat /dev/display/layers/$name" '"dirty":{"h":10,"w":20,' "the plane's dirty, the rectangle"

# --- Fit: scaled, the same picture smaller or larger
run "call /apps/vnc/$pid/on/menu \"fit\"" "" "View › Fit"
sleep 0.5
run "cat /dev/vnc/sessions/$name" '"scale":[0-9.]*' "fit: a scale"
scale=$(last | perl -ne 'print $1 if /"scale":([0-9.]+)/')
tell "fill zrle 0 0 160 100 33cc33"
echo "!wait 300" >&3
echo "!shot $tmp/fit.ppm" >&3
sleep 0.8
n=$(perl -e 'local $/; open F, $ARGV[0] or die; $_ = <F>; s/^P6\s+\d+\s+\d+\s+255\s//; my $c = pack("H6", "33cc33"); my $n = 0; while (/\G(...)/gs) { $n++ if $1 eq $c } print $n' "$tmp/fit.ppm")
want=$(perl -e "printf '%d', 160 * 100 * $scale * $scale")
[ "$n" -gt $((want * 9 / 10)) ] && [ "$n" -le $((want * 11 / 10)) ] && ok "fit at $scale: 160 × 100 shows as $n pixels (about $want)" || bad "fit at $scale: $n pixels of 33cc33, wanted about $want"

# --- the cursor: a picture, and the pointer takes it over the screen
tell "cursor"
sleep 0.3
run "cat /dev/vnc/sessions/$name/cursor" '"kind":"picture"' "the other side's cursor, a picture"
case "$(last)" in *'"hot":'*) ok "with its hot spot" ;; *) bad "no hot spot" ;; esac
origin
hand "!move $((ox + 40)) $((oy + 30))"
hand "!move $((ox + 41)) $((oy + 31))"
run "cat /dev/pointer/cursor" "\"dev\",\"vnc\",\"sessions\",\"$name\",\"cursor\"" "over the screen, the pointer's cursor is the other side's"
at=$(size "$log")
hand "!move $((ox + 60)) $((oy + 50))"
heard "pointer 0 " "a move: PointerEvent, no button" "$at"

# --- the pointer: a click where it lands on the other side
at=$(size "$log")
hand "!click $((ox + 100)) $((oy + 50))"
rx=$(perl -e "printf '%d', 100 / $scale") ry=$(perl -e "printf '%d', 50 / $scale")
heard "pointer 1 $rx $ry" "a click: button 1 down at $rx, $ry (the window's pixels over the scale)" "$at"
heard "pointer 0 $rx $ry" "and up" "$at"
at=$(size "$log")
hand '!post {"irq": 35, "event": "scroll", "x": '"$((ox + 100))"', "y": '"$((oy + 50))"', "dx": 0, "dy": 30, "mods": [], "buttons": []}'
heard "pointer 16 " "the wheel down: button 5" "$at"
at=$(size "$log")
hand '!post {"irq": 35, "event": "scroll", "x": '"$((ox + 100))"', "y": '"$((oy + 50))"', "dx": -30, "dy": 0, "mods": [], "buttons": []}'
heard "pointer 32 " "the wheel left: button 6" "$at"

# --- keys: X keysyms
at=$(size "$log")
hand "!key a"
heard "key 1 0x61" "a: keysym 0x61 down" "$at"
heard "key 0 0x61" "and up" "$at"
at=$(size "$log")
hand "!key Enter"
heard "key 1 0xff0d" "Enter: Return" "$at"
at=$(size "$log")
hand "!key ArrowLeft"
heard "key 1 0xff51" "ArrowLeft: Left" "$at"
at=$(size "$log")
hand "!commit é"
heard "key 1 0xe9" "an input method's é: its keysym" "$at"
at=$(size "$log")
hand '!post {"irq": 34, "event": "key", "down": true, "code": 55, "key": "Meta", "text": "", "mods": ["cmd"], "repeat": false}'
hand '!post {"irq": 34, "event": "key", "down": true, "code": 0, "key": "a", "text": "a", "mods": ["cmd"], "repeat": false}'
hand '!post {"irq": 34, "event": "key", "down": false, "code": 0, "key": "a", "text": "", "mods": ["cmd"], "repeat": false}'
hand '!post {"irq": 34, "event": "key", "down": false, "code": 55, "key": "Meta", "text": "", "mods": [], "repeat": false}'
heard "key 1 0xffeb" "cmd, to a server not a Mac's: Super_L" "$at"
heard "key 1 0x61" "cmd-a: a, by the key's place" "$at"
at=$(size "$log")
hand '!post {"irq": 34, "event": "key", "down": true, "code": 31, "key": "o", "text": "ø", "mods": ["alt"], "repeat": false}'
hand '!post {"irq": 34, "event": "key", "down": false, "code": 31, "key": "o", "text": "", "mods": ["alt"], "repeat": false}'
heard "key 1 0x6f" "option-o: o (the other side makes its own ø)" "$at"
at=$(size "$log")
hand '!post {"irq": 34, "event": "key", "down": true, "code": 18, "key": "1", "text": "!", "mods": ["shift", "ctrl"], "repeat": false}'
heard "key 1 0x21" "control-shift-1: !, shifted as a US keyboard" "$at"
hand '!post {"irq": 34, "event": "key", "down": false, "code": 18, "key": "1", "text": "", "mods": [], "repeat": false}'
at=$(size "$log")
run "call /apps/vnc/$pid/on/menu \"send\" [\"cmd\",\"Tab\"]" "" "Connection › Send cmd-Tab"
heard "key 1 0xffeb" "cmd down" "$at"
heard "key 1 0xff09" "Tab down" "$at"
heard "key 0 0xffeb" "and both up" "$at"

# --- the clipboard, both ways
tell "cut hello from far"
run "cat /dev/clip/text" '"text":"hello from far"' "ServerCutText: /dev/clip/text"
case "$(last)" in *'"from":"vnc"'*) ok "from vnc (the clip driver gives it the Mac)" ;; *) bad "not from vnc" ;; esac
run 'write /dev/clip/text {"text":"\u00fcber here","count":0,"from":"shell"}' "" "a copy here"
at=$(size "$log")
run "call /apps/vnc/$pid/on/menu \"clip\"" "" "Connection › Send Clipboard"
heard "cut über here" "ClientCutText, Latin-1" "$at"

# --- the other side resizing
at=$(size "$log")
tell "resize 400 240"
heard "request whole 0 0 400 240" "DesktopSize: the whole new screen asked for" "$at"
sleep 0.4
run "cat /dev/vnc/sessions/$name" '"w":400' "the session's new size"
run "call /apps/vnc/$pid/on/menu \"actual\"" "" "Actual Size again"
sleep 0.5
same "resized"
tell "resize 300 180 ext"
sleep 0.4
run "cat /dev/vnc/sessions/$name" '"w":300' "ExtendedDesktopSize: the new size"
same "resized again"

# --- the window resized: the view follows it
run "call /apps/vnc/$pid/on/menu \"fit\"" "" "Fit again"
run "wm resize $name 600 360" "" "the window resized"
sleep 0.8
run "cat /dev/vnc/views/$name" '"w":600' "the view, as wide as the window"
vh=$(last | perl -ne 'print $1 if /"h":(\d+)/')
want=$(perl -e "my \$a = 600 / 300; my \$b = $vh / 180; print 0 + sprintf('%.3f', \$a < \$b ? \$a : \$b)")
run "cat /dev/vnc/sessions/$name" "\"scale\":$want[,}]" "fit: the scale follows (300 × 180 in 600 × $vh)"

# --- the sheet over a live screen: the plane let go while it is up, back after
run "call /apps/vnc/$pid/on/menu \"connect\"" "" "Connection › Connect…, while live"
sleep 0.4
run "cat /dev/display/layers/$name" '"plane":null' "the sheet up: the plane let go"
hand "!key Escape"
sleep 0.4
run "cat /dev/display/layers/$name" '"plane":{[^}]*"source":"vnc"' "the sheet gone: the plane back"

# --- the keyboard gone to another window: what is held let go on the other side
at=$(size "$log")
hand '!post {"irq": 34, "event": "key", "down": true, "code": 7, "key": "x", "text": "x", "mods": [], "repeat": false}'
heard "key 1 0x78" "x held down" "$at"
run "start /apps/inspect programs/inspect" "in /apps/inspect" "another window"
heard "key 0 0x78" "the keyboard gone: x let go on the other side" "$at"

# --- the server going: closed, the window says so
tell "quit"
sleep 0.5
run "cat /dev/vnc/sessions/$name" '"state":"closed"' "the server closing: closed"
run "call /apps/vnc/$pid/on/menu \"disconnect\"" "" "Disconnect"
sleep 0.4
run "ls /dev/vnc/sessions" "" "sessions"
case "$(last)" in *"$name"*) bad "the session still there" ;; *) ok "disconnected: the session gone" ;; esac
run "cat /dev/display/layers/$name" '"plane":null' "and the plane gone from the layer"

# --- RFB 3.7, VNC authentication: the password asked for, typed, never written
serve b --version 3.7 --security vnc --password sekrit9 --w 200 --h 120
run "wm run vnc 127.0.0.1:$port" "" "a second window, a server wanting a password"
sleep 1
run "ls /dev/vnc/sessions" "vnc-" "its session"
newest
pid="@${name#vnc-}"
run "cat /dev/vnc/sessions/$name" '"state":"password"' "it waits for a password"
case "$(last)" in *'"security":"vnc"'*) ok "VNC authentication" ;; *) bad "not vnc security" ;; esac
run "cat /apps/vnc/$pid/view" '"sheet":{' "the sheet, open"
echo "!type sekrit9" >&3
sleep 0.4
echo "!key Enter" >&3
heard "auth ok" "the server takes the password (DES, against openssl's)"
sleep 0.6
run "cat /dev/vnc/sessions/$name" '"state":"live"' "live"
tell "fill zrle 5 5 40 30 abcdef"
run "call /apps/vnc/$pid/on/menu \"actual\"" "" "Actual Size"
sleep 0.5
same "after VNC authentication"
grep -rq sekrit9 "$tmp/sd" && bad "the password is on the card" || ok "the password is nowhere on the card"
run "cat /apps/vnc/$pid/view" '"sheet":null' "the sheet gone"
case "$(last)" in *sekrit9*) bad "the password in the view" ;; *) ok "the password not in the view" ;; esac
run "cat /dev/vnc/views/$name" '"host"' "the view node"
case "$(last)" in *sekrit9*) bad "the password in the view node" ;; *) ok "the password not in the driver's view node" ;; esac
run "cat /apps/vnc/connections/$pid" '"host"' "the connection's document"
case "$(last)" in *sekrit9*) bad "the password in the document" ;; *) ok "the password not in the document" ;; esac
grep -q sekrit9 "$out" "$err" && bad "the password in the log" || ok "the password not in the OS's log"

# a wrong password: refused, said
serve c --version 3.8 --security vnc --password right
run "wm run vnc 127.0.0.1:$port" "" "a third, to refuse"
sleep 1
run "ls /dev/vnc/sessions" "vnc-" "sessions"
newest
echo "!type wrong" >&3
sleep 0.3
echo "!key Enter" >&3
heard "auth refused" "the server refuses a wrong one"
sleep 0.6
run "cat /dev/vnc/sessions/$name" '"state":"failed"' "failed"
case "$(last)" in *'refused: Authentication failed'*) ok "with the server's reason" ;; *) bad "no reason" ;; esac

# --- Apple's: RFB 3.889, type 30 (DH, MD5, AES-128), a user and a password
serve d --version 3.889 --security ard --user alice --password "wonder land" --w 240 --h 150
run "wm run vnc 127.0.0.1:$port alice" "" "a Mac's Screen Sharing, as alice"
sleep 1
run "ls /dev/vnc/sessions" "vnc-" "sessions"
newest
pid="@${name#vnc-}"
heard "version RFB 003.008" "3.889 answered as 3.8"
run "cat /dev/vnc/sessions/$name" '"state":"password"' "it waits for alice's password"
echo "!type wonder land" >&3
sleep 0.4
echo "!key Enter" >&3
heard "ard user=alice" "type 30: the user, decrypted by the server (AES-128 through openssl, its key MD5 of the DH secret)"
heard "auth ok" "and the password: taken"
sleep 0.6
run "cat /dev/vnc/sessions/$name" '"state":"live"' "live"
case "$(last)" in *'"mac":true'*) ok "a Mac" ;; *) bad "not a Mac" ;; esac
case "$(last)" in *'"security":"ard"'*) ok "security ard" ;; *) bad "not ard" ;; esac
case "$(last)" in *'"keys":{"alt":"Meta_L","cmd":"Alt_L"}'*|*'"keys":{"cmd":"Alt_L","alt":"Meta_L"}'*) ok "a Mac's keys: cmd Alt_L, option Meta_L" ;; *) bad "a Mac's keys" ;; esac
at=$(size "$log")
hand '!post {"irq": 34, "event": "key", "down": true, "code": 55, "key": "Meta", "text": "", "mods": ["cmd"], "repeat": false}'
hand '!post {"irq": 34, "event": "key", "down": false, "code": 55, "key": "Meta", "text": "", "mods": [], "repeat": false}'
heard "key 1 0xffe9" "cmd to a Mac: Alt_L" "$at"
grep -rq "wonder land" "$tmp/sd" && bad "alice's password is on the card" || ok "alice's password is nowhere on the card"

# --- Remember password: the Mac's keychain (headless keeps one in memory, says each act by its account)
# the sheet's checkbox clicked, found in the window's access tree
remember() {
	from=$(size "$out")
	echo "cat /dev/display/windows/$name" >&3
	waitfor "$out" '"x":' "$from" 50
	geo=$(last | perl -ne '1 while s/(?<=.)\{[^{}]*\}/0/; if (/"x":(-?\d+)/) { my $x = $1; my ($y) = /"y":(-?\d+)/; print "$x $y" }')
	from=$(size "$out")
	echo "cat /dev/display/layers/$name" >&3
	waitfor "$out" '"access"' "$from" 50
	at=$(last | grep '"access"' | python3 -c 'import json, sys
def walk(n):
	for k in n:
		if k.get("role") == "checkbox": return k
		f = walk(k.get("children", []))
		if f: return f
k = walk(json.loads(sys.stdin.readline())["access"])
print(k["x"] + 4, k["y"] + 4)')
	hand "!click $(( ${geo% *} + ${at% *} )) $(( ${geo#* } + ${at#* } ))"
}
serve f --version 3.8 --security vnc --password kept42 --w 120 --h 80
run "wm run vnc 127.0.0.1:$port" "" "a server wanting a password, to remember"
sleep 1
run "ls /dev/vnc/sessions" "vnc-" "sessions"
newest
pid="@${name#vnc-}"
run "cat /dev/vnc/sessions/$name" '"state":"password"' "it waits for a password"
remember
run "cat /apps/vnc/$pid/view" '"remember":true' "Remember password, checked"
echo "!type kept42" >&3
sleep 0.4
at=$(size "$err")
echo "!key Enter" >&3
heard "auth ok" "taken"
if waitfor "$err" "\[keychain\] set 127.0.0.1:$port" "$at" 50; then ok "live: the password kept in the keychain, as 127.0.0.1:$port"; else bad "not kept in the keychain"; fi
run "cat /apps/vnc/connections/$pid" '"remember":true' "the connection remembers"
run "call /apps/vnc/$pid/on/menu \"disconnect\"" "" "Disconnect"
sleep 0.4
at=$(size "$err") seen=$(size "$log")
run "call /apps/vnc/$pid/on/menu \"connect\"" "" "Connect…, no password typed"
hand "!key Enter"
if waitfor "$err" "\[keychain\] get 127.0.0.1:$port (found)" "$at" 50; then ok "the keychain asked first"; else bad "the keychain not asked"; fi
heard "auth ok" "its password taken" "$seen"
sleep 0.4
run "cat /dev/vnc/sessions/$name" '"state":"live"' "live, nothing typed"
run "cat /apps/vnc/$pid/view" '"sheet":null' "and no sheet"
grep -rq kept42 "$tmp/sd" && bad "the kept password on the card" || ok "the kept password nowhere on the card"
grep -q kept42 "$out" "$err" && bad "the kept password in the log" || ok "nor in the OS's log"
# unchecked: asked again, then taken out of the keychain once live
run "call /apps/vnc/$pid/on/menu \"disconnect\"" "" "Disconnect"
sleep 0.4
run "call /apps/vnc/$pid/on/menu \"connect\"" "" "Connect…"
remember
run "cat /apps/vnc/$pid/view" '"remember":false' "Remember password, unchecked"
hand "!key Enter"
sleep 0.6
run "cat /dev/vnc/sessions/$name" '"state":"password"' "the keychain not asked: a password wanted"
echo "!type kept42" >&3
sleep 0.4
at=$(size "$err")
echo "!key Enter" >&3
if waitfor "$err" "\[keychain\] drop 127.0.0.1:$port" "$at" 50; then ok "live: taken out of the keychain"; else bad "not taken out"; fi

# --- RFB 3.3, None
serve e --version 3.3 --security none --w 100 --h 80
run "wm run vnc 127.0.0.1:$port" "" "RFB 3.3"
heard "version RFB 003.003" "3.3 answered as 3.3"
heard "init shared=1" "None, then the init"
sleep 0.6
run "ls /dev/vnc/sessions" "vnc-" "sessions"
newest
run "cat /dev/vnc/sessions/$name" '"state":"live"' "live over 3.3"

echo "!wait 200" >&3
grep -q "AddressSanitizer\|runtime error" "$err" && bad "the sanitizer said something" || true
[ "$failed" = 0 ] && echo "all passed" || echo "$failed failed"
exit "$failed"
