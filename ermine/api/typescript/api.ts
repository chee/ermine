// the process api: what context.createAPI gives a program; inside the graph, all a program has.
//
//   const context = createProcessContext({ scheduler, table, commit, host, programs: () => p })
//   const p = createPrograms({ ..., createAPI: context.createAPI })
//   put("value", RUN, context.run)                    // a host runner for javascript programs
//   den.offer("runners", "javascript", attributes, context.run)   // a den's, the same
//   context.runner({ api: (start) => ({ ...context.createAPI(start), offer }) })   // its own api
//
// the context is the world every process's api shares (statuses, runs, methods, stop reasons);
// createAPI(start) one process's, start its facts ({ box, places, process: { id, at, args, cwd },
// scheduler, table, scope }; a den's has its den too). an api knows its process by a key it
// carries (a symbol's field), not by being the api made: a copy (spread, Object.assign) is as good
//
//   export default function ({ open, read, edit, memo, effect, method, send }) {
//     const notes = open("./notes", { a: 1 })
//     const a = memo("a", () => read(notes, ["a"]))
//     method("on/bump", () => edit(notes, (d) => { d.a++ }))
//     effect("draw", () => read(a), (n) => draw(n))
//     return "the process's value"
//   }
//
// paths (path.ts' parse): crew inside the process's node (gone at stop), ./crew its cwd, ../crew
// above, /crew the box's "/". a node: {path} (walked at each use) or {id}; part "value" or
// "attributes".
// pulses: every write and promise settling asks for one in a microtask; pulse() runs one now.
// a read after a write sees it at once; a memo gives its last result until the pulse.
// writes: under the open scope (none: the process's own; stopped: throws); patches or a recipe.
//
//   open(p, value?)      the node at p; a value: made (with folders) if missing, else unchanged
//   create(folder, v)    a new node in folder, named by its id
//   read(x, path?)       value at path, tracked; none: undefined; a pending memo throws PENDING
//   peep(x, path?)       value at path, untracked (no dependency: a write there reruns nothing);
//                        none, or a pending memo: undefined
//   reads(x, path?)      every value at path, tracked: [{ value, from, gone?, inside? }] (From),
//                        sync's items there (its "values": the path's, or an open path's above
//                        it, at path). position 0 is read's (undefined too), from its item, else
//                        from its entry's change; then the rest, each from its commit; none: [];
//                        a pending memo throws PENDING
//   entries(x)           every item: [{ value, from, id, refused? }]; none: []
//   list(x)              the names under x, tracked
//   info(x)              x's attributes, as a node
//   edit(x, change)      patches or a recipe; one change (made if missing). synced, it replaces
//                        what reads showed first at each path it writes
//   edits(x, change, which?)   edit's, replacing every value reads gives at each path it writes,
//                        or the ones given (reads' items)
//   watch(x, fn)         fn at each write at x, with patches, change and value; returns the stop
//   place(p, x)          x's node at a second name. unplace(p): the name out, the node stays
//   move(from, to)       places' move. remove(x): unplaced and its entries deleted
//   memo(name, f, o?)    a compute; result, status and latest run written to its own node at name;
//                        its scope once, as made (SCOPE: the node of the nearest scope above it
//                        with one; none: not written).
//                        made again by the owner's next run: same id and node, new f. a name not
//                        made again goes after the run (kept if the run fails). a second at a name
//                        in one run: already-there
//   effect(name, f, act, o?)   f tracked, act(value, before) after the round; node as memo's
//   early(name, f, act, o?)    an effect run and acted at once; later acts before other effects'
//   method(p, fn)        fn as the node's value, called by send in a scope under the open one
//   send(p, ...args)     the method at p, in a scope { ...setup.info(), caller: id }; its return
//   teardown(fn)         fn(why) as the open scope goes: "replaced" (its owner ran again), the
//                        reason the process was stopped with (stop's why, a den's reason through
//                        its handle: runner-stopped, den-stopped, the caller's), else "ended"
//   ref(p, make)         the node at p, make() if missing: a live value kept while the node is
//   start(program, at, { box?, args?, cwd?, onwhynot? })   program: a name or a way;
//                        stopped with this one, its teardowns told this one's why; no way: refused
//                        no-way (setup.programs none: thrown)
//   stop(p)              a process this one started
//   openwith(x, { onwhynot }?)   every way to open x, nearest first (a generator)
//   box(at)              a box: the folder at, seen from its own "/" (ermine/boxes)
//   args, pulse, PENDING, REFUSED
//
// protect (setup.may; none: all allowed): reads ask "read" (refused: Refusal thrown; entries keeps
// the item with id REFUSED); writes ask with the open scope: edit "edit"; open, create, place,
// unplace, move "place" on the slot; remove "remove"; send "execute"; present, absent, land "edit".
// memo's and effect's own writes are not asked. open: the ops' names.
//
// presence (setup.presence; none: these throw):
//   presence(x)          live rows at x: [{ who, value, until }], tracked
//   present(x, v, { ttl?, who? })   my row at x; who: setup.who or the process id; ttl 10s
//   absent(x, { who? })  my row out
//
// patch nodes (setup.overlay):
//   patch(at, over, change)   a patch node at at over over's part, against the table's value
//   land(p)              its patches put on its target, its "patch" entry gone
//   layers(x, path?)     every layer, front first: [{ value, from, stale?, error? }]
//
// scope nodes: a write's metadata stops after the first scope whose own info holds the NODE key
// (places' header.ts). a process's scope holds its node's; each memo and effect is made with
// { [NODE]: its node's id }.
//
// runners (run, runner({ show?, api? })): each both @ermine/programs/start's (a function given the
// code and an api) and a den's ({ start(code, start), api(start) }, api's none: createAPI). the
// program is its value (or module's default) called with the api, once, untracked; its return
// (show's) the process's value, written with the process's scope open. its handle's stop(reason):
// the process's teardowns told reason, as stop's why (the starter's stop is under way: it is what
// calls the handle's)
// stop(p, why): p's teardowns told why (none: "ended"), then programs' stop (setup.programs none:
// told only, its starter stops it)
//
// open: remove leaves what is under the node; memo claims skip notice and early's first run.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Key as Step, type Patch } from "@ermine/op/apply"
import produce from "@ermine/op/produce"
import { type Box, box as boxInto, createBox, type Host, inside, unbox } from "@ermine/boxes"
import {
	at as dig,
	type Fact,
	type Id,
	move as moveIn,
	type Path,
	place as placeIn,
	PlacesError,
	unplace as unplaceIn,
} from "@ermine/places"
import { get, gets, list as listAt } from "@ermine/places/lib"
import { parse, plan } from "@ermine/places/path"
import { createChangeHeader, NODE } from "@ermine/places/header"
import {
	createGuard,
	REFUSED,
	slot as slotOf,
	target as targetOf,
	type Thing,
} from "@ermine/places/guard"
import type { Policy } from "@ermine/protect"
import {
	clear,
	type Live,
	readPresence,
	setPresence,
	type World as PresenceWorld,
} from "@ermine/presence"
import {
	entries as layersOf,
	type Item as Layer,
	land as landIn,
	type Overlay,
	type PatchNode,
} from "@ermine/patch-nodes"
import { createStatus, STATUS } from "@ermine/places/status"
import { createRuns, type Runs } from "@ermine/processes/runs"
import { openwith as openwithIn, satisfy, type Way, type Whynot } from "@ermine/programs"
import type { Handle, Process, Programs, Runner, Start } from "@ermine/programs/start"
import {
	type Computer,
	type Equal,
	type Info,
	PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/scheduler"
import type { Sited } from "@ermine/sites"
import type { Key, Table } from "@ermine/table"

export type Setup = {
	scheduler: Scheduler
	table: Table
	// the host's commit (a box's places is a view of the host's, and shares it)
	commit: (changed: readonly Entry<unknown>[]) => void
	// what boxes are made over: the host's places, table and scheduler, and its commit
	host: Host
	// made after this (createPrograms takes createAPI): asked when used. none (a den's world): an
	// api's start throws, stop only tells its teardowns
	programs?: () => Programs
	// what a send's scope holds beside the caller (the caller over it): the host's ("trusted-event", read
	// from the native event)
	info?: () => Info
	// the policy every process's reads and writes are asked of, from where it is; none: all allowed
	may?: Policy
	// the host's presence world (playground/presence); none: present, absent and presence throw
	presence?: PresenceWorld
	// who a process's presence row is, unless it says (the device); none: the process's id
	who?: string
	// the overlay in front of places' table (patch nodes), for layers; none: the table's layer alone
	overlay?: Pick<Overlay, "layers">
	// how the automatic pulse is asked for: f run soon, once (none: queueMicrotask). a harness, or a
	// host with no microtasks (C), runs what it was given when it likes
	schedule?: (f: () => void) => void
	// a new node's id (none: uuidv7, time-ordered)
	id?: () => string
	// told of each memo, effect and method a program makes, as it is made: for a host's inspector
	notice?: (made: Noticed) => void
	// where the memos, effects and send's scopes are made, each noting its site (ermine/sites; its
	// ours holding this file, start.ts and the scheduler's, as they are made in runWithScope): a
	// memo's site is the program's line. none: the scheduler's, no sites
	sites?: Pick<Sited, "createScope" | "createComputer" | "createEffect">
}

// the attribute a memo's or effect's node holds its scope in: the NODE key's id of the nearest
// scope above it with one, written once as the node is made (beside status.ts')
export const SCOPE = "ermine.computer.scope"

// the NODE key's id of o or the nearest scope above it with one; none: undefined
function nodeAbove(o: Scope | undefined): Id | undefined {
	for (; o !== undefined; o = o.parent) if (NODE in o.info) return o.info[NODE] as Id
	return undefined
}

// what notice is told: the computer (none for a method), its node, and the process's id
export type Noticed = {
	readonly kind: "memo" | "effect" | "method"
	readonly computer?: Computer
	readonly node: Node
	readonly id: Id
	readonly process: Id
}

// a node: walked to by its path at each use, or its id (a node with no place)
export type Node = { readonly path?: Path; readonly id?: Id; readonly part: Key }
export type Target = Node | string | readonly string[]

// a recipe (produce's), or patches
export type Change = readonly Patch[] | ((draft: any, helpers: any) => unknown)

// why a scope goes, as its teardowns are told: its owner ran again, the process ended, or the
// reason its stop was given (a den's reasons and its caller's: a reason that is no string, as given)
export type Why = "ended" | "replaced" | (string & Record<never, never>)

// a write landing at a watched node
export type Watched = {
	readonly patches: readonly Patch[]
	readonly change: ChangeHeader | undefined
	readonly value: unknown
}

export type Item = {
	readonly value: unknown
	readonly from: string
	readonly id: Id
	// refused by the policy: its id REFUSED, no value
	readonly refused?: true
}

// one value a path holds, and where it is from. gone: a delete; inside: a write under it is not its
// own (sync's items, extensions/together's lists)
export type Version = {
	readonly value: unknown
	readonly from: From
	readonly gone?: true
	readonly inside?: true
}

// the value read gives: the commit of the first item sync has there (who: actor, when: time,
// where: external, head: its name), or none listed, its entry's change; a field not known left
// out
export type Shown = {
	readonly who?: unknown
	readonly when?: number
	readonly where?: ChangeHeader["external"]
	readonly head?: string
}

// another value sync has at the path (a conflict): by, the sync engine (undefined for now: it
// becomes the sync process's id once hosts run sync as a process); its commit as it tells it (head:
// its name, who: actor, signer hex, when: time, lamport, where: external); differs, the part
export type Conflict = {
	readonly kind: "conflict"
	readonly by: Id | undefined
	readonly head: string
	readonly who: unknown
	readonly signer: string
	readonly when: number
	readonly lamport: number
	readonly where?: ChangeHeader["external"]
	readonly differs: readonly string[]
}

export type From = Shown | Conflict

// a commit as sync tells it (extensions/together's Head), and one item of a path's list and each
// open path's, as its "values" table has them (Item, Values)
type Head = {
	readonly head: string
	readonly lamport: number
	readonly actor: unknown
	readonly signer: string
	readonly time: number
	readonly external?: ChangeHeader["external"]
}
type Listed = {
	readonly value?: unknown
	readonly gone?: true
	readonly inside?: true
	readonly from: Head
}
type Row = { readonly path: readonly Step[]; readonly items: readonly Listed[] }

// the metadata key a write says what it replaces by, for sync: "all", or commit names (hex)
// (extensions/together's REPLACES)
const REPLACES = "replaces"

export type BoxNode = {
	readonly box: Box
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
}

// what a refusal from start says: start's, or no-way (satisfy yielded none), with the whynots
export type Refusal = { readonly refused: string; readonly why?: readonly Whynot[] }

export type API = {
	open: (at: string | Path, value?: unknown) => Node
	create: (folder: string | Path, value: unknown) => Node
	read: (x: Target, path?: readonly Step[]) => unknown
	peep: (x: Target, path?: readonly Step[]) => unknown
	reads: (x: Target, path?: readonly Step[]) => Version[]
	entries: (x: Target) => Item[]
	list: (x: Target) => string[]
	info: (x: Target) => Node
	edit: (x: Target, change: Change) => void
	edits: (x: Target, change: Change, which?: readonly Version[]) => void
	watch: (x: Target, fn: (w: Watched) => void) => () => void
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
	move: (from: string | Path, to: string | Path) => void
	remove: (x: Target) => void
	memo: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		options?: { equal?: Equal<T> },
	) => Node
	effect: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options?: { equal?: Equal<T> },
	) => Node
	early: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options?: { equal?: Equal<T> },
	) => Node
	method: (at: string | Path, fn: (...args: any[]) => unknown) => Node
	send: (at: Target, ...args: unknown[]) => unknown
	teardown: (fn: (why: Why) => unknown) => void
	ref: <T>(at: string | Path, make: () => T) => Node
	start: (
		program: string | Way,
		at: string | Path,
		options?: {
			box?: BoxNode
			args?: readonly string[]
			cwd?: string | Path
			onwhynot?: (why: Whynot) => void
		},
	) => Process | Refusal
	stop: (p: Process) => void
	openwith: (x: Target, options?: { onwhynot?: (why: Whynot) => void }) => Generator<Way, void>
	box: (at: string | Path) => BoxNode
	presence: (x: Target) => Live[]
	present: (x: Target, value: unknown, options?: { ttl?: number; who?: string }) => void
	absent: (x: Target, options?: { who?: string }) => void
	patch: (at: string | Path, over: Target, change: Change) => Node
	land: (p: Target) => void
	layers: (x: Target, path?: readonly Step[]) => Layer[]
	readonly args: readonly string[]
	pulse: () => void
	readonly PENDING: typeof PENDING
	readonly REFUSED: typeof REFUSED
}

export class SendError extends Error {
	constructor(readonly code: "not-a-method", readonly at: string) {
		super(`${code} (${at})`)
		this.name = "SendError"
	}
}

export type { Start }

// what a runner of this context gives back: its stop(reason) tells the process's teardowns reason
export type Told = Handle & { readonly stop: (reason?: unknown) => void }

// a runner both programs' start and a den take: called (code, api), as programs' runner is; start,
// as a den's is, given the start's facts, the program given api(start)
export type Run = Runner & {
	readonly start: (code: unknown, start: Start) => Told
	readonly api: (start: Start) => API
}

export type ProcessContext = {
	createAPI: (start: Start) => API
	// a host runner for a javascript program: its value (or module's default) called with the api,
	// once, untracked; its return the process's value
	run: Run
	// the same, show(value, api) making setup's return what is kept (a view made real, say), with
	// the process's scope open; its return the process's value. api: what a den's start gives the
	// program (none: createAPI), a runner's own over this one ({ ...createAPI(start), more })
	runner: (
		options?: { show?: (value: unknown, api: API) => unknown; api?: (start: Start) => API },
	) => Run
	// a process stopped, its teardowns told why
	stop: (p: Process, why?: Why) => void
	// a memo's, effect's or early's latest run, by its node's id (runs.ts)
	runs: Runs["read"]
}

// a uuidv7 (rfc 9562): 48 bits of ms, then a 12-bit count within the ms (started random), then
// random. later ones sort after: a clock going back, or 4096 in one ms, borrows the next ms
let last = 0
let count = 0
export function uuidv7(): string {
	const now = Date.now()
	if (now > last) {
		last = now
		count = crypto.getRandomValues(new Uint16Array(1))[0] & 0x7ff
	} else if (++count > 0xfff) {
		last++
		count = 0
	}
	const b = crypto.getRandomValues(new Uint8Array(16))
	for (let i = 0; i < 6; i++) b[i] = Math.floor(last / 2 ** (8 * (5 - i))) & 0xff
	b[6] = 0x70 | (count >> 8)
	b[7] = count & 0xff
	b[8] = 0x80 | (b[8] & 0x3f)
	const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const isNode = (x: Target): x is Node => typeof x === "object" && !Array.isArray(x)

// what an api carries of its process: a key a copy keeps (an own enumerable field, a symbol's)
const PROCESS = Symbol("ermine/api process")

const isMap = (v: unknown): v is Record<PropertyKey, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

export function createProcessContext(setup: Setup): ProcessContext {
	const { scheduler: s, table, commit } = setup
	const sited = setup.sites ?? s
	const statuses = createStatus({ places: { commit }, table, scheduler: s })
	const { describe, watchAll } = setup.host.places
	const runs = createRuns({ places: { describe, watchAll }, table, scheduler: s })
	// a method's function: the scope open when it was made
	const methods = new WeakMap<object, Scope>()
	// why a process is stopping, by its scope, said by stop (or its handle's) before its scope goes
	const whys = new WeakMap<Scope, Why>()
	// the memos' nodes: a read of one pending with no value throws PENDING
	const memos = new Set<Id>()
	// each process, by the key its apis carry (PROCESS)
	const inners = new WeakMap<object, { id: Id; scope: Scope }>()

	// one pulse, in a microtask, however many ask
	let queued = false
	const schedule = setup.schedule ?? queueMicrotask
	function later() {
		if (queued) return
		queued = true
		schedule(() => {
			queued = false
			s.pulse()
		})
	}
	const newId = setup.id ?? uuidv7
	s.onSettle(later)

	const header = (extra?: Info) => createChangeHeader(s, extra)

	// what a part holds when nothing is there: attributes are a map, so {}; a value, nothing
	const empty = (part: Key) => part === "attributes" ? {} : undefined

	// patches on (part, id): the entry made when there is none (the table event tells its readers),
	// else updated and committed
	// extra: the change's innermost metadata (edits: what it replaces)
	function write(part: Key, id: Id, patches: readonly Patch[], extra?: Info) {
		const entry = table.get(part, id) as Entry<unknown> | undefined
		if (entry === undefined) {
			const v = apply(empty(part), patches)
			if (v !== undefined) table.add(part, id, createEntry(v, header(extra)) as never)
			return
		}
		update(entry, patches, header(extra))
		commit([entry])
	}

	// a whole value as patches; undefined: taken out
	const whole = (v: unknown): Patch[] => [v === undefined ? { path: [] } : { path: [], value: v }]

	// a process's teardowns to be told why: a reason given, else "ended" (one given before kept)
	function tell(scope: Scope, why?: unknown) {
		if (why !== undefined) whys.set(scope, why as Why)
		else if (!whys.has(scope)) whys.set(scope, "ended")
	}

	function stop(p: Process, why?: Why) {
		tell(p.scope, why)
		setup.programs?.().stop(p)
	}

	function programs(): Programs {
		if (setup.programs === undefined) throw new Error("no programs here: the host gave none")
		return setup.programs()
	}

	function createAPI(given: Start): API {
		const { box: home, places, process, scope } = given
		const at = process.at
		const cwd = process.cwd

		// f with a scope open: the one open, else the process's own
		const within = <T>(f: () => T): T =>
			s.getCurrentScope() !== undefined ? f() : s.runWithScope(scope, f)
		const owner = () => s.getCurrentScope() ?? scope

		// protect: asked only when the host gave a policy
		const guarded = setup.may !== undefined
		const guard = createGuard({
			places,
			scheduler: s,
			table,
			may: setup.may,
			from: at,
		})
		const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
		const ask = (op: string, ...targets: Parameters<typeof guard.write>[1][]) => {
			if (guarded) guard.write(op, ...targets)
		}
		// the parent at path's folder, and the name: what placing there changes
		const slotAt = (path: Path, parent: Id) =>
			slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

		function resolve(p: string | Path): Path {
			const steps = typeof p === "string" ? parse(p) : p
			const first = steps[0]
			const from = first === "/" ? [] : first === "." || first === ".." ? cwd : at
			const names = plan(["/", ...from, ...steps])
			if (names === undefined) throw new PlacesError("nothing-there", "..")
			return names
		}
		const nodeOf = (x: Target): Node => isNode(x) ? x : { path: resolve(x), part: "value" }
		const idOf = (n: Node): Id | undefined => n.id ?? (n.path ? get(places, n.path) : undefined)
		function needId(n: Node): Id {
			const id = idOf(n)
			if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
			return id
		}

		// id placed under name in the folder parent (at path, its name the last): its children entry
		// made when it has none
		function placeUnder(parent: Id, name: string, id: Id, path?: Path) {
			if (path !== undefined) ask("place", slotAt(path, parent))
			const children = table.get("children", parent) as Entry<unknown> | undefined
			if (children === undefined) {
				table.add(
					"children",
					parent,
					createEntry<Record<string, unknown>>({ [name]: id }, header()),
				)
			} else commit(placeIn(children, name, id, header()))
		}
		// a node at path holding value (none: a folder), folders made on the way
		function make(path: Path, value: unknown, id: Id = newId()): Id {
			if (path.length === 0) throw new PlacesError("already-there", "/")
			let parent: Id = places.root
			for (let i = 0; i < path.length - 1; i++) {
				const there = get(places, path.slice(0, i + 1))
				if (there !== undefined) parent = there
				else {
					const folder = newId()
					placeUnder(parent, path[i], folder, path.slice(0, i + 1))
					parent = folder
				}
			}
			ask("place", slotAt(path, parent))
			if (value !== undefined) table.add("value", id, createEntry(value, header()))
			placeUnder(parent, path[path.length - 1], id)
			return id
		}
		// the children entry of the folder a path is in, and the name
		function slot(path: Path): [Entry<unknown>, string] {
			const parent = get(places, path.slice(0, -1))
			const children = parent === undefined ? undefined : table.get("children", parent)
			if (children === undefined || path.length === 0) {
				throw new PlacesError("nothing-there", path.join("/"))
			}
			return [children as Entry<unknown>, path[path.length - 1]]
		}

		function open(p: string | Path, value?: unknown): Node {
			const path = resolve(p)
			if (value !== undefined) {
				within(() => {
					if (get(places, path) === undefined) make(path, value)
				})
				later()
			}
			return { path, part: "value" }
		}

		function create(folder: string | Path, value: unknown): Node {
			const id = newId()
			const path = [...resolve(folder), id]
			within(() => make(path, value, id))
			later()
			return { path, part: "value" }
		}

		function read(x: Target, path: readonly Step[] = []): unknown {
			const n = nodeOf(x)
			const id = idOf(n)
			if (id === undefined) return undefined
			if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
			if (n.part === "value" && memos.has(id)) {
				const v = places.readValue("value", id, path)
				if (v === undefined && places.readValue("attributes", id, [STATUS]) === PENDING) {
					throw PENDING
				}
				return v
			}
			return places.readValue(n.part, id, path)
		}

		// read's, untracked: the value now, nothing to rerun from it
		function peep(x: Target, path: readonly Step[] = []): unknown {
			return places.peep(() => {
				try {
					return read(x, path)
				} catch (e) {
					if (e === PENDING) return undefined
					throw e
				}
			})
		}

		function reads(x: Target, path: readonly Step[] = []): Version[] {
			const n = nodeOf(x)
			const shown = read(n, path)
			const id = idOf(n)
			if (id === undefined) return []
			const items = listed(n.part, id, path)
			if (items === undefined) {
				// nothing open there: what read gives, from its entry's change
				if (shown === undefined) return []
				const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
				const from: Shown = {
					...change?.actor !== undefined && { who: change.actor },
					...change?.time !== undefined && { when: change.time },
					...change?.external !== undefined && { where: change.external },
				}
				return [{ value: shown, from }]
			}
			const marks = (i: Listed) => ({
				...i.gone && { gone: true as const },
				...i.inside && { inside: true as const },
			})
			const [first, ...rest] = items, h = first.from
			const from: Shown = {
				who: h.actor,
				when: h.time,
				...h.external !== undefined && { where: h.external },
				head: h.head,
			}
			return [
				{ value: shown, from, ...marks(first) },
				...rest.map((i): Version => ({
					value: i.value,
					from: {
						kind: "conflict",
						by: undefined,
						head: i.from.head,
						who: i.from.actor,
						signer: i.from.signer,
						when: i.from.time,
						lamport: i.from.lamport,
						...i.from.external !== undefined && { where: i.from.external },
						differs: [n.part as string],
					},
					...marks(i),
				})),
			]
		}
		// sync's items at path, as its "values" at id has them, tracked: the path's own, or the
		// nearest open path's above it, each value at path (none there: gone). none listed: undefined
		function listed(part: Key, id: Id, path: readonly Step[]): Listed[] | undefined {
			const rows = places.readValue("values" as Key, id, [part as string]) as
				| readonly Row[]
				| undefined
			let near: Row | undefined
			for (const r of rows ?? []) {
				if (r.path.length > path.length || !r.path.every((k, i) => k === path[i])) continue
				if (near === undefined || r.path.length > near.path.length) near = r
			}
			if (near === undefined) return undefined
			const rest = path.slice(near.path.length)
			return near.items.map((i) => {
				const value = i.gone ? undefined : dig(i.value, rest)
				return value === undefined ? { ...i, value, gone: true } : { ...i, value }
			})
		}

		function entries(x: Target): Item[] {
			const n = nodeOf(x)
			if (n.path === undefined) {
				if (n.id === undefined) return []
				const value = places.readValue(n.part, n.id)
				return value === undefined ? [] : [{ value, from: "id", id: n.id }]
			}
			const found = gets(places, n.path)
			if (!guarded || n.path.length === 0) {
				return found.map((a) => ({
					value: places.readValue(n.part, a.id),
					from: a.from,
					id: a.id,
				}))
			}
			const name = n.path[n.path.length - 1]
			const asked = guard.members(found.map((a) => ({ name, id: a.id })), n.path.slice(0, -1))
			return found.map((a, i) =>
				asked[i].id === REFUSED
					? { value: undefined, from: a.from, id: REFUSED, refused: true as const }
					: { value: places.readValue(n.part, a.id), from: a.from, id: a.id }
			)
		}

		function list(x: Target): string[] {
			const n = nodeOf(x)
			if (guarded) {
				const id = idOf(n)
				if (id !== undefined) guard.read(targetOf(thing(id, n.path), "children"))
			}
			if (n.path !== undefined) return [...listAt(places, n.path)]
			return n.id === undefined ? [] : places.readKeys("children", n.id)
		}

		const info = (x: Target): Node => ({ ...nodeOf(x), part: "attributes" })

		function edit(x: Target, change: Change, extra?: Info) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				ask("edit", targetOf(thing(id, n.path), n.part))
				const patches = typeof change === "function"
					? produce(table.get(n.part, id)?.value ?? empty(n.part), change as never)
					: change
				if (patches.length) write(n.part, id, patches, extra)
			})
			later()
		}

		// edit's, telling sync what it replaces: every value at each path written, or the ones given
		// (by their heads)
		function edits(x: Target, change: Change, which?: readonly Version[]) {
			const heads = which?.flatMap((v) => typeof v.from.head === "string" ? [v.from.head] : [])
			edit(x, change, { [REPLACES]: heads ?? "all" })
		}

		function watch(x: Target, fn: (w: Watched) => void): () => void {
			const n = nodeOf(x)
			if (n.path === undefined) throw new PlacesError("nothing-there", "a node with no place")
			const stop = places.watchPath(
				n.path,
				(fact: Fact) =>
					fn({ patches: fact.patches, change: fact.change, value: fact.entry?.value }),
				{ part: n.part },
			)
			s.registerTeardown(owner(), stop)
			return stop
		}

		function place(p: string | Path, x: Target) {
			within(() => {
				const path = resolve(p)
				const id = needId(nodeOf(x))
				const parent = get(places, path.slice(0, -1))
				if (parent === undefined || path.length === 0) {
					throw new PlacesError("nothing-there", path.join("/"))
				}
				placeUnder(parent, path[path.length - 1], id, path)
			})
			later()
		}

		function unplace(p: string | Path) {
			within(() => {
				const path = resolve(p)
				const [children, name] = slot(path)
				ask("place", slotAt(path, get(places, path.slice(0, -1))!))
				commit(unplaceIn(children, name, header()))
			})
			later()
		}

		function move(from: string | Path, to: string | Path) {
			within(() => {
				const fromPath = resolve(from)
				const source = slot(fromPath)
				guard.move(fromPath, resolve(to))
				ask("place", slotAt(fromPath, get(places, fromPath.slice(0, -1))!))
				const path = resolve(to)
				const parent = get(places, path.slice(0, -1))
				if (parent === undefined || path.length === 0) {
					throw new PlacesError("nothing-there", path.join("/"))
				}
				if (table.get("children", parent) === undefined) {
					table.add("children", parent, createEntry<Record<string, unknown>>({}, header()))
				}
				ask("place", slotAt(path, parent))
				const into = table.get("children", parent) as Entry<unknown>
				commit(moveIn(source, [into, path[path.length - 1]], header()))
			})
			later()
		}

		function remove(x: Target) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				ask("remove", targetOf(thing(id, n.path)))
				if (n.path !== undefined && n.path.length) {
					const [children, name] = slot(n.path)
					const v = children.value as Record<string, unknown> | undefined
					if (v !== undefined && v[name] === id) commit(unplaceIn(children, name, header()))
				}
				for (const [part] of table.get(id)) table.del(part as Key, id)
				runs.drop(id)
			})
			later()
		}

		// a memo's or effect's code, in place: a run of its owner making it again gives it new code
		type Code = {
			f: (previous: any) => unknown
			act?: (value: any, before: any) => void
			equal?: Equal<any>
		}
		// what is made at each path (its names), by owner: the computer, its node's id, its code
		type Made = { own: Scope; c?: Computer; id: Id; code: Code }
		const named = new Map<string, Set<Made>>()
		const keyOf = (path: Path) => JSON.stringify(path)

		// the one made at path under own: claimed, given new code (a parent's rerun does
		// not destroy its children; two of a name in one run are refused). as own's run starts, what its earlier runs made is old (the scheduler's): one
		// old is claimed; one not old was made in this run (or own has had no run since):
		// already-there. none: a
		// new one is to be made
		function again(own: Scope, path: Path, code: Code): Made | undefined {
			for (const m of named.get(keyOf(path)) ?? []) {
				if (m.own !== own || m.c === undefined || m.c.state !== "alive") continue
				if (!s.claim(m.c)) throw new PlacesError("already-there", path.join("/"))
				m.code = code
				gone(m, path)
				later()
				return m
			}
		}

		// m's node and name go once its computer has: asked again in each run of its owner that
		// makes it (a cleanup of that run: run once the next run is done, it finds the computer
		// claimed, alive, and leaves it), and as the owner goes (what is under it first)
		function gone(m: Made, path: Path) {
			s.registerTeardown(m.own, () => {
				if (m.c?.state === "alive") return
				const there = named.get(keyOf(path))
				if (there?.delete(m) && there.size === 0) named.delete(keyOf(path))
				memos.delete(m.id)
				try {
					const [children, last] = slot(path)
					if ((children.value as Record<string, unknown>)?.[last] === m.id) {
						commit(unplaceIn(children, last, header()))
					}
				} catch (e) {
					if (!(e instanceof PlacesError)) throw e
				}
				for (const [part] of table.get(m.id)) table.del(part as Key, m.id)
				runs.drop(m.id)
			})
		}

		// a computer's node: a new id, placed at path, its scope written (own's NODE key, or the
		// nearest above with one; none: not written); told to named, its node and name gone with it
		function computerNode(own: Scope, path: Path, code: Code): Made {
			const id = newId()
			const above = nodeAbove(own)
			within(() => {
				const parent = get(places, path.slice(0, -1))
				if (parent === undefined) throw new PlacesError("nothing-there", path.join("/"))
				placeUnder(parent, path[path.length - 1], id)
				if (above !== undefined) {
					table.add(
						"attributes",
						id,
						createEntry<Record<string, unknown>>({ [SCOPE]: above }, header()),
					)
				}
			})
			const m: Made = { own, id, code }
			const at = keyOf(path)
			named.set(at, (named.get(at) ?? new Set()).add(m))
			gone(m, path)
			return m
		}

		const same = (m: Made) => (a: unknown, b: unknown) =>
			m.code.equal ? m.code.equal(a, b) : Object.is(a, b)

		function memo<T>(
			name: string | Path,
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			options: { equal?: Equal<T> } = {},
		): Node {
			const own = owner()
			const path = resolve(name)
			const n: Node = { path, part: "value" }
			const code: Code = { f, equal: options.equal }
			if (again(own, path, code)) return n
			const m = computerNode(own, path, code)
			const id = m.id
			memos.add(id)
			const set = (v: T) => {
				if (v !== undefined || table.get("value", id) !== undefined) {
					write("value", id, whole(v))
				}
			}
			const c = s.runWithScope(
				own,
				() =>
					sited.createComputer<T>(
						(previous) => m.code.f(previous) as T,
						set,
						same(m),
						undefined,
						{ [NODE]: id },
					),
			)
			m.c = c
			statuses.give(c, id)
			runs.give(c, id)
			setup.notice?.({ kind: "memo", computer: c, node: n, id, process: process.id })
			later()
			return n
		}

		function effect<T>(
			name: string | Path,
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, before: T | undefined) => void,
			options: { equal?: Equal<T> } = {},
		): Node {
			return effectOf(false, name, f, act, options)
		}

		function early<T>(
			name: string | Path,
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, before: T | undefined) => void,
			options: { equal?: Equal<T> } = {},
		): Node {
			return effectOf(true, name, f, act, options)
		}

		// an effect, early or not. an early one runs, and acts, inside createEffect: before its
		// computer is given back, so its first run gives the status and the run record its node, from
		// inside it (runs.ts: a run given while it ran). made again: claimed, its first run after
		// the claim in the round's runs, its act in its queue (open: a claim is not a making)
		function effectOf<T>(
			early: boolean,
			name: string | Path,
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, before: T | undefined) => void,
			options: { equal?: Equal<T> },
		): Node {
			const own = owner()
			const path = resolve(name)
			const n: Node = { path, part: "value" }
			const code: Code = { f, act, equal: options.equal }
			if (again(own, path, code)) return n
			const m = computerNode(own, path, code)
			const id = m.id
			let given = false
			const run = (previous: T | undefined) => {
				if (!given) {
					given = true
					const c = s.getRun()!.computer
					statuses.give(c, id)
					runs.give(c, id)
				}
				return m.code.f(previous) as T
			}
			const then = (v: T, before: T | undefined) => {
				if (v !== undefined || table.get("value", id) !== undefined) {
					write("value", id, whole(v))
				}
				m.code.act!(v, before)
			}
			const c = s.runWithScope(
				own,
				() =>
					early
						? sited.createEffect<T>(run, then, same(m), { early }, { [NODE]: id })
						: sited.createEffect<T>(
							(previous) => m.code.f(previous) as T,
							then,
							same(m),
							undefined,
							{ [NODE]: id },
						),
			)
			m.c = c
			statuses.give(c, id)
			runs.give(c, id)
			setup.notice?.({ kind: "effect", computer: c, node: n, id, process: process.id })
			later()
			return n
		}

		function method(p: string | Path, fn: (...args: any[]) => unknown): Node {
			methods.set(fn, owner())
			const path = resolve(p)
			const made = within(() => {
				const id = get(places, path)
				if (id === undefined) return make(path, fn)
				ask("edit", targetOf(thing(id, path), "value"))
				write("value", id, whole(fn))
				return id
			})
			const n: Node = { path, part: "value" }
			setup.notice?.({ kind: "method", node: n, id: made, process: process.id })
			later()
			return n
		}

		function send(p: Target, ...args: unknown[]): unknown {
			const n = nodeOf(p)
			const id = idOf(n)
			const fn = id === undefined ? undefined : table.get("value", id)?.value
			if (typeof fn !== "function") {
				throw new SendError("not-a-method", n.path?.join("/") ?? String(n.id))
			}
			const call = sited.createScope(
				{ ...setup.info?.(), caller: process.id },
				methods.get(fn) ?? scope,
			)
			try {
				s.runWithScope(call, () => ask("execute", targetOf(thing(id!, n.path), "value")))
				return s.runWithScope(call, () => fn(...args))
			} finally {
				s.teardown(call)
				later()
			}
		}

		function teardown(fn: (why: Why) => unknown) {
			s.registerTeardown(
				owner(),
				() => fn(whys.get(scope) ?? (scope.state === "alive" ? "replaced" : "ended")),
			)
		}

		function ref<T>(p: string | Path, made: () => T): Node {
			const path = resolve(p)
			within(() => {
				if (get(places, path) === undefined) make(path, made())
			})
			later()
			return { path, part: "value" }
		}

		function start(
			program: string | Way,
			where: string | Path,
			options: {
				box?: BoxNode
				args?: readonly string[]
				cwd?: string | Path
				onwhynot?: (why: Whynot) => void
			} = {},
		): Process | Refusal {
			const target = options.box?.box ?? home
			const path = options.box ? inside(where) : resolve(where)
			const dir = options.cwd === undefined
				? undefined
				: options.box
				? inside(options.cwd)
				: resolve(options.cwd)
			let way: Way | undefined
			const why: Whynot[] = []
			if (typeof program !== "string") way = program
			else {
				const onwhynot = (w: Whynot) => (why.push(w), options.onwhynot?.(w))
				const from = target === home ? cwd : []
				for (const w of satisfy(target.places, program, from, { onwhynot })) {
					way = w
					break
				}
			}
			if (way === undefined) return { refused: "no-way", why }
			const more = {
				...(options.args === undefined ? {} : { args: options.args }),
				...(dir === undefined ? {} : { cwd: dir }),
			}
			const found = way
			const p = within(() => programs().start(target, found, path, more))
			if (!("refused" in p)) {
				s.registerTeardown(scope, () => stop(p, whys.get(scope) ?? "ended"))
			}
			later()
			return p
		}

		function openwith(
			x: Target,
			options: { onwhynot?: (why: Whynot) => void } = {},
		): Generator<Way, void> {
			return openwithIn(places, needId(nodeOf(x)), cwd, options)
		}

		function box(where: string | Path): BoxNode {
			const b = within(() => createBox(setup.host, resolve(where), home, header()))
			later()
			return {
				box: b,
				place: (p, y) => {
					within(() => void boxInto(b, p, needId(nodeOf(y)), header()))
					later()
				},
				unplace: (p) => {
					within(() => void unbox(b, p, header()))
					later()
				},
			}
		}

		function world(): PresenceWorld {
			if (setup.presence === undefined) throw new Error("no presence here: the host gave none")
			return setup.presence
		}
		function presence(x: Target): Live[] {
			const n = nodeOf(x)
			const id = idOf(n)
			if (id === undefined) return []
			if (guarded) guard.read(targetOf(thing(id, n.path), "presence" as Key))
			return readPresence(world(), id)
		}
		function present(x: Target, value: unknown, options: { ttl?: number; who?: string } = {}) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				ask("edit", targetOf(thing(id, n.path), "presence" as Key))
				setPresence(
					world(),
					id,
					options.who ?? setup.who ?? String(process.id),
					value,
					options.ttl ?? 10_000,
				)
			})
			later()
		}
		function absent(x: Target, options: { who?: string } = {}) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				ask("edit", targetOf(thing(id, n.path), "presence" as Key))
				clear(world(), id, options.who ?? setup.who ?? String(process.id))
			})
			later()
		}

		function patch(p: string | Path, over: Target, change: Change): Node {
			const path = resolve(p)
			within(() => {
				const o = nodeOf(over)
				const on = needId(o)
				const base = table.get(o.part, on) as Entry<unknown> | undefined
				const patches = typeof change === "function"
					? produce(base?.value ?? empty(o.part), change as never)
					: change
				const node: PatchNode = { on, part: o.part, at: base?.change.time ?? 0, patches }
				const id = get(places, path) ?? make(path, undefined)
				write("patch", id, whole(node))
			})
			later()
			return { path, part: "value" }
		}
		function land(p: Target) {
			within(() => {
				const id = needId(nodeOf(p))
				const v = table.get("patch", id)?.value
				if (v !== undefined) ask("edit", targetOf(thing(v.on), v.part))
				commit(landIn(table, id, header()))
			})
			later()
		}
		function layers(x: Target, path: readonly Step[] = []): Layer[] {
			const n = nodeOf(x)
			const id = idOf(n)
			if (id === undefined) return []
			if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
			if (setup.overlay !== undefined) return layersOf(places, setup.overlay, n.part, id, path)
			const value = places.readValue(n.part, id, path)
			return value === undefined ? [] : [{ value, from: "table" }]
		}

		const api: API = {
			open,
			create,
			read,
			peep,
			reads,
			entries,
			list,
			info,
			edit: (x: Target, change: Change) => edit(x, change),
			edits,
			watch,
			place,
			unplace,
			move,
			remove,
			memo,
			effect,
			early,
			method,
			send,
			teardown,
			ref,
			start,
			stop: (p) => stop(p, "ended"),
			openwith,
			box,
			presence,
			present,
			absent,
			patch,
			land,
			layers,
			args: process.args,
			pulse: () => s.pulse(),
			PENDING,
			REFUSED,
		}
		const key = {}
		inners.set(key, { id: process.id, scope })
		Object.defineProperty(api, PROCESS, { value: key, enumerable: true })
		return api
	}

	const runner: ProcessContext["runner"] = (options = {}) => {
		const { show } = options
		const make = options.api ?? createAPI
		// the program run with api; inner its process (none: an api of no process here, nothing kept)
		const go = (code: unknown, api: unknown, inner?: { id: Id; scope: Scope }): Told => {
			const f = typeof code === "function" ? code : (code as { default?: unknown } | null)?.default
			if (typeof f !== "function") throw new TypeError("not a program: no function, no default")
			const made = f(api)
			const value = show === undefined ? made : show(made, api as API)
			if (inner !== undefined && value !== undefined) {
				s.runWithScope(inner.scope, () => write("value", inner.id, whole(value)))
				later()
			}
			return { stop: (reason?: unknown) => void (inner && tell(inner.scope, reason)) }
		}
		const run = (code: unknown, api: unknown) => {
			const key = isMap(api) ? api[PROCESS] : undefined
			return go(code, api, isMap(key) ? inners.get(key) : undefined)
		}
		return Object.assign(run, {
			start: (code: unknown, start: Start) =>
				go(code, make(start), { id: start.process.id, scope: start.scope }),
			api: make,
		})
	}

	return { createAPI, run: runner(), runner, stop, runs: runs.read }
}
