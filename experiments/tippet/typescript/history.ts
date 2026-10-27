// history: a graph and its log, tied. every kept write here becomes a step (the recorder); every
// step from elsewhere is written into the graph (the lander). the graph is the last snapshot and the
// steps after it, like an image and its changes file
//
// the merge, lofi: an entry's value is its steps' patches applied in order of lamport, then device,
// from nothing. a step that lands last is applied as it is; one that lands earlier has its entry
// worked out again. a step whose patches don't apply is passed over, and listed in failed until
// they do
//
// heads, and versions (reads are lists: two writes made apart both stay). a step says what it was
// written on (step.ts, on): its entry's heads at the writer, the steps of it no other step there
// names (an old step, saying none, names every step before it in order). the recorder writes each
// step on the entry's heads, so a write that saw two heads replaces both. versions(node, part):
//   0. the merge above: the graph's value, the one writes are made on. from: every head
//   1. then each head's own, newest first, those not already listed: the merge again, from the
//      newest step that puts the whole value and every head has seen (or from nothing), but a patch
//      of a step the head hasn't seen is passed over where it touches what the head's side wrote:
//      a step the head has seen and another head hasn't. from: that head
//   a value removed is listed gone, and only beside one that isn't: none at all is []
// two patches made apart on one value: at paths apart (neither a prefix of the other; a move
// touches its path and move's), both stand, one version. at the same path or one inside the
// other (two splices of one text, two puts of one key, a key put inside a value put whole): both
// stay, as versions: 0 the merge (the later's applied over the earlier's; a splice's range as
// written, not moved for the other's), then each side as it wrote it. a write that saw both is
// made on 0, and is then the only head: one version again. that rule, and 0 being the merge, are
// mink's picks (10-26), not decided: 0 stays the value every device works out alike without
// knowing which side a later write took, and a write that saw both lands on the value its writer
// saw. at most the 16 newest heads get a version
//
// forgets (a try-out, off unless asked for): not a history keeper, a small device. it keeps the
// newest state per node it holds, not the runs: forget(sync), now and then where a host would
// snapshot, snapshots and lets go every run in the snapshot that has passed on (sync.passed: to
// every link; this device's own, to a keeper). it serves no one what it let go: keepers (galaxy,
// browsers) do. an entry keeps no list of its steps, only the newest: a step that comes late, older
// than the newest, is passed over, not merged in; its newest is its only head and version. lofi,
// and that's fine
//
//   const h = createHistory({ log, table, places, run: hosted })
//   await h.load()
//   await h.snapshot()
//   h.versions(node, "value")   // [{ value, from: { heads } }, …]
import createEntry, { type ChangeHeader } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Places } from "@ermine/core/places"
import type { Key, Table } from "@ermine/core/table"
import { decodeStep, type On, same, type Step } from "./step.ts"
import type { Log } from "./log.ts"
import type { Sync } from "./sync.ts"

// a step, as an entry's list holds it
type Ref = [lamport: number, device: string, n: number]
export type Failed = { device: string; n: number; node: string; part: string; why: string }
// one of an entry's values: its heads by device and n. gone: the value removed
export type Version = {
	value: unknown
	gone?: true
	from: { heads: [device: string, n: number][] }
}
// the most heads given a version each
const MOST = 16

const before = (a: Ref, b: Ref) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
// an entry's name in entries
const name = (part: string, node: string) => `${part}\0${node}`
// s names r: in its on, or, an old step, r is before it
const covers = (s: Step, r: Ref) =>
	s.on
		? s.on.some((o) => o.device === r[1] && o.n === r[2])
		: before(r, [s.lamport, s.device, s.n])
// what a patch touches: its path, and its move's
const touched = (p: Patch) => p.move ? [p.path, p.move.path] : [p.path]
// one path a prefix of the other, or the same
const overlap = (a: readonly unknown[], b: readonly unknown[]) => {
	for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return false
	return true
}
// its first patch puts (or removes) the whole value
const whole = (s: Step) => {
	const p = s.patches[0]
	return p !== undefined && p.path.length === 0 && !p.range && !p.move
}
// a value as bytes, to tell versions apart (none: empty)
const bytesOf = (v: unknown) => {
	try {
		return v === undefined ? new Uint8Array() : encode(v as Value)
	} catch {
		return new Uint8Array([0xff])
	}
}

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
	// not a history keeper (above)
	forgets?: boolean
}) {
	const { log, table, places } = o
	const kept = o.kept ?? keptByDefault
	const run = o.run ?? (<T>(f: () => T) => f())
	// each kept entry's steps, in order: part \0 node → refs; and its heads, newest first
	const entries = new Map<string, Ref[]>()
	const heads = new Map<string, Ref[]>()
	const failed: Failed[] = []
	const unkept: Omit<Failed, "device" | "n">[] = []
	// writing into the graph: the recorder passes over what that makes
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
	const header = (s: Step): ChangeHeader => ({
		time: s.when,
		actor: s.who ?? s.device,
		metadata: { device: s.device, n: s.n, lamport: s.lamport },
	})

	// a step into its entry's list; true: it went last. forgets: the list is the newest alone, and
	// one older is not put in
	function place(s: Step): boolean {
		const k = name(s.part, s.node), ref: Ref = [s.lamport, s.device, s.n]
		let refs = entries.get(k)
		if (!refs) entries.set(k, refs = [])
		if (o.forgets) return refs[0] && before(ref, refs[0]) ? false : (refs[0] = ref, true)
		let i = refs.length
		while (i > 0 && before(ref, refs[i - 1])) i--
		refs.splice(i, 0, ref)
		return i === refs.length - 1
	}

	// a step landed: the heads it names no longer heads, and it one unless a step after it names it
	// (it came late). last: it went last
	function head(s: Step, last: boolean) {
		const k = name(s.part, s.node), ref: Ref = [s.lamport, s.device, s.n]
		if (o.forgets) return void (last && heads.set(k, [ref]))
		const hs = (heads.get(k) ?? []).filter((h) => !covers(s, h))
		if (last || !named(k, ref)) hs.push(ref)
		heads.set(k, hs.sort((a, b) => before(a, b) ? 1 : -1))
	}
	// a step of the entry's after ref names it (one not held passed over)
	function named(k: string, ref: Ref) {
		for (const r of entries.get(k) ?? []) {
			if (!before(ref, r)) continue
			try {
				if (covers(decodeStep(log.step(r[1], r[2])), ref)) return true
			} catch {
				// not held
			}
		}
		return false
	}

	// an entry's versions (above)
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
		// gone only beside a value: none at all is nothing known
		const known = () => out.some((v) => !v.gone) ? out : []
		if (o.forgets || hs.length < 2) return known()
		let steps: Step[]
		try {
			steps = refs.map((r) => decodeStep(log.step(r[1], r[2])))
		} catch {
			// a step not held: the merge alone
			return known()
		}
		// which heads have seen each step, a bit each: from the newest, each step's on
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
		// what came before the newest whole value every head has seen counts for nothing
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
			// what h's side wrote: steps h has seen and some head hasn't
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
					// passed over, as the merge passes over a step that doesn't apply
				}
			}
			const b = bytesOf(value)
			if (!listed.some((x) => same(x, b))) listed.push(b), out.push(item(value, [h]))
		})
		return known()
	}

	// f, in the host's run, its writes not recorded
	function quietly(f: () => void) {
		landing = true
		try {
			run(f)
		} finally {
			landing = false
		}
	}

	// patches into the graph's entry, as step s
	function write(s: Step, patches: readonly Patch[]) {
		quietly(() => {
			const e = table.get(s.part as Key, s.node)
			if (e) return void (update(e, patches, header(s)), places.commit([e]))
			const v = apply(undefined, patches)
			if (v !== undefined) table.add(s.part as Key, s.node, createEntry(v as never, header(s)))
		})
	}

	// an entry worked out again from all its steps
	function redo(s: Step) {
		const refs = entries.get(name(s.part, s.node))!
		let value: unknown, last = s
		// those failed before that apply now
		const fixed = new Set<Failed>()
		for (const r of refs) {
			const step = decodeStep(log.step(r[1], r[2])),
				was = failed.find((f) => f.device === step.device && f.n === step.n)
			try {
				value = apply(value, step.patches)
				last = step
				if (was) fixed.add(was)
			} catch (e) {
				if (!was) fail(step, e)
			}
		}
		write(last, [value === undefined ? { path: [] } : { path: [], value }])
		if (fixed.size) {
			failed.splice(0, failed.length, ...failed.filter((f) => !fixed.has(f))), tell()
		}
	}

	// steps from elsewhere: each that goes last applied as it is; an entry one went earlier in is
	// worked out again once, after them all (forgets: one that goes earlier is passed over)
	function land(steps: Step[]) {
		const redos = new Map<string, Step>()
		for (const s of steps) {
			const k = name(s.part, s.node)
			try {
				const last = place(s)
				if (o.forgets && !last) continue
				head(s, last)
				if (!last || redos.has(k)) redos.set(k, s)
				else write(s, s.patches)
			} catch (e) {
				fail(s, e)
			}
		}
		for (const s of redos.values()) {
			try {
				redo(s)
			} catch (e) {
				fail(s, e)
			}
		}
	}

	// each kept entry's value, its list of steps and its heads (their places in the list), and how
	// many of each device's steps are in it
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

	// the recorder: a kept write here, a step
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
				// written on its entry's heads
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
		// written here, it is already in the graph, unless it sorts before steps already there
		const last = place(s)
		head(s, last)
		if (!last) redo(s)
	})
	// the lander: steps from elsewhere (this device's own are only ever written here)
	const unlisten = log.on((device, steps) => {
		if (device !== log.device) land(steps)
	})

	return {
		failed: failed as readonly Failed[],
		unkept: unkept as readonly Omit<Failed, "device" | "n">[],
		onChange(f: () => void) {
			changed.push(f)
			return () => void changed.splice(changed.indexOf(f), 1)
		},

		snapshot,
		versions,

		// forgets: a snapshot, then every run in it that has passed on let go (above)
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

		// after a restart: the log loaded, the snapshot written into the graph, and every step held
		// after it landed, this device's too
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
						entries.set(name(part, node), refs)
						// heads; none said (a snapshot from before): the newest
						const hd = hs ? hs.map((i) => refs[i]) : refs.slice(-1)
						heads.set(name(part, node), hd.filter((r) => r !== undefined))
						if (v === null) continue
						table.sub(
							part as Key,
							node,
							createEntry(v as never, { time: 0, actor: "snapshot" }),
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
		},

		stop() {
			unwatch()
			unlisten()
		},
	}
}
