#!/bin/sh
# build.sh: Wayland for ermineOS on this Mac (NOTES.md). Fetches the sources
# into src/ (checked by sha256), patches libwayland for Darwin
# (patches/*.patch), and builds, all into ../mac/build/wayland:
#   lib/libepoll-shim.a        epoll(7) on kqueue, static (libwayland's event loop)
#   lib/libwayland-*.a, .dylib libwayland, patched; libffi is the system's
#   bin/wayland-scanner
#   gen/                       xdg-shell's server and client code, the keymap as C
#   lib/libway.a               the compositor (way.c), with xdg-shell and the keymap
#   bin/weston-simple-shm      weston's simple-shm, unchanged, for macOS
#   bin/way_probe              test/probe.c, a client that reports what it is sent
#   bin/way_fill               test/fill.c, a client that draws every frame, for measuring
#   bin/way_test               test/way_test.c, the headless test
# Then runs libwayland's own tests (meson test) unless NOTEST=1.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
build="$(cd "$here/.." && pwd)/mac/build/wayland"
src="$here/src"
sdk="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
for tool in meson ninja cmake pkg-config; do
	command -v "$tool" >/dev/null || { echo "build.sh: needs $tool (brew install meson ninja cmake pkgconf)" >&2; exit 1; }
done
mkdir -p "$src" "$build/gen" "$build/bin" "$build/lib" "$build/pc"

fetch() { # url, file, sha256
	if [ ! -f "$src/$2" ]; then curl -sSfL "$1" -o "$src/$2.part" && mv "$src/$2.part" "$src/$2"; fi
	echo "$3  $src/$2" | shasum -a 256 -c - >/dev/null || { echo "build.sh: $2: wrong sha256" >&2; exit 1; }
}
fetch https://gitlab.freedesktop.org/wayland/wayland/-/releases/1.26.0/downloads/wayland-1.26.0.tar.xz \
	wayland-1.26.0.tar.xz 64176eaa46e4969903e286f8e5ef8331affc17fdf03ac9b58381d2b23162b7a3
fetch https://gitlab.freedesktop.org/wayland/wayland-protocols/-/releases/1.49/downloads/wayland-protocols-1.49.tar.xz \
	wayland-protocols-1.49.tar.xz ec4c8f74942d6dff7ace8b4ce4764f0ef9ff618a935d974ea77edee2ad240b14
fetch https://github.com/jiixyj/epoll-shim/archive/refs/tags/v0.0.20240608.tar.gz \
	epoll-shim-0.0.20240608.tar.gz 8f5125217e4a0eeb96ab01f9dfd56c38f85ac3e8f26ef2578e538e72e87862cb
fetch https://gitlab.freedesktop.org/wayland/weston/-/releases/14.0.2/downloads/weston-14.0.2.tar.xz \
	weston-14.0.2.tar.xz b47216b3530da76d02a3a1acbf1846a9cd41d24caa86448f9c46f78f20b6e0ac

# each tree extracted afresh when its patch (or none) is newer than the tree
unpack() { # tarball, dir, patch or ""
	if [ ! -f "$src/$2/.unpacked" ] || { [ -n "$3" ] && [ "$3" -nt "$src/$2/.unpacked" ]; }; then
		rm -rf "${src:?}/$2"
		tar -xf "$src/$1" -C "$src"
		if [ -n "$3" ]; then patch -s -p1 -d "$src/$2" < "$3"; fi
		touch "$src/$2/.unpacked"
	fi
}
unpack wayland-1.26.0.tar.xz wayland-1.26.0 "$here/patches/wayland-1.26.0-darwin.patch"
unpack wayland-protocols-1.49.tar.xz wayland-protocols-1.49 ""
unpack epoll-shim-0.0.20240608.tar.gz epoll-shim-0.0.20240608 ""
unpack weston-14.0.2.tar.xz weston-14.0.2 ""

# epoll-shim, static
if [ ! -f "$build/lib/libepoll-shim.a" ]; then
	cmake -S "$src/epoll-shim-0.0.20240608" -B "$build/epoll-shim-obj" -DCMAKE_BUILD_TYPE=RelWithDebInfo \
		-DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX="$build" -Wno-dev >/dev/null 2>&1
	cmake --build "$build/epoll-shim-obj" >/dev/null 2>&1
	cmake --install "$build/epoll-shim-obj" >/dev/null
fi
# what meson finds them by: this epoll-shim, and the system's libffi
cat > "$build/pc/epoll-shim.pc" <<EOF
Name: epoll-shim
Description: epoll on kqueue (static, ermineOS's build)
Version: 0.0.20240608
Libs: -L$build/lib -lepoll-shim
Cflags: -I$build/include/libepoll-shim
EOF
cat > "$build/pc/libffi.pc" <<EOF
Name: libffi
Description: the system's libffi
Version: 3.4
Libs: -lffi
Cflags: -I$sdk/usr/include/ffi
EOF

# libwayland
export PKG_CONFIG_PATH="$build/pc:/opt/homebrew/opt/expat/lib/pkgconfig:/opt/homebrew/opt/libxml2/lib/pkgconfig"
if [ ! -f "$build/obj/build.ninja" ]; then
	meson setup "$build/obj" "$src/wayland-1.26.0" -Ddocumentation=false -Dtests=true \
		-Ddefault_library=both --prefix="$build" --libdir=lib >/dev/null
fi
ninja -C "$build/obj" >/dev/null
meson install -C "$build/obj" --no-rebuild >/dev/null
if [ -z "$NOTEST" ]; then meson test -C "$build/obj" --no-rebuild -q; fi

# protocols and keymap
scanner="$build/bin/wayland-scanner"
xdg="$src/wayland-protocols-1.49/stable/xdg-shell/xdg-shell.xml"
"$scanner" server-header "$xdg" "$build/gen/xdg-shell-server-protocol.h"
"$scanner" client-header "$xdg" "$build/gen/xdg-shell-client-protocol.h"
"$scanner" private-code "$xdg" "$build/gen/xdg-shell-protocol.c"
{
	echo "// made by build.sh from keymap/us.xkb (xkbcli compile-keymap --layout us --model pc105)"
	printf 'const char way_keymap[] =\n'
	sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/\\n"/' "$here/keymap/us.xkb"
	printf ';\nconst unsigned way_keymap_size = sizeof way_keymap;\n'
} > "$build/gen/keymap.c"

cflags="-std=c11 -Wall -Wextra -Werror -Wno-unused-parameter -O2 -g -I$build/include -I$build/gen -I$here"
static_server="$build/lib/libwayland-server.a $build/lib/libepoll-shim.a -lffi -lm"
static_client="$build/lib/libwayland-client.a $build/lib/libepoll-shim.a -lffi -lm"

# the compositor
# shellcheck disable=SC2086
cc $cflags -c "$here/way.c" -o "$build/gen/way.o"
# shellcheck disable=SC2086
cc $cflags -Wno-overlength-strings -c "$build/gen/keymap.c" -o "$build/gen/keymap.o"
# shellcheck disable=SC2086
cc -O2 -I$build/include -c "$build/gen/xdg-shell-protocol.c" -o "$build/gen/xdg-shell-protocol.o"
rm -f "$build/lib/libway.a"
ar rcs "$build/lib/libway.a" "$build/gen/way.o" "$build/gen/keymap.o" "$build/gen/xdg-shell-protocol.o"

# weston's simple-shm, its sources unchanged (clients/compat: linux/input.h and config.h)
weston="$src/weston-14.0.2"
# shellcheck disable=SC2086
cc -O2 -g -I"$here/clients/compat" -I"$weston" -I"$weston/include" -I"$build/gen" -I"$build/include" \
	-I"$build/include/libepoll-shim" \
	-o "$build/bin/weston-simple-shm" "$weston/clients/simple-shm.c" "$weston/shared/os-compatibility.c" \
	"$build/gen/xdg-shell-protocol.c" $static_client

# the probe and the test
# shellcheck disable=SC2086
cc $cflags -o "$build/bin/way_probe" "$here/test/probe.c" "$build/gen/xdg-shell-protocol.c" $static_client
# shellcheck disable=SC2086
cc $cflags -o "$build/bin/way_fill" "$here/test/fill.c" "$build/gen/xdg-shell-protocol.c" $static_client
# shellcheck disable=SC2086
cc $cflags -o "$build/bin/way_test" "$here/test/way_test.c" "$build/lib/libway.a" $static_server
echo "built $build/bin/way_test, $build/bin/weston-simple-shm, $build/bin/way_probe, $build/bin/way_fill, $build/lib/libway.a"
