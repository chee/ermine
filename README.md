# ermine

A graph of named nodes that remembers how, why and who. Any node can be given
a program and is then a process, placed in the tree like anything else.
Resolution looks around and then up the path the process came by, like
`node_modules`. A node may be mounted at several places. Reads are lists:
none, one, or several. Nothing happens silently, and every entry has a
shareable part a sync layer can carry.

This is a Deno workspace. `core/` is the graph; the other directories are the
layers to be built on it, empty for now. `TODO.md` says what each will be and
what is still open about it.

```
core/docs/design.tex       the design: what the core is and must guarantee
core/docs/protocol.tex     how an implementation is checked
core/conformance/          the suite: scenarios.py writes scenarios/*.json; run.mjs plays them
core/fuzz/                 random sessions with invariants, against one implementation or several at once
core/bench/                how fast and how big the TypeScript core is: its shapes, the reactivity workloads, variants
core/haskell/ermine.hs     the executable specification; passes the whole suite
core/c/, core/zig/         the ports that measure whether the core is small enough; both pass the suite
core/ts/                   the TypeScript core, written by hand (@chee/ermine)
docs/common.tex            the LaTeX preamble every document shares
TODO.md                    the layers: one section each, what is decided and what is open
demos/core-web/            a canvas for the core: nodes, placements, processes, every method of the library
```

```
deno task lint              check the scenario files, no driver needed
deno task conformance ts    run the suite against an implementation (ts, haskell, c, zig)
deno task fuzz ts c         random sessions; with several implementations, every answer is compared
deno task bench             how fast the TypeScript core is on its own shapes (also bench:memory,
                            bench:reactivity against shift's workloads, bench:variants for representation choices)
deno task watch ts          rerun it on every change
deno task build             type-check and bundle the TypeScript core
deno task demo              serve demos/core-web on http://localhost:8700
make docs                   build every PDF (tectonic)
make haskell                build the Haskell core (GHC wasm toolchain)
```
