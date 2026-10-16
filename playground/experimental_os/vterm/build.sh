#!/bin/sh
# build.sh: libvterm for ermineOS (drv_pty.c's terminals: the screen each
# session keeps, and the keyboard's and mouse's bytes). libvterm is Paul
# Evans's, MIT, the library behind Emacs's vterm and Neovim's terminal
# (https://www.leonerd.org.uk/code/libvterm/). Fetches the release into src/
# (checked by sha256, the one Neovim's build pins too), and builds it, its
# sources unchanged, into ../mac/build/vterm:
#   lib/libvterm.a     static
#   include/vterm.h, vterm_keycodes.h
# Then runs its own tests (t/run-test.pl) if perl is here, unless NOTEST=1.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
build="$(cd "$here/.." && pwd)/mac/build/vterm"
src="$here/src"
version=0.3.3
mkdir -p "$src" "$build/lib" "$build/include" "$build/obj"

fetch() { # url, file, sha256
	if [ ! -f "$src/$2" ]; then curl -sSfL "$1" -o "$src/$2.part" && mv "$src/$2.part" "$src/$2"; fi
	echo "$3  $src/$2" | shasum -a 256 -c - >/dev/null || { echo "build.sh: $2: wrong sha256" >&2; exit 1; }
}
fetch "https://www.leonerd.org.uk/code/libvterm/libvterm-$version.tar.gz" \
	"libvterm-$version.tar.gz" 09156f43dd2128bd347cbeebe50d9a571d32c64e0cf18d211197946aff7226e0

tree="$src/libvterm-$version"
if [ ! -f "$tree/.unpacked" ]; then
	rm -rf "$tree"
	tar -xzf "$src/libvterm-$version.tar.gz" -C "$src"
	touch "$tree/.unpacked"
fi

# its Makefile wants libtool; the sources are plain C99, so each is compiled here
rm -f "$build"/obj/*.o
for f in "$tree"/src/*.c; do
	cc -std=c99 -O2 -g -Wall -mmacosx-version-min=14.0 -I"$tree/include" -c "$f" -o "$build/obj/$(basename "$f" .c).o"
done
rm -f "$build/lib/libvterm.a"
ar rcs "$build/lib/libvterm.a" "$build"/obj/*.o
cp "$tree/include/vterm.h" "$tree/include/vterm_keycodes.h" "$build/include/"

if [ -z "$NOTEST" ] && command -v perl >/dev/null; then
	# its test harness, against this build
	cc -std=c99 -O2 -I"$tree/include" -o "$build/obj/harness" "$tree/t/harness.c" "$build/lib/libvterm.a"
	failed=""
	for t in "$tree"/t/[0-9]*.test; do
		(cd "$tree" && perl t/run-test.pl -e "$build/obj/harness" "t/$(basename "$t")") >/dev/null 2>&1 || failed="$failed $(basename "$t")"
	done
	if [ -n "$failed" ]; then echo "build.sh: libvterm's tests failed:$failed" >&2; exit 1; fi
fi
echo "built $build/lib/libvterm.a"
