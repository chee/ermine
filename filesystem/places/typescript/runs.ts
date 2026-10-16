// a computer's latest run, on its own node: never saved, at one place. chee 10-15: "oh shoot we
// should also record reads"; "the core thing is you can find out _why_ and _what_, if i opened a
// document with a specific process running a specific program i can see all of that information
// somewhere"; "reads and writes should be on the "run" record"; the latest only, "because
// subduction will keep the rest"; "let's keep them both on attributes right now"
//
// the attribute ermine.computer.run, beside status.ts' ermine.computer.status, replaced by each run:
//   n        the run's number (the scheduler's)
//   started  when it started; ended: when it ended. milliseconds since 1970, fractional
//   end      how it ended, as the scheduler's onRunEnd says: done, pending, failed or looping
//   error    failed: what it threw (an Error); looping: an Error "looping"
//   reads    what it read, in the order first read, each once, as places' describe names it:
//            { part, id, path, keys?, change }. change: the change of the entry there as the run
//            ended (none there: undefined), the version it saw: the header itself, shared (who,
//            when, the site, the op). a key places can't name: { key }, the key itself
//   writes   what it wrote, in the order landed, each time: { part, id, change } (a table event
//            taking it out: no change). a write is the run's when it lands with the run open (the
//            scheduler's getRun, as places' commit marks by): its code, its set, an effect's act
//            (told at onEffect), a teardown at its start. places' watchAll tells each one
//
// not recorded: what the scheduler doesn't track (a read outside a run, in runWithScope, after an
// await, an effect's act), and the value (a memo's is on its node). a stopped run writes nothing:
// a newer one follows in the same pulse. mine, open: the version as the shared header (its identity
// says which write; C keeps its pieces as values); started/ended from performance.now
//
// written as each run ends (and after an effect's act that wrote), with the computer's scope open
// and the run open when the pulse began (from a pulse with none, from outside), as status.ts. one
// update, a patch for each field that differs: n, started and ended every run (runs are writes),
// reads, writes, end and error only when they differ, so a reader of reads reruns only when they do
//
// a run that read a record (the attribute, all of the attributes of a node holding one, or their
// change) writes none (mine, open): written from outside, two readers of each other's records, or
// one of its own, would run each other forever, and the scheduler sees no loop in it. core
// candidate (scheduler): a run's end written as the computer's own, so causes.ts finds the loop
//
// cost (runs_bench.ts, 100 computers each reading 3 nodes, all rerun each pulse, a quiet machine):
// 0.74 µs a run recording nothing, 0.93 with status.ts, 2.6 with runs, 2.7 with both. most of it is
// the write itself (update, apply, commit, the marks); performance.now's op about 7%. cheaper: the
// scheduler giving each run's start and end times; n, started and ended written only with another
// field (the record then the last run that differed); one commit for a pulse's records
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Key as Step, Patch } from "@ermine/op/apply"
import type { Computer, Ended, More, Scheduler } from "@ermine/scheduler"
import type { Id, Key, Table, Tables } from "@ermine/table"
import { createChangeHeader, getWho } from "./header.ts"
import type { Fact, Places, Where } from "./places.ts"

// the attribute
export const RUN = "ermine.computer.run"

// a read, named: where, and the change there as the run ended
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

export type Run = {
	n: number
	// none: given while it ran, its start not seen
	started?: number
	ended: number
	end: Exclude<Ended, "stopped">
	error?: Error
	reads: Read[]
	writes: Write[]
}

export type Setup = {
	places: Pick<Places, "commit" | "describe" | "watchAll">
	table: Pick<Table, "get" | "add">
	scheduler: Pick<
		Scheduler,
		"runWithScope" | "getInfo" | "getRun" | "onRunStart" | "onRunEnd" | "onEffect"
	>
}

// milliseconds since 1970, fractional
const now = () => performance.timeOrigin + performance.now()

// a computer's run as it goes: its number, its start, its writes so far, how many of them the
// record holds
type Going = { n: number; started?: number; writes: Write[]; written: number }

// listens to the scheduler's run start and end, its effects, and places' writes, from here on
export function createRuns(setup: Setup): {
	// the node a computer's run is written on
	give: (computer: Computer, id: Id) => void
	// stop listening
	stop: () => void
} {
	const { places, table, scheduler } = setup
	const ids = new WeakMap<Computer, Id>()
	const going = new WeakMap<Computer, Going>()

	// a fact landing with a run open of a computer given: that run's write
	function landed(f: Fact) {
		const run = scheduler.getRun()
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

	// whether a read is of a record: the attribute, all of the attributes of a node holding one, or
	// their change
	function ofARecord(w: Where): boolean {
		if (w.part !== "attributes" || w.keys) return false
		if (w.path !== null && w.path.length > 0) return w.path[0] === RUN
		const v = table.get("attributes", w.id)?.value
		return isMap(v) && Object.hasOwn(v, RUN)
	}

	// the reads named, unless they are the ones there already (then those). one of a record: undefined
	function named(keys: readonly unknown[], was: unknown): Read[] | undefined {
		const old = Array.isArray(was) && was.length === keys.length ? was as Read[] : undefined
		let same = old !== undefined
		const out: Read[] = []
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i]
			const w = places.describe(k)
			let r: Read
			if (w === undefined) r = { key: k }
			else {
				if (ofARecord(w)) return
				const change = table.get(w.part, w.id)?.change
				r = w.keys
					? { part: w.part, id: w.id, path: w.path, keys: true, change }
					: { part: w.part, id: w.id, path: w.path, change }
			}
			if (same && !sameRead(old![i], r)) same = false
			out.push(r)
		}
		return same ? old! : out
	}

	// a record's header, as header.ts makes it, but its site: always the line in write below, so
	// captured at the first and given to every one after (a stack read each run is most of the cost)
	let site: ChangeHeader["external"]
	function header(): ChangeHeader {
		if (site === undefined) {
			const h = createChangeHeader(scheduler)
			site = h.external ?? []
			return h
		}
		const h: ChangeHeader = { ...getWho(scheduler)!, time: Math.floor(Date.now() / 1000) }
		if (site.length) h.external = site
		return h
	}

	// the record written, with c open: a patch for each field that differs. c gone (an effect torn
	// down by its own act): nothing
	function write(c: Computer, id: Id, run: Run) {
		if (c.state !== "alive") return
		scheduler.runWithScope(c, () => {
			const made = header()
			const there = table.get("attributes", id) as Entry<unknown> | undefined
			const v = there?.value
			if (there === undefined) {
				const entry = createEntry<Record<string, unknown>>({ [RUN]: run }, made)
				table.add("attributes", id, entry as Entry<Tables["attributes"]>)
				return
			}
			const was = isMap(v) ? v[RUN] : undefined
			const patches: Patch[] = []
			if (!isMap(v)) patches.push({ path: [], value: {} })
			if (!isMap(was)) patches.push({ path: [RUN], value: run })
			else {
				for (const k of ["n", "started", "ended", "end", "error", "reads", "writes"] as const) {
					if (Object.hasOwn(was, k) && was[k] === run[k]) continue
					if (!Object.hasOwn(was, k) && run[k] === undefined) continue
					patches.push(
						run[k] === undefined ? { path: [RUN, k] } : { path: [RUN, k], value: run[k] },
					)
				}
			}
			update(there, patches, made)
			places.commit([there])
		})
	}

	// the record of what the computer given id did, now; the one there (a map), to keep what is the
	// same. a run that read a record: none
	function record(
		c: Computer,
		id: Id,
		g: Going,
		ended: Ended,
		reads: readonly unknown[],
		more: More,
	) {
		const there = table.get("attributes", id)?.value
		const was = isMap(there) && isMap(there[RUN]) ? there[RUN] : undefined
		const reads_ = named(once(reads), was?.reads)
		if (reads_ === undefined) return
		const run: Run = {
			n: g.n,
			ended: now(),
			end: ended as Run["end"],
			reads: reads_,
			writes: sameWrites(was?.writes, g.writes) ? was!.writes as Write[] : g.writes.slice(),
		}
		if (g.started !== undefined) run.started = g.started
		if (ended === "failed") {
			run.error = more.error instanceof Error ? more.error : new Error(String(more.error))
		} else if (ended === "looping") run.error = new Error("looping")
		g.written = g.writes.length
		write(c, id, run)
	}

	const offs = [
		places.watchAll(landed),
		scheduler.onRunStart((c, n) => {
			if (ids.has(c)) going.set(c, { n, started: now(), writes: [], written: 0 })
		}),
		scheduler.onRunEnd((c, n, ended, reads, more) => {
			const id = ids.get(c)
			if (id === undefined || ended === "stopped") return
			let g = going.get(c)
			// given while it ran: its start not seen
			if (g === undefined || g.n !== n) going.set(c, g = { n, writes: [], written: 0 })
			record(c, id, g, ended, reads, more)
		}),
		// an effect's act wrote: the record's writes again
		scheduler.onEffect((c, n) => {
			const id = ids.get(c)
			const g = going.get(c)
			if (id === undefined || g === undefined || g.n !== n || g.writes.length === g.written) {
				return
			}
			const there = table.get("attributes", id)?.value
			const was = isMap(there) ? there[RUN] : undefined
			if (!isMap(was) || was.n !== n) return
			g.written = g.writes.length
			write(c, id, { ...was, writes: g.writes.slice() } as Run)
		}),
	]

	return {
		give: (c, id) => void ids.set(c, id),
		stop: () => {
			for (const off of offs) off()
		},
	}
}

// a computer's latest run, by its node's id, the read told; none: undefined
export const latest = (places: Pick<Places, "readValue">, id: Id): Run | undefined =>
	places.readValue("attributes", id, [RUN]) as Run | undefined

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)

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

function sameWrites(was: unknown, writes: readonly Write[]): boolean {
	if (!Array.isArray(was) || was.length !== writes.length) return false
	for (let i = 0; i < writes.length; i++) {
		const a = was[i] as Write, b = writes[i]
		if (a.part !== b.part || a.id !== b.id || a.change !== b.change) return false
	}
	return true
}
