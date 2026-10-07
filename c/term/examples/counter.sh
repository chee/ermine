#!/bin/sh
# counter.sh: an ermine program in POSIX sh that reacts to keys. It
# subscribes to its window's keys and size nodes, takes what arrived with
# events ten times a second, and draws its count into its screen node.
#   + or up: one more    - or down: one less    0: back to 0    q: quit
# It shows who typed the last key: "here", or the peer key a link's owner
# stamped on it (a key typed in a terminal that mounted this one).

seq=0
count=0
last=
by=

ask() {
	seq=$((seq + 1))
	printf '{"seq":%d,%s}\n' "$seq" "$1"
	IFS= read -r answer || exit 0
}

size() {
	ask '"cmd":"read","address":["size"]'
	rest=${answer#*\"rows\":}
	rows=${rest%%[!0-9]*}
	rest=${answer#*\"cols\":}
	cols=${rest%%[!0-9]*}
	[ -n "$rows" ] || rows=24
	[ -n "$cols" ] || cols=80
}

draw() {
	ask "\"cmd\":\"write\",\"address\":[\"screen\"],\"patches\":[{\"type\":\"snapshot\",\"value\":{\"rows\":$rows,\"cols\":$cols,\"lines\":[\"\",\"  count: $count\",\"\",\"  last key: $last\",\"  by: $by\",\"\",\"  + or up: more   - or down: less   0: reset   q: quit\"],\"styles\":[[],[[2,{\"bold\":true,\"fg\":2}]],[],[],[],[],[[2,{\"reverse\":true}],[53,{}]]]}}]"
}

ask '"cmd":"subscribe","address":["keys"]'
ask '"cmd":"subscribe","address":["size"]'
size
draw
while :; do
	ask '"cmd":"events","sub":1'
	rest=$answer
	changed=
	while :; do
		case $rest in
		*'"type":"snapshot","value":"'*) ;;
		*) break ;;
		esac
		rest=${rest#*\"type\":\"snapshot\",\"value\":\"}
		key=${rest%%\"*}
		last=$key
		changed=1
		case $key in
		+ | up) count=$((count + 1)) ;;
		- | down) count=$((count - 1)) ;;
		0) count=0 ;;
		q) exit 0 ;;
		esac
	done
	if [ -n "$changed" ]; then
		case $answer in
		*'"peer":"'*)
			rest=${answer##*\"peer\":\"}
			by="peer $(printf '%.16s' "$rest")..."
			;;
		*) by=here ;;
		esac
	fi
	ask '"cmd":"events","sub":2'
	case $answer in
	*'"change"'*) size; changed=1 ;;
	esac
	[ -z "$changed" ] || draw
	sleep 0.1
done
