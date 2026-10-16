# wayland.sh: what ermineOS's builds take of the Wayland compositor
# (../wayland/NOTES.md), sourced by test/sources.sh (build.sh,
# test/headless.sh) after $mac is set. ../wayland/build.sh fetches and builds
# libwayland, patched for Darwin, and the compositor (libway.a) into
# $mac/build/wayland, once; drv_wayland.c links them.
#
# Gives: $way_cflags (for the C), $way_libs (to link).

wayland="$(cd "$mac/../wayland" && pwd)"
way="$mac/build/wayland"
if [ ! -f "$way/lib/libway.a" ]; then
  echo "building libwayland and the compositor into $way" >&2
  NOTEST=1 sh "$wayland/build.sh" >&2
fi
way_cflags="-I$wayland -I$way/include -I$way/gen"
way_libs="$way/lib/libway.a $way/lib/libwayland-server.a $way/lib/libepoll-shim.a -lffi"
