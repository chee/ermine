// a link: two holders reconciled, each given what the other has and it lacks, by each one's cursor
//
//   const link = createLink(history, file, { limit: 64 })
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
import type { Cursor, Holder, Outcome } from "./holder.ts"
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
	stop(): void
	// done when no sync is running or waiting
	idle(): Promise<void>
	// how many names each side is known to hold (it gave them, or acked them: taken or passed),
	// every refusal so far, whether a sync runs, and what a live sync last threw
	status(): { known: { a: number; b: number }; refused: Refusal[]; busy: boolean; error?: string }
}

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

export function createLink(a: Holder, b: Holder, options: { limit?: number } = {}): Link {
	const holders = { a, b }
	const other = (s: Side): Side => s === "a" ? "b" : "a"
	const cursors: Record<Side, Cursor> = { a: undefined, b: undefined }
	// the names each holder is known to hold
	const holds: Record<Side, Set<string>> = { a: new Set(), b: new Set() }
	const refused: Refusal[] = []
	let error: string | undefined

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

	async function round(): Promise<Round> {
		return { ab: await pull("a"), ba: await pull("b") }
	}

	async function sync(): Promise<Round> {
		let sum: Round = { ab: leg(), ba: leg() }
		for (;;) {
			const one = await round()
			sum = { ab: add(sum.ab, one.ab), ba: add(sum.ba, one.ba) }
			const moved = one.ab.sent + one.ba.sent > 0
			if (!moved && !one.ab.behind && !one.ba.behind) return sum
		}
	}

	async function fetch(node: string): Promise<Round> {
		const get = (s: Side) => holders[s].get?.(node) ?? Promise.resolve([])
		return { ab: await cross(await get("a"), "a"), ba: await cross(await get("b"), "b") }
	}

	// live: one sync at a time, one more if poked while it ran
	let running: Promise<void> | undefined
	let again = false
	function poked() {
		if (running) return void (again = true)
		running = (async () => {
			do {
				again = false
				try {
					await sync()
				} catch (e) {
					error = String(e)
				}
			} while (again)
		})().finally(() => running = undefined)
	}
	let stops: (() => void)[] = []

	return {
		round,
		sync,
		fetch,
		start() {
			if (stops.length) return
			stops = [a.watch(poked), b.watch(poked)]
			poked()
		},
		stop() {
			stops.forEach((s) => s())
			stops = []
		},
		async idle() {
			while (running) await running
		},
		status: () => ({
			known: { a: holds.a.size, b: holds.b.size },
			refused: [...refused],
			busy: running !== undefined,
			...(error === undefined ? {} : { error }),
		}),
	}
}
