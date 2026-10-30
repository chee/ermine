// Each computer's latest run, on a table of the runs' own keyed by the computer's node id.
// Reads are tracked one key per field, marked with the computer as the writer.
import type { ChangeHeader, Frame } from "@ermine/graph/entry"
import type { Key as Step } from "@ermine/changeable/apply"
import type { Fact, Places } from "@ermine/places"
import { target } from "./guard.ts"
import type { Target } from "@ermine/protect"
import type { Computer, Ended, More, Scheduler } from "@ermine/reactivity"
import type { Id, Key, Table } from "@ermine/graph/table"

export type Read = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
	readonly keys?: true
	readonly change: ChangeHeader | undefined
} | { readonly key: unknown }

export type Write = {
	readonly part: Key
	readonly id: Id
	readonly change: ChangeHeader | undefined
}

export type Act = { readonly end: "done" } | { readonly end: "failed"; readonly error: unknown }
const ACT_DONE: Act = Object.freeze({ end: "done" })

export type Run = {
	readonly n: number
	readonly frame: Frame
	readonly started?: number
	readonly ended: number
	readonly end: Exclude<Ended, "stopped">
	readonly error?: unknown
	readonly act?: Act
	readonly reads: readonly Read[]
	readonly writes: readonly Write[]
}

export type Field = keyof Run
export const FIELDS: readonly Field[] = [
	"n",
	"frame",
	"started",
	"ended",
	"end",
	"error",
	"act",
	"reads",
	"writes",
]

export type Asks = { read: (...targets: Target[]) => void }

export type Setup = {
	places: Pick<Places, "describe" | "watchAll">
	table: Pick<Table, "get">
	scheduler: Pick<
		Scheduler,
		"getRun" | "onRunStart" | "onRunEnd" | "onEffect" | "onTrack" | "track" | "mark"
	>
	hold?: (id: Id, run: Run, keep: (run: Run) => void) => void
}

export type Runs = {
	give: (computer: Computer, id: Id) => void
	read: {
		(id: Id, guard?: Asks): Run | undefined
		<F extends Field>(id: Id, field: F, guard?: Asks): Run[F] | undefined
	}
	drop: (id: Id) => void
	stop: () => void
}

const now = () => performance.timeOrigin + performance.now()

type Going = {
	n: number
	frame?: Frame
	started?: number
	writes: Write[]
	written: number
	saw?: Map<unknown, ChangeHeader | undefined>
}

type Held = { run: Run | undefined; keys: Partial<Record<Field, object>> }

export function createRuns(setup: Setup): Runs {
	const { places, table, scheduler: s } = setup
	const ids = new WeakMap<Computer, Id>()
	const going = new WeakMap<Computer, Going>()
	const records = new Map<Id, Held>()

	function held(id: Id): Held {
		let h = records.get(id)
		if (h === undefined) records.set(id, h = { run: undefined, keys: {} })
		return h
	}
	function keyOf(h: Held, f: Field): object {
		return h.keys[f] ??= {}
	}

	function landed(f: Fact) {
		const run = s.getRun()
		if (run === undefined) return
		const g = going.get(run.computer)
		if (g !== undefined && g.n === run.n) {
			g.writes.push({ part: f.part, id: f.id, change: f.change })
		}
	}

	// Each read once, in first-read order; a few are scanned, more use a set.
	function once(reads: readonly unknown[]): unknown[] {
		if (reads.length < 16) {
			const out: unknown[] = []
			for (const k of reads) if (!out.includes(k)) out.push(k)
			return out
		}
		return [...new Set(reads)]
	}

	function named(
		keys: readonly unknown[],
		was: readonly Read[] | undefined,
		saw: Map<unknown, ChangeHeader | undefined> | undefined,
	): readonly Read[] {
		const old = was !== undefined && was.length === keys.length ? was : undefined
		let same = old !== undefined
		const out: Read[] = []
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i]
			const w = places.describe(k)
			let r: Read
			if (w === undefined) r = { key: k }
			else {
				const change = saw !== undefined && saw.has(k)
					? saw.get(k)
					: table.get(w.part, w.id)?.change
				r = w.keys
					? { part: w.part, id: w.id, path: w.path, keys: true, change }
					: { part: w.part, id: w.id, path: w.path, change }
			}
			if (same && !sameRead(old![i], r)) same = false
			out.push(r)
		}
		return same ? old! : out
	}

	function write(c: Computer, id: Id, run: Run) {
		if (setup.hold) setup.hold(id, run, (r) => put(c, id, r))
		else put(c, id, run)
	}
	function put(c: Computer, id: Id, run: Run) {
		const h = held(id)
		const was = h.run
		h.run = run
		const changed: object[] = []
		for (const f of FIELDS) {
			if (was !== undefined && was[f] === run[f]) continue
			if (h.keys[f] !== undefined) changed.push(h.keys[f]!)
		}
		if (changed.length) s.mark(changed, c)
	}

	function record(
		c: Computer,
		id: Id,
		g: Going,
		ended: Ended,
		reads: readonly unknown[],
		more: More,
	) {
		const was = records.get(id)?.run
		const failed = ended === "failed"
		const error = failed ? more.error : ended === "looping" ? new Error("looping") : undefined
		const run: Run = {
			n: g.n,
			frame: g.frame ?? c.frame,
			...(g.started !== undefined ? { started: g.started } : {}),
			ended: now(),
			end: ended as Run["end"],
			...(failed || error !== undefined ? { error } : {}),
			reads: named(once(reads), was?.reads, g.saw),
			writes: sameWrites(was?.writes, g.writes) ? was!.writes : g.writes.slice(),
		}
		g.written = g.writes.length
		if (ended !== "pending") g.saw = undefined
		write(c, id, run)
	}

	const offs = [
		places.watchAll(landed),
		s.onTrack((key, run) => {
			const g = going.get(run.computer)
			if (g === undefined || g.n !== run.n) return
			const saw = g.saw ??= new Map()
			if (saw.has(key)) return
			const w = places.describe(key)
			saw.set(key, w === undefined ? undefined : table.get(w.part, w.id)?.change)
		}),
		s.onRunStart((c, n, _rank, frame) => {
			if (ids.has(c)) going.set(c, { n, frame, started: now(), writes: [], written: 0 })
		}),
		s.onRunEnd((c, n, ended, reads, more) => {
			const id = ids.get(c)
			if (id === undefined || ended === "stopped" || c.state !== "alive") return
			let g = going.get(c)
			if (g === undefined || g.n !== n) going.set(c, g = { n, writes: [], written: 0 })
			record(c, id, g, ended, reads, more)
		}),
		s.onEffect((c, n, more) => {
			const id = ids.get(c)
			if (id === undefined) return
			const was = records.get(id)?.run
			if (was === undefined || was.n !== n || c.state !== "alive") return
			const act: Act = "error" in more ? { end: "failed", error: more.error } : ACT_DONE
			const g = going.get(c)
			const wrote = g !== undefined && g.n === n && g.writes.length !== g.written
			if (!wrote && act === was.act) return
			if (wrote) g.written = g.writes.length
			write(c, id, { ...was, act, ...(wrote ? { writes: g.writes.slice() } : {}) })
		}),
	]

	function read(id: Id, a?: Field | Asks, b?: Asks) {
		const field = typeof a === "string" ? a : undefined
		const guard = typeof a === "string" ? b : a
		guard?.read(target({ id }))
		const h = held(id)
		if (field !== undefined) {
			s.track(keyOf(h, field))
			return h.run?.[field]
		}
		for (const f of FIELDS) s.track(keyOf(h, f))
		return h.run
	}

	return {
		give: (c, id) => void ids.set(c, id),
		read: read as Runs["read"],
		drop: (id) => {
			const h = records.get(id)
			if (h === undefined) return
			records.delete(id)
			const keys = Object.values(h.keys)
			if (h.run !== undefined && keys.length) s.mark(keys)
		},
		stop: () => {
			for (const off of offs) off()
		},
	}
}

function sameRead(a: Read, b: Read): boolean {
	if ("key" in a || "key" in b) return "key" in a && "key" in b && a.key === b.key
	return a.part === b.part && a.id === b.id && a.keys === b.keys && a.change === b.change &&
		samePath(a.path, b.path)
}

function samePath(a: readonly Step[] | null, b: readonly Step[] | null): boolean {
	if (a === b) return true
	if (a === null || b === null || a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

function sameWrites(was: readonly Write[] | undefined, writes: readonly Write[]): boolean {
	if (was === undefined || was.length !== writes.length) return false
	for (let i = 0; i < writes.length; i++) {
		const a = was[i], b = writes[i]
		if (a.part !== b.part || a.id !== b.id || a.change !== b.change) return false
	}
	return true
}
