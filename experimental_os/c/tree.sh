# tree.sh: what ermineOS's builds compile, staged in one tree, sourced by
# mac/metal/build.sh and test/headless.sh once they have set $mac (the mac
# folder). core/ is taken as committed (git HEAD), never the working tree:
# core changes through its own careful process, and is often half-way through
# a change there. ERMINE_CORE_WORKING=1 takes core as it is now instead, to
# try the OS against a core change before it is committed. Beside it go the
# layers ermineOS links (cache, link, subduction) and its own C, as they are
# now, so every relative include (../../core, ../../../core) finds that core.
# The tree is $mac/build/tree; committed core is taken again only when HEAD
# moves.
#
# Gives: $tree, the root of the copy, laid out as the repository is, and
# $core_sources, the core C it links.

repo="$(cd "$mac/../.." && pwd)"
tree="$mac/build/tree"
head="$(git -C "$repo" rev-parse HEAD)"
mkdir -p "$tree"
if [ -n "$ERMINE_CORE_WORKING" ]; then
  # core as it is now, for trying a change to core's API before it is committed
  rm -rf "$tree/core" "$tree/.core"
  mkdir -p "$tree/core"
  rsync -a --exclude '*_test' --exclude '*.dSYM' --exclude scratch "$repo/core/" "$tree/core/"
  echo "building with core as it is now (ERMINE_CORE_WORKING)" >&2
elif [ "$(cat "$tree/.core" 2>/dev/null)" != "$head" ]; then
  rm -rf "$tree/core"
  git -C "$repo" archive "$head" core | tar -x -C "$tree"
  echo "$head" > "$tree/.core"
fi
if [ -z "$ERMINE_CORE_WORKING" ] && ! git -C "$repo" diff --quiet HEAD -- core; then
  echo "core has changes not committed: building with core as committed ($(echo "$head" | cut -c1-8))" >&2
fi
for d in cache/c link/c subduction/c; do
  mkdir -p "$tree/layers/$d"
  rsync -a --delete --exclude target --exclude build --exclude lib "$repo/layers/$d/" "$tree/layers/$d/"
done
mkdir -p "$tree/experimental_os/c"
rsync -a --delete "$repo/experimental_os/c/" "$tree/experimental_os/c/"

# core's C, as the staged core has it: library.c is there only once core's
# lookup change is (or, with ERMINE_CORE_WORKING, while it is being made)
core_sources=""
for f in graph/c/json.c graph/c/cbor.c graph/c/ermine.c graph/c/graph.c graph/c/library.c graph/c/entry.c \
  protect/c/protect.c scheduler/c/schedule.c scheduler/c/steps.c; do
  [ -f "$tree/core/$f" ] && core_sources="$core_sources $tree/core/$f"
done
