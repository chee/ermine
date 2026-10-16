import { assert, assertEquals } from "@std/assert"
import { dir, disk, lay, prune, relative } from "./layout.ts"
import * as manifest from "./manifest.ts"
import * as names from "./names.ts"
import { byCodePoint } from "./names.ts"
import type { Found, Graph, Hash, Id, Laid, Layout, Node, Step, Value as Json } from "./types.ts"

// The layout is pure: these tests give it graphs and a disk in memory.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const h = (v: Json) => manifest.hash(v)

/** A node holding a value, with slots. */
function node(value: Json, directory: { [name: string]: Id[] } = {}): Node {
	const form = manifest.form(value)
	const n: Node = {
		kept: [h(value), form],
		sides: [],
		info: [],
		directory: new Map(Object.entries(directory)),
	}
	if (form === "bin") n.head = (value as Uint8Array).slice(0, names.HEAD)
	return n
}

const graph = (nodes: { [id: string]: Node }, root = "r"): Graph => ({
	root,
	nodes: new Map(Object.entries(nodes)),
})

/** What is at a path on the disk in memory: the store's, or another's. */
type Thing =
	| { kind: "file"; hash: Hash }
	| { kind: "link"; target: string }
	| { kind: "folder"; ino: number }
	| { kind: "other" }

const FIXED = new Set(["", ".ermine", ".ermine/tmp", ".ermine/id"])
const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")))

/** A disk in memory that carries plans out, checking what each step expects before and after. */
class Disk {
	things = new Map<string, Thing>()
	next = 1
	probe = (folder: string) =>
		[...this.things.keys()].filter((p) => p !== folder && parent(p) === folder)
			.map((p) => p.slice(p.lastIndexOf("/") + 1))
	ino = (path: string) => {
		const t = this.things.get(path)
		return t?.kind === "folder" ? t.ino : null
	}
	fits(path: string, f: Found): boolean {
		const t = this.things.get(path)
		if (f === null) return !t
		if ("file" in f) return t?.kind === "file" && t.hash === f.file
		if ("link" in f) return t?.kind === "link" && t.target === f.link
		return t?.kind === "folder" && (f.folder === null || t.ino === f.folder)
	}
	room(path: string) {
		const up = parent(path)
		assert(FIXED.has(up) || this.things.get(up)?.kind === "folder", `no folder for ${path}`)
		assert(!this.things.has(path), `${path} is taken`)
	}
	move(from: string, to: string) {
		assert(this.things.has(from), `nothing at ${from}`)
		this.room(to)
		for (const [p, t] of [...this.things]) {
			if (p === from || p.startsWith(from + "/")) {
				this.things.delete(p)
				this.things.set(to + p.slice(from.length), t)
			}
		}
	}
	carry(plan: Step[]) {
		plan.forEach((s, i) => assertEquals(s.number, i + 1))
		for (const s of plan) {
			const at = s.from ?? s.to!
			assert(
				this.fits(at, s.before),
				`step ${s.number} finds what it expects at ${at}: ${JSON.stringify(s)} ${
					JSON.stringify(this.things.get(at))
				}`,
			)
			if (s.what === "remove") this.move(s.from!, `.ermine/tmp/${s.number}`)
			else if (s.what === "rename") this.move(s.from!, s.to!)
			else if (s.what === "info") assert(this.things.has(s.to!), `info on nothing at ${s.to}`)
			else {
				if (s.before === null) this.room(s.to!)
				const a = s.after!
				this.things.set(
					s.to!,
					"file" in a
						? { kind: "file", hash: a.file }
						: "link" in a
						? { kind: "link", target: a.link }
						: { kind: "folder", ino: this.next++ },
				)
			}
			assert(this.fits(s.to ?? s.from!, s.after), `step ${s.number} leaves what it says`)
		}
		for (const p of [...this.things.keys()]) {
			if (p.startsWith(".ermine/tmp/")) this.things.delete(p)
		}
	}
	/** Checks that the disk is the layout, but for others' entries. */
	is(want: Map<string, Laid>) {
		for (const [p, l] of want) {
			const t = this.things.get(p)
			if (l.kind === "file" || l.kind === "side") {
				assertEquals(t, { kind: "file", hash: l.hash }, p)
			} else if (l.kind === "link") assertEquals(t, { kind: "link", target: l.target }, p)
			else assertEquals(t?.kind, "folder", p)
		}
		for (const [p, t] of this.things) {
			if (t.kind !== "other") assert(want.has(p), `${p} is not in the layout`)
		}
	}
}

/** Lays each graph out in turn on a disk in memory, checking each plan, and gives the last layout. */
function steps(
	graphs: Graph[],
	d = new Disk(),
	old = new Map<Id, Layout>(),
	before = graphs[0],
) {
	let laying: ReturnType<typeof lay> | undefined
	graphs.forEach((g, i) => {
		laying = lay(g, old, d.probe, i + 1, names.PASS, { before, ino: d.ino })
		d.carry(laying.plan)
		d.is(disk(g, laying.layout))
		for (const rec of laying.layout.values()) delete rec.was
		old = laying.layout
		before = g
	})
	return { ...laying!, disk: d }
}

/** The graph of the paper's example after each of its six changes. */
function example(): Graph[] {
	const a = node({ theme: "dark" }), c = node("12:00"), d1 = node("hello"), d2 = node(PNG)
	return [
		graph({ r: node(null, { apps: ["a"] }), a }),
		graph({ r: node(null, { apps: ["a"] }), a: node({ theme: "dark" }, { clock: ["c"] }), c }),
		graph({
			r: node(null, { apps: ["a"], docs: ["d1"] }),
			a: node({ theme: "dark" }, { clock: ["c"] }),
			c,
			d1,
		}),
		graph({
			r: node(null, { apps: ["a"], docs: ["d1", "d2"] }),
			a: node({ theme: "dark" }, { clock: ["c"] }),
			c,
			d1,
			d2,
		}),
		graph({
			r: node(null, { apps: ["a"], docs: ["d1", "d2"], pinned: ["d1"] }),
			a: node({ theme: "dark" }, { clock: ["c"] }),
			c,
			d1,
			d2,
		}),
		graph({
			r: node(null, { apps: ["a"], docs: ["d1", "d2"], pinned: ["d1"], Notes: ["x9"] }),
			a: node({ theme: "dark" }, { clock: ["c"] }),
			c,
			d1,
			d2,
		}),
	]
}

const shape = (want: Map<string, Laid>) =>
	Object.fromEntries(
		[...want].sort(([a], [b]) => byCodePoint(a, b)).map(([p, l]) => [
			p,
			l.kind === "link" ? `-> ${l.target}` : l.kind === "file" ? `${l.kind} ${l.id}` : l.kind,
		]),
	)

Deno.test("the paper's example lays out as the paper shows it", () => {
	const gs = example()
	const { layout } = steps(gs)
	assertEquals(shape(disk(gs[5], layout)), {
		"Notes": "-> .ermine/id/x9",
		"apps": "folder",
		"apps.text": "file a",
		"apps/clock.txt": "file c",
		"docs": "union",
		"docs/1.txt": "file d1",
		"docs/2.png": "file d2",
		"pinned.txt": "-> docs/1.txt",
	})
	const records = Object.fromEntries(
		[...layout].map(([id, r]) => [id, manifest.shown.decode(manifest.shown.encode(r))]),
	)
	assertEquals(records, {
		a: {
			entries: new Map([["clock", "clock"]]),
			file: "apps.text",
			folder: true,
			home: ["r", "apps", 0],
			laid: h({ theme: "dark" }),
		},
		c: { file: "clock.txt", home: ["a", "clock", 0], laid: h("12:00") },
		d1: { file: "1.txt", home: ["r", "docs", 0], laid: h("hello") },
		d2: { file: "2.png", home: ["r", "docs", 1], laid: h(PNG) },
		r: {
			entries: new Map<string, string | string[]>([
				["Notes", "Notes"],
				["apps", "apps"],
				["docs", ["docs", "1", "2"]],
				["pinned", "pinned"],
			]),
			folder: true,
		},
	})
})

Deno.test("at time 4 d1 moves from docs.txt into the new union's folder", () => {
	const gs = example()
	const at3 = steps(gs.slice(0, 3))
	assertEquals(shape(disk(gs[2], at3.layout))["docs.txt"], "file d1")
	const at4 = lay(gs[3], at3.layout, at3.disk.probe, 4, names.PASS, { before: gs[2] })
	assertEquals(
		at4.plan.map((s) => [s.what, s.from ?? null, s.to ?? null]),
		[["folder", null, "docs"], ["rename", "docs.txt", "docs/1.txt"], [
			"file",
			null,
			"docs/2.png",
		]],
	)
})

Deno.test("an unplaced mount's link goes, and a union of one is a file again", () => {
	const gs = example()
	const { disk: d, layout } = steps(gs)
	const r = gs[5].nodes.get("r")!
	const unpinned = graph({
		...Object.fromEntries(gs[5].nodes),
		r: { ...r, directory: new Map([...r.directory].filter(([n]) => n !== "pinned")) },
	})
	const one = graph({
		...Object.fromEntries(unpinned.nodes),
		r: {
			...r,
			directory: new Map([...unpinned.nodes.get("r")!.directory].map(([n, ids]) => [
				n,
				n === "docs" ? ["d1"] : ids,
			])),
		},
	})
	const out = steps([unpinned, one], d, layout, gs[5])
	const want = disk(one, out.layout)
	assertEquals(shape(want)["docs.txt"], "file d1")
	assertEquals(Object.keys(shape(want)).filter((p) => p.startsWith("docs")), ["docs.txt"])
	assertEquals(out.layout.get("d2")?.away, true)
	assertEquals(out.layout.get("r")!.entries!.get("docs"), "docs")
	assert(!("pinned.txt" in shape(want)))
})

Deno.test("a node with a value keeps its file when it comes to hold others; null shows no file", () => {
	const out = steps([
		graph({ r: node(null, { x: ["x"] }), x: node("hi") }),
		graph({ r: node(null, { x: ["x"] }), x: node("hi", { y: ["y"] }), y: node(null) }),
		graph({ r: node(null, { x: ["x"] }), x: node(null, { y: ["y"] }), y: node(null) }),
	])
	const g = graph({ r: node(null, { x: ["x"] }), x: node(null, { y: ["y"] }), y: node(null) })
	assertEquals(shape(disk(g, out.layout)), { "x": "folder", "x/y.text": "file y" })
})

Deno.test("a stem clear of another's entry, of .ermine, of names passed over, and cut", () => {
	const d = new Disk()
	d.things.set("Doc.txt", { kind: "other" })
	d.things.set("a.txt", { kind: "other" })
	const long = "é".repeat(200)
	const g = graph({
		r: node(null, {
			"doc": ["d"],
			"a": ["a"],
			".ermine": ["e"],
			".DS_Store": ["s"],
			"foo.swp": ["w"],
			[long]: ["l"],
			"x/y": ["xy"],
		}),
		d: node({ k: 1 }),
		a: node("text"),
		e: node("e"),
		s: node("s"),
		w: node("w"),
		l: node("l"),
		xy: node("xy"),
	})
	const out = steps([g], d)
	const e = out.layout.get("r")!.entries!
	assertEquals(e.get("doc"), "doc.FINAL")
	assertEquals(e.get("a"), "a.FINAL")
	assertEquals(e.get(".ermine"), ".ermine.FINAL")
	assertEquals(e.get(".DS_Store"), "_.DS_Store_")
	assertEquals(e.get("foo.swp"), "_foo.swp_")
	assertEquals(e.get("x/y"), "x:y")
	const stem = e.get(long) as string
	assert(new TextEncoder().encode(stem + ".txt" + ".FINAL".repeat(5)).length <= 255)
	assert(long.startsWith(stem))
	assertEquals(out.layout.get("w")!.file, "_foo.swp_.txt")
})

Deno.test("a home stays put when a node is mounted higher, and moves when its slot lets it go", () => {
	const deep = graph({ r: node(null, { a: ["a"] }), a: node(null, { b: ["b"] }), b: node("b") })
	const mounted = graph({
		r: node(null, { a: ["a"], z: ["b"] }),
		a: node(null, { b: ["b"] }),
		b: node("b"),
	})
	const out = steps([deep, mounted])
	assertEquals(shape(disk(mounted, out.layout))["z.txt"], "-> a/b.txt")
	const let_go = graph({ r: node(null, { a: ["a"], z: ["b"] }), a: node(null), b: node("b") })
	const moved = steps([deep, mounted, let_go])
	assertEquals(moved.layout.get("b")!.home, ["r", "z", 0])
	assertEquals(shape(disk(let_go, moved.layout))["z.txt"], "file b")
})

Deno.test("a new home is the first slot breadth first, slots in code point order", () => {
	const g = graph({
		r: node(null, { b: ["x"], a: ["deep"] }),
		deep: node(null, { x: ["x"] }),
		x: node("x"),
	})
	const out = steps([g])
	assertEquals(out.layout.get("x")!.home, ["r", "b", 0])
	assertEquals(shape(disk(g, out.layout))["a/x.txt"], "-> ../b.txt")
})

Deno.test("a union's members are numbered again, keeping a person's words", () => {
	const three = graph({
		r: node(null, { u: ["p", "q", "s"] }),
		p: node("p"),
		q: node(PNG),
		s: node("s"),
	})
	const out = steps([three])
	// a person named q's file 2 cat.png; the files program set the layout so
	const r = out.layout.get("r")!
	r.entries!.set("u", ["u", "1", "2 cat", "3"])
	out.layout.get("q")!.file = "2 cat.png"
	out.disk.move("u/2.png", "u/2 cat.png")
	const two = graph({ r: node(null, { u: ["q", "s"] }), q: node(PNG), s: node("s") })
	const next = lay(two, out.layout, out.disk.probe, 2, names.PASS, {
		before: three,
		ino: out.disk.ino,
	})
	out.disk.carry(next.plan)
	out.disk.is(disk(two, next.layout))
	assertEquals(next.layout.get("r")!.entries!.get("u"), ["u", "1 cat", "2"])
	assertEquals(next.layout.get("q")!.file, "1 cat.png")
})

Deno.test("a pending mount is a link into .ermine/id, its id percent-encoded", () => {
	const g = graph({ r: node(null, { a: ["a"] }), a: node(null, { p: ["x/y.z"] }) })
	const out = steps([g])
	assertEquals(shape(disk(g, out.layout))["a/p"], "-> ../.ermine/id/x%2Fy%2Ez")
	const arrived = graph({
		r: node(null, { a: ["a"] }),
		a: node(null, { p: ["x/y.z"] }),
		"x/y.z": node("here"),
	})
	const next = steps([g, arrived])
	assertEquals(shape(disk(arrived, next.layout))["a/p.txt"], "file x/y.z")
})

Deno.test("two slots that take each other's names are renamed through tmp", () => {
	const g = graph({ r: node(null, { a: ["x"], b: ["y"] }), x: node("x"), y: node("y") })
	const swapped = graph({ r: node(null, { a: ["y"], b: ["x"] }), x: node("x"), y: node("y") })
	const out = steps([g, swapped])
	assertEquals(shape(disk(swapped, out.layout)), { "a.txt": "file y", "b.txt": "file x" })
})

Deno.test("a file written and moved is renamed then swapped; a new form is a new file", () => {
	const g = graph({ r: node(null, { a: ["x"] }), x: node("one") })
	const out = steps([g])
	const written = graph({ r: node(null, { a: ["x"] }), x: node("two") })
	const w = lay(written, out.layout, out.disk.probe, 2, names.PASS, { before: g })
	assertEquals(w.plan.map((s) => [s.what, s.before, s.after]), [[
		"file",
		{ file: h("one") },
		{ file: h("two") },
	]])
	assertEquals(w.changed.get("x")!.was, h("one"))
	const reform = graph({ r: node(null, { a: ["x"] }), x: node([1, 2]) })
	const f = lay(reform, out.layout, out.disk.probe, 2, names.PASS, { before: g })
	assertEquals(f.plan.map((s) => [s.what, s.from ?? s.to]), [["remove", "a.txt"], [
		"file",
		"a.text",
	]])
	assertEquals(lay(g, out.layout, out.disk.probe, 2, names.PASS, { before: g }).plan, [])
})

Deno.test("dir gives a node's folder; prune drops what does not fit", () => {
	const gs = example()
	const { layout } = steps(gs)
	assertEquals(dir(layout, "r"), "")
	assertEquals(dir(layout, "a"), "apps")
	assertEquals(dir(layout, "d2"), "docs/2")
	const bad = new Map(layout)
	bad.set("c", { ...layout.get("c")!, home: ["r", "nowhere", 0] })
	bad.set("ghost", { file: "g.txt", home: ["r", "apps", 0] })
	const fit = prune(gs[5], bad)
	assert(!fit.has("c") && !fit.has("ghost"))
	assert(fit.has("a") && fit.has("d1"))
	assertEquals(prune(gs[5], layout).size, layout.size)
	assertEquals(relative("a/b", "c"), "../../c")
	assertEquals(relative("a", "a/x"), "x")
	assertEquals(relative("a", ""), "..")
})

Deno.test("an entry left out is laid again under a new name", () => {
	const g = graph({ r: node(null, { a: ["x"] }), x: node("x") })
	const out = steps([g])
	// the store could not lay a.txt: a person's file was there first
	out.disk.things.set("a.txt", { kind: "other" })
	out.layout.get("r")!.left = ["a.txt"]
	const next = lay(g, out.layout, out.disk.probe, 2, names.PASS, { before: g })
	out.disk.carry(next.plan)
	out.disk.is(disk(g, next.layout))
	assertEquals(next.layout.get("x")!.file, "a.FINAL.txt")
	assertEquals(next.layout.get("r")!.left, undefined)
})

// random graphs ---------------------------------------------------------------

/** A small random number generator, seeded. */
function random(seed: number) {
	let s = seed >>> 0 || 1
	const next = () => {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		return (s >>> 0) / 4294967296
	}
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
	}
}

const NAMES = [
	"a",
	"A",
	"b",
	"a.txt",
	"docs",
	"README.md",
	"x.text",
	"data.raw",
	"clock",
	"pic",
	".DS_Store",
	"foo.swp",
	"a/b",
	"",
	"café",
	"café",
	"Notes",
	"1",
	"2 cat",
	"ß",
	"SS",
	"x".repeat(260),
]

function value(r: ReturnType<typeof random>): Json {
	switch (r.int(7)) {
		case 0:
			return r.pick(["", "hi", "12:00", "line\n", "ünï"])
		case 1:
			return r.pick([PNG, new Uint8Array([1, 2, 3]), new Uint8Array(0)])
		case 2:
			return new Float32Array([r.int(5), 1.5])
		case 3:
			return { n: r.int(3) }
		case 4:
			return null
		case 5:
			return [r.int(3), "x"]
		default:
			return r.int(4)
	}
}

Deno.test("for a few dozen seeds, each plan carried out leaves the disk as the layout says", () => {
	for (let seed = 1; seed <= 30; seed++) {
		const r = random(seed)
		const values = new Map<Id, Json>([["r", null]])
		const dirs = new Map<Id, Map<string, Id[]>>([["r", new Map()]])
		const sides = new Map<Id, Json[]>()
		const infos = new Map<Id, [string, Json][]>()
		let made = 0
		const snap = (): Graph => {
			const nodes = new Map<Id, Node>()
			for (const [id, v] of values) {
				const n = node(v)
				n.sides = (sides.get(id) ?? []).map((x) => node(x)).map((x) =>
					[...x.kept, x.head] as const
				)
				n.info = (infos.get(id) ?? []).map(([k, x]) => [k, ...node(x).kept] as const)
				n.directory = new Map(
					[...dirs.get(id)!].filter(([, ids]) => ids.length).map(([k, ids]) => [k, [...ids]]),
				)
				nodes.set(id, n)
			}
			return { root: "r", nodes }
		}
		const d = new Disk()
		let old = new Map<Id, Layout>()
		let before = snap()
		for (let t = 1; t <= 20; t++) {
			for (let k = r.int(3) + 1; k > 0; k--) {
				const ids = [...values.keys()]
				const h = r.pick(ids)
				const slots = dirs.get(h)!
				const op = r.int(12)
				if (op < 4) {
					const id = `n${++made}`
					values.set(id, value(r))
					dirs.set(id, new Map())
					const name = r.pick(NAMES)
					const slot = slots.get(name) ?? []
					slot.splice(r.int(slot.length + 1), 0, id)
					slots.set(name, slot)
				} else if (op < 6) {
					const id = r.next() < 0.2 ? `p${r.int(3)}` : r.pick(ids)
					const name = r.pick(NAMES)
					const slot = slots.get(name) ?? []
					if (!slot.includes(id)) slot.push(id)
					slots.set(name, slot)
				} else if (op < 8) {
					const full = [...slots].filter(([, ids]) => ids.length)
					if (full.length) {
						const [, slot] = r.pick(full)
						slot.splice(r.int(slot.length), 1)
					}
				} else if (op === 10) {
					sides.set(h, Array.from({ length: r.int(3) }, () => value(r)))
				} else if (op === 11) {
					infos.set(h, Array.from({ length: r.int(3) }, (_, i) => [`k${i}`, value(r)]))
				} else if (h !== "r" || r.next() < 0.3) values.set(h, value(r))
				// a person's entry, somewhere the store shows a folder
				if (r.next() < 0.1) {
					const folders = [...d.things].filter(([, t]) => t.kind === "folder").map(([p]) => p)
					const at = r.pick(["", ...folders])
					const p = (at ? at + "/" : "") + r.pick(["Doc", "a.txt", "1.txt", "notes"])
					if (!d.things.has(p)) d.things.set(p, { kind: "other" })
				}
			}
			const g = snap()
			const l = lay(g, old, d.probe, t, names.PASS, { before, ino: d.ino })
			d.carry(l.plan)
			d.is(disk(g, l.layout))
			// the batch is done: was goes
			for (const rec of l.layout.values()) delete rec.was
			// laying the same graph again changes nothing
			const again = lay(g, l.layout, d.probe, t, names.PASS, { before: g, ino: d.ino })
			assertEquals(again.plan, [], `seed ${seed}, time ${t}`)
			assertEquals(again.changed, new Map(), `seed ${seed}, time ${t}`)
			old = l.layout
			before = g
		}
	}
})

Deno.test("sides are files beside a node's, one more .FINAL each, clear of others' names", () => {
	const c = { ...node("12:00"), sides: [[h("13:00"), "txt"], [h({ a: 1 }), "cbor"]] as const }
	const d = node("x")
	const g = graph({ r: node(null, { clock: ["c"], "clock.FINAL.txt": ["d"] }), c, d })
	const { layout, disk: on } = steps([g])
	assertEquals(layout.get("c")!.file, "clock.txt")
	assertEquals(layout.get("d")!.file, "clock.FINAL.txt")
	assertEquals(layout.get("c")!.sides, ["clock.FINAL.FINAL.txt", "clock.FINAL.FINAL.FINAL.text"])
	assertEquals(on.things.get("clock.FINAL.FINAL.txt"), { kind: "file", hash: h("13:00") })
	// a side that goes is removed; one that changes is written again
	const c2 = { ...node("12:00"), sides: [[h("14:00"), "txt"]] as const }
	const g2 = graph({ r: node(null, { clock: ["c"], "clock.FINAL.txt": ["d"] }), c: c2, d })
	const l2 = lay(g2, layout, on.probe, 2, names.PASS, { before: g, ino: on.ino })
	on.carry(l2.plan)
	on.is(disk(g2, l2.layout))
	assertEquals(l2.layout.get("c")!.sides, ["clock.FINAL.FINAL.txt"])
})

Deno.test("a node's info changed alone is one info step on its file and its folder", () => {
	const a = node("v", { x: ["b"] })
	const b = node(1)
	const g = graph({ r: node(null, { a: ["a"] }), a, b })
	const { layout, disk: on } = steps([g])
	const a2 = { ...a, info: [["color", h("red"), "txt"]] as const }
	const g2 = graph({ r: node(null, { a: ["a"] }), a: a2, b })
	const l = lay(g2, layout, on.probe, 2, names.PASS, { before: g, ino: on.ino })
	assertEquals(l.plan.map((s) => [s.what, s.to]), [["info", "a"], ["info", "a.txt"]])
	assertEquals(l.plan[0].info, a2.info)
})
