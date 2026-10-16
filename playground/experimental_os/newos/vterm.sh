# vterm.sh: what ermineOS's builds take of libvterm (drv_pty.c's terminals),
# sourced by test/sources.sh (build.sh, test/headless.sh) after $mac is set.
# ../vterm/build.sh fetches and builds it into $mac/build/vterm, once.
#
# Gives: $vt_cflags (for the C), $vt_libs (to link).

vt="$mac/build/vterm"
if [ ! -f "$vt/lib/libvterm.a" ]; then
  echo "building libvterm into $vt" >&2
  sh "$mac/../vterm/build.sh" >&2
fi
vt_cflags="-I$vt/include"
vt_libs="$vt/lib/libvterm.a"
