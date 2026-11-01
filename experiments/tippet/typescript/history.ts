// History: a graph and its log, tied. The recorder turns kept writes into steps; the lander writes
// steps from elsewhere into the graph. An entry's value is its steps' patches applied in order of
// lamport, then device, a splice by ids where its writer meant (elements.ts); a step that lands
// earlier makes the entry be worked out again, undone back to it when it can be (rebase).
// versions(node, part) lists the merge, then each head's own value (at most the 16 newest heads).
// forgets: a device that holds, per entry, only its newest step and its elements, the value being
// the graph's; a late step goes into them as is, or, when what it does needs the steps after it,
// the entry is worked out again from the log. forget(sync) snapshots and lets go the runs that have
// passed on; after that a late step needing them is passed over.
import createEntry, { type ChangeHeader } from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import apply, { type Patch } from "@ermine/changeable/apply"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Places } from "@ermine/places"
import type { Key, Table } from "@ermine/graph/table"
import { decodeStep, needs, same, type Step, writeIds } from "./step.ts"
import {
	fresh,
	LATE,
	Late,
	load as loadState,
	save as saveState,
	type State,
	step as applyStep,
} from "./elements.ts"
import type { Log } from "./log.ts"
import type { Sync } from "./sync.ts"

type Ref = [lamport: number, device: string, n: number]
type Own = State & { tail: { ref: Ref; undo: Patch[]; back: (() => void)[] }[]; all: boolean }
export type Failed = { device: string; n: number; node: string; part: string; why: string }
export type Version = {
	value: unknown
	gone?: true
	from: { heads: [device: string, n: number][] }
}
const MOST = 16

const before = (a: Ref, b: Ref) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const name = (part: string, node: string) => `${part}\0${node}`
const covers = (s: Step, r: Ref) => s.on.some((o) => o.device === r[1] && o.n === r[2])
const touched = (p: Patch) => p.move ? [p.path, p.move.path] : [p.path]
const overlap = (a: readonly unknown[], b: readonly unknown[]) => {
	for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return false
	return true
}
const whole = (s: Step) => {
	const p = s.patches[0]
	return p !== undefined && p.path.length === 0 && !p.range && !p.move
}
const puts = (s: Step) => s.patches.length === 1 && whole(s) && s.patches[0].value !== undefined
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
	// per entry its elements only, the value the graph's (WIRE.md, ids: a reader that forgets)
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
	// it. so a late step is looked up, never every later step read again
	const namers = new Map<string, Map<string, Ref>>()
	// per entry, the value its steps make as history worked it out (the graph's, but for a write here
	// that made no step) and its strings' and arrays' elements (elements.ts), and its newest steps
	// (rebase) in the order applied, each with what undoes it; all: those are every step in it. none:
	// not known (after a load: made again from the first step when needed). forgets: its elements
	// only, the value the graph's, from the entry's first step seen
	const window = o.forgets ? 0 : o.rebase ?? 256
	const own = new Map<string, Own>()
	const failed: Failed[] = []
	const unkept: Omit<Failed, "device" | "n">[] = []
	let landing = false
	const broken = new Set<string>()
	const changed: (() => void)[] = []
	const tell = () => changed.forEach((f) => f())

	// forgets: each failed step's place, and per entry the newest of them: a late step before it may
	// let it apply, one after it can't
	// forgets: per entry the place of its newest step that is one put of the whole value
	const top = new Map<string, Ref>()
	const failedAt = new WeakMap<Failed, Ref>()
	const worst = new Map<string, Ref>()
	function fail(s: Step, e: unknown) {
		const f: Failed = { device: s.device, n: s.n, node: s.node, part: s.part, why: String(e) }
		failed.push(f)
		if (o.forgets) {
			const k = name(s.part, s.node), r: Ref = [s.lamport, s.device, s.n], w = worst.get(k)
			failedAt.set(f, r)
			if (!w || before(w, r)) worst.set(k, r)
		}
		tell()
	}
	// forgets: worst again, after failed steps of entry k went
	function refail(k: string) {
		worst.delete(k)
		for (const f of failed) {
			const r = failedAt.get(f), w = worst.get(k)
			if (r && name(f.part, f.node) === k && (!w || before(w, r))) worst.set(k, r)
		}
	}
	const header = (s: Step): ChangeHeader => ({
		time: s.when,
		actor: s.who ?? s.device,
		frame: { info: { device: s.device, n: s.n, lamport: s.lamport }, parent: undefined },
	})

	function place(s: Step, ref: Ref): boolean {
		const k = name(s.part, s.node)
		let refs = entries.get(k)
		// an entry seen from its first step, a whole value: its own from nothing, every step in its tail
		if (!refs) {
			entries.set(k, refs = [])
			if ((o.forgets || whole(s)) && !own.has(k)) own.set(k, { ...fresh(), tail: [], all: true })
		}
		if (o.forgets) {
			if (puts(s) && !(top.get(k) && before(ref, top.get(k)!))) top.set(k, ref)
			return refs[0] && before(ref, refs[0]) ? false : (refs[0] = ref, true)
		}
		let i = refs.length
		while (i > 0 && before(ref, refs[i - 1])) i--
		refs.splice(i, 0, ref)
		const n = namers.get(k)
		if (n) noted(n, s, ref)
		return i === refs.length - 1
	}

	const newer = (a: Ref | undefined, b: Ref) => !a || before(a, b) ? b : a
	function noted(n: Map<string, Ref>, s: Step, r: Ref) {
		for (const o of s.on) n.set(`${o.device} ${o.n}`, newer(n.get(`${o.device} ${o.n}`), r))
	}

	function head(s: Step, ref: Ref, last: boolean) {
		const k = name(s.part, s.node)
		if (o.forgets) return void (last && heads.set(k, [ref]))
		const hs = (heads.get(k) ?? []).filter((h) => !covers(s, h))
		if (last || !named(k, ref)) hs.push(ref)
		heads.set(k, hs.sort((a, b) => before(a, b) ? 1 : -1))
	}
	// a step of the entry's after ref names it (one not held passed over)
	function named(k: string, ref: Ref) {
		let n = namers.get(k)
		if (!n) {
			namers.set(k, n = new Map())
			for (const r of entries.get(k) ?? []) {
				try {
					noted(n, decodeStep(log.step(r[1], r[2])), r)
				} catch {
					// not held
				}
			}
		}
		const by = n.get(`${ref[1]} ${ref[2]}`)
		return by !== undefined && before(ref, by)
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
			if (!seen[i]) continue
			for (const x of steps[i].on) {
				const j = at.get(`${x.device} ${x.n}`)
				if (j !== undefined) seen[j] |= seen[i]
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
			const st = fresh()
			for (let i = start; i < steps.length; i++) {
				const s = steps[i]
				const keep = s.patches.map((p) =>
					!!(seen[i] & bit) || !touched(p).some((a) => side.some((b) => overlap(a, b)))
				)
				if (!keep.some(Boolean)) continue
				try {
					applyStep(st, s, { keep })
				} catch {
					// a step that doesn't apply without the other side's patches: left out
				}
			}
			const value = st.value
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

	const trim = (mine: Own) => {
		if (mine.tail.length > window) {
			mine.tail.splice(0, mine.tail.length - window), mine.all = false
		}
	}
	// a step applied after the rest to an entry's own value, and noted in its tail: its patches as
	// applied there, by position; one that doesn't apply passed over (nothing to undo), its error
	function onto(mine: Own, r: Ref, s: Step): { applied: Patch[] } | { error: unknown } {
		const undo: Patch[] = [], back: (() => void)[] = []
		try {
			const { applied } = applyStep(mine, s, { undo, back })
			mine.tail.push({ ref: r, undo, back }), trim(mine)
			return { applied }
		} catch (error) {
			mine.tail.push({ ref: r, undo: [], back: [] }), trim(mine)
			return { error }
		}
	}

	// an entry's own value worked out again from refs[from] on (from 0: from nothing), each step
	// applied in order. note: new failures into failed. the last that applied, and those failed
	// before that apply now
	function replay(k: string, mine: Own, from: number, note: boolean) {
		const refs = entries.get(k)!
		let last: Step | undefined
		const fixed = new Set<Failed>()
		for (let i = from; i < refs.length; i++) {
			const step = decodeStep(log.step(refs[i][1], refs[i][2])),
				was = failed.find((f) => f.device === step.device && f.n === step.n)
			const out = onto(mine, refs[i], step)
			if ("applied" in out) {
				last = step
				if (was) fixed.add(was)
			} else if (!was && note) fail(step, out.error)
		}
		own.set(k, mine)
		return { last, fixed }
	}
	// an entry's own value made again from its first step, not written (a write here needs it)
	const rebuild = (
		k: string,
	) => (replay(k, { ...fresh(), tail: [], all: true }, 0, false), own.get(k)!)

	// an entry worked out again for its early steps (placed, not applied): its own value undone back
	// to before the earliest, when its tail reaches that far, else from nothing; then every step from
	// there applied in order, and the value written whole
	function rework(k: string, early: Ref[]) {
		const refs = entries.get(k)!
		const first = early.reduce((a, b) => before(b, a) ? b : a)
		let mine = own.get(k), from = 0
		if (mine) {
			let t = mine.tail.length, value = mine.value
			const backs: (() => void)[] = []
			while (t > 0 && before(first, mine.tail[t - 1].ref)) {
				const x = mine.tail[--t]
				value = apply(value, x.undo), backs.push(...[...x.back].reverse())
			}
			if (t > 0 || mine.all) {
				for (const f of backs) f()
				mine.tail.length = t, mine.value = value
				from = refs.findIndex((r) => r[1] === first[1] && r[2] === first[2])
			} else mine = undefined
		}
		const { last, fixed } = replay(k, mine ?? { ...fresh(), tail: [], all: true }, from, true)
		const value = own.get(k)!.value
		if (value !== undefined || graph(k) !== undefined) {
			write(last ?? decodeStep(log.step(first[1], first[2])), [
				value === undefined ? { path: [] } : { path: [], value },
			])
		}
		if (fixed.size) {
			failed.splice(0, failed.length, ...failed.filter((f) => !fixed.has(f)))
			if (o.forgets) refail(k)
			tell()
		}
	}

	// forgets: a step into an entry's elements, late or not. a late one needing the steps after it, or
	// not applying, or into an entry with failed steps: the entry is worked out again from the log
	// once it is quiet (anew); once the log let steps go, it is passed over
	const graph = (k: string) => {
		const [part, node] = k.split("\0")
		return table.get(part as Key, node)?.value
	}
	function into(k: string, s: Step, r: Ref, last: boolean, again = true) {
		const mine = own.get(k)!
		// one put of the whole value, a newer one ordered after it: overwritten, as in order
		const t = top.get(k), bad = worst.get(k)
		if (!last && puts(s) && t && before(r, t) && !(bad && before(r, bad))) return
		if (waiting.has(k)) return void waiting.get(k)!.push(r)
		mine.value = graph(k)
		try {
			const { applied } = applyStep(mine, s, { late: !last })
			write(s, applied)
			mine.value = graph(k)
		} catch (e) {
			mine.value = graph(k)
			if (!last && !cut) return void waiting.set(k, [r])
			return void fail(s, e instanceof Late ? LATE : e)
		}
		const w = worst.get(k)
		if (last || !again || !w || !before(r, w)) return
		if (!cut) return void waiting.set(k, [r])
		for (const f of failed.filter((f) => name(f.part, f.node) === k)) {
			let t: Step
			try {
				t = decodeStep(log.step(f.device, f.n))
			} catch {
				continue
			}
			const i = failed.indexOf(f)
			if (i < 0) continue
			failed.splice(i, 1)
			into(k, t, [t.lamport, t.device, t.n], false, false)
		}
		refail(k)
		tell()
	}
	// forgets: the entry's steps the log holds, in order, applied again from nothing, its value
	// written whole; none let go. scan: the log read once for all the entries of a catch-up
	let cut = false
	function scan(keys: Set<string>) {
		const out = new Map<string, Ref[]>()
		for (const d of Object.keys(log.have())) {
			for (let n = 1; n <= log.count(d); n++) {
				let bytes: Uint8Array
				try {
					bytes = log.step(d, n)
				} catch {
					cut = true
					return
				}
				try {
					const t = decodeStep(bytes), k = name(t.part, t.node)
					if (keys.has(k)) out.set(k, [...out.get(k) ?? [], [t.lamport, d, n]])
				} catch {
					// not a step
				}
			}
		}
		return out
	}
	function anew(k: string, early: Ref[], refs: Ref[] = []) {
		// some let go: each as it comes
		if (cut) {
			for (const r of early.sort((a, b) => before(a, b) ? -1 : 1)) {
				into(k, decodeStep(log.step(r[1], r[2])), r, !before(r, entries.get(k)![0]))
			}
			return
		}
		refs.sort((a, b) => before(a, b) ? -1 : 1)
		entries.set(k, refs), own.delete(k)
		try {
			rework(k, [refs[0]])
		} finally {
			entries.set(k, refs.slice(-1))
			const mine = own.get(k)
			if (mine) mine.value = graph(k), mine.tail = [], mine.all = false
		}
	}

	// entries a step landed early in, to be worked out again once the log is quiet: once for a
	// whole catch-up, however many runs it comes in. a step going last in one waits with it
	const waiting = new Map<string, Ref[]>()
	function land(steps: Step[]) {
		for (const s of steps) {
			const k = name(s.part, s.node)
			try {
				const r: Ref = [s.lamport, s.device, s.n]
				const last = place(s, r)
				head(s, r, last)
				if (o.forgets) {
					into(k, s, r, last)
					continue
				}
				const mine = own.get(k)
				if (!last || waiting.has(k)) waiting.set(k, [...waiting.get(k) ?? [], r])
				else if (mine) {
					// by its ids, as its own value has it
					const out = onto(mine, r, s)
					if ("applied" in out) write(s, out.applied)
					else fail(s, out.error)
				} else if (s.patches.some(needs)) rework(k, [r])
				else write(s, s.patches)
			} catch (e) {
				fail(s, e)
			}
		}
	}
	function flush() {
		const all = [...waiting]
		waiting.clear()
		const found = o.forgets && !cut && all.length ? scan(new Set(all.map(([k]) => k))) : undefined
		for (const [k, early] of all) {
			try {
				if (o.forgets) anew(k, early, found?.get(k))
				else rework(k, early)
			} catch (e) {
				fail(decodeStep(log.step(early[0][1], early[0][2])), e)
			}
		}
	}

	async function snapshot() {
		const out: [string, string, Value | null, Ref[], number[], Value | null, Ref | null][] = []
		for (const [k, refs] of entries) {
			const [part, node] = k.split("\0")
			const v = table.get(part as Key, node)?.value
			const hs = (heads.get(k) ?? []).map((h) =>
				refs.findIndex((r) => r[1] === h[1] && r[2] === h[2])
			)
			out.push([
				part,
				node,
				v === undefined ? null : v as Value,
				refs,
				hs,
				o.forgets && own.has(k) ? saveState(own.get(k)!) : null,
				o.forgets ? top.get(k) ?? null : null,
			])
		}
		const count: Record<string, number> = {}
		for (const d of Object.keys(log.have())) count[d] = log.count(d)
		await log.snapshot(encode({ count, entries: out } as unknown as Value))
	}

	const unwatch = places.watchAll((f) => {
		if (landing || typeof f.id !== "string" || !kept(f.id, String(f.part))) return
		const who = f.change?.actor, id = f.id, k = name(String(f.part), id)
		const me = log.device, known = entries.get(k)?.length
		const start = (all: boolean): Own => ({ ...fresh(), tail: [], all })
		const wholly = (ps: Patch[]) => ps[0]?.path.length === 0 && !ps[0].range && !ps[0].move
		// the write as a step: its splices and the array items its paths go through named from the
		// entry's own elements, applied there (as the graph has it); a whole value starts them again.
		// throws when it can't, with the entry's own value as it was
		function attempt(patches: Patch[]): Step {
			const whole = wholly(patches)
			const mine = me === undefined
				? undefined
				: whole && (broken.has(k) || !known || (o.forgets && !own.has(k)))
				? start(!known)
				: broken.has(k)
				? undefined
				: own.get(k) ?? (known ? o.forgets ? undefined : rebuild(k) : start(true))
			const undo: Patch[] = [], back: (() => void)[] = []
			const n = me === undefined ? 0 : log.count(me) + 1
			const at = { device: me ?? "", n, seq: me === undefined ? 0 : log.seq(me) }
			let ids: Value[] | undefined
			try {
				if (broken.has(k) && !whole) throw new Error("its entry has a write not kept")
				if (mine) {
					ids = writeIds(
						at,
						applyStep(mine, { ...at, lamport: log.lamport + 1, patches }, { undo, back }).ids,
					)
				}
				if (
					ids ? patches.some((p, i) => needs(p) !== (ids![i] !== null)) : patches.some(needs)
				) {
					throw new Error("its elements can't name it")
				}
				const s = log.write({
					node: id,
					part: String(f.part),
					patches,
					on: (heads.get(k) ?? []).map(([, device, n]) => ({ device, n })),
					ids: ids ?? patches.map(() => null),
					when: f.change?.time ?? Math.floor(Date.now() / 1000),
					...(typeof who === "string" && { who }),
				})
				const r: Ref = [s.lamport, s.device, s.n], last = place(s, r)
				head(s, r, last)
				// last always (one past the highest lamport seen). named: in its own value already
				if (mine) own.set(k, mine), mine.tail.push({ ref: r, undo, back }), trim(mine)
				if (o.forgets && own.has(k)) own.get(k)!.value = graph(k)
				return s
			} catch (e) {
				// its own value has a write no step holds: undone
				if (mine && ids && own.get(k) === mine) {
					mine.value = apply(mine.value, undo)
					for (const f of [...back].reverse()) f()
				}
				throw e
			}
		}
		const patches = f.patches.map(clean)
		try {
			attempt(patches)
		} catch (e) {
			if (wholly(patches)) {
				broken.add(k)
				unkept.push({ node: id, part: String(f.part), why: String(e) })
				return tell()
			}
			// the graph's whole value instead, which starts its elements again
			const v = graph(k)
			try {
				attempt([v === undefined ? { path: [] } : { path: [], value: v }])
			} catch (x) {
				broken.add(k)
				unkept.push({ node: id, part: String(f.part), why: String(x) })
				return tell()
			}
			unkept.push({ node: id, part: String(f.part), why: `${e}, its whole value was put` })
			tell()
		}
		broken.delete(k)
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
			const drop = Object.entries(held).map(([d, n]) =>
				[d, Math.min(n, passed[d] ?? 0)] as const
			)
			cut ||= drop.some(([, n]) => n > 0)
			log.drop(Object.fromEntries(drop))
		},

		async load() {
			const bytes = await log.load()
			let count: Record<string, number> = {}
			if (bytes) {
				const snap = decode(bytes) as unknown as {
					count: Record<string, number>
					entries: [string, string, unknown, Ref[], number[], unknown, Ref | null][]
				}
				count = snap.count
				quietly(() => {
					for (const [part, node, v, refs, hs, elements, put] of snap.entries) {
						entries.set(name(part, node), refs), namers.delete(name(part, node))
						own.delete(name(part, node)), top.delete(name(part, node))
						if (put && o.forgets) top.set(name(part, node), put)
						if (elements) {
							own.set(name(part, node), {
								...loadState(elements),
								value: v ?? undefined,
								tail: [],
								all: false,
							})
						}
						heads.set(name(part, node), hs.map((i) => refs[i]).filter((r) => r !== undefined))
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
