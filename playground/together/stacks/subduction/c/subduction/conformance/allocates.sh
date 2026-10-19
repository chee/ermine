#!/bin/sh
# allocates.sh: the portable C allocates through platform.h's hooks only
# (erm_host_malloc, _realloc, _free), never C's own, so a board's heap is
# the one used: no malloc, calloc, realloc or free left undefined in its
# objects.
set -e
cc=${CC:-cc}
status=0
for f in websocket.c store_memory.c; do
	"$cc" -std=c11 -c "../$f" -I.. -o "/tmp/erm-allocates-$$.o"
	used=$(nm -u "/tmp/erm-allocates-$$.o" | sed 's/^ *U //; s/^_//' | grep -E '^(malloc|calloc|realloc|free)$' || true)
	rm -f "/tmp/erm-allocates-$$.o"
	if [ -n "$used" ]; then
		echo "allocates: $f calls C's own $(echo $used)" >&2
		status=1
	fi
done
[ $status = 0 ] && echo "allocates: only platform.h's hooks"
exit $status
