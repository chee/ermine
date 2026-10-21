#!/bin/sh
# two littlesync-pigs over HTTP sessions to the deployed gateway (https://galaxy.observer/littlesync/,
# Railway; https through libcurl, http_posix.c), in a fresh room each run (no pigs in it). a adds a pig, picks it up, carries it, drops it; c
# adds one. Both see the other's pig, c sees a's held while carried, both list the same pigs at the same
# places. Not in make test (the network): make galaxy. Screens in build/galaxy/*.txt, protocol events in
# build/galaxy/*.log.
# Usage: sh test/galaxy.sh build/littlesync-pigs [URL]
pigs=${1:-build/littlesync-pigs}
url=${2:-https://galaxy.observer}
d=build/galaxy
rm -rf $d && mkdir -p $d
failed=0
check() { # file pattern what
	if grep -q "$2" "$1"; then echo "  ok   $3"; else echo "  FAIL $3 ($1 lacks: $2)"; failed=1; fi
}
room=ermine:0010$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
echo "two littlesync-pigs over $url, room ${room#ermine:0010}"
# a: adds a pig at 0.7 s, picks it up at about 6 s, carries it, drops it at about 10.5 s. c: adds one at 2.7 s
$pigs --http $url --room $room --state $d/a --name otter --dump $d/a.txt --log $d/a.log \
	--keys "a.......... lll........ " --exit-after 20000 </dev/null >/dev/null 2>&1 &
a=$!
$pigs --http $url --room $room --state $d/c --name wren --dump $d/c.txt --log $d/c.log \
	--keys ".....a" --exit-after 20000 </dev/null >/dev/null 2>&1 &
c=$!
sleep 8.5
cp $d/c.txt $d/c-mid.txt
wait $a $c
check $d/a.txt "peer up" "a's link to the gateway is up"
check $d/c.txt "peer up" "c's link to the gateway is up"
check $d/a.txt "pigs 2" "a has its pig and c's"
check $d/c.txt "pigs 2" "c has its pig and a's"
check $d/c-mid.txt "held by otter" "c sees a's pig held while a carries it"
! grep -q "held by" $d/c.txt && echo "  ok   c sees it put down" || { echo "  FAIL c still shows it held"; failed=1; }
la=$(grep '^[a-z] [0-9a-f]\{8\} ' $d/a.txt | cut -d' ' -f1-4 | sort)
lc=$(grep '^[a-z] [0-9a-f]\{8\} ' $d/c.txt | cut -d' ' -f1-4 | sort)
[ -n "$la" ] && [ "$la" = "$lc" ] && echo "  ok   a and c list the same pigs at the same places" ||
	{ echo "  FAIL a and c differ"; echo "$la"; echo "$lc"; failed=1; }
grep -q "rx commits" $d/c.log && ! grep -q "rx bad seal" $d/c.log && echo "  ok   c took commits in, no bad seals" ||
	{ echo "  FAIL c took no commits or had bad seals"; failed=1; }
grep "^[a-z] [0-9a-f]\{8\} \|^room \|http" $d/c.txt
exit $failed
