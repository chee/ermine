#!/bin/sh
# two littlesync-pigs over a pty pair, one scripted scenario: a adds a pig; b sees it, picks it up and
# carries it (a sees it held), drops it (a sees it where it was dropped). Screens in build/pty/*.txt,
# protocol events in build/pty/*.log. Usage: sh test/pty.sh build/littlesync-pigs
pigs=${1:-build/littlesync-pigs}
d=build/pty
rm -rf $d && mkdir -p $d
failed=0
check() { # file pattern what
	if grep -q "$2" "$1"; then echo "  ok   $3"; else echo "  FAIL $3 ($1 lacks: $2)"; failed=1; fi
}
echo "two littlesync-pigs over a pty pair"
# a makes the pty and adds a pig at 0.7 s; b connects to it, selects the new pig (tab), carries it
$pigs --pty --pty-file $d/pty --state $d/a --name otter --dump $d/a.txt --log $d/a.log --keys "a......" --exit-after 7000 2>/dev/null &
a=$!
n=0; while [ ! -s $d/pty ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n+1)); done
slave=$(cat $d/pty)
$pigs --port $slave --state $d/b --name newt --dump $d/b.txt --log $d/b.log --keys "...." --exit-after 7000 2>/dev/null &
b=$!
wait $a $b
check $d/a.txt "pigs 2" "a has two pigs"
check $d/b.txt "pigs 2" "b has two pigs (the one a added)"
check $d/a.txt "peer up" "a sees the peer up"
check $d/b.txt "peer up" "b sees the peer up"
grep -c "rx commits" $d/b.log | grep -qv '^0' && echo "  ok   b took commits in" || { echo "  FAIL b took no commits"; failed=1; }
# the same letters and places on both
la=$(grep '^[ab] ermine' $d/a.txt | sort); lb=$(grep '^[ab] ermine' $d/b.txt | sort)
[ "$la" = "$lb" ] && echo "  ok   both list the same pigs at the same places" || { echo "  FAIL pig lists differ"; echo "$la"; echo "$lb"; failed=1; }

# second scenario: b picks up the first pig, carries it right, a sees it held, then b drops it
rm -rf $d/pty
$pigs --pty --pty-file $d/pty --state $d/a --name otter --dump $d/a2.txt --log $d/a2.log --exit-after 7500 2>/dev/null &
a=$!
n=0; while [ ! -s $d/pty ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n+1)); done
slave=$(cat $d/pty)
$pigs --port $slave --state $d/b --name newt --dump $d/b2.txt --log $d/b2.log --keys ".. llllllllll..... " --exit-after 7500 2>/dev/null &
b=$!
sleep 4
cp $d/a2.txt $d/a2-mid.txt
wait $a $b
check $d/a2-mid.txt "held by newt" "a sees a pig held by b while b carries it"
check $d/b2.txt "carrying -" "b let go"
! grep -q "held by" $d/a2.txt && echo "  ok   a sees it put down (no longer held)" || { echo "  FAIL a still shows it held"; failed=1; }
grep "^[ab] ermine" $d/a2.txt | head -3
exit $failed
