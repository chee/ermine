#!/bin/sh
# two littlesync-pigs over the gateway's HTTP sessions (http.h, gateway/http.ts): the gateway on a
# local port, a and c each --http to it. a adds a pig, c sees it; c adds one and moves it, a sees it
# moved; a carries its pig, c sees it held. No server by default (UPSTREAM a closed port: the
# gateway relays between its links, holding acks); a second argument is a server (wss://galaxy.observer:
# the pig room as it is there, so no pig count is checked). Screens in build/http/*.txt, protocol
# events in build/http/*.log, the gateway's in build/http/gateway.log.
# Usage: sh test/http.sh build/littlesync-pigs [UPSTREAM]
pigs=${1:-build/littlesync-pigs}
upstream=${2:-ws://127.0.0.1:9}
d=build/http
rm -rf $d && mkdir -p $d
failed=0
check() { # file pattern what
	if grep -q "$2" "$1"; then echo "  ok   $3"; else echo "  FAIL $3 ($1 lacks: $2)"; failed=1; fi
}
port=$((20000 + $$ % 20000))
echo "two littlesync-pigs over HTTP to a gateway on $port (upstream $upstream)"
PORT=$port UPSTREAM=$upstream deno run --allow-net --allow-env --allow-read gateway/main.ts >$d/gateway.log 2>&1 &
g=$!
trap 'kill $g 2>/dev/null' EXIT
n=0; while ! grep -q listening $d/gateway.log && [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done
grep -q listening $d/gateway.log || { echo "  FAIL the gateway did not start"; cat $d/gateway.log; exit 1; }
# a: adds a pig at 0.7 s, picks it up at about 6.3 s, carries it, drops it at about 10.8 s. c: picks up
# adds a pig at once, picks it up at about 4.7 s, carries it right 8 steps (0.16), drops it
$pigs --http http://127.0.0.1:$port --state $d/a --name otter --dump $d/a.txt --log $d/a.log \
	--keys "a........... lll........ " --exit-after 15000 </dev/null >/dev/null 2>&1 &
a=$!
$pigs --http http://127.0.0.1:$port --state $d/c --name wren --dump $d/c.txt --log $d/c.log \
	--keys "a......... llllllll " --exit-after 15000 </dev/null >/dev/null 2>&1 &
c=$!
sleep 2.5
cp $d/a.txt $d/a-before.txt
sleep 6
cp $d/c.txt $d/c-mid.txt
wait $a $c
check $d/a.txt "peer up" "a's link to the gateway is up"
check $d/c.txt "peer up" "c's link to the gateway is up"
[ "$upstream" = ws://127.0.0.1:9 ] && check $d/c.txt "pigs 2" "c has the pig a added, and its own"
# c's pig: the one its log says it added
cid=$(grep ' add ermine:' $d/c.log | head -1 | sed 's/.*ermine:....\(........\).*/\1/')
before=$(grep "^. $cid " $d/a-before.txt | cut -d' ' -f3)
after=$(grep "^. $cid " $d/a.txt | cut -d' ' -f3)
[ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ] && echo "  ok   a sees c's pig moved ($before to $after)" ||
	{ echo "  FAIL a does not see c's pig moved ($cid: $before, $after)"; failed=1; }
check $d/c-mid.txt "held by otter" "c sees a's pig held while a carries it"
! grep -q "held by" $d/c.txt && echo "  ok   c sees it put down" || { echo "  FAIL c still shows it held"; failed=1; }
la=$(grep '^[a-z] [0-9a-f]\{8\} ' $d/a.txt | cut -d' ' -f1-4 | sort); lc=$(grep '^[a-z] [0-9a-f]\{8\} ' $d/c.txt | cut -d' ' -f1-4 | sort)
[ -n "$la" ] && [ "$la" = "$lc" ] && echo "  ok   a and c list the same pigs at the same places" ||
	{ echo "  FAIL a and c differ"; echo "$la"; echo "$lc"; failed=1; }
grep -q "rx commits" $d/c.log && ! grep -q "rx bad seal" $d/c.log && echo "  ok   c took commits in, no bad seals" ||
	{ echo "  FAIL c took no commits or had bad seals"; failed=1; }
grep "http .* open" $d/gateway.log | head -2
grep "^[a-z] [0-9a-f]\{8\} \|^room " $d/c.txt
exit $failed
