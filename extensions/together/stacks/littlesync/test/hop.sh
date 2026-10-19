#!/bin/sh
# three littlesync-pigs in a line over two pty pairs, a - b - c: b opens both (two --port, two links)
# and relays. a adds a pig, c sees it; c moves the first pig (d3b58353), a sees it moved; a carries
# its pig, c sees it held; each sees the others' pointers (presence rows, b relaying). Screens in build/hop/*.txt, protocol events in build/hop/*.log.
# Usage: sh test/hop.sh build/littlesync-pigs
pigs=${1:-build/littlesync-pigs}
d=build/hop
rm -rf $d && mkdir -p $d
failed=0
check() { # file pattern what
	if grep -q "$2" "$1"; then echo "  ok   $3"; else echo "  FAIL $3 ($1 lacks: $2)"; failed=1; fi
}
wait_for() { n=0; while [ ! -s "$1" ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n+1)); done; }
echo "three littlesync-pigs over two pty pairs, a - b - c"
# a: adds a pig at 0.7 s (it is selected), waits, picks it up at about 6.3 s, carries it, drops it at
# about 10.8 s. c: picks up the first pig at about 3.2 s, carries it right 8 steps (0.16), drops it
$pigs --pty --pty-file $d/ab --state $d/a --name otter --dump $d/a.txt --log $d/a.log \
	--keys "a........... lll........ " --exit-after 13000 2>/dev/null &
a=$!
$pigs --pty --pty-file $d/bc --state $d/c --name wren --dump $d/c.txt --log $d/c.log \
	--keys "..... llllllll " --exit-after 13000 2>/dev/null &
c=$!
wait_for $d/ab
wait_for $d/bc
$pigs --port "$(cat $d/ab)" --port "$(cat $d/bc)" --state $d/b --name newt --dump $d/b.txt --log $d/b.log \
	--exit-after 12500 2>/dev/null &
b=$!
sleep 2.5
cp $d/a.txt $d/a-before.txt
sleep 6
cp $d/c.txt $d/c-mid.txt
wait $a $b $c
check $d/b.txt "peers up,up" "b has two links up"
check $d/c.txt "pigs 2" "c has the pig a added (through b)"
grep "d3b58353 x=0.50" $d/a-before.txt >/dev/null && echo "  ok   a had the first pig at 0.50 before" ||
	{ echo "  FAIL a-before lacks d3b58353 at 0.50"; failed=1; }
check $d/a.txt "d3b58353 x=0.66" "a sees the first pig where c moved it"
check $d/c-mid.txt "held by otter" "c sees a's pig held while a carries it"
check $d/c-mid.txt "^@ otter x=" "c sees a's pointer (its presence row, through b)"
check $d/c-mid.txt "^@ newt x=0.50 y=0.50" "c sees b's pointer"
check $d/a.txt "^@ wren x=0.66" "a sees c's pointer where c left it"
! grep -q "held by" $d/c.txt && echo "  ok   c sees it put down" || { echo "  FAIL c still shows it held"; failed=1; }
la=$(grep '^[ab] [0-9a-f]\{8\} ' $d/a.txt | cut -d' ' -f1-4 | sort); lc=$(grep '^[ab] [0-9a-f]\{8\} ' $d/c.txt | cut -d' ' -f1-4 | sort)
[ -n "$la" ] && [ "$la" = "$lc" ] && echo "  ok   a and c list the same pigs at the same places" ||
	{ echo "  FAIL a and c differ"; echo "$la"; echo "$lc"; failed=1; }
grep -q "rx commits" $d/c.log && ! grep -q "rx bad seal" $d/c.log && echo "  ok   c took commits in, no bad seals" ||
	{ echo "  FAIL c took no commits or had bad seals"; failed=1; }
grep "^[ab] [0-9a-f]\{8\} \|^room " $d/c.txt
exit $failed
