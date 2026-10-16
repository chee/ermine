# catclock

xclock's cat mode (X11, 1988; `COPYING`) in plain C11 with no libc. One source, two hosts: wasm in a
browser's canvas, and natively on ermineOS.

## The C

`catclock.c` is the one file to compile; it includes `colours.h` (the colours), `cat.h` (hands,
tail, eyes), `draw.h` (X11-style lines and polygons on a 150 × 300 window), `maths.h` (sin and cos
by hand) and `bitmaps.h` (made from `xbm/` by `xbm.ts`). It keeps no clock: the host says the time.

```c
uint32_t *cc_init(int w, int h, int format); // the buffer, w × h; NULL if too big (CC_MAX_PIXELS)
void cc_frame(double ms, int tz);            // ms since 1970 UTC, tz minutes east of UTC
```

`format`: `CC_RGBA` (bytes R, G, B, A: a canvas's ImageData) or `CC_XRGB` (words 0x00RRGGBB: an
ermineOS plane). The cat is drawn at the largest whole scale that fits, centred.

## Build and run

- `sh playground/catclock/build.sh`: `web/catclock.wasm`, and one frame natively in
  `build/frame.png`.
- `deno run -A playground/catclock/serve.ts`, then http://localhost:8077: the demo, on ermine's
  programs (`ermine/programs`, `ermine/boxes`). The C nodes are typed (`ermine.type`:
  `public.c-source`, `public.c-header`; the types at `/ermine/types`). `/loaders` holds two
  compilers and canvas, the page's runner (a live function running `canvas.js`'s code on the
  canvas). The compilers: clang (a live function asking serve.ts's `/compile`; `GET /compile` says
  which clang) and wasm-clang (clang and wasm-ld as wasm, `@yowasp/clang`, in the page's worker
  `web/clang.worker.ts`: 105 MB fetched on its first build, then some seconds a build). Both get
  `web/clang.ts`' flags; the map's chain view switches between them. The cat runs in a box made from
  `/catclock`, `/loaders` and `/ermine/types` boxed in: `satisfy` finds catclock.c → compiler →
  canvas, one way per compiler, and `start` starts him on the picked one at `/clock` in the box, his
  build through build.ts' cache at `/cache`, and a save stops him and starts him again. The build is
  steps, each kept in `/cache` by its key: every `.c` beside catclock.c compiled into its `.o` (with
  what clang said), then the objects linked into the `.wasm`. A C file's step takes its unit
  (`web/program.ts`): it and the headers it `#include`s, comments blanked, lines and columns kept,
  so a comment edited in place, an edit undone, or a header it doesn't include is a cache hit. The
  link's key names each object by its hash, so C that compiles to the same `.o` links as a hit. The
  objects go over the wire gzipped: the cat's `.o` is 8.7 MB, nearly all its zeroed pixel buffers
  (the wasm, 26 KB). The map shows the graph (the cache's hits and misses) or the chain (satisfy's
  chain and why, the compilers, the box). With autosave on, each keystroke is a start, cancelling
  the build before. `/clock.html` is the clock alone, with `web/canvas.js`.
- the demos site (`playground/demos`, `deno task dev` at http://localhost:8040/catclock/, and its
  static build): the same page. In dev, wasm-clang is its one compiler. On Netlify, also
  netlify-clang: `functions/compile.mts` at `/catclock/compile` (`netlify.toml`), the same build as
  the worker (`web/yowasp.ts`) in a Netlify Function, so its identity is wasm-clang's and the two
  share every cache key.
- ermineOS: its own cat clock, `playground/experimental_os/newos/programs/catclock/catclock.c`, a
  program exec runs, built by `sh playground/experimental_os/newos/build.sh`; then Applications →
  Cat Clock.
