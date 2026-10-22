// history: a graph and its log, tied. every kept write here becomes a step (the recorder, on places'
// watchAll); every step from elsewhere is written into the graph (the lander). the graph is the
// last snapshot and the steps after it, like an image and its changes file
//
// the merge, lofi: an entry's value is its steps' patches applied in order of lamport, then device,
// from nothing. a step that arrives last in that order is applied as it is; one that arrives
// earlier than steps already there, and the entry is worked out again from its steps. so devices
// holding the same steps show the same values, whatever order they came in. a step whose patches
// don't apply there is passed over, and listed in failed. text typed at once by two people is not
// this file's job
//
//   const h = createHistory({ log, table, places, run: hosted })
//   await h.load()
//   await h.snapshot()
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Places } from "@ermine/places"
import type { Key, Table } from "@ermine/table"
import { decodeStep, type Step } from "./step.ts"
import type { Log } from "./log.ts"

// a step, as an entry's list holds it
type Ref = [lamport: number, device: string, n: number]
export type Failed = { device: string; n: number; node: string; part: string; why: string }

const before = (a: Ref, b: Ref) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

// a patch as cbor can hold it: no undefined fields
const clean = (p: Patch): Patch => ({
	path: p.path,
	...(p.range && { range: p.range }),
	...(p.value !== undefined && { value: p.value }),
	...(p.move && { move: clean(p.move as Patch) }),
})

// what is kept when the host doesn't say: string ids in value, attributes and children
export const keptByDefault = (_: string, part: string) =>
	part === "value" || part === "attributes" || part === "children"

export type History = ReturnType<typeof createHistory>

export function createHistory(o: {
	log: Log
	table: Table
	places: Pick<Places, "commit" | "watchAll">
	// which writes are kept (and so travel); none: string ids in value, attributes, children
	kept?: (node: string, part: string) => boolean
	// writes into the graph made inside it: the host's scope, say
	run?: <T>(f: () => T) => T
}) {
	const { log, table, places } = o
	const kept = o.kept ?? keptByDefault
	const run = o.run ?? (<T>(f: () => T) => f())
	// each kept entry's steps, in order: part \0 node → refs
	const entries = new Map<string, Ref[]>()
	const failed: Failed[] = []
	const unkept: Omit<Failed, "device" | "n">[] = []
	let landing = false
	// entries with a write here that wasn't kept: their patches stay here until a whole write is
	// kept, so a peer never gets a patch to a value it never had
	const broken = new Set<string>()
	// told when failed or unkept grow
	const changed: (() => void)[] = []
	const tell = () => changed.forEach((f) => f())

	function fail(s: Step, e: unknown) {
		failed.push({ device: s.device, n: s.n, node: s.node, part: s.part, why: String(e) })
		tell()
	}
	const stepOf = (r: Ref) => decodeStep(log.step(r[1], r[2]))
	const headerOf = (s: Step): ChangeHeader => ({
		time: s.when,
		actor: s.who ?? s.device,
		metadata: { device: s.device, n: s.n, lamport: s.lamport },
	})

	// a step into its entry's list; true: it went last
	function place(s: Step): boolean {
		const k = `${s.part}\0${s.node}`, ref: Ref = [s.lamport, s.device, s.n]
		let refs = entries.get(k)
		if (!refs) entries.set(k, refs = [])
		let i = refs.length
		while (i > 0 && before(ref, refs[i - 1])) i--
		refs.splice(i, 0, ref)
		return i === refs.length - 1
	}

	// the graph's entry made what its steps say: patches applied as given, or a whole value
	function write(s: Step, patches: readonly Patch[], whole?: { value: unknown }) {
		landing = true
		try {
			run(() => {
				const e = table.get(s.part as Key, s.node)
				const ps = whole
					? [whole.value === undefined ? { path: [] } : { path: [], value: whole.value }]
					: patches
				if (e) return void (update(e, ps, headerOf(s)), places.commit([e]))
				const v = apply(undefined, ps)
				if (v !== undefined) {
					table.add(s.part as Key, s.node, createEntry(v as never, headerOf(s)))
				}
			})
		} finally {
			landing = false
		}
	}

	// an entry worked out again from all its steps
	function redo(s: Step) {
		const refs = entries.get(`${s.part}\0${s.node}`)!
		let value: unknown, last = s
		for (const r of refs) {
			const step = stepOf(r)
			try {
				value = apply(value, step.patches)
				last = step
			} catch (e) {
				if (!failed.some((f) => f.device === step.device && f.n === step.n)) fail(step, e)
			}
		}
		write(last, [], { value })
	}

	function land(s: Step) {
		if (!place(s)) return redo(s)
		try {
			write(s, s.patches)
		} catch (e) {
			fail(s, e)
		}
	}

	// the recorder: a kept write here, a step
	const unwatch = places.watchAll((f) => {
		if (landing || typeof f.id !== "string" || !kept(f.id, String(f.part))) return
		const who = f.change?.actor, k = `${String(f.part)}\0${f.id}`
		const first = f.patches[0], whole = first?.path.length === 0 && !first.range && !first.move
		let s: Step
		try {
			if (broken.has(k) && !whole) throw new Error("its entry has a write not kept")
			s = log.write({
				node: f.id,
				part: String(f.part),
				patches: f.patches.map(clean),
				when: f.change?.time ?? Math.floor(Date.now() / 1000),
				...(typeof who === "string" && { who }),
			})
		} catch (e) {
			broken.add(k)
			unkept.push({ node: f.id, part: String(f.part), why: String(e) })
			return tell()
		}
		broken.delete(k)
		// written here, it is already in the graph, unless it sorts before steps already there
		if (!place(s)) redo(s)
	})
	// the lander: steps from elsewhere (this device's own are only ever written here)
	const unlisten = log.on((device, steps) => {
		if (device === log.device) return
		for (const s of steps) {
			try {
				land(s)
			} catch (e) {
				fail(s, e)
			}
		}
	})

	return {
		failed: failed as readonly Failed[],
		unkept: unkept as readonly Omit<Failed, "device" | "n">[],
		onChange(f: () => void) {
			changed.push(f)
			return () => void changed.splice(changed.indexOf(f), 1)
		},

		// each kept entry's value and its list of steps, and how many of each device's steps are in it
		async snapshot() {
			const out: [string, string, Value | null, Ref[]][] = []
			for (const [k, refs] of entries) {
				const [part, node] = k.split("\0")
				const v = table.get(part as Key, node)?.value
				out.push([part, node, v === undefined ? null : v as Value, refs])
			}
			const count: Record<string, number> = {}
			for (const d of Object.keys(log.have())) count[d] = log.count(d)
			await log.snapshot(encode({ count, entries: out } as unknown as Value))
		},

		// after a restart: the log loaded, the snapshot written into the graph, and every step held
		// after it landed, this device's too, and those whose signature never made it to disk
		async load() {
			const bytes = await log.load()
			let count: Record<string, number> = {}
			if (bytes) {
				const snap = decode(bytes) as unknown as {
					count: Record<string, number>
					entries: [string, string, unknown, Ref[]][]
				}
				count = snap.count
				landing = true
				try {
					run(() => {
						for (const [part, node, v, refs] of snap.entries) {
							entries.set(`${part}\0${node}`, refs)
							if (v !== null) {
								table.sub(
									part as Key,
									node,
									createEntry(v as never, { time: 0, actor: "snapshot" }),
								)
							}
						}
					})
				} finally {
					landing = false
				}
			}
			for (const device of Object.keys(log.have())) {
				for (let n = (count[device] ?? 0) + 1; n <= log.count(device); n++) {
					const s = decodeStep(log.step(device, n))
					try {
						land(s)
					} catch (e) {
						fail(s, e)
					}
				}
			}
		},

		stop() {
			unwatch()
			unlisten()
		},
	}
}
