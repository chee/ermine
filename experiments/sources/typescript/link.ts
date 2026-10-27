// a link: two holders reconciled, each given what the other has and it lacks, by each one's cursor
//
//   const link = createLink(history, file, { graph, limit: 64 })
//   await link.sync()         // until neither has anything new for the other
//   link.start()              // or: synced whenever either is poked; link.stop()
//
// a leg: one batch one way: since(cursor, limit) of one, what the other is not known to hold put
// into it, the cursor moved past the batch. the link knows a holder holds a write when it came
// from it, or when it said taken or passed (its ack): such a write is never sent to it, so a write
// is never sent back to where it came from. a refused write is passed by (the holder said no;
// asking again would say the same) and listed in refused, for whoever looks
//
// back-pressure: at most limit writes a leg, and one sync at a time; a poke while one runs makes
// one more after it. behind: a leg stopped short, more to come
//
// shown: the link is a process (ermine/processes' start) in the graph given, at
// /system/links/link-<8 hex>, or the at given. it has a place though it joins two holders, not
// two places: like any process it is this device's work, so it sits beside the others under
// /system. its state (status.ts: not-synced, syncing, in-step, behind, cant-sync) is its
// computer's value, its node's value; its records KNOWN ({ a, b }: how many names each side is
// known to hold) and REFUSED (every refusal so far) its attributes, written as each round, sync
// and fetch ends. close: the process stopped, its node gone
import type { Process } from "@ermine/processes/start"
import type { Cursor, Holder, Outcome } from "./holder.ts"
import { type Code, KNOWN, REFUSED, type Running, type Shown, startShown } from "./status.ts"
import type { Write } from "./write.ts"

export type Refusal = { readonly name: string; readonly node: string; readonly why: string }

// one way, one batch or summed over many
export type Leg = {
	sent: number
	taken: number
	passed: number
	refused: Refusal[]
	behind: boolean
}

// both ways: a to b, b to a
export type Round = { ab: Leg; ba: Leg }

export type Link = {
	// one leg each way
	round(): Promise<Round>
	// rounds until neither moves anything nor is behind: what they moved, summed
	sync(): Promise<Round>
	// one node's writes, asked of each side by get, crossed: for a holder that can't list
	fetch(node: string): Promise<Round>
	start(): void
	// not live any more
	stop(): void
	// done when no sync is running or waiting
	idle(): Promise<void>
	// its process: its node holds its state and records
	readonly process: Process
	// its process stopped (live stopped first): its node gone
	close(): void
}

export type LinkOptions = {
	// the graph its process runs in, under the scope given (the device's)
	graph: Running
	// where; none: /system/links/link-<8 hex>. taken: throws
	at?: readonly string[]
	limit?: number
}

const hex8 = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0"))
		.join("")

type Side = "a" | "b"

const leg = (): Leg => ({ sent: 0, taken: 0, passed: 0, refused: [], behind: false })

function add(sum: Leg, one: Leg): Leg {
	return {
		sent: sum.sent + one.sent,
		taken: sum.taken + one.taken,
		passed: sum.passed + one.passed,
		refused: [...sum.refused, ...one.refused],
		behind: one.behind,
	}
}

export function createLink(a: Holder, b: Holder, options: LinkOptions): Link {
	const holders = { a, b }
	const other = (s: Side): Side => s === "a" ? "b" : "a"
	const cursors: Record<Side, Cursor> = { a: undefined, b: undefined }
	// the names each holder is known to hold
	const holds: Record<Side, Set<string>> = { a: new Set(), b: new Set() }
	const refused: Refusal[] = []
	let showing!: Shown
	const at = options.at ?? ["system", "links", `link-${hex8()}`]
	const p = startShown(options.graph, at, { [KNOWN]: { a: 0, b: 0 }, [REFUSED]: [] }, (s) => {
		showing = s
		return () => stop()
	})
	if ("refused" in p) throw new Error(`taken: /${at.join("/")}`)
	// what the node shows: the names known, the refusals, and the state given (none: as it is)
	function show(code?: Code, why?: string) {
		showing.record({
			[KNOWN]: { a: holds.a.size, b: holds.b.size },
			[REFUSED]: refused.map((r) => ({ ...r })),
		})
		if (code !== undefined) showing.state(code, why)
	}
	show("not-synced")

	// writes from one side put into the other, but those it is known to hold
	async function cross(writes: Write[], from: Side): Promise<Leg> {
		const to = other(from)
		for (const w of writes) holds[from].add(w.name)
		const sending = writes.filter((w) => !holds[to].has(w.name))
		const out = leg()
		if (sending.length === 0) return out
		let said: Outcome[]
		try {
			said = await holders[to].put(sending)
		} catch (e) {
			// put never throws; one that does refused all
			said = sending.map(() => ({ refused: `threw: ${e}` }))
		}
		out.sent = sending.length
		sending.forEach((w, i) => {
			const o = said[i] ?? { refused: "no answer" }
			if (o === "taken" || o === "passed") {
				holds[to].add(w.name)
				out[o]++
			} else {
				const r = { name: w.name, node: w.node, why: o.refused }
				out.refused.push(r)
				refused.push(r)
			}
		})
		return out
	}

	async function pull(from: Side): Promise<Leg> {
		const holder = holders[from]
		if (holder.since === undefined) return leg()
		const got = await holder.since(cursors[from], options.limit)
		const out = await cross(got.writes, from)
		cursors[from] = got.cursor
		out.behind = got.more
		return out
	}

	// one leg each way, what it moved shown
	async function legs(): Promise<Round> {
		return { ab: await pull("a"), ba: await pull("b") }
	}

	// what threw shown, then thrown
	async function shown<T>(f: () => Promise<T>): Promise<T> {
		try {
			return await f()
		} catch (e) {
			show("cant-sync", e instanceof Error ? e.message : String(e))
			throw e
		}
	}

	const round = () =>
		shown(async () => {
			const one = await legs()
			show(one.ab.behind || one.ba.behind ? "behind" : undefined)
			return one
		})

	const sync = () =>
		shown(async () => {
			show("syncing")
			let sum: Round = { ab: leg(), ba: leg() }
			for (;;) {
				const one = await legs()
				sum = { ab: add(sum.ab, one.ab), ba: add(sum.ba, one.ba) }
				const moved = one.ab.sent + one.ba.sent > 0
				if (!moved && !one.ab.behind && !one.ba.behind) break
			}
			show("in-step")
			return sum
		})

	const fetch = (node: string) =>
		shown(async () => {
			const get = (s: Side) => holders[s].get?.(node) ?? Promise.resolve([])
			const one = { ab: await cross(await get("a"), "a"), ba: await cross(await get("b"), "b") }
			show()
			return one
		})

	// live: one sync at a time, one more if poked while it ran
	let running: Promise<void> | undefined
	let again = false
	function poked() {
		if (running) return void (again = true)
		running = (async () => {
			do {
				again = false
				// what it threw is on the node
				await sync().catch(() => {})
			} while (again)
			// cleared here, in the tick the loop ended: a poke after it starts the next sync
			running = undefined
		})()
	}
	let stops: (() => void)[] = []
	function stop() {
		stops.forEach((s) => s())
		stops = []
	}

	return {
		round,
		sync,
		fetch,
		start() {
			if (stops.length) return
			stops = [a.watch(poked), b.watch(poked)]
			poked()
		},
		stop,
		async idle() {
			while (running) await running
		},
		process: p,
		close() {
			stop()
			options.graph.processes.stop(p)
		},
	}
}
