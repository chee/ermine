# scheduler split: plan

Rewritten 2026-10-11 by mutate-patch-node-id, after chee said "Remove pick, and anything else I can't
trace to your own words". Every rule here is chee's own words, quoted with where and when.
Anything else is marked "mine".

## chee's words

From this session (10-11):
- "the return value of scheduler() will be the api given to a host"
- "scheduler is in charge of hooking up everything, graph and tree and notify and protect"
- killing: "let's, in the meantime, require a process to be killed manually with outro"
- the graph wiring is `graph.ts`, `createGraph`: "we'll go with createGraph for now"
- "with scheduler can we break the code loading, loader stuff out, and process running?"
- separate LLMs that chee runs, then integrated into the scheduler by me; "i dont want the new LLMs to be thinking about ../core and get confused"
- "let's skip the paper"
- "we should make a scheduler folder"
- needs and provides go in info; the info object is called "ermine.program.provisions"
- "pick isn't real, it's just like... we started a process with code - it doesn't need to be stored anywhere it is what it is"
- a process's value is written as given: "do not copy" (it was a deep copy through CBOR, from the old core scheduler; removed in TS and C)

Quoted, with their dates, in working/WHAT-IS-A-PROCESS.tex:
- order and run as two parts, with one kind of hook for both the order and a recorder: "this is a yes" (10-09 08:13)
- "maybe exported as separate functions but the scheduler function contains both? is that a sensible break?" (10-09 08:13; a lean)

Quoted in core/scheduler/LOADERS.tex (loaders; undated there):
- the host says what it is by root loaders at the top of the root: "that's what loaders inside end up hitting"
- a program needing only `javascript` "is saying it's chill"
- a loader with alternatives on both sides, paired: "obviously yes"
- the whole chain or none: "we match on a path that leads from where we are to root while collecting all the secret keys (capability) so there's no deadend"
- going down: "absolutely not"
- going up is right to left: "if going down goes left to right, then going up is right to left ... it's like you're going back in time"
- whatever the rule: "visualizable and explainable"
- the example: "if i need ["b"] and i see an ["a"] beside me, then i go up 3 levels and see a needs:["a"] provides["b"]"

## Done

- `graph.ts` (`createGraph`), `scheduler/rank.ts`, `scheduler/scheduler.ts`. `newcore/scheduler.ts` is a one-line re-export for old importers.
- `scheduler/` holds `scheduler.ts`, `rank.ts`, `scheduler_test.ts`, `conformance/` and `c/`.
- Step 1: `scheduler/order.ts` (`createOrder`), cut out of `scheduler/scheduler.ts` unchanged. Everything in "Must still hold" holds; the old suite is the same in every scenario.
- `processes/records.ts` (`createRecords`; moved from `scheduler/` to a new `processes/` folder, chee 10-11): status, value and the latest run written into the graph, agents, read times. Cut out unchanged; it copies values with newcore's `cbor.ts`, not cbor-x (chee: "we should use our own cbor, not cbor-x"). Everything in "Must still hold" holds.
- `programs/` (chee 10-11: "make a folder called programs and pull processes, handlers and code in there as separate files"): `processes.ts` (start, replacing, parts, cleanups, killing), `handlers.ts` (calls, now or queued), `code.ts` (finding code by path). Shared types in `scheduler/types.ts`. The scheduler tells them nothing of order; they call back through hooks (started, due, mark, ending, gone). Cut out unchanged; everything in "Must still hold" holds.

## Next

1. **order.ts, by me, not an LLM (done).** Mine: cut "who runs next" (the due list, ranks, choosing the next process) out of `scheduler/scheduler.ts` into `scheduler/order.ts`, in one step, changing nothing. Its interface comes out of the code as it is.
2. **Process running: decided after step 1.** Once order is out, look at what's left. Then chee says whether running (`run.ts`) comes apart from the rest, and whether an LLM or I do it.
3. **Loaders: waiting on chee.** Only the words above are known. Before any brief, chee says what a loader does. Mine, as questions only:
   - what code is given;
   - what it answers;
   - what happens to a process when the code it was started with changes;
   - how it searches.

## Must still hold after each step

- `deno check scheduler/ graph.ts` passes.
- The scheduler's unit tests and conformance pass, 58 of 58.
- The old suite, through the scratchpad adapter: the same result in every scenario (50/45/40).
- The C scheduler: 25 of 25.
- Moments, times and pids: unchanged.

## Later (chee, 10-11)

- Not copying a process's value: "it's dangerous this not-copying, and it's possible we should freeze objects on the way through, and it's probably a security hole. but we can figure that all out later."
- Whether the process's node holds its value at all: "i'm not even sure if it should actually _have_ the value there - but that's for later too"
