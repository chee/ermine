// Where an insert by ids goes never hangs on how elements are held in runs: elements.ts against a
// plain one-element-a-place FugueMax (YjsMod), over seeded sessions of devices typing forward,
// backward, at the start and deleting, with gaps in lamports (writes elsewhere between keystrokes)
// and late steps (worked in by undoing back, as history does, so runs are cut and joined again).
import { assertEquals } from "@std/assert"
import apply, { type Patch } from "@ermine/changeable/apply"
import { fresh, type State, step } from "./elements.ts"
import { type Id, readIds, writeIds } from "./step.ts"
import type { Value } from "@ermine/encoding/cbor"

type S = {
	device: string
	n: number
	lamport: number
	seq: number
	patches: Patch[]
	ids?: Value[]
}
const order = (a: S, b: S) =>
	a.lamport - b.lamport || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0)

// one element a place
type Item = {
	id: Id
	left: Id | null
	right: Id | null
	key: [string, number]
	gone: boolean
}
const is = (a: Id | null, b: Id | null) =>
	a === b || (!!a && !!b && a.device === b.device && a.c === b.c && a.k === b.k)
const above = (a: Item["key"], b: Item["key"]) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]
function reference(steps: S[], chars: Map<string, string>) {
	const doc: Item[] = []
	const at = (i: Id | null, none: number) => i ? doc.findIndex((x) => is(x.id, i)) : none
	for (const s of [...steps].sort(order)) {
		if (!s.ids) continue
		const anchors = readIds(s, s.ids).map((x) => x!.splice!)
		let c = s.seq
		s.patches.forEach((p, q) => {
			const a = anchors[q]
			for (const [g, k] of a.gone) {
				for (let x = 0; x < k; x++) doc[at({ ...g, c: g.c + x }, -1)].gone = true
			}
			const n = p.value === undefined ? 0 : [...(p.value as string)].length
			if (!n) return
			const right = a.before === undefined
				? null
				: a.before === true
				? doc[at(a.after, -1)].right
				: a.before
			let left = at(a.after, -1)
			for (let e = 0; e < n; e++, c++) {
				const it: Item = {
					id: { device: s.device, c },
					left: e ? { device: s.device, c: c - 1 } : a.after,
					right,
					key: [s.device, c],
					gone: false,
				}
				let spot = left + 1
				if (e === 0) {
					const r = at(right, doc.length)
					let scanning = false
					for (let i = spot;; i++) {
						if (!scanning) spot = i
						if (i === doc.length || i === r) break
						const o = doc[i], ol = at(o.left, -1), or = at(o.right, doc.length)
						if (ol < left) break
						if (ol === left) {
							if (or === r && above(it.key, o.key)) break
							scanning = or < r
						}
					}
				}
				doc.splice(spot, 0, it)
				left = spot
			}
		})
	}
	return doc.filter((x) => !x.gone).map((x) => chars.get(`${x.id.device} ${x.id.c}`)).join("")
}

// a device: its elements, and its tail of steps with what undoes each
type Device = { st: State; tail: { s: S; undo: Patch[]; back: (() => void)[] }[]; has: Set<S> }
function onto(d: Device, s: S) {
	const undo: Patch[] = [], back: (() => void)[] = []
	try {
		step(d.st, s, { undo, back })
		d.tail.push({ s, undo, back })
	} catch {
		d.tail.push({ s, undo: [], back: [] })
	}
}
// late steps worked in: undone back to the earliest, then all again in order
function take(d: Device, steps: S[]) {
	const late = steps.filter((s) => !d.has.has(s)).sort(order)
	if (!late.length) return
	const again: S[] = []
	while (d.tail.length && order(d.tail.at(-1)!.s, late[0]) > 0) {
		const x = d.tail.pop()!
		d.st.value = apply(d.st.value, x.undo)
		for (const f of [...x.back].reverse()) f()
		again.push(x.s)
	}
	for (const s of [...again, ...late].sort(order)) onto(d, s)
	for (const s of late) d.has.add(s)
}

Deno.test("elements: where an insert goes never hangs on its runs (FugueMax, one a place)", () => {
	let seed = 1
	const rand = (n: number) =>
		Math.floor((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * n)
	for (let run = 1; run <= 200; run++) {
		seed = run
		const names = [1, 2, 3].map((i) => i.toString(16).padStart(2, "0").repeat(32))
		const chars = new Map<string, string>()
		let glyph = 0x4e00
		const put: S = {
			device: names[0],
			n: 1,
			lamport: 1,
			seq: 0,
			patches: [{ path: [], value: "" }],
		}
		const all: S[] = [put], known = names.map(() => new Set<S>([put]))
		const ds: Device[] = names.map(() => ({ st: fresh(), tail: [], has: new Set() }))
		ds.forEach((d) => take(d, [put]))
		const count = names.map((_, i) => i === 0 ? 1 : 0), seqs = names.map(() => 0)
		const gap = names.map(() => 0)
		for (let op = 0; op < 40; op++) {
			if (rand(10) < 3) {
				const a = rand(3), b = rand(3)
				for (const s of known[b]) known[a].add(s)
				for (const s of known[a]) known[b].add(s)
				take(ds[a], [...known[a]]), take(ds[b], [...known[b]])
				continue
			}
			const i = rand(3), d = ds[i], mode = rand(5), times = 1 + rand(4)
			let pos = -1
			for (let t = 0; t < times; t++) {
				// a write elsewhere between keystrokes: a gap in lamports
				if (rand(3) === 0) gap[i] += 1 + rand(3)
				const len = [...(d.st.value as string)].length
				if (pos < 0 || pos > len) pos = mode === 0 ? 0 : rand(3) ? len : rand(len + 1)
				let p: Patch
				if (mode === 4 && len > 0) {
					pos = Math.min(pos, len - 1)
					p = { path: [], range: [pos, pos + 1 + rand(Math.min(2, len - pos))] }
				} else {
					const v = String.fromCharCode(glyph++) +
						(rand(4) ? "" : String.fromCharCode(glyph++))
					p = { path: [], range: [pos, pos], value: v }
					;[...v].forEach((ch, x) => chars.set(`${names[i]} ${seqs[i] + x}`, ch))
					if (mode === 1) pos += [...v].length
				}
				const lamport = Math.max(...[...known[i]].map((s) => s.lamport)) + 1 + gap[i]
				const at = { device: names[i], n: ++count[i], seq: seqs[i] }
				const undo: Patch[] = [], back: (() => void)[] = []
				const { ids } = step(d.st, { ...at, lamport, patches: [p] }, { undo, back })
				const s: S = { ...at, lamport, patches: [p], ids: writeIds(at, ids) }
				d.tail.push({ s, undo, back }), d.has.add(s)
				seqs[i] += p.value === undefined ? 0 : [...(p.value as string)].length
				all.push(s), known[i].add(s)
			}
		}
		const want = reference(all, chars)
		for (const d of ds) take(d, all)
		const once = fresh()
		for (const s of [...all].sort(order)) {
			try {
				step(once, s)
			} catch {
				// as every peer: passed over
			}
		}
		assertEquals(once.value, want, `seed ${run}: all at once`)
		ds.forEach((d, i) => assertEquals(d.st.value, want, `seed ${run}: device ${i}, late steps`))
	}
})

const A = "01".repeat(32), B = "02".repeat(32)
Deno.test("elements: one gone span over many runs is found run by run in no time (an index by id)", () => {
	const P = 40000, state = fresh()
	const put: Patch = { path: [], value: { t: "" } }
	step(state, { device: A, n: 1, lamport: 1, seq: 0, patches: [put] })
	const prepend: Patch[] = Array.from(
		{ length: P },
		() => ({ path: ["t"], range: [0, 0], value: "x" }),
	)
	step(state, { device: A, n: 2, lamport: 2, seq: 0, patches: prepend })
	assertEquals((state.value as { t: string }).t.length, P)
	const gone: Patch = { path: ["t"], range: [0, 0] }
	const began = performance.now()
	step(state, {
		device: B,
		n: 1,
		lamport: 3,
		seq: 0,
		patches: [gone],
		ids: [[null, [[[new Uint8Array(32).fill(1), 0], P]], null, []]],
	})
	assertEquals((state.value as { t: string }).t, "")
	assertEquals(performance.now() - began < 1500, true)
})
