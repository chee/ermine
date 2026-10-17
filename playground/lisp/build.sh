#!/bin/sh
# build/ermine, one executable for every harness, and bin/<suite>, a wrapper per harness
cd "$(dirname "$0")" || exit 1
mkdir -p build; sbcl --noinform --non-interactive --load build.lisp >build/log.txt 2>&1 || { grep -B2 -A8 -m3 -E "error|Unhandled" build/log.txt | head -40; exit 1; }
mkdir -p bin
for s in apply invert squish node update table unread tracker paths scheduler; do
	printf '#!/bin/sh\nexec "$(dirname "$0")/../build/ermine" %s\n' "$s" >"bin/$s"
	chmod +x "bin/$s"
done
