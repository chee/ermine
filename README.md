# ermine

A small core for designable and repairable software: software whose parts the people using it can
see, rearrange, replace, reshape and repair, where every value says which change made it and every read
says why it was given (`core/graph/GRAPH.tex`, Designable software).

The graph of `core/graph/GRAPH.tex`, protect of `core/protect/PROTECT.tex`, the reference scheduler
of `core/scheduler/SCHEDULER.tex` and the loaders of `core/scheduler/LOADERS.tex`, in Deno
TypeScript, C and Haskell, each with a harness that speaks the lines of `core/PROTOCOL.tex`; the
graph also in OCaml and Zig. `working/MAP.org` says where the design stands and which paper holds
what. Every command below runs from the repository root.

## Layout

One folder per part, each with its paper and one subfolder per language:

```
core/PROTOCOL.tex    the lines every harness speaks
core/graph/          GRAPH.tex; typescript/, c/ (the C harness), haskell/ (the Haskell harness), ocaml/, zig/
core/scheduler/      SCHEDULER.tex, LOADERS.tex; typescript/, with the TS harness in typescript/harness/; c/, haskell/
core/protect/        PROTECT.tex; typescript/, c/, haskell/
core/mod.ts          the core's TypeScript, all in one module
layers/link/         LINK.tex, link.org; typescript/ (deno/ holds the command line link), c/, haskell/
layers/cache/        CACHE.tex, cache.org; typescript/, c/, haskell/
layers/subduction/   SYNC.tex, PRESENCE.tex and notes; typescript/, c/ (linked into the C harness; c/peer/, a C peer)
layers/lock/         LOCK.tex
layers/keyhive/      KEYHIVE.tex, NOTES.md
experimental_hosts/term/   c/: ermine-term and erminex, over core/graph/c
experimental_hosts/web/    dom.org, signals.org; typescript/: demo/, dom/, signals/, keep/, devtools/, bundle/
working/             MAP.org, HOST.tex, IDEAS.tex, working notes, next.org
conformance/         the suite (scenarios/, one folder per stack), the fuzzer (fuzz/), a HARNESS.md per layer, steps.ts
recipes/
deno.json            one config for all the TypeScript
```

The TypeScript, each next to its `_test.ts`:

```
core/graph/typescript/types.ts     values, Patch, Change, Record, Path, Site, the Interface, Invalid and Refused
core/graph/typescript/patch.ts     values and applying patches; splices count code points, bytes and elements
core/graph/typescript/graph.ts     graph(): the bare graph. It marks; it never runs anything
core/graph/typescript/cbor.ts      deterministic CBOR, typed arrays as RFC 8746 tags
core/graph/typescript/hash.ts      BLAKE3 hashes of bytes, for sync's commits and the cache
core/protect/typescript/protect.ts protect(api, may): asks may() before every operation
core/scheduler/typescript/schedule.ts  schedule(api, loaders, {graph}): the reference scheduler: start, rounds, kills
core/scheduler/typescript/loaders.ts   the loader interface, and sameThread(), which runs a JS module's parts in the page
core/scheduler/typescript/harness/main.ts      the harness: JSON lines on stdin and stdout, a new stack per reset
core/scheduler/typescript/harness/forms.ts     values in JSON: bytes, typed arrays, live stand-ins, NaN, -0
core/mod.ts                        all of the core
conformance/steps.ts               steps(): the loader of programs as data (PROTOCOL.tex, Programs as data); hosts use it too
experimental_layers/keep/typescript/keeper.ts     keep(graph, backend, root): a wrapper right over the bare graph that keeps
                                   what GRAPH.tex says is kept; load(backend) gives it back for graph(root, kept)
experimental_layers/keep/typescript/indexeddb.ts  the keeper's backend in the browser
experimental_layers/keep/typescript/deno/files.ts the keeper's backend on the filesystem: an append-only log; uses Deno
experimental_hosts/web/typescript/bundle/            one entry per browser bundle, and build.ts, the browser build
```

Nothing in these folders uses `Deno` but the tests, the harness, the `deno/` folders and the build,
nor does `conformance/steps.ts`, so the rest bundles for the browser (a test in
`core/graph/typescript/graph_test.ts` checks it).

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

`deno task demo` serves every demo on one server, `experimental_hosts/web/typescript/demo/serve.ts`,
at <http://localhost:8317/>: an index at `/`, core at `/core/`, d2 at `/d2/`, dom-example at
`/dom/`, the signals examples at `/signals/`, browser-sync at `/browser-sync/` with its eg-walker
playground at `/browser-sync/playground`, and core's together example at `/together/`, with its
link server at ws://localhost:8318. A small menu in each page's corner moves between them. It builds
them all on start and rebuilds core and d2 when a file changes. browser-sync's options pass through:
`deno task demo -- --local`, `-- --server wss://…`, `-- --with ts|c|here`. `demo/sync` runs on its
own, `deno task demo:sync`, since its server starts on its own port when imported. Each demo's own
task still works (`demo:together`, `demo:browser-sync`, `demo:sync`), and `deno task demo:core` is
what `deno task demo` was: it builds core and serves it alone at <http://localhost:8317/>,
rebuilding when a file changes. `deno task demo:build` only builds it, into its `dist/`.

The core demo runs `schedule(protect(watch(keep(graph("root"))), may), loaders)` in the
page (`src/world.ts`; the loaders are steps, same-thread and the host's own), with a browser,
an inspector, a transcript, a why pane, a workspace, a stage for effects, rules for protect, a
lookup tester, and example boot images, among them a trip planner in the spirit of Embark, a
spreadsheet whose formulas are processes, a desk whose things are drawn by renderers found by
lookup, two documents sharing a paragraph, a pixel pipeline that is just a slot, and a small GPT
(`src/llm.ts`) that learns names in the page and writes them a character a change. Nodes can be
dragged between folders in the browser and on the canvas: a drop is a move (place, then unplace),
shift-drop mounts it in one more place, and dropping on a row's edge places it in that slot, before
or after. The "graph" tab lays the whole graph out on a canvas: what holds what, which programs a process
runs, what each run read and wrote, with sparks when a change marks a process. A card that holds
anything folds, hiding what it holds there but what is shown elsewhere, with their edges drawn to
it. "graph3d" stands the same tree in depth (`src/space.tsx`): the nodes of one slot one behind another,
the first, which its name reaches, in front; a dashed card for a node whose own card is elsewhere;
and what is in front of a process's value, waiting, an error, newer, as sheets in front of its
card. Drag to turn it. Every panel collapses: the browser to a rail by its name, the rest from
the tabs above the main box. It is an authoring
tool: ⌘K, or the + on a row, makes folders, texts, lists, programs, renderers and processes where
you are; a new process lives in the folder it works on, so its lookups search there, and runs
because it is also under the root. A program is a module whose default export the scheduler calls
with its context and nothing else; it may import `PENDING` from `"ermine"`, and `h`, `screen` and
`fire` from `"demo"`, the host. Programs are edited in CodeMirror, live by default, with what they
throw shown at its line. ⌘Z undoes with a new change whose cause names what it undoes. Each graph is
a project that saves itself in the browser as a boot image: code that rebuilds it in a fresh graph,
which can be exported and imported as a `.ermine.js` file. Every act from outside is a workspace
snippet, so each change carries the site it was made from. Programs are JS modules, or lists of
steps as in the protocol.

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
`experimental_hosts/web/typescript/bundle/dist/`: `graph.js`, `protect.js` and `schedule.js` (the
reference scheduler and its loaders, `sameThread` and `builtin`), and a `.min.js` of each. Each
bundle exports its layer and `ErmineError`, `Invalid` and `Refused`. An error is known by a shared
mark, not by its class, so a `Refused` thrown by `protect.js` counts as one in `graph.js` and
`schedule.js`.

## In a browser

```js
import { graph } from "./dist/graph.js";
import { protect } from "./dist/protect.js";
import { sameThread, schedule } from "./dist/schedule.js";

const g = graph("root");
const may = (agent, process, op, args) => true; // asked before every operation
const api = schedule(protect(g, may), { "same-thread": sameThread() }, { graph: g });
const me = { agent: "me" }; // no cause: each change gets its site, the line it was made from

// a loader for programs of kind "js", a number, and a program that doubles it
api.place({ ...me, address: [], name: "loaders", id: "loaders", value: null });
api.place({ ...me, address: ["loaders"], name: "js", id: "js", value: { loader: "same-thread" } });
api.place({ ...me, address: [], name: "n", id: "n", value: 2 });
const source = `
  export const compute = ({ api }) => api.read({ address: ["n"] })[0].value * 2;
  export const effect = ({ value }) => console.log(value);
`;
const double = { kind: "js", compute: source, effect: source };
api.place({ ...me, address: [], name: "double", id: "double", value: double });

// p waits for its module to load, then runs: it logs 4
api.start({ ...me, address: [], program: ["double"], name: "p" });
// later, a write to what p read runs it again: it logs 10
setTimeout(() => {
  api.write({ ...me, address: ["n"], patches: [{ type: "snapshot", value: 5 }] });
}, 100);
```
