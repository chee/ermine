// @ermine/system's functions [chee 10-25: "let's change the process api to be verb first … a very
// clear mechanical api"; "the let's do @ermine/system"]. each is one function, shared by every
// process: it finds the context it acts as (a process's, from the scope open, registry.ts; the
// host's, for the host's ermine object) and does its work as that context (acting.ts' go). no api
// object per process [chee 10-25: ">Drop the objects. ye"]. programs import them from
// @ermine/system (system/mod.ts). each is in the file of its job, beside its implementation:
// read runs readAs, which takes the context first.
//
// one verb for each of a node's three parts [chee 10-25: "i wonder if we should have readChildren
// peepChildren readChildrenVersions explainChildren patchChildren and we build these other things
// atop. i also thing we should drop `value` from the value ones"; "we'll go with peep"; readAll: "i
// guess is best of these"]:
//            value        attributes          children
// read       read         readAttributes      readChildren ({ name: node })
// every one  readAll      readAllAttributes   readAllChildren
// write      patch        patchAttributes     patchChildren (one name a patch: a node, or none)
// who        explain      explainAttributes   explainChildren
// untracked  peep(f): f with nothing it reads tracked
// nodes      getNode (makes nothing), hasNode, ensureNode (made, with value or nothing, only if
//            missing), createNode (a fresh name), ref (make() only if missing: a live value),
//            readEntries (every node a path reaches)
// names      place, unplace (patchChildren's rule, by a path), rename (one change over two
//            folders, its cycle check), list, remove
// computing  createMemo, createEffect ({ early }), pulse (the pending pulse now; in one: nothing)
// actions    createAction, executeAction, getCaller
// the rest   getStatus, addTeardown, getArgs, PENDING, REFUSED
//
// paths: a bare name inside the process's node (the host's: the root), gone at stop; ./ its folder;
// ../ above; / the root. a node: a path (walked at each use) or a handle (handles.ts: the
// node and the context that made it, resolved and asked as that context; the rest of a call stays
// the caller's). no ids anywhere a process is given [chee 10-25]: paths as it sees them (seenIn),
// handles for what it reached, changes as views.
// pulses: every write and every promise settling asks for one (a verb that writes, as it returns:
// go; an action's call, also as it ends). a read after a write sees it at once; a memo gives its
// last result until the pulse.
// writes: patches only, never a recipe [chee 10-25]; under the open scope (nothing open: a
// process's throws nothing-open, the host's falls back to its own scope); each value and attribute
// write through onWrite. a write's header holds its frame: the frame open, shared, never copied
// [chee 10-29: "the design drifted, frames should be in the graph"; "we only need filenames
// captured with new Error when the thing comes from outside the graph"]. where a write came from
// is a walk up the frame's parents: a frame holds locations (every line of a stack, ermine's own
// too) when what it is began outside the graph: a process or computer made from outside, a call
// into a handler from outside, and a write made from outside with no frame up the chain holding
// any (a fresh frame on top). inside, nothing is captured. a build location (@ermine/bundling's,
// through @ermine/system/site) stands in for the stack. a call's record keeps its frame.
//
//   read(x, key?)        the value at key, tracked; a node there with none: undefined; a node not
//                        there, or a pending memo with no value: throws PENDING
//   readAll(x, key?)     every value at key, tracked: [{ value, from }]. position 0 read's, from:
//                        { change } (a ChangeView: time, actor, locations); then what features show
//                        (onRead), each from naming its feature
//   readEntries(x)       every node x's path reaches: [{ value, from, node?, refused? }], node a
//                        handle; refused: no value, no node
//   place(p, x)          x's node at a second name. unplace(p): the name out, the node stays.
//                        remove(x): unplaced and its entries deleted, asked "remove" [chee 10-27:
//                        "why wouldn't we just export remove and pulse too? protect remove"]; a
//                        node no name reaches no longer exists [chee 10-25]. unplace and remove
//                        stop what is made at the node and under it [chee 10-27: "yes removing a
//                        node should stop what's at it"]: each memo and effect's scope torn down,
//                        its teardowns told "ended", its node and name gone; each action's handler gone (a send to it after is a send to a
//                        missing handler: pending); the process that made them runs on. remove
//                        stops them always (the node itself) and what is under it unless a name
//                        still reaches it; unplace stops what no name reaches now. rename stops
//                        nothing
//   createMemo(name, f, o?)   a compute at its own node at name: its result, status and latest
//                        run; made again by its owner's next run (same node, new f); a name not
//                        made again goes after the run. a second at a name in
//                        one run: already-there
//   createAction(p, fn)  fn as the node's value, run by executeAction as the scope that placed it
//   executeAction(p, ...args)  the action at p, run as the scope that placed it, under a mark
//                        { caller: { node, actor }, handler, call } that owns nothing (what the
//                        action makes is the placing scope's, and lasts as it does); its return.
//                        a generator action (a function*; an async function* throws not-a-function) is stepped by the system, each step
//                        under the mark; the call gives a promise of its return. its record (calls.ts) is
//                        held as the handler's latest, and open till the generator finishes (a plain
//                        action's: when it returns, or its promise settles). nothing there: pending, loudly (a wait recorded, PENDING thrown,
//                        so a memo or effect running it reruns when the action comes). a value no
//                        function: not-a-method
//   addTeardown(fn)      fn(why) as the owner goes (the scope open, past a call's mark), through
//                        onTeardown: "replaced", "ended", or a stop's reason. not in an effect's
//                        act: return a cleanup from the act instead (it runs before the next act
//                        and as the effect goes; a returned non-function throws). not in an action
//                        either (not-here): it would pile onto the placing scope, a closure a call;
//                        add it in setup
//   createWriter()       in setup or an action (not a compute or an act): a writer,
//                        `const withWriter = createWriter()`, then withWriter(() => patch(...)) runs
//                        the function as the scope createWriter was called in, with nothing open, its
//                        writes carrying the mark it was made under (an action's call), each at its own
//                        line; userActivated on their change while the page is user-activated (the
//                        mark kept never carries it: only a run while a person had just interacted does). a write through
//                        a writer made in an action explains as that call (its view, while it is the
//                        handler's latest), but is not added to the call's record "writes": the record
//                        closes when the call finishes. not data, and hidden as a handle is wherever a
//                        record or view shows values; gone with its parent; inside a scope or run:
//                        already-inside
//   start(fn, at, o?)    a process, asked as the starter ("place"), belonging to the scope that
//                        started it; setup, an action, a writer (not a compute or
//                        an act). its stop() is asked as the starter too. taken: { refused: "taken", at }
//   getStatus(x, key?)   tracked: { state, error?, phase?, waiting?, n? }; not there: undefined.
//                        key: that field alone, read and told alone (a reader of state isn't run
//                        again when only n moves).
//                        waiting names nodes by path as this process sees them (null: outside)
//   explain(x, key?)     tracked: a change and its writer, one step. x a change's view: that one;
//                        a node: its entry's, and a write held there. the writer and its record
//                        name nodes by path from the root (null: none reaches it)
//   getCaller()          in an action: { actor, process? }; elsewhere: undefined
//
// a memo or effect made in an action is the scope's that placed the action, and the call's record
// says so (made). the call's mark lasts as its record does: a promise's till it settles; it owns
// nothing, so nothing goes with it. an effect's act makes nothing. protect: reads ask "read" (refused: Refusal; readEntries keeps the item, refused);
// patch "edit"; ensureNode, createNode,
// place, unplace, rename "place" on the slot; remove "remove"; executeAction "execute"; a memo's
// and effect's own writes not asked.
// scope nodes: a lookup up a write's frames (nearest) stops after the first frame whose info holds the
// node key. a process's scope holds its node's; each memo and effect is made with { node: its
// node's id }.
//
// the files of this folder, one for each job:
//   shapes      what a program is given (Status, Item, ChangeView …), SendError, System
//   base        what ermine.ts builds and every function works from
//   setting     a context's base and its own state: here(inner)
//   scopes      the scope open: its owner, marks, an act, the actor, the call; teardown, runAs
//   addressing  a node given (a path, a handle) to its id and back to its path, a change's view
//   asking      the policy asked: a read, a refusal, a name placed
//   tree        names in folders: a path's folder, a name put in and taken out, a node's entries gone
//   nodes, reading (and list), patching, explaining, names, computing, actions, process (but
//               getStatus): those functions, each beside its implementation
//   made        what an owner's runs made: found by its next run, let go; stopped by unplace, remove
//   status      getStatus, and the entries a status is written in

// the files of this folder (ermine_test checks the list against the folder)
export const NAMES: readonly string[] = [
	"index",
	"shapes",
	"base",
	"setting",
	"scopes",
	"addressing",
	"asking",
	"tree",
	"nodes",
	"reading",
	"patching",
	"explaining",
	"names",
	"made",
	"computing",
	"actions",
	"process",
	"status",
]
