// patch nodes at random, against an oracle that trusts nothing the overlay keeps: random patch
// nodes (sets, ranges, moves, takings out; some changing in place) over N's value, or its
// attributes (changed in place, as places keeps them), come, change, move to the other part, go
// and land, while N is written and replaced. after each pulse: the overlay gives what the live patch nodes, applied in order
// over the table's entry, give; every reader holds what a read now gives (nobody whose value
// changed was left untold); the layers end where the value does. a few dozen seeds
import { assertEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import { at, createPlaces, type Places, unread } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createOverlay, land, type Overlay, type PatchNode } from "./patch.ts"

function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const PARTS = ["value", "attributes"] as const
const PATHS: (string | number)[][] = [
	[],
	["a"],
	["a", "x"],
	["a", "y"],
	["b"],
	["b", 0],
	["b", 1],
	["b", 2],
	["b", 0, "x"],
	["b", 1, "x"],
	["c"],
	["d"],
	["d", "x"],
	["m"],
	["m", "x"],
]
// string parts: ASCII, BMP, pairs, a pair and a modifier, lone halves (a high then a low: a pair), U+0000
const TEXTS = ["a", "b", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
const start = () => ({ a: { x: 1, y: 2 }, b: [{ x: 10 }, { x: 11 }, 12], c: "a😀\uD83D中" })

function run(seed: number) {
	const r = random(seed)
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => overlay.onTableChange(part, id))
	const overlay: Overlay = createOverlay(table, () => places)
	const places: Places = createPlaces({
		root: "R",
		table: overlay,
		paths: createPaths(),
		scheduler: s,
	})
	const host = s.createRootScope({ actor: "host" })
	const header = () => s.runWithScope(host, () => createChangeHeader(s))
	// entries written in place, through places' unread, as children are
	const placed = new WeakSet<object>()
	const put = (part: Key, id: Id, v: unknown) => {
		const e = createEntry(v, header())
		if (r() < 0.3) placed.add(e)
		table.sub(part, id, e as never)
	}
	const write = (e: Entry<unknown>, ps: Patch[]) =>
		(placed.has(e) ? unread.update : update)(e, ps, header())

	for (const part of PARTS) put(part, "N", start())
	const readers = PARTS.flatMap((part) =>
		PATHS.map((path) => {
			const w = { part, path, value: undefined as unknown }
			s.runWithScope(
				s.createRootScope({ actor: "reader" }),
				() =>
					s.createComputer(
						() => structuredClone(places.readValue(part, "N", path)),
						(v) => void (w.value = v),
					),
			)
			return w
		})
	)
	s.pulse()

	const text = (most = 3) =>
		Array.from({ length: Math.floor(r() * (most + 1)) }, () => pick(TEXTS)).join("")
	const value = () => pick([0, 1, text(), { x: 3 }, [7, 8]])
	const somewhere = () => pick(PATHS.filter((p) => p.length))
	function patch(): Patch {
		const path = somewhere()
		const k = r()
		// a move out of a, written under next: what readers had changes with it, in place
		if (k < 0.1) return { path: ["m"], move: { path: ["a"] } }
		if (k < 0.4) return { path, value: value() }
		if (k < 0.55) return { path }
		if (k < 0.65) {
			const a = Math.floor(r() * 3), b = a + Math.floor(r() * 2)
			return { path: ["b"], range: [a, b], value: r() < 0.5 ? [9] : [] }
		}
		if (k < 0.75) {
			// c's code points: set, taken out, or moved within
			const a = Math.floor(r() * 5), b = a + Math.floor(r() * 3)
			const j = r()
			if (j < 0.5) return { path: ["c"], range: [a, b], value: text(2) }
			if (j < 0.7) return { path: ["c"], range: [a, b] }
			const g = Math.floor(r() * 4)
			return { path: ["c"], range: [g, g], move: { path: ["c"], range: [a, b] } }
		}
		return { path, move: { path: somewhere() } }
	}
	const patches = () => Array.from({ length: 1 + Math.floor(r() * 2) }, patch)
	const node = (part: Key): PatchNode => ({ on: "N", part, at: 0, patches: patches() })

	// what the overlay should give at (part, N): the live patch nodes over it, in the index's order
	// (its rule: the order they came), each applied over the table's entry, set aside if it throws
	function oracle(part: Key) {
		const over = (p: Id) => {
			const v = table.get("patch", p)?.value
			return v?.on === "N" && v.part === part
		}
		let v = table.get(part, "N")?.value
		for (const p of (overlay.index.get("N") ?? []).filter(over)) {
			try {
				v = apply(v, table.get("patch", p)!.value!.patches)
			} catch { /* set aside */ }
		}
		return v
	}

	let next = 0
	const live: Id[] = []
	for (let step = 0; step < 40; step++) {
		const k = r(), part = pick(PARTS)
		if (k < 0.2 || live.length === 0) {
			const p = `P${next++}`
			live.push(p)
			put("patch", p, node(part))
		} else if (k < 0.35) {
			const p = pick(live)
			const e = table.get("patch", p)!
			write(e, [{ path: ["patches"], value: patches() }])
			overlay.commit([e])
		} else if (k < 0.4) {
			// moved to the other part
			const p = pick(live)
			const e = table.get("patch", p)!
			const other = e.value!.part === "value" ? "attributes" : "value"
			write(e, [{ path: ["part"], value: other }])
			overlay.commit([e])
		} else if (k < 0.45) {
			// a patch node's entry replaced whole
			put("patch", pick(live), node(part))
		} else if (k < 0.52) {
			table.del("patch", live.splice(Math.floor(r() * live.length), 1)[0])
		} else if (k < 0.56) {
			const p = pick(live)
			try {
				overlay.commit(land(table, p, header()))
				live.splice(live.indexOf(p), 1)
			} catch { /* its patches don't apply: nothing changed */ }
		} else if (k < 0.62) {
			// N's entry replaced whole
			put(part, "N", start())
		} else {
			const n = table.get(part, "N")!
			const ps = patches()
			try {
				apply(n.value, ps)
			} catch {
				continue
			}
			write(n, ps)
			overlay.commit([n])
		}
		s.pulse()
		const where = `seed ${seed}, step ${step}`
		assertEquals(
			new Set(overlay.index.get("N") ?? []),
			new Set(live.filter((p) => table.get("patch", p) !== undefined)),
			`${where}, index`,
		)
		for (const part of PARTS) {
			const now = oracle(part)
			assertEquals(overlay.get(part, "N")?.value, now, `${where}, ${part}`)
			// the layers, made one patch node at a time, end where the value does
			assertEquals(overlay.layers(part, "N")[0]?.value, now, `${where}, ${part} layers`)
		}
		for (const w of readers) {
			const now = at(oracle(w.part), w.path)
			assertEquals(w.value, now, `${where}, reader ${w.part} ${JSON.stringify(w.path)}`)
		}
	}
}

Deno.test("patch nodes: the overlay gives what its patch nodes do, and tells every reader whose value changed, at random", () => {
	for (let seed = 1; seed <= 40; seed++) run(seed)
})
