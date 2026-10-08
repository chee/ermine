# ermine

The graph of `core/graph/GRAPH.tex`, protect of `core/protect/PROTECT.tex`, the reference scheduler
of `core/scheduler/SCHEDULER.tex` and the loaders of `core/scheduler/LOADERS.tex`, in Deno
TypeScript, with the line-protocol harness of `layers/link/PROTOCOL.tex`; the graph also in C and
Haskell. The older drive is still here, for the demo. Every command below runs from the repository
root.

## Layout

One folder per part, each with its paper and one subfolder per language:

```
core/graph/          GRAPH.tex; typescript/, c/ (the C harness), haskell/
core/scheduler/      SCHEDULER.tex, LOADERS.tex; typescript/, with the TS harness in typescript/harness/
core/protect/        PROTECT.tex; typescript/
core/mod.ts          the core's TypeScript, all in one module
layers/link/         PROTOCOL.tex, link.org; typescript/ (deno/ holds the command line link)
layers/subduction/   SYNC.tex and its notes; typescript/, c/ (linked into the C harness)
layers/lock/         LOCK.tex
layers/keyhive/      KEYHIVE.tex, NOTES.md
layers/cache/        cache.org; typescript/
experimental_hosts/term/   c/: ermine-term and erminex, over core/graph/c
experimental_hosts/web/    dom.org, signals.org; typescript/: demo/, dom/, signals/, keep/, devtools/, bundle/
working/             IDEAS.tex, HOST.tex, ARCHITECTURE.tex, next.org and other notes
conformance/         the suite and the fuzzer
recipes/
deno.json            one config for all the TypeScript
```

The TypeScript, each next to its `_test.ts`:

```
core/graph/typescript/types.ts     values, Patch, Change, Record, Path, Site, the Interface, Invalid and Refused
core/graph/typescript/patch.ts     values and applying patches; splices count code points, bytes and elements
core/graph/typescript/graph.ts     graph(): the bare graph. It marks; it never runs anything
core/graph/typescript/steps.ts     steps(): the loader of programs as data (PROTOCOL.tex, Programs as data)
core/graph/typescript/cbor.ts      deterministic CBOR, typed arrays as RFC 8746 tags
core/graph/typescript/hash.ts      BLAKE3 hashes of bytes, for sync's commits and the cache
core/protect/typescript/protect.ts protect(api, may): asks may() before every operation
core/scheduler/typescript/schedule.ts  schedule(api, loaders, {graph}): the reference scheduler: start, rounds, kills
core/scheduler/typescript/loaders.ts   the loader interface, and sameThread(), which runs a JS module's parts in the page
core/scheduler/typescript/drive.ts     drive(api, root, load): the older driver, which the demo still runs
core/scheduler/typescript/harness/main.ts      the harness: JSON lines on stdin and stdout, a new stack per reset
core/scheduler/typescript/harness/forms.ts     values in JSON: bytes, typed arrays, live stand-ins, NaN, -0
core/scheduler/typescript/harness/programs.ts  programs as data, as drive ran them
core/mod.ts                        all of the core
experimental_hosts/web/typescript/keep/keeper.ts     keep(graph, backend, root): a wrapper right over the bare graph that keeps
                                   what GRAPH.tex says is kept; load(backend) gives it back for graph(root, kept)
experimental_hosts/web/typescript/keep/indexeddb.ts  the keeper's backend in the browser
experimental_hosts/web/typescript/keep/deno/files.ts the keeper's backend on the filesystem: an append-only log; uses Deno
experimental_hosts/web/typescript/bundle/            one entry per browser bundle, and build.ts, the browser build
```

Nothing in these folders uses `Deno` but the tests, the harness, the `deno/` folders and the build,
so the rest bundles for the browser (a test in `core/graph/typescript/graph_test.ts` checks it).

## Running

```
deno task test          # unit tests
deno task conformance   # the suite in conformance/ against core/scheduler/typescript/harness/main.ts
deno task check         # type check
deno lint && deno fmt --check
```

The harness claims the graph, protect and schedule stacks:

```
cd conformance
ERMINE_REQUIRE=schedule ERMINE_HARNESS="deno run --quiet $PWD/../core/scheduler/typescript/harness/main.ts" \
  deno test --allow-run --allow-read --allow-env conformance_test.ts
```

## The scheduler

```js
const g = graph("root");
const api = schedule(protect(g, may), { steps: steps(), "same-thread": sameThread() }, {
  graph: g,
});
api.top(api);
api.start({ agent: "me", address: [], program: ["programs", "editor"] });
```

The scheduler is given the bare graph too, for its bookkeeping beneath the wrappers. A loader node
`{"loader": name}` at `loaders/<kind>` names one of the loaders it was given. With `sameThread()` a
part's code is a module's source or address; the part is the module's `compute` or `effect` export,
or its default. Importing is slow, so a compute returns pending until its module has loaded, and
then the loader places the answer node `[name, "loaded"]`, so the process runs again.

To run the suite by hand, or one part of it:

```
cd conformance
ERMINE_HARNESS="deno run --quiet $PWD/../core/scheduler/typescript/harness/main.ts" deno task conformance:test
ERMINE_HARNESS="deno run --quiet $PWD/../core/scheduler/typescript/harness/main.ts" \
  deno test --allow-run --allow-read --allow-env --filter "graph/"
```

## The demo

`deno task demo` builds `experimental_hosts/web/typescript/demo/core` and serves it at
<http://localhost:8317/>, rebuilding when a file changes; `deno task demo:build` only builds it,
into its `dist/`. It runs `drive(protect(graph(), may), "root", load)` in the page, with a browser,
an inspector, a transcript, a why pane, a workspace, a stage for effects, rules for protect, a
lookup tester, and example boot images, among them a trip planner in the spirit of Embark, a
spreadsheet whose formulas are processes, a desk whose things are drawn by renderers found by
lookup, two documents sharing a paragraph, and a pixel pipeline that is just a slot. Nodes can be
dragged between folders in the browser and on the canvas: a drop is a move (place, then unplace),
shift-drop mounts it in one more place, and dropping on a row's edge places it in that slot, before
or after. "explode" lays the whole graph out on a canvas: what holds what, which programs a process
runs, what each run read and wrote, with sparks when a change marks a process. It is an authoring
tool: ⌘K, or the + on a row, makes folders, texts, lists, programs, renderers and processes where
you are; a new process lives in the folder it works on, so its lookups search there, and runs
because it is also under the root. A program is a module whose default export the scheduler calls
with its context and nothing else; it may import `PENDING` from `"ermine"`, and `h`, `screen` and
`fire` from `"demo"`, the host. Programs are edited in CodeMirror, live by default, with what they
throw shown at its line. ⌘Z undoes with a new change whose cause names what it undoes. Each graph is
a project that saves itself in the browser as a boot image: code that rebuilds it in a fresh graph,
which can be exported and imported as a `.ermine.js` file. Every act from outside is a workspace
snippet, so each change carries the site it was made from. Programs are JS function bodies, or lists
of steps as in the protocol.

## The devtools

`experimental_hosts/web/typescript/devtools/` is a devtools panel for Chrome, Firefox and Safari, in
Solid 2.0 for now. A host shows a graph to it by pushing it onto a global, with the layer it
chooses: `(globalThis.__ermine ??= []).push({ name: "app", api })`; the demo pushes the layer
beneath protect. The panel reaches the page only through `inspectedWindow.eval`, and the agent it
puts there uses the graph's own operations as the agent `"devtools"`: directories and reads by
address, a lookup from the selected address, and a subscription to every address it has listed, so
it hears the changes and records there. It never writes.
`cd experimental_hosts/web/typescript/devtools && deno task build` writes `dist/chrome`,
`dist/firefox` (and an `.xpi`) and `dist/safari`; `deno task install` also builds the Safari app,
which needs Xcode; `.github/workflows/devtools.yml` builds it on GitHub as an artifact. The panel is
on Solid 2.0 rc.8: the newest compiler on npm still puts handlers at `$$click`, which later runtimes
no longer read.

## Building

`deno task build` writes one self-contained ES module per layer into
`experimental_hosts/web/typescript/bundle/dist/`: `graph.js`, `protect.js` and `drive.js`, and a
`.min.js` of each. Each bundle exports its layer and `ErmineError`, `Invalid` and `Refused`. An
error is known by a shared mark, not by its class, so a `Refused` thrown by `protect.js` counts as
one in `graph.js` and `drive.js`.

## In a browser

```js
import { graph } from "./dist/graph.js";
import { protect } from "./dist/protect.js";
import { drive } from "./dist/drive.js";

const load = (code) => new Function("ctx", code); // programs are JS source here
const may = (agent, process, op, args) => true;
const top = drive(protect(graph(), may), "root", load);
const at = { agent: "me", site: { file: "page.js", line: 1, column: 1 } };
top.make({ ...at, id: "root", value: {} });
top.make({ ...at, id: "n", value: 2 });
top.make({ ...at, id: "double", value: "return ctx.api.read({ node: 'n' }).value * 2" });
top.make({ ...at, id: "p", value: null, data: { path: [] } });
top.place({ ...at, parent: "p", name: "compute", id: "double" });
top.place({ ...at, parent: "root", name: "p", id: "p" }); // p starts and runs: its value is 4
top.write({ ...at, node: "n", patches: [{ type: "snapshot", value: 5 }] }); // p runs again: 10
```
