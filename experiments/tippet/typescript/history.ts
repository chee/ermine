// History: a graph and its log, tied. The recorder turns kept writes into steps; the lander writes
// steps from elsewhere into the graph. An entry's value is its steps' patches applied in order of
// lamport, then device; a step that lands earlier makes the entry be worked out again.
// versions(node, part) lists the merge, then each head's own value (at most the 16 newest heads).
// forget(sync) is a try-out: it snapshots and lets go the runs that have passed on, and a late step
// is then skipped rather than merged in.
import createEntry, { type ChangeHeader } from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import apply, { type Patch } from "@ermine/changeable/apply"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Places } from "@ermine/places"
import type { Key, Table } from "@ermine/graph/table"
import { decodeStep, type On, same, type Step } from "./step.ts"
import type { Log } from "./log.ts"
import type { Sync } from "./sync.ts"

type Ref = [lamport: number, device: string, n: number]
type Own = { value: unknown; tail: { ref: Ref; undo: Patch[] }[]; all: boolean }
export type Failed = { device: string; n: number; node: string; part: string; why: string }
export type Version = {
	value: unknown
	gone?: true
	from: { heads: [device: string, n: number][] }
}
const MOST = 16
// at most this many steps after a late one are read for named, before an index is made
const FEW = 64

const before = (a: Ref, b: Ref) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const name = (part: string, node: string) => `${part}\0${node}`
const covers = (s: Step, r: Ref) =>
	s.on
		? s.on.some((o) => o.device === r[1] && o.n === r[2])
		: before(r, [s.lamport, s.device, s.n])
const touched = (p: Patch) => p.move ? [p.path, p.move.path] : [p.path]
const overlap = (a: readonly unknown[], b: readonly unknown[]) => {
	for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return false
	return true
}
const whole = (s: Step) => {
	const p = s.patches[0]
	return p !== undefined && p.path.length === 0 && !p.range && !p.move
}
const bytesOf = (v: unknown) => {
	try {
		return v === undefined ? new Uint8Array() : encode(v as Value)
	} catch {
		return new Uint8Array([0xff])
	}
}

const clean = (p: Patch): Patch => ({
	path: p.path,
	...(p.range && { range: p.range }),
	...(p.value !== undefined && { value: p.value }),
	...(p.move && { move: clean(p.move as Patch) }),
})

export const keptByDefault = (_: string, part: string) =>
	part === "value" || part === "attributes" || part === "children"

export type History = {
	failed: readonly Failed[]
	unkept: readonly Omit<Failed, "device" | "n">[]
	onChange(f: () => void): () => void
	snapshot: () => Promise<void>
	versions: (node: string, part: string) => Version[]
	forget(sync: Pick<Sync, "passed">): Promise<void>
	load(): Promise<void>
	stop(): void
}

export function createHistory(o: {
	log: Log
	table: Table
	places: Pick<Places, "commit" | "watchAll">
	kept?: (node: string, part: string) => boolean
	run?: <T>(f: () => T) => T
	forgets?: boolean
	// how many of each entry's newest steps keep the patches that undo them (256): a step landing
	// among them is worked in by undoing back to it, not from the first step. 0: always from the first
	rebase?: number
}): History {
	const { log, table, places } = o
	const kept = o.kept ?? keptByDefault
	const run = o.run ?? (<T>(f: () => T) => f())
	const entries = new Map<string, Ref[]>()
	const heads = new Map<string, Ref[]>()
	// per entry, made when first asked (named): for each step named in an on, the newest step naming
	// it; and the newest old step, which names every step before it. so a late step is looked up,
	// never every later step read again
	const namers = new Map<string, { by: Map<string, Ref>; old?: Ref }>()
	// per entry, the value its steps make as history worked it out (the graph's, but for a write here
	// not kept), and its newest steps in the order applied, each with what undoes it; all: those are
	// every step in value. none: not known (after a load, or rebase 0), worked out from the first
	const window = o.forgets ? 0 : o.rebase ?? 256
	const own = new Map<string, Own>()
	const failed: Failed[] = []
	const unkept: Omit<Failed, "device" | "n">[] = []
	let landing = false
	const broken = new Set<string>()
	const changed: (() => void)[] = []
	const tell = () => changed.forEach((f) => f())

	function fail(s: Step, e: unknown) {
		failed.push({ device: s.device, n: s.n, node: s.node, part: s.part, why: String(e) })
		tell()
	}
	const header = (s: Step): ChangeHeader => ({
		time: s.when,
		actor: s.who ?? s.device,
		frame: { info: { device: s.device, n: s.n, lamport: s.lamport }, parent: undefined },
	})

	function place(s: Step): boolean {
		const k = name(s.part, s.node), ref: Ref = [s.lamport, s.device, s.n]
		let refs = entries.get(k)
		// an entry seen from its first step: its own value from nothing, every step in its tail
		if (!refs) {
			entries.set(k, refs = []), window && own.set(k, { value: undefined, tail: [], all: true })
		}
		if (o.forgets) return refs[0] && before(ref, refs[0]) ? false : (refs[0] = ref, true)
		let i = refs.length
		while (i > 0 && before(ref, refs[i - 1])) i--
		refs.splice(i, 0, ref)
		const n = namers.get(k)
		if (n) noted(n, s, ref)
		return i === refs.length - 1
	}

	const newer = (a: Ref | undefined, b: Ref) => !a || before(a, b) ? b : a
	function noted(n: { by: Map<string, Ref>; old?: Ref }, s: Step, r: Ref) {
		if (!s.on) return void (n.old = newer(n.old, r))
		for (const o of s.on) n.by.set(`${o.device} ${o.n}`, newer(n.by.get(`${o.device} ${o.n}`), r))
	}

	function head(s: Step, last: boolean) {
		const k = name(s.part, s.node), ref: Ref = [s.lamport, s.device, s.n]
		if (o.forgets) return void (last && heads.set(k, [ref]))
		const hs = (heads.get(k) ?? []).filter((h) => !covers(s, h))
		if (last || !named(k, ref)) hs.push(ref)
		heads.set(k, hs.sort((a, b) => before(a, b) ? 1 : -1))
	}
	// a step of the entry's after ref names it (one not held passed over)
	function named(k: string, ref: Ref) {
		let n = namers.get(k)
		// no index yet and few steps after ref (only those can name it): read them, no index made
		const refs = entries.get(k) ?? []
		let i = refs.length
		while (!n && i > 0 && refs.length - i <= FEW && before(ref, refs[i - 1])) i--
		if (!n && refs.length - i <= FEW) {
			for (; i < refs.length; i++) {
				try {
					if (covers(decodeStep(log.step(refs[i][1], refs[i][2])), ref)) return true
				} catch {
					// not held
				}
			}
			return false
		}
		if (!n) {
			namers.set(k, n = { by: new Map() })
			for (const r of entries.get(k) ?? []) {
				try {
					noted(n, decodeStep(log.step(r[1], r[2])), r)
				} catch {
					// not held
				}
			}
		}
		const by = n.by.get(`${ref[1]} ${ref[2]}`)
		return (by !== undefined && before(ref, by)) || (n.old !== undefined && before(ref, n.old))
	}

	function versions(node: string, part: string): Version[] {
		const k = name(part, node), refs = entries.get(k)
		if (!refs?.length) return []
		const hs = (heads.get(k) ?? []).slice(0, MOST)
		const item = (value: unknown, from: Ref[]): Version => ({
			...(value === undefined && { gone: true as const }),
			value,
			from: { heads: from.map((r) => [r[1], r[2]]) },
		})
		const shown = table.get(part as Key, node)?.value, out = [item(shown, hs)]
		const known = () => out.some((v) => !v.gone) ? out : []
		if (o.forgets || hs.length < 2) return known()
		let steps: Step[]
		try {
			steps = refs.map((r) => decodeStep(log.step(r[1], r[2])))
		} catch {
			return known()
		}
		const at = new Map(refs.map((r, i) => [`${r[1]} ${r[2]}`, i]))
		const seen = new Array<number>(refs.length).fill(0), all = (1 << hs.length) - 1
		hs.forEach((h, j) => seen[at.get(`${h[1]} ${h[2]}`)!] |= 1 << j)
		for (let i = refs.length - 1; i >= 0; i--) {
			const on: readonly On[] | undefined = steps[i].on
			if (!seen[i]) continue
			if (!on) { for (let j = 0; j < i; j++) seen[j] |= seen[i] }
			else {
				for (const x of on) {
					const j = at.get(`${x.device} ${x.n}`)
					if (j !== undefined) seen[j] |= seen[i]
				}
			}
		}
		let start = 0
		for (let i = refs.length - 1; i > 0; i--) {
			if (seen[i] === all && whole(steps[i])) {
				start = i
				break
			}
		}
		const listed = [bytesOf(shown)]
		hs.forEach((h, j) => {
			const bit = 1 << j
			const side = steps.flatMap((s, i) =>
				i >= start && seen[i] & bit && seen[i] !== all ? s.patches.flatMap(touched) : []
			)
			let value: unknown
			for (let i = start; i < steps.length; i++) {
				const ps = seen[i] & bit
					? steps[i].patches
					: steps[i].patches.filter((p) =>
						!touched(p).some((a) => side.some((b) => overlap(a, b)))
					)
				if (!ps.length) continue
				try {
					value = apply(value, ps)
				} catch {
				}
			}
			const b = bytesOf(value)
			if (!listed.some((x) => same(x, b))) listed.push(b), out.push(item(value, [h]))
		})
		return known()
	}

	function quietly(f: () => void) {
		landing = true
		try {
			run(f)
		} finally {
			landing = false
		}
	}

	function write(s: Step, patches: readonly Patch[]) {
		quietly(() => {
			const e = table.get(s.part as Key, s.node)
			if (e) return void (update(e, patches, header(s)), places.commit([e]))
			const v = apply(undefined, patches)
			if (v !== undefined) table.add(s.part as Key, s.node, createEntry(v as never, header(s)))
		})
	}

	// a step applied after the rest to an entry's own value, and noted in its tail; one that doesn't
	// apply passed over (nothing to undo)
	function onto(mine: Own, r: Ref, patches: readonly Patch[]): boolean {
		const undo: Patch[] = []
		let ok = true
		try {
			mine.value = apply(mine.value, patches, { undo })
		} catch {
			undo.length = 0, ok = false
		}
		mine.tail.push({ ref: r, undo })
		if (mine.tail.length > window) {
			mine.tail.splice(0, mine.tail.length - window), mine.all = false
		}
		return ok
	}

	// an entry worked out again for its early steps (placed, not applied): its own value undone back
	// to before the earliest, when its tail reaches that far, else from nothing; then every step from
	// there applied in order, and the value written whole
	function rework(k: string, early: Ref[]) {
		const refs = entries.get(k)!
		const first = early.reduce((a, b) => before(b, a) ? b : a)
		let mine = own.get(k), from = 0
		if (mine) {
			let t = mine.tail.length, value = mine.value
			while (t > 0 && before(first, mine.tail[t - 1].ref)) {
				value = apply(value, mine.tail[--t].undo)
			}
			if (t > 0 || mine.all) {
				mine.tail.length = t, mine.value = value
				from = refs.findIndex((r) => r[1] === first[1] && r[2] === first[2])
			} else mine = undefined
		}
		if (!mine) mine = { value: undefined, tail: [], all: true }
		let last: Step | undefined
		const fixed = new Set<Failed>()
		for (let i = from; i < refs.length; i++) {
			const step = decodeStep(log.step(refs[i][1], refs[i][2])),
				was = failed.find((f) => f.device === step.device && f.n === step.n)
			const undo: Patch[] = []
			try {
				mine.value = apply(mine.value, step.patches, { undo })
				last = step
				if (was) fixed.add(was)
			} catch (e) {
				undo.length = 0
				if (!was) fail(step, e)
			}
			mine.tail.push({ ref: refs[i], undo })
		}
		if (mine.tail.length > window) {
			mine.tail.splice(0, mine.tail.length - window), mine.all = false
		}
		if (window) own.set(k, mine)
		else own.delete(k)
		const value = mine.value
		write(last ?? decodeStep(log.step(first[1], first[2])), [
			value === undefined ? { path: [] } : { path: [], value },
		])
		if (fixed.size) {
			failed.splice(0, failed.length, ...failed.filter((f) => !fixed.has(f))), tell()
		}
	}

	// entries a step landed early in, to be worked out again once the log is quiet: once for a
	// whole catch-up, however many runs it comes in. a step going last in one waits with it
	const waiting = new Map<string, Ref[]>()
	function land(steps: Step[]) {
		for (const s of steps) {
			const k = name(s.part, s.node), r: Ref = [s.lamport, s.device, s.n]
			try {
				const last = place(s)
				if (o.forgets && !last) continue
				head(s, last)
				if (!last || waiting.has(k)) waiting.set(k, [...waiting.get(k) ?? [], r])
				else {
					const mine = own.get(k)
					if (mine) onto(mine, r, s.patches)
					write(s, s.patches)
				}
			} catch (e) {
				fail(s, e)
			}
		}
	}
	function flush() {
		const all = [...waiting]
		waiting.clear()
		for (const [k, early] of all) {
			try {
				rework(k, early)
			} catch (e) {
				fail(decodeStep(log.step(early[0][1], early[0][2])), e)
			}
		}
	}

	async function snapshot() {
		const out: [string, string, Value | null, Ref[], number[]][] = []
		for (const [k, refs] of entries) {
			const [part, node] = k.split("\0")
			const v = table.get(part as Key, node)?.value
			const hs = (heads.get(k) ?? []).map((h) =>
				refs.findIndex((r) => r[1] === h[1] && r[2] === h[2])
			)
			out.push([part, node, v === undefined ? null : v as Value, refs, hs])
		}
		const count: Record<string, number> = {}
		for (const d of Object.keys(log.have())) count[d] = log.count(d)
		await log.snapshot(encode({ count, entries: out } as unknown as Value))
	}

	const unwatch = places.watchAll((f) => {
		if (landing || typeof f.id !== "string" || !kept(f.id, String(f.part))) return
		const who = f.change?.actor, k = name(String(f.part), f.id)
		const first = f.patches[0], whole = first?.path.length === 0 && !first.range && !first.move
		let s: Step
		try {
			if (broken.has(k) && !whole) throw new Error("its entry has a write not kept")
			s = log.write({
				node: f.id,
				part: String(f.part),
				patches: f.patches.map(clean),
				on: (heads.get(k) ?? []).map(([, device, n]) => ({ device, n })),
				when: f.change?.time ?? Math.floor(Date.now() / 1000),
				...(typeof who === "string" && { who }),
			})
		} catch (e) {
			broken.add(k)
			unkept.push({ node: f.id, part: String(f.part), why: String(e) })
			return tell()
		}
		broken.delete(k)
		const last = place(s), r: Ref = [s.lamport, s.device, s.n]
		head(s, last)
		// its entry waiting: it waits too; else early, worked in now; else last, onto the value
		const mine = own.get(k)
		if (waiting.has(k)) waiting.get(k)!.push(r)
		else if (!last) rework(k, [r])
		else if (mine) onto(mine, r, s.patches)
	})
	const unlisten = log.on((device, steps) => {
		if (device !== log.device) land(steps)
	})
	const unquiet = log.onQuiet(flush)

	return {
		failed: failed as readonly Failed[],
		unkept: unkept as readonly Omit<Failed, "device" | "n">[],
		onChange(f: () => void) {
			changed.push(f)
			return () => void changed.splice(changed.indexOf(f), 1)
		},

		snapshot,
		versions,

		async forget(sync: Pick<Sync, "passed">) {
			if (!o.forgets) throw new Error("this history keeps every run")
			const held = log.have()
			await snapshot()
			const passed = sync.passed()
			log.drop(
				Object.fromEntries(
					Object.entries(held).map(([d, n]) => [d, Math.min(n, passed[d] ?? 0)]),
				),
			)
		},

		async load() {
			const bytes = await log.load()
			let count: Record<string, number> = {}
			if (bytes) {
				const snap = decode(bytes) as unknown as {
					count: Record<string, number>
					entries: [string, string, unknown, Ref[], number[]?][]
				}
				count = snap.count
				quietly(() => {
					for (const [part, node, v, refs, hs] of snap.entries) {
						entries.set(name(part, node), refs), namers.delete(name(part, node))
						own.delete(name(part, node))
						const hd = hs ? hs.map((i) => refs[i]) : refs.slice(-1)
						heads.set(name(part, node), hd.filter((r) => r !== undefined))
						if (v === null) continue
						table.sub(
							part as Key,
							node,
							createEntry(v as never, {
								time: 0,
								actor: "snapshot",
								frame: { info: {}, parent: undefined },
							}),
						)
					}
				})
			}
			const steps: Step[] = []
			for (const device of Object.keys(log.have())) {
				for (let n = (count[device] ?? 0) + 1; n <= log.count(device); n++) {
					steps.push(decodeStep(log.step(device, n)))
				}
			}
			land(steps)
			flush()
		},

		stop() {
			unwatch()
			unlisten()
			unquiet()
		},
	}
}
