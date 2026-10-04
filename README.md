# ermine

A graph of named nodes that remembers how, why and who. Any node can be given
a program and is then a process, placed in the tree like anything else.
Resolution looks around and then up the path the process came by, like
`node_modules`. A node may be mounted at several places. Reads are lists:
none, one, or several. Nothing happens silently, and every entry has a
shareable part a sync layer can carry.

This is a Deno workspace. `core/` is the graph; the other directories are the
layers to be built on it, each with a page saying what it will be.

```
core/docs/design.tex       the design: what the core is and must guarantee
core/docs/protocol.tex     how an implementation is checked
core/conformance/          the suite: scenarios.py writes scenarios/*.json; run.mjs plays them
core/haskell/ermine.hs     the executable specification; passes the whole suite
core/ts/                   the TypeScript core, written by hand (@chee/ermine)
core/plans/                how the Haskell core was planned
docs/common.tex            the LaTeX preamble every document shares
plans/                     plans that span layers

scheduler/   glitch freedom as a process          programs/   processes whose code is a node
views/       processes that draw                  transactions/  writes held back and landed together
live/        values too frequent to log           histories/  nodes that remember and merge
optypes/     what a node's ops mean, and optypes that are data    hosts/      devices, adapters and painting
```

```
deno task lint              check the scenario files, no driver needed
deno task conformance ts    run the suite against an implementation (ts, haskell)
deno task watch ts          rerun it on every change
deno task build             type-check and bundle the TypeScript core
make docs                   build every PDF (tectonic)
make haskell                build the Haskell core (GHC wasm toolchain)
```
