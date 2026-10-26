// runs: each computer's latest run, on a table of the runs' own (not the graph's table, not
// places'), by the computer's node id. replaced each run, never saved; subduction keeps the rest.
//
//   n        the scheduler's run number
//   started  and ended: ms since 1970, fractional
//   end      done | pending | failed | looping (the scheduler's onRunEnd)
//   error    failed: what it threw, as thrown (any value); looping: an Error "looping"
//   act      an effect's, once its act has run after this run: { end: "done" } or { end: "failed",
//            error } (what it threw, as thrown); none until then, and none for a run not acted
//            on or of a compute. a newer run's record has none of its own again
//   reads    first-read order, each once, as places' describe names it: { part, id, path, keys?,
//            change }; change: the entry's header as the run first read the key (a run that
//            reads a node and then writes it names the change before its write), the same object
//            (no copy). unnamed: { key }
//   writes   landing order, each time: { part, id, change } (taken out: no change); a write is the
//            run's when it lands with the run open (its code, set, effect act, teardown)
//
// a run's end is a write to the runs' table (runs are writes): n, started and ended every run, the
// rest only when they differ (the field kept as it was, so a reader of reads reruns only when
// they do). not recorded: untracked reads (outside a run, after an await, an effect's act), the
// value (a memo's is on its node).
//
// read: read(id, field?), the policy asked first as reading the computer's node (guard given),
// then each field read tracked: one key a field a record, marked when that field changes, with the
// computer as the writer: what reads a record is due after the computer, and a loop through
// records (a record's reader whose own record its writer reads) is the scheduler's to see
// (causes), as any other. no table event, no header, no places commit.
// a computer gone: drop(id), its record out, its readers marked.
import type { ChangeHeader } from "@ermine/core/node/entry"
import type { Key as Step } from "@ermine/core/op/apply"
import type { Fact, Places } from "@ermine/core/places"
import { target } from "@ermine/core/places/guard"
import type { Target } from "@ermine/core/protect"
import type { Computer, Ended, More, Scheduler } from "@ermine/core/scheduler"
import type { Id, Key, Table } from "@ermine/core/table"

// a read, named: where, and the change there as the run first read it
export type Read = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
	readonly keys?: true
	readonly change: ChangeHeader | undefined
} | { readonly key: unknown }

// a write: where it landed, and its change (a table event taking it out: none)
export type Write = {
	readonly part: Key
	readonly id: Id
	readonly change: ChangeHeader | undefined
}

// an effect's act, after its run
export type Act = { readonly end: "done" } | { readonly end: "failed"; readonly error: unknown }
const ACT_DONE: Act = Object.freeze({ end: "done" })

export type Run = {
	readonly n: number
	// none: given while it ran, its start not seen
	readonly started?: number
	readonly ended: number
	readonly end: Exclude<Ended, "stopped">
	// as thrown: any value (looping: an Error)
	readonly error?: unknown
	readonly act?: Act
	readonly reads: readonly Read[]
	readonly writes: readonly Write[]
}

export type Field = keyof Run
export const FIELDS: readonly Field[] = [
	"n",
	"started",
	"ended",
	"end",
	"error",
	"act",
	"reads",
	"writes",
]

// what asks the policy (places' guard): a no or a pending throws
export type Asks = { read: (...targets: Target[]) => void }

export type Setup = {
	places: Pick<Places, "describe" | "watchAll">
	table: Pick<Table, "get">
	scheduler: Pick<
		Scheduler,
		"getRun" | "onRunStart" | "onRunEnd" | "onEffect" | "onTrack" | "track" | "mark"
	>
	// a record on its way to being held, by the computer's node id: keep(run) holds it, as given or
	// changed; not called, not held (a feature's onRecord). none: held
	hold?: (id: Id, run: Run, keep: (run: Run) => void) => void
}

export type Runs = {
	// the computer's runs written by its node's id
	give: (computer: Computer, id: Id) => void
	// a computer's latest run, or one field of it; none: undefined. the guard (the reader's) asked
	// as reading the node; each field read tracked
	read: {
		(id: Id, guard?: Asks): Run | undefined
		<F extends Field>(id: Id, field: F, guard?: Asks): Run[F] | undefined
	}
	// the node's record out (its computer gone), its readers told
	drop: (id: Id) => void
	// stop listening
	stop: () => void
}

// milliseconds since 1970, fractional
const now = () => performance.timeOrigin + performance.now()

// a computer's run as it goes: its number, its start, its writes so far, how many the record holds
// saw: the change at each key's first track in the run (made when the first is tracked)
type Going = {
	n: number
	started?: number
	writes: Write[]
	written: number
	saw?: Map<unknown, ChangeHeader | undefined>
}

// a record, and its keys: one a field, made the first time read
type Held = { run: Run | undefined; keys: Partial<Record<Field, object>> }

export function createRuns(setup: Setup): Runs {
	const { places, table, scheduler: s } = setup
	const ids = new WeakMap<Computer, Id>()
	const going = new WeakMap<Computer, Going>()
	// the runs' table
	const records = new Map<Id, Held>()

	function held(id: Id): Held {
		let h = records.get(id)
		if (h === undefined) records.set(id, h = { run: undefined, keys: {} })
		return h
	}
	function keyOf(h: Held, f: Field): object {
		return h.keys[f] ??= {}
	}

	// a fact landing with a run open of a computer given: that run's write
	function landed(f: Fact) {
		const run = s.getRun()
		if (run === undefined) return
		const g = going.get(run.computer)
		if (g !== undefined && g.n === run.n) {
			g.writes.push({ part: f.part, id: f.id, change: f.change })
		}
	}

	// the run's reads, each once, in the order first read: a few, looked through; more, a set
	function once(reads: readonly unknown[]): unknown[] {
		if (reads.length < 16) {
			const out: unknown[] = []
			for (const k of reads) if (!out.includes(k)) out.push(k)
			return out
		}
		return [...new Set(reads)]
	}

	// the reads named, unless they are the ones there already (then those)
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

	// the record written, through hold when given
	function write(c: Computer, id: Id, run: Run) {
		if (setup.hold) setup.hold(id, run, (r) => put(c, id, r))
		else put(c, id, run)
	}
	// the record held: the fields that differ marked, the computer their writer
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
			...(g.started !== undefined ? { started: g.started } : {}),
			ended: now(),
			end: ended as Run["end"],
			...(failed || error !== undefined ? { error } : {}),
			reads: named(once(reads), was?.reads, g.saw),
			writes: sameWrites(was?.writes, g.writes) ? was!.writes : g.writes.slice(),
		}
		g.written = g.writes.length
		g.saw = undefined
		write(c, id, run)
	}

	const offs = [
		places.watchAll(landed),
		// the change a key has when the run first tracks it
		s.onTrack((key, run) => {
			const g = going.get(run.computer)
			if (g === undefined || g.n !== run.n) return
			const saw = g.saw ??= new Map()
			if (saw.has(key)) return
			const w = places.describe(key)
			saw.set(key, w === undefined ? undefined : table.get(w.part, w.id)?.change)
		}),
		s.onRunStart((c, n) => {
			if (ids.has(c)) going.set(c, { n, started: now(), writes: [], written: 0 })
		}),
		s.onRunEnd((c, n, ended, reads, more) => {
			const id = ids.get(c)
			if (id === undefined || ended === "stopped" || c.state !== "alive") return
			let g = going.get(c)
			// given while it ran: its start not seen
			if (g === undefined || g.n !== n) going.set(c, g = { n, writes: [], written: 0 })
			record(c, id, g, ended, reads, more)
		}),
		// an effect's act ran: its end, and what it wrote, in the record
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
		// the policy: as reading the computer's node
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
