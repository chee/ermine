# tree.sh: what ermineOS's builds compile, staged in one tree, sourced by
# mac/metal/build.sh and test/headless.sh once they have set $mac (the mac
# folder). The OS keeps its own copy of the old core and layers
# (experimental_os/core, experimental_os/layers); the layers ermineOS links
# (cache, link, subduction), that core and its own C are staged as they are
# now, so every relative include (../core, ../../core) finds that core.
# The tree is $mac/build/tree.
#
# Gives: $tree, the root of the copy, laid out as the repository is, and
# $core_sources, the core C it links.

repo="$(cd "$mac/../.." && pwd)"
tree="$mac/build/tree"
os="$tree/experimental_os"
mkdir -p "$os/core"
rsync -a --delete --exclude '*_test' --exclude '*.dSYM' --exclude scratch "$repo/experimental_os/core/" "$os/core/"
for d in cache/c link/c subduction/c; do
  mkdir -p "$os/layers/$d"
  rsync -a --delete --exclude target --exclude build --exclude lib "$repo/experimental_os/layers/$d/" "$os/layers/$d/"
done
mkdir -p "$os/c"
rsync -a --delete "$repo/experimental_os/c/" "$os/c/"

# core's C, as the staged core has it
core_sources=""
for f in graph/c/json.c graph/c/cbor.c graph/c/ermine.c graph/c/graph.c graph/c/library.c graph/c/entry.c \
  protect/c/protect.c scheduler/c/schedule.c scheduler/c/steps.c; do
  [ -f "$os/core/$f" ] && core_sources="$core_sources $os/core/$f"
done
