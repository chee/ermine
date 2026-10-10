# jsc.sh: what loaders/deno-js's JavaScriptCore runner (jsc.c) needs of a
# build, sourced by mac/metal/build.sh and test/headless.sh once tree.sh has
# set $repo: the framework, and ../deno/jsc.js, the runner it evaluates,
# bundled again from jsc.ts and what it imports when deno is here and one of
# them is newer. Without deno, jsc.js is used as it is.
#
# Gives: $jsc_libs.
jsc_libs="-framework JavaScriptCore"
jsc_js="$repo/experimental_os/deno/jsc.js"
if command -v deno > /dev/null 2>&1; then
  for f in "$repo/experimental_os/deno/jsc.ts" "$repo/experimental_os/deno/tools.ts" "$repo/experimental_os/deno/readline.ts" "$repo/experimental_os/typescript/blitter.ts"; do
    if [ ! -f "$jsc_js" ] || [ "$f" -nt "$jsc_js" ]; then
      if {
        echo "// jsc.js: made from jsc.ts by c/jsc.sh (deno bundle); not edited by hand."
        (cd "$repo" && deno bundle --quiet --format iife experimental_os/deno/jsc.ts)
      } > "$jsc_js.new"; then
        mv "$jsc_js.new" "$jsc_js"
        echo "bundled $jsc_js" >&2
      else
        rm -f "$jsc_js.new"
        echo "jsc.ts did not bundle: $jsc_js is as it was" >&2
      fi
      break
    fi
  done
fi
