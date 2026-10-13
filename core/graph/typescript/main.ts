// the graph: newcore's libraries hooked up. it holds the table, places, a trackgraph and one notify
// per node; no library knows another. places says what a read rested on (depend), the graph tracks
// it in the trackgraph and asks that node's notify to watch it; mutate tells the graph each patch
// (patched), the graph tells the node's notify, and notify's reads mark the owners that read there.
//
// an owner is anything that reads tracked (the scheduler's processes); the graph knows nothing of
// it but that it read, and tells marked when a change reached what it read. ephemeral nodes may
// have an owner too. protect is asked as the actor before each operation through bound.
import createChange, { type Change, type ChangeHeader } from "@ermine/change"
import type { Which } from "@ermine/op/mutate"
import createNode, { type Node, type Side } from "@ermine/node"
import {
	createNotify,
	type Facts,
	facts,
	type Patch,
	type Read as Watch,
} from "@ermine/scheduler/notify"
import {
	createPlaces,
	type Depend,
	type Item,
	type Part,
	type Place,
	PlacesError,
	type Span,
	type Step,
	type Where,
} from "@ermine/places"
import {
	type Answer,
	anyone,
	type Ask,
	check,
	edit,
	list as listAsk,
	type May,
	pass as passing,
	placing,
	read as readAsks,
	type Which as Object,
} from "@ermine/protect"
import { capture, type FileLocation } from "@ermine/util/stacktrace"
import { createTable } from "./table.ts"
import { createTracker, type Node as Track } from "@ermine/scheduler/tracker"

type N = Node<unknown, Change>
type V = Side<unknown, Change>

export class GraphError extends Error {
	// refused: protect's why, or {code: "pending"} where it did not know yet
	constructor(readonly code: string, message?: string, readonly why?: unknown) {
		super(message === undefined ? code : `${code}: ${message}`)
	}
}

// a change that marked an owner: its where and header (SCHEDULER.tex, Marks)
export type By = ChangeHeader & { node: string; which?: Which | "loaded" }

// one object a change changed (WIRING.tex, Out): the patches mutate applied, in order; at: the
// version, the span of versions replaced by the one made, or the versions popped
export type Changed = {
	node: string
	object: Which
	patches: Patch[]
	header: ChangeHeader
	at: number | readonly [number, number] | { pop: Span }
	ephemeral: boolean
}

// who a change is by, as places asks for it
export type Acting = {
	actor: unknown
	reader?: string
	cause?: unknown
	site?: ChangeHeader["external"]
	message?: string
}

// what the host and code act through: reads, and writes unless read only. where: an address,
// or an id (places.ts, Where)
export type Api = {
	// the whole node of an id; none: not loaded, or refused
	node(id: string): Node<unknown, Change> | undefined
	look(address: Where): Item<unknown, Change>[]
	lookup(path: readonly string[]): Item<unknown, Change>[]
	lookups(path: readonly string[]): Item<unknown, Change>[]
	children(address: Where, name?: string): Item<unknown, Change>[] | string[]
	// the names of a node's info or children, in order (children(address) is names(address, "children"))
	names(address: Where, part: "info" | "children"): string[]
	content(address: Where): (Item<unknown, Change> & { versions?: V[] })[]
	info(address: Where, name: string): (Item<unknown, Change> & { versions?: V[] })[]
	write(address: Where, patches: Iterable<Patch>, index?: number, slotindex?: Span): Change
	set(
		address: Where,
		name: string,
		patches: Iterable<Patch>,
		index?: number,
		slotindex?: Span,
	): Change
	insert(id: string, name: string, child: string, index?: Span, slotindex?: Span): Change
	remove(id: string, name: string, index: Span, slotindex?: Span): Change
	pop(id: string, name: string, slotindex: Span): Change
	rename(id: string, name: string, to: string): Change[]
	move(
		id: string,
		name: string,
		index: number,
		toid: string,
		toname: string,
		toindex?: number,
	): Change[]
	// a new node holding value (none: no value); an owner may make it ephemeral
	create(value?: unknown, options?: { id?: string; ephemeral?: boolean }): string
	// the same interface, its changes carrying cause and message
	as(o: { cause?: unknown; message?: string }): Api
}

// a read, given what to track it with (none: untracked)
export type Read = (depend?: Depend) => unknown
export type ReadArgs = { address?: Where; name?: string }

// an interface: at a place, as an actor; it stops when alive says so
export type Bind<O> = {
	place: Place
	agent: unknown
	reader?: string
	cause?: unknown
	message?: string
	// the caller's site captured on each change: the host's
	site?: boolean
	depend?: Depend
	writes: boolean
	alive: () => boolean
	// may make, place and move ephemeral nodes, owning those it makes
	owner?: O
	// what changes are made with: given to marked; and own, not marked by them
	tag?: unknown
	// the times of the changes made, pushed
	wrote?: number[]
	// around each read (default: run it tracked by depend), and each change (default: run it)
	reading?: (op: string, read: Read, args: ReadArgs) => unknown
	around?: <T>(f: () => T) => T
}

// what a tracked reader is given: depend to track with, and its trackgraph node's begin/end/untrack
export type Reader = { depend: Depend; begin(): void; end(): void; untrack(): void }

// what tracks reads (default: trackgraph.ts): a node per owner and per spot read; a run's reads
// between begin and end; the owners reading a spot
export type Tracker<W, T> = {
	node(owner: W): T
	begin(t: T): void
	track(t: T, to: T): void
	end(t: T): void
	untrack(t: T): void
	owners(t: T): readonly W[]
}
// what a tracker's node is made for: an owner, or a spot (a part of a node read)
export type Tracked<O> = { owner: O } | { spot: { id: string; part: Part } }

function trackgraph<W>(): Tracker<W, Track<W>> {
	const t = createTracker<W>()
	return { ...t, owners: (n) => t.readers(n).map((l) => l.from.owner) }
}

export type Options<O> = {
	// the root: the host's node, restored or new; its id is where paths start
	root: Node<unknown, Change>
	// who the host's own changes are by
	actor?: unknown
	// the last time given; each change takes the next
	clock?: { time: number }
	// a fresh id for a node made at a time; "@" and the time if not given
	id?: (time: number) => string
	// who may do what (protect.ts); default anyone
	may?: May
	// a change reached what owner read; tag: what it was made with
	marked?: (owner: O, by: By, tag: unknown) => void
	// an ephemeral node now owned by owner
	owned?: (owner: O, id: string) => void
	// a node gone, and its owner if ephemeral: before its loaded readers are marked
	released?: (id: string, owner: O | undefined) => void
	// what tracks reads; default trackgraph.ts
	// deno-lint-ignore no-explicit-any
	tracker?: Tracker<Tracked<O>, any>
	// the host's site for its changes; default read off the call stack
	site?: () => FileLocation | undefined
	// the author's clock stamped on each change made, whole seconds since 1970; none: no stamp
	wallclock?: () => number | undefined
	// told, after an operation lands, each object it changed; not by `versions`, and not for an
	// operation refused or that throws
	changed?: (record: Changed) => void
}

// the files a site is not in
export const ours: ReadonlySet<string> = new Set([
	import.meta.url,
	...[
		"core/scheduler/typescript/scheduler.ts",
		"core/scheduler/typescript/order.ts",
		"core/scheduler/typescript/rank.ts",
		"core/scheduler/typescript/records.ts",
		"core/scheduler/typescript/processes.ts",
		"core/scheduler/typescript/notify.ts",
		"ermine/programs/typescript/handlers.ts",
		"ermine/programs/typescript/code.ts",
		"core/places/typescript/places.ts",
		"core/op/typescript/apply.ts",
		"core/node/typescript/update.ts",
		"core/node/typescript/node.ts",
		"core/graph/typescript/table.ts",
		"core/scheduler/typescript/tracker.ts",
		"core/util/typescript/stacktrace.ts",
	].map((f) => new URL(`../../../${f}`, import.meta.url).href),
])

export function pidOf(time: number): string {
	return `@${time}`
}

const sameWhich = (a: Which, b: Which) =>
	typeof a === "string" || typeof b === "string"
		? a === b
		: a.length === b.length && a.every((x, i) => x === b[i])
const whichKey = (w: Which) => (typeof w === "string" ? w : w.join("\u0000"))
const pathOf = (w: Which): string[] => (typeof w === "string" ? [w] : [...w])

// a spot: a part of a node something read; a trackgraph node's owner: an owner, or a spot
type Spot<O> = { id: string; part: Part; track: unknown; watch?: Watch }
// a node's spots: loaded, value and its names as fields; its lists' and infos' by name
type Spots<O> = {
	loaded?: Spot<O>
	value?: Spot<O>
	names?: Spot<O>
	infonames?: Spot<O>
	children?: Map<string, Spot<O>>
	info?: Map<string, Spot<O>>
}
type Own<O> = { owner: O } | { spot: Spot<O> }

// a map as a plain object's own keys, read through
function through(m: ReadonlyMap<string, unknown>): Record<string, unknown> {
	return new Proxy({}, {
		get: (_, k) => (typeof k === "string" ? m.get(k) : undefined),
		has: (_, k) => typeof k === "string" && m.has(k),
		ownKeys: () => [...m.keys()],
		getOwnPropertyDescriptor: (_, k) =>
			typeof k === "string" && m.has(k)
				? { value: m.get(k), enumerable: true, configurable: true, writable: false }
				: undefined,
	})
}

export function createGraph<O>(options: Options<O>) {
	const clock = options.clock ?? { time: 0 }
	const fresh = options.id ?? pidOf
	const hostActor = options.actor ?? "host"
	const may = options.may ?? anyone

	const table = createTable<unknown, Change>()
	const tracks = (options.tracker ?? trackgraph()) as Tracker<Own<O>, unknown>

	// who the changes now being made are by; set around each operation
	let acting: Acting | undefined
	// whether mutate's patches are heard, or the operation is told to notify whole
	let hearing = true
	type Heard = { patch: Patch; facts: Facts; id: string; which: Which; header: ChangeHeader }
	const heard: Heard[] = []
	const made: ChangeHeader[] = []
	// told whole instead: which change touched each object, so each is told by its own. few: a list,
	// the latest last
	type Touch = { id: string; which: Which; h: ChangeHeader }
	let touched: Touch[] | undefined
	function by(): ChangeHeader {
		if (acting === undefined) throw new Error("a change made outside an operation")
		const h: ChangeHeader = { ...acting, time: ++clock.time }
		const w = options.wallclock?.()
		if (w !== undefined) h.wallclock = w
		made.push(h)
		type Told = (patch: Patch, facts: Facts, id: string, which: Which) => void
		let told: Told | undefined = hear
		if (!hearing) {
			const t = touched
			told = t && ((_p, _f, id, which) => void t.push({ id, which, h }))
		}
		// the operation's changed records: each change's patches, in order
		if (log) {
			const entry: Entry = { header: h, patches: [] }
			log.push(entry)
			const was = told
			told = (patch, f, id, which) => {
				entry.patches.push(patch)
				was?.(patch, f, id, which)
			}
		}
		return told ? { ...h, patched: told } as ChangeHeader : h
	}
	// the changes an operation makes, in order, kept while it runs when `changed` is given
	type Entry = { header: ChangeHeader; patches: Patch[] }
	let log: Entry[] | undefined
	const hear = (patch: Patch, facts: Facts, id: string, which: Which) =>
		void heard.push({ patch, facts, id, which, header: made[made.length - 1] })

	const places = createPlaces<unknown, Change>(table.get, options.root.id, { by })

	const ephemeral = new Set<string>()
	const owners = new Map<string, O>()

	// spots and notify: what was read, and the watch on it

	const spots = new Map<string, Spots<O>>()
	const notifies = new Map<string, ReturnType<typeof createNotify>>()

	// a node as notify walks it, every version: info and children read through to the node's
	// maps, never copied
	function view(n: N): Record<string, unknown> {
		return { value: n.value, info: through(n.attributes), children: through(n.children) }
	}

	// one object of a node before a patch at path, as facts reads it: that path alone
	function before(path: string[], vs: V[] | undefined): Record<string, unknown> {
		if (path[0] === "value") return { value: vs ?? [] }
		return { [path[0]]: vs === undefined || vs.length === 0 ? {} : { [path[1]]: vs } }
	}

	function spot(id: string, part: Part): Spot<O> {
		let n = spots.get(id)
		if (n === undefined) spots.set(id, n = {})
		if (part === "loaded") return n.loaded ??= newSpot(id, part)
		if (part === "value") return n.value ??= newSpot(id, part)
		if (part.length === 1) {
			return part[0] === "info" ? n.infonames ??= newSpot(id, part) : n.names ??= newSpot(id, part)
		}
		const m = part[0] === "children" ? (n.children ??= new Map()) : (n.info ??= new Map())
		let s = m.get(part[1])
		if (s === undefined) m.set(part[1], s = newSpot(id, part))
		return s
	}
	function newSpot(id: string, part: Part): Spot<O> {
		const s: Spot<O> = { id, part, track: undefined }
		s.track = tracks.node({ spot: s })
		watch(s)
		return s
	}
	// every spot of a node
	function* spotsOf(id: string): Iterable<Spot<O>> {
		const n = spots.get(id)
		if (n === undefined) return
		if (n.loaded) yield n.loaded
		if (n.value) yield n.value
		if (n.names) yield n.names
		if (n.infonames) yield n.infonames
		if (n.children) yield* n.children.values()
		if (n.info) yield* n.info.values()
	}

	// notify watches what is read: an object deep, a node's names not
	function watch(s: Spot<O>) {
		if (s.watch || s.part === "loaded") return
		const n = table.get(s.id)
		if (!n) return
		let nf = notifies.get(s.id)
		if (!nf) notifies.set(s.id, nf = createNotify(() => view(n)))
		const path = s.part === "value" ? ["value"] : [...s.part]
		const names = path.length === 1 && path[0] !== "value"
		s.watch = nf.read(path, { deep: !names })
		s.watch.on(() => fire(s))
	}

	// the change being told, for the marks it makes
	let telling: { by: By; tag?: unknown; own?: O } | undefined

	// readers of a spot: marked by the change being told
	function fire(s: Spot<O>) {
		if (!telling) return
		for (const o of tracks.owners(s.track)) {
			if (!("owner" in o) || o.owner === telling.own) continue
			options.marked?.(o.owner, telling.by, telling.tag)
		}
	}

	function tell(id: string, patch: Patch, f: Facts | (() => Facts)) {
		const nf = notifies.get(id)
		if (nf) nf.patched(patch, typeof f === "function" ? f() : f)
	}

	// a whole object of a node, from old versions to what it has now
	function whole(n: N, which: Which, old: V[] | undefined) {
		const path = pathOf(which)
		const now = versionsOf(n, which)
		if ((old?.length ?? 0) === 0 && now.length === 0) return
		const patch: Patch = now.length ? { path, value: now } : { path }
		tell(n.id, patch, () => facts(patch, before(path, old)))
	}

	function versionsOf(n: N, which: Which): V[] {
		if (which === "value") return n.value
		const m = (which[0] === "info" ? n.attributes : n.children) as Map<string, V[]>
		return m.get(which[1]) ?? []
	}

	// whether the object was there before the change, from its first patch's facts: a patch
	// below [] needs it there; an empty list is none
	function existed(h: Heard): boolean {
		if (h.patch.path.length > 0) return true
		const list = h.which !== "value" && h.which[0] === "children"
		if (h.patch.range === undefined) return h.facts.place.had
		return list ? h.facts.place.length > 0 : true
	}

	// what mutate told, to notify: each patch under its version, or the object whole where a
	// version was made or went
	function flush(slot: number | null) {
		if (heard.length === 0) return
		const all = heard.splice(0)
		for (let i = 0; i < all.length;) {
			const first = all[i]
			let j = i + 1
			while (
				j < all.length && all[j].id === first.id &&
				whichKey(all[j].which) === whichKey(first.which) &&
				all[j].header === first.header
			) j++
			const group = all.slice(i, j)
			i = j
			const n = table.get(first.id)
			if (!n) continue
			telling!.by = { ...first.header, node: first.id, which: first.which }
			const now = versionsOf(n, first.which)
			const was = existed(first)
			const at = slot ?? -1
			const mine = at >= 0 ? now[at] : undefined
			if (mine && was && mine.change?.time === first.header.time) {
				// the facts hold under the prefix: at [], the version map, "content" there
				const pre = [...pathOf(first.which), at, "content"]
				for (const h of group) {
					const patch: Patch = { ...h.patch, path: [...pre, ...h.patch.path] }
					if (h.patch.move) {
						patch.move = { ...h.patch.move, path: [...pre, ...h.patch.move.path] }
					}
					tell(n.id, patch, h.facts)
				}
				continue
			}
			// made or gone: the object whole. its old first content is not kept, only that it was
			const rest = now.filter((v) => v.change?.time !== first.header.time)
			const old = was ? [{ content: null, change: undefined as unknown as Change }, ...rest] : rest
			whole(n, first.which, old)
		}
	}

	// an operation making changes: by whom, then notify told, the readers marked.
	// slot: the version patched (null: none told by patch); snap: objects told whole instead
	function changing<T>(
		who: Acting,
		o: {
			tag?: unknown
			own?: O
			wrote?: number[]
			slot?: number | null
			snap?: [string, Which][]
		},
		f: () => T,
	): T {
		const wasActing = acting, wasHearing = hearing, wasTelling = telling, wasTouched = touched
		const snap = o.snap
		// told whole: each object's versions before
		let snaps: { n: N | undefined; which: Which; old: V[] | undefined }[] | undefined
		if (snap !== undefined) {
			snaps = []
			for (const [id, which] of snap) {
				const n = table.get(id)
				snaps.push({ n, which, old: n ? versionsOf(n, which) : undefined })
			}
		}
		acting = who
		hearing = snap === undefined
		const touches = touched = hearing ? undefined : []
		const start = made.length
		let out: T
		try {
			out = f()
		} catch (e) {
			heard.length = 0
			made.length = start
			throw e
		} finally {
			acting = wasActing
			hearing = wasHearing
			touched = wasTouched
		}
		const end = made.length
		// nothing made: nothing to tell
		if (end === start && heard.length === 0) return out
		const header = made[end - 1]
		// changed (WIRING.tex, Out): an operation of the api reports its own records (log);
		// any other change reports them here, so every change makes them, the scheduler's too
		const reports: Changed[] | undefined = options.changed && log === undefined ? [] : undefined
		if (reports && snaps === undefined) {
			for (let i = 0; i < heard.length;) {
				const first = heard[i]
				const patches: Patch[] = []
				let j = i
				while (
					j < heard.length && heard[j].id === first.id && heard[j].header === first.header &&
					whichKey(heard[j].which) === whichKey(first.which)
				) patches.push(heard[j++].patch)
				reports.push({
					node: first.id,
					object: first.which,
					patches,
					header: first.header,
					at: typeof o.slot === "number" ? o.slot : 0,
					ephemeral: ephemeral.has(first.id),
				})
				i = j
			}
		}
		if (o.wrote) { for (let i = start; i < end; i++) o.wrote.push(made[i].time!) }
		made.length = start
		// by: set for each object told, before it is told
		telling = { by: undefined as unknown as By, tag: o.tag, own: o.own }
		try {
			if (snaps === undefined) flush(o.slot === undefined ? 0 : o.slot)
			else {
				for (const sn of snaps) {
					if (!sn.n) continue
					const h = touchOf(touches!, sn.n.id, sn.which) ?? header
					telling.by = { ...h, node: sn.n.id, which: sn.which }
					if (versionsOf(sn.n, sn.which) !== sn.old) {
						whole(sn.n, sn.which, sn.old)
						// told whole, so sent whole: the first version put, or the object removed
						const now = versionsOf(sn.n, sn.which)
						const content = now[0]?.content
						reports?.push({
							node: sn.n.id,
							object: sn.which,
							patches: content === undefined ? [{ path: [] }] : [{ path: [], value: content }],
							header: h,
							at: 0,
							ephemeral: ephemeral.has(sn.n.id),
						})
					}
				}
			}
		} finally {
			telling = wasTelling
		}
		for (const r of reports ?? []) options.changed!(r)
		return out
	}

	// the change that last touched an object, told whole
	function touchOf(touches: Touch[], id: string, which: Which): ChangeHeader | undefined {
		for (let i = touches.length - 1; i >= 0; i--) {
			const t = touches[i]
			if (t.id === id && sameWhich(t.which, which)) return t.h
		}
	}

	// changed: one record per change made, each at its target
	type Target = [node: string, object: Which, at: Changed["at"]]
	function report(entries: Entry[], targets: Target[]) {
		for (let i = 0; i < entries.length && i < targets.length; i++) {
			const [node, object, at] = targets[i]
			const { header, patches } = entries[i]
			options.changed!({ node, object, patches, header, at, ephemeral: ephemeral.has(node) })
		}
	}

	// INTERNAL AND DANGEROUS (WIRING.tex, In): not in Api, so never in what hosts and programs get.
	// Only sync calls it, and only with APPLY.tex's versions of that object, from the histories. It
	// throws away the object's versions and puts list in their place, local ones included: anything
	// not in list is gone. It is not a patch: no mutate, so nothing checks that list follows from
	// what was there. protect is not asked: sync is a privileged runner. It makes no record, so what
	// it writes is never sent: called with anything but what the histories say, the device silently
	// differs from every other until a blop for that object is taken in, and a change made in
	// between is committed against the wrong version.
	// from: the blop just taken in; its header marks the readers, its cause wrapped as
	// {sync: {signer, name}, cause}. Versions already there (the same place) are kept as they are;
	// the others get the time of this one change from elsewhere
	function versions(
		id: string,
		which: Which,
		list: V[],
		from?: Omit<ChangeHeader, "time"> & { signer: string; name: string },
	) {
		const n = table.get(id)
		if (!n) return
		const old = versionsOf(n, which)
		const place = (v: V) => (v.because as { place?: { name?: string } } | undefined)?.place?.name
		if (
			list.length === old.length &&
			list.every((v, i) => place(v) !== undefined && place(v) === place(old[i]))
		) {
			return
		}
		const time = ++clock.time
		const now = list.map((v) => {
			const p = place(v)
			return (p !== undefined && old.find((o) => place(o) === p)) ||
				{ ...v, change: { ...v.change, time } }
		})
		if (which === "value") n.value = now
		else {
			const m = (which[0] === "info" ? n.attributes : n.children) as Map<string, V[]>
			if (now.length === 0) m.delete(which[1])
			else m.set(which[1], now)
		}
		let header: Omit<ChangeHeader, "time"> & { signer?: string; name?: string } | undefined = from
		if (!header) {
			const v = list.find((v) => v.because !== undefined)
			const why = (v?.because as { why?: { signer?: string } } | undefined)?.why
			if (v && place(v) !== undefined) {
				header = { ...v.change, signer: why?.signer, name: place(v) }
			}
		}
		const { signer, name, time: _t, node: _n, ...rest } = (header ?? { actor: hostActor }) as
			& ChangeHeader
			& { signer?: string; name?: string; node?: string }
		const cause = signer === undefined
			? rest.cause
			: { sync: { signer, name }, ...(rest.cause === undefined ? {} : { cause: rest.cause }) }
		const by: By = { ...rest, time, node: id, which }
		if (cause !== undefined) by.cause = cause
		else delete by.cause
		const was = telling
		telling = { by }
		try {
			whole(n, which, old)
		} finally {
			telling = was
		}
	}

	// loading: a node in, or out

	function loaded(id: string, change: By) {
		const s = spots.get(id)?.loaded
		if (!s) return
		const was = telling
		telling = { by: change }
		try {
			fire(s)
		} finally {
			telling = was
		}
	}

	// time: a node made now is loaded by its making's change
	function intro(node: N, who: Acting = { actor: hostActor }, time = ++clock.time) {
		table.intro(node)
		for (const s of spotsOf(node.id)) watch(s)
		loaded(node.id, { ...who, time, node: node.id, which: "loaded" })
	}

	// no longer loaded: not ephemeral, owned by none; its loaded readers marked by cause
	function release(id: string, cause: By) {
		if (!table.get(id)) return
		table.outro(id)
		notifies.delete(id)
		for (const s of spotsOf(id)) s.watch = undefined
		ephemeral.delete(id)
		const owner = owners.get(id)
		owners.delete(id)
		options.released?.(id, owner)
		loaded(id, cause)
	}

	// a node made, as the acting one: loaded, not yet placed. owner: it is ephemeral, owned by
	// that owner (true: by none). With a value, a record (WIRING.tex, Out)
	function make(
		id: string | undefined,
		value: unknown,
		who: Acting,
		has = true,
		owner?: O | true,
	): string {
		const time = clock.time + 1
		let pid = id ?? fresh(time)
		if (id === undefined) { for (let k = 1; table.get(pid); k++) pid = `${fresh(time)}-${k}` }
		const header: ChangeHeader = { ...who, time: ++clock.time }
		const w = options.wallclock?.()
		if (w !== undefined) header.wallclock = w
		const change = createChange(pid, header)
		const node = createNode<unknown, Change>(
			pid,
			has ? { value: [{ content: value, change }] } : {},
			{ header },
		)
		intro(node, who, header.time)
		if (owner !== undefined) own(pid, owner === true ? undefined : owner)
		if (options.changed && has && value !== undefined) {
			options.changed({
				node: pid,
				object: "value",
				patches: [{ path: [], value }],
				header,
				at: 0,
				ephemeral: ephemeral.has(pid),
			})
		}
		return pid
	}

	// an ephemeral node, owned by owner if given
	function own(id: string, owner?: O) {
		ephemeral.add(id)
		if (owner === undefined) return
		owners.set(id, owner)
		options.owned?.(owner, id)
	}

	// what owner reads tracked through
	function reader(owner: O): Reader {
		const t = tracks.node({ owner })
		return {
			depend: (id, part) => tracks.track(t, spot(id, part).track),
			begin: () => tracks.begin(t),
			end: () => tracks.end(t),
			untrack: () => tracks.untrack(t),
		}
	}

	// protect: asked as the actor, before each operation not the graph's own. the policy's
	// own reads are the asker's: tracked when it is

	const policyRead = (depend?: Depend) => (id: string) => {
		depend?.(id, "loaded")
		const n = table.get(id)
		if (!n) return undefined
		depend?.(id, "value")
		return n.value.length && n.value[0].content !== undefined ? { value: n.value[0].content } : {}
	}
	const ask = (actor: unknown, asks: Iterable<Ask>, depend?: Depend): Answer =>
		check(may, actor, asks, policyRead(depend)).answer
	function allowed(answer: Answer, op: string) {
		if ("yes" in answer) return
		const why = "no" in answer ? answer.no : { code: "pending" }
		throw new GraphError("refused", `${op}: ${why.code}`, why)
	}
	// asked as actor; refused: thrown
	const asking = (actor: unknown, asks: Iterable<Ask>, op: string) => allowed(ask(actor, asks), op)

	// items as the actor may have them: passing each step of its route, and reading the object
	// read; refused: no node, and why; pending: no node
	function guard<T extends { id: string; route: Step[]; node?: unknown }>(
		items: T[],
		actor: unknown,
		depend?: Depend,
		object?: Object,
	): T[] {
		return items.map((it) => {
			const asks = passing(it.route)
			if (it.node && object) asks.push({ op: "read", args: { node: it.id, object } })
			// no one object asked for: the whole node goes out, so every object is read
			else if (it.node) asks.push(...readAsks(it.node as Parameters<typeof readAsks>[0]))
			const a = ask(actor, asks, depend)
			if ("yes" in a) return it
			const { node: _n, versions: _v, ...rest } = it as T & { versions?: unknown }
			const out = rest as unknown as T & { refused?: unknown }
			if ("no" in a) out.refused = a.no
			return out
		})
	}

	// what reaching a node to write it asks: passing its route, then the edit
	function writing(
		pl: Place,
		address: Where,
		index: number | undefined,
		object: Object,
		slotindex: Span | undefined,
	): Ask[] {
		const items = places.look(pl, address)
		const it = index === undefined ? items.find((i) => i.node) : items[index]
		if (!it?.node) return []
		return [...passing(it.route), edit("write", it.id, object, slotindex ?? 0)]
	}

	// how a write is told to notify: from a slot, by its patches; or the objects snapped, whole
	type Telling = { slot?: number | null; snap?: [string, Which][] }
	// how a write is told to notify: by its patches; none, the object whole, as its version is new
	// all the same, so what read it is marked
	function empty(
		ps: Patch[],
		pl: Place,
		address: Where,
		index: number | undefined,
		object: Which,
		slotindex: Span | undefined,
	): Telling {
		const at = slotindex === undefined ? 0 : typeof slotindex === "number" ? slotindex : null
		if (ps.length) return { slot: at }
		const items = places.look(pl, address)
		const it = index === undefined ? items.find((i) => i.node) : items[index]
		return { snap: it?.node ? [[it.id, object]] : [] }
	}

	// placing an id: and reading it, where its node is loaded
	function placed(
		node: string,
		name: string,
		before: readonly unknown[],
		after: readonly unknown[],
	) {
		const asks = placing(node, name, before, after)
		for (const a of [...asks]) {
			if (a.op !== "place") continue
			const n = table.get(a.args.id!)
			if (n) asks.push(...readAsks(n))
		}
		return asks
	}
	const idsAt = (id: string, name: string, slotindex?: Span) => {
		const at = slotindex === undefined
			? 0
			: typeof slotindex === "number"
			? slotindex
			: slotindex[0]
		return (table.get(id)?.children.get(name)?.[at]?.content ?? []) as readonly unknown[]
	}

	// the interface

	function bound(b: Bind<O>): Api {
		const live = (op: string) => {
			if (!b.alive()) throw new GraphError("stopped", `${op}: this interface has stopped`)
		}
		const around = b.around ?? (<T>(f: () => T) => f())
		const r = (op: string, f: Read, args: ReadArgs = {}) => {
			live(op)
			return b.reading ? b.reading(op, f, args) : f(b.depend)
		}
		const pl = b.place
		const who = (): Acting => {
			const a: Acting = { actor: b.agent }
			if (b.reader !== undefined) a.reader = b.reader
			if (b.cause !== undefined) a.cause = b.cause
			if (b.message !== undefined) a.message = b.message
			if (b.site) {
				const site = options.site ? options.site() : capture(ours)
				if (site) a.site = site
			}
			return a
		}
		const w = <T>(
			op: string,
			f: () => T,
			// how it is told to notify; a function: worked out once the write may go ahead
			how: Telling | (() => Telling) = {},
			asks?: () => Ask[],
			// where each change it makes was made, for changed: node, object and version
			targets?: (out: T) => Target[],
		): T => {
			live(op)
			if (!b.writes) throw new GraphError("read-only", `${op}: a compute only reads`)
			if (asks) allowed(ask(b.agent, asks()), op)
			const o = typeof how === "function" ? how() : how
			if (!options.changed || !targets) {
				return around(() => changing(who(), { ...o, tag: b.tag, wrote: b.wrote }, f))
			}
			return around(() => {
				const was = log, mine: Entry[] = log = []
				let out: T
				try {
					out = changing(who(), { ...o, tag: b.tag, wrote: b.wrote }, f)
				} finally {
					log = was
				}
				report(mine, targets(out))
				return out
			})
		}
		// names: of each node the actor may reach and list (the list ask, for info too)
		const listed = (address: Where, part: "info" | "children", d?: Depend) => {
			if (part !== "info" && part !== "children") throw new PlacesError("wrong-field")
			const seen = new Set<string>()
			for (const it of guard(places.look(pl, address, d), b.agent, d)) {
				if (!it.node || !("yes" in ask(b.agent, [listAsk(it.id)], d))) continue
				d?.(it.id, [part])
				for (const k of (part === "info" ? it.node.attributes : it.node.children).keys()) {
					seen.add(k)
				}
			}
			return [...seen]
		}
		const slot = (s?: Span) => (s === undefined ? 0 : typeof s === "number" ? s : null)
		const mayPlace = (child: string) => {
			if (ephemeral.has(child) && b.owner === undefined) {
				throw new GraphError(
					"not-a-process",
					"only a process makes, places or moves an ephemeral node",
				)
			}
		}
		return {
			// read as a list, as every read is, so the host sees its item; the node given
			node: (id) =>
				(r("node", (d) => {
					const out = guard(places.look(pl, id, d), b.agent, d)
					const n = out[0]?.node
					if (n === undefined) return out
					// the whole node: every object of it read
					d?.(id, "value")
					d?.(id, ["children"])
					for (const k of n.children.keys()) d?.(id, ["children", k])
					for (const k of n.attributes.keys()) d?.(id, ["info", k])
					return out
				}, { address: id }) as Item<unknown, Change>[])[0]?.node,
			as: (o) => bound({ ...b, cause: o.cause, message: o.message }),
			look: (address) =>
				r("look", (d) => guard(places.look(pl, address, d), b.agent, d), { address }) as Item<
					unknown,
					Change
				>[],
			lookup: (path) =>
				r("lookup", (d) => guard(places.lookup(pl, path, d), b.agent, d), {
					address: path,
				}) as Item<unknown, Change>[],
			lookups: (path) =>
				r("lookups", (d) => guard(places.lookups(pl, path, d), b.agent, d), {
					address: path,
				}) as Item<unknown, Change>[],
			children: (address, name) =>
				r("children", (d) => {
					if (name !== undefined) {
						return guard(
							places.children(pl, address, name, d) as Item<unknown, Change>[],
							b.agent,
							d,
						)
					}
					return listed(address, "children", d)
				}, { address, name }) as Item<unknown, Change>[] | string[],
			names: (address, part) =>
				r("names", (d) => listed(address, part, d), { address, name: part }) as string[],
			content: (address) =>
				r("content", (d) => guard(places.content(pl, address, d), b.agent, d, "value"), {
					address,
				}) as ReturnType<Api["content"]>,
			info: (address, name) =>
				r("info", (d) => guard(places.info(pl, address, name, d), b.agent, d, ["info", name]), {
					address,
					name,
				}) as ReturnType<Api["info"]>,
			write: (address, patches, index, slotindex) => {
				const ps = [...patches]
				return w(
					"write",
					() => places.write(pl, address, ps, index, slotindex),
					() => empty(ps, pl, address, index, "value", slotindex),
					() => writing(pl, address, index, "value", slotindex),
					(c) => [[c.node, "value", slotindex ?? 0]],
				)
			},
			set: (address, name, patches, index, slotindex) => {
				const ps = [...patches]
				return w(
					"set",
					() => places.set(pl, address, name, ps, index, slotindex),
					() => empty(ps, pl, address, index, ["info", name], slotindex),
					() => writing(pl, address, index, ["info", name], slotindex),
					(c) => [[c.node, ["info", name], slotindex ?? 0]],
				)
			},
			insert: (id, name, child, index, slotindex) => {
				mayPlace(child)
				return w(
					"insert",
					() => places.insert(id, name, child, index, slotindex),
					{ slot: slot(slotindex) },
					() => {
						// a number is a gap: nothing replaced; a span: the ids there
						const gone = Array.isArray(index)
							? idsAt(id, name, slotindex).slice(index[0], index[1])
							: []
						return placed(id, name, gone, [child])
					},
					() => [[id, ["children", name], slotindex ?? 0]],
				)
			},
			remove: (id, name, index, slotindex) =>
				w(
					"remove",
					() => places.remove(id, name, index, slotindex),
					{ slot: slot(slotindex) },
					() => {
						const [a, z] = typeof index === "number" ? [index, index + 1] : index
						return placing(id, name, idsAt(id, name, slotindex).slice(a, z), [])
					},
					() => [[id, ["children", name], slotindex ?? 0]],
				),
			pop: (id, name, slotindex) =>
				w(
					"pop",
					() => places.pop(id, name, slotindex),
					{ snap: [[id, ["children", name]]] },
					() => [edit("pop", id, ["children", name], slotindex)],
					() => [[id, ["children", name], { pop: slotindex }]],
				),
			rename: (id, name, to) =>
				w(
					"rename",
					() => places.rename(id, name, to),
					{ snap: [[id, ["children", name]], [id, ["children", to]]] },
					() => {
						const ids = idsAt(id, name)
						return [...placing(id, name, ids, []), ...placed(id, to, [], ids)]
					},
					() => [[id, ["children", name], 0], [id, ["children", to], 0]],
				),
			move: (id, name, index, toid, toname, toindex) => {
				const child = table.get(id)?.children.get(name)?.[0]?.content?.[index]
				if (typeof child === "string") mayPlace(child)
				// within one list, order alone asks nothing
				const across = id !== toid || name !== toname
				return w(
					"move",
					() => places.move(id, name, index, toid, toname, toindex),
					{},
					() =>
						across ? [...placing(id, name, [child], []), ...placed(toid, toname, [], [child])] : [],
					() =>
						across
							? [[id, ["children", name], 0], [toid, ["children", toname], 0]]
							: [[id, ["children", name], 0]],
				)
			},
			create: (value, o = {}) => {
				live("create")
				if (!b.writes) throw new GraphError("read-only", "create: a compute only reads")
				if (o.ephemeral && b.owner === undefined) {
					throw new GraphError("not-a-process", "only a process makes an ephemeral node")
				}
				return around(() =>
					make(o.id, value, who(), value !== undefined, o.ephemeral ? b.owner : undefined)
				)
			},
		}
	}

	// the root: the host's
	table.intro(options.root)

	return {
		get: table.get,
		places,
		by,
		changing,
		intro,
		release,
		make,
		own,
		ephemeral: (id: string) => ephemeral.has(id),
		owner: (id: string) => owners.get(id),
		reader,
		asking,
		bound,
		// internal and dangerous, and not in Api: see where it is defined
		versions,
	}
}

export type Graph<O> = ReturnType<typeof createGraph<O>>
