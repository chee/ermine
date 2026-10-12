// Writes the layout scenarios to newcore/files/conformance/layout/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/layout/fixtures.ts
// A scenario: {title, steps: [{request, expect}]}, each request alone (harness.ts has the
// protocol). Expected answers are the reference's (layout.ts, through harness.ts's answer), and a
// handful are checked here by hand against FILES.tex (The layout, Writing): those are the
// assertions below, each naming what it checks.
//
// A sequence lays graphs out in turn on a disk in memory, as a store would: each step's probe and
// ino are the disk's, its plan is carried out on the disk, checking what each step expects before
// and after, the disk is then checked to be the layout (and a disk request is written for it),
// and the layout, less was, is the next step's old. Between steps a person or the files program
// may change the disk or the layout.
import { assert, assertEquals } from "@std/assert"
import * as manifest from "../../files/ts/manifest.ts"
import * as names from "../../files/ts/names.ts"
import type { Step as Plan, Value } from "../../files/ts/types.ts"
import { answer, NULL } from "./harness.ts"

const out = new URL("../../files/conformance/layout/", import.meta.url)
assertEquals(manifest.NULL, NULL, "the harness's NULL is null's hash")

type J = Record<string, unknown>
type Step = { request: J & { op: string }; expect: unknown }
const ask = (request: J & { op: string }): Step => ({
	request,
	expect: JSON.parse(JSON.stringify(answer(structuredClone(request)))),
})

// ---- values, nodes and graphs, in the protocol's JSON
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const h = (v: Value) => manifest.hash(v)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6])
const RAW = new Uint8Array([1, 2, 3])
const PDF = new TextEncoder().encode("%PDF-1.7 hello")

/** A value's kept, and its head when it is bytes. */
function kept(value: Value): { kept: [string, string]; head?: string } {
	const form = manifest.form(value)
	const k: { kept: [string, string]; head?: string } = { kept: [h(value), form] }
	if (form === "bin") k.head = hex((value as Uint8Array).slice(0, names.HEAD))
	return k
}

type More = { sides?: Value[]; info?: [string, Value][] }
/** A node holding a value, with slots, its later versions' sides, and info. */
function node(value: Value, directory: Record<string, string[]> = {}, more: More = {}): J {
	return {
		...kept(value),
		sides: (more.sides ?? []).map((v) => {
			const k = kept(v)
			return k.head === undefined ? k.kept : [...k.kept, k.head]
		}),
		info: (more.info ?? []).map(([n, v]) => [n, h(v), manifest.form(v)]),
		directory,
	}
}
const graph = (nodes: Record<string, J>, root = "r"): J => ({ root, nodes })

// ---- a disk in memory
type Thing =
	| { kind: "file"; hash: string }
	| { kind: "link"; target: string }
	| { kind: "folder"; ino: number }
	| { kind: "other" }

const FIXED = new Set(["", ".ermine", ".ermine/tmp", ".ermine/id"])
const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")))
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1)

class Disk {
	things = new Map<string, Thing>()
	next = 100
	/** Every folder's names, .ermine in the store's folder included. */
	probe(): Record<string, string[]> {
		const out: Record<string, string[]> = { "": [".ermine"], ".ermine": [] }
		for (const [p, t] of this.things) if (t.kind === "folder") out[p] ??= []
		for (const p of [...this.things.keys()].sort()) out[parent(p)]?.push(base(p))
		return out
	}
	ino(): Record<string, number> {
		const out: Record<string, number> = {}
		for (const [p, t] of this.things) if (t.kind === "folder") out[p] = t.ino
		return out
	}
	fits(path: string, f: unknown): boolean {
		const t = this.things.get(path)
		if (f === null) return !t
		const x = f as { file?: string; link?: string; folder?: number | null }
		if ("file" in x) return t?.kind === "file" && t.hash === x.file
		if ("link" in x) return t?.kind === "link" && t.target === x.link
		return t?.kind === "folder" && (x.folder === null || t.ino === x.folder)
	}
	room(path: string, self?: string) {
		const up = parent(path)
		assert(FIXED.has(up) || this.things.get(up)?.kind === "folder", `no folder for ${path}`)
		const k = names.key(base(path))
		for (const p of this.things.keys()) {
			// the volume compares names as names.key does
			assert(
				!(p !== self && parent(p) === up && names.key(base(p)) === k),
				`${path} is taken by ${p}`,
			)
		}
	}
	move(from: string, to: string) {
		assert(this.things.has(from), `nothing at ${from}`)
		this.room(to, from)
		for (const [p, t] of [...this.things]) {
			if (p === from || p.startsWith(from + "/")) {
				this.things.delete(p)
				this.things.set(to + p.slice(from.length), t)
			}
		}
	}
	carry(plan: Plan[]) {
		plan.forEach((s, i) => assertEquals(s.number, i + 1))
		for (const s of plan) {
			const at = s.from ?? s.to!
			assert(this.fits(at, s.before), `step ${s.number} finds what it expects at ${at}`)
			if (s.what === "remove") this.move(s.from!, `.ermine/tmp/${s.number}`)
			else if (s.what === "rename") this.move(s.from!, s.to!)
			else if (s.what === "info") assert(this.things.has(s.to!), `info on nothing at ${s.to}`)
			else {
				if (s.before === null) this.room(s.to!)
				const a = s.after as { file?: string; link?: string }
				this.things.set(
					s.to!,
					"file" in a
						? { kind: "file", hash: a.file! }
						: "link" in a
						? { kind: "link", target: a.link! }
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
	is(want: Record<string, { kind: string; hash?: string; target?: string }>) {
		for (const [p, l] of Object.entries(want)) {
			const t = this.things.get(p)
			if (l.kind === "file" || l.kind === "side") {
				assertEquals(t, { kind: "file", hash: l.hash! }, p)
			} else if (l.kind === "link") assertEquals(t, { kind: "link", target: l.target! }, p)
			else assertEquals(t?.kind, "folder", p)
		}
		for (const [p, t] of this.things) {
			if (t.kind !== "other" && !p.startsWith(".ermine/")) assert(p in want, `${p} is not laid`)
		}
	}
	other(path: string) {
		this.things.set(path, { kind: "other" })
	}
}

// ---- a sequence of batches
type Layout = Record<string, J>
type Laying = { layout: Layout; changed: Layout; plan: Plan[] }

class Run {
	disk = new Disk()
	old: Layout = {}
	before?: J
	time = 0
	steps: Step[] = []
	last?: Laying
	/** Lays a graph out from the old layout, carries the plan out, and checks the disk. */
	lay(g: J, o: { pass?: string[]; before?: J | null; ino?: false; carry?: false } = {}): Laying {
		this.time++
		const request: J & { op: string } = {
			op: "lay",
			graph: g,
			old: this.old,
			probe: this.disk.probe(),
			time: this.time,
		}
		if (o.ino !== false) request.ino = this.disk.ino()
		if (o.pass) request.pass = o.pass
		const before = o.before === undefined ? this.before : o.before ?? undefined
		if (before) request.before = before
		const s = ask(request)
		this.steps.push(s)
		const laying = s.expect as Laying
		if (o.carry !== false) {
			this.disk.carry(laying.plan)
			const d = ask({
				op: "disk",
				graph: g,
				layout: laying.layout,
				...(o.pass ? { pass: o.pass } : {}),
			})
			this.steps.push(d)
			this.disk.is(d.expect as never)
		}
		const next: Layout = structuredClone(laying.layout)
		for (const r of Object.values(next)) delete r.was
		this.old = next
		this.before = g
		this.last = laying
		return laying
	}
	ask(request: J & { op: string }) {
		const s = ask(request)
		this.steps.push(s)
		return s.expect
	}
}

const all: { name: string; scenario: unknown }[] = []
const scenario = (name: string, title: string, steps: Step[]) =>
	all.push({ name, scenario: { title, steps } })
/** A sequence: the graphs laid out in turn, with what happens between. */
function sequence(name: string, title: string, f: (run: Run) => void) {
	const run = new Run()
	f(run)
	scenario(name, title, run.steps)
}

const files = (l: Laying) => l.plan.map((s) => [s.what, s.from ?? null, s.to ?? null])
const entries = (run: Run, id = "r") => run.old[id].entries as Record<string, unknown>

// ============================================================ the pure ones

scenario("relative", "relative: the path a link in one folder holds to another path", [
	ask({ op: "relative", from: "", to: "a.txt" }),
	ask({ op: "relative", from: "", to: "" }),
	ask({ op: "relative", from: "a", to: "a" }),
	ask({ op: "relative", from: "a", to: "a/b.txt" }),
	ask({ op: "relative", from: "a", to: "b.txt" }),
	ask({ op: "relative", from: "a/b/c", to: "a/x/y.txt" }),
	ask({ op: "relative", from: "a/b", to: "" }),
	ask({ op: "relative", from: "docs", to: ".ermine/id/x%2Fy" }),
	ask({ op: "relative", from: "", to: ".ermine/root.txt" }),
	ask({ op: "relative", from: "ab", to: "a/b" }),
	ask({ op: "relative", from: "a/b", to: "a/bc/d" }),
])
assertEquals(
	(all[0].scenario as { steps: Step[] }).steps.map((s) => s.expect),
	[
		"a.txt",
		".",
		".",
		"b.txt",
		"../b.txt",
		"../../x/y.txt",
		"../..",
		"../.ermine/id/x%2Fy",
		".ermine/root.txt",
		"../a/b",
		"../bc/d",
	],
	"FILES.tex, Links: relative to the link's folder",
)

{
	const L: Layout = {
		r: { folder: true, entries: { a: "a", u: ["u", "1", "2"], gone: "gone", bad: "bad" } },
		a: { home: ["r", "a", 0], folder: true, entries: { b: "b" } },
		b: { home: ["a", "b", 0], file: "b.txt", folder: true, entries: { f: "f" } },
		m1: { home: ["r", "u", 0], file: "1.txt", folder: true },
		m2: { home: ["r", "u", 1], folder: true },
		m3: { home: ["r", "u", 2], folder: true },
		x: { away: true, home: ["r", "a", 0], file: "a.txt" },
		g: { home: ["r", "gone", 0], folder: true },
		y: { home: ["z", "q", 0], folder: true },
		z: { home: ["y", "q", 0], folder: true, entries: { q: "q" } },
		n: { home: ["r", "nowhere", 0], folder: true },
		f: { home: ["b", "f", 0], file: "f.txt" },
		k: { home: ["r", "bad", 0], folder: true },
		kk: { home: ["k", "c", 0] },
	}
	const at = (id: string) => ask({ op: "dir", layout: L, id })
	const steps = [
		at("r"),
		at("a"),
		at("b"),
		at("m1"),
		at("m2"),
		at("m3"),
		at("x"),
		at("y"),
		at("n"),
		at("f"),
		at("kk"),
		at("missing"),
	]
	assertEquals(steps.map((s) => s.expect), [
		"",
		"a",
		"a/b",
		"u/1",
		"u/2",
		null,
		null,
		null,
		null,
		"a/b/f",
		null,
		null,
	], "dir: a node's folder by its home's stems; none away, past a union's stems, in a cycle")
	scenario(
		"dir",
		"dir: a node's folder path, shown or not; none when away, unknown, cycling, or its holder has no folder or stem",
		steps,
	)
}

scenario("same-info", "sameInfo: the same names and values in the same order", [
	ask({ op: "sameInfo", a: [], b: [] }),
	ask({ op: "sameInfo", a: [["tag", h("x"), "txt"]], b: [["tag", h("x"), "txt"]] }),
	ask({ op: "sameInfo", a: [["tag", h("x"), "txt"]], b: [["tag", h("y"), "txt"]] }),
	ask({ op: "sameInfo", a: [["tag", h("x"), "txt"]], b: [["tag", h("x"), "cbor"]] }),
	ask({ op: "sameInfo", a: [["tag", h("x"), "txt"]], b: [["Tag", h("x"), "txt"]] }),
	ask({
		op: "sameInfo",
		a: [["a", h(1), "cbor"], ["b", h(2), "cbor"]],
		b: [["b", h(2), "cbor"], ["a", h(1), "cbor"]],
	}),
	ask({ op: "sameInfo", a: [["a", h(1), "cbor"]], b: [["a", h(1), "cbor"], ["b", h(2), "cbor"]] }),
	ask({ op: "sameInfo", a: [["a", h(1), "cbor"], ["b", h(2), "cbor"]], b: [["a", h(1), "cbor"]] }),
])

{
	const g = graph({
		r: node(null, { a: ["a"], u: ["m", "n"], p: ["pend"], w: ["w"] }),
		a: node(null, { b: ["b"] }),
		b: node("b"),
		m: node("m"),
		n: node("n"),
		w: node("w"),
		lost: node("lost"),
		far: node("far"),
	})
	const L: Layout = {
		r: { folder: true, entries: { a: "a", u: ["u", "1", "2"], w: "w" } },
		a: { home: ["r", "a", 0], folder: true, entries: { b: "b" } },
		b: { home: ["a", "b", 0], file: "b.txt" },
		m: { home: ["r", "u", 0], file: "1.txt" },
		n: { home: ["r", "u", 5], file: "2.txt" },
		w: { home: ["r", "a", 0], file: "w.txt" },
		far: { away: true, home: ["r", "far", 0], file: "far.txt" },
		lost: { home: ["gone", "x", 0], file: "x.txt" },
		ghost: { home: ["r", "a", 0], file: "a.txt" },
		pend: { home: ["r", "p", 0], file: "p.txt" },
	}
	const rooted: Layout = { r: { home: ["a", "b", 0], folder: true }, a: L.a }
	const awayroot: Layout = { r: { away: true, folder: true } }
	const noroot: Layout = { a: L.a, b: L.b }
	// a holder away: what it held goes with it
	const held: Layout = {
		r: L.r,
		a: { away: true, home: ["r", "a", 0], folder: true, entries: { b: "b" } },
		b: L.b,
	}
	// a holder with no folder, and one whose stem is gone
	const bare: Layout = {
		r: { folder: true, entries: { u: ["u", "1", "2"] } },
		a: { home: ["r", "a", 0], file: "a.txt", entries: { b: "b" } },
		b: L.b,
		m: L.m,
	}
	// a union's stems that are a slot of one, and one slot's stems for a union
	const shape: Layout = {
		r: { folder: true, entries: { a: ["a", "1"], u: "u" } },
		a: { home: ["r", "a", 0], folder: true, entries: { b: "b" } },
		m: { home: ["r", "u", 0], file: "u.txt" },
	}
	const steps = [
		ask({ op: "prune", graph: g, layout: L }),
		ask({ op: "prune", graph: g, layout: rooted }),
		ask({ op: "prune", graph: g, layout: awayroot }),
		ask({ op: "prune", graph: g, layout: noroot }),
		ask({ op: "prune", graph: g, layout: held }),
		ask({ op: "prune", graph: g, layout: bare }),
		ask({ op: "prune", graph: g, layout: shape }),
		ask({ op: "prune", graph: g, layout: {} }),
	]
	const ids = (s: Step) => Object.keys(s.expect as J).sort()
	assertEquals(ids(steps[0]), ["a", "b", "far", "m", "r"], "prune: what fits the graph stays")
	scenario(
		"prune",
		"prune: drops records of unknown ids, homes not holding their node, under dropped or away holders, past a stem's shape; keeps away records of known nodes",
		steps,
	)
}

{
	// a disk request on a layout the store would not make by itself: left entries, a pass list
	const g = graph({
		r: node("root", { a: ["a"], "foo.swp": ["a"], p: ["x.y"], s: ["s"] }),
		a: node("a", { b: ["b"] }),
		b: node("b"),
		s: node("s", {}, { sides: ["s2", { k: 1 }] }),
	})
	const L: Layout = {
		r: {
			file: "root.txt",
			laid: h("root"),
			folder: true,
			entries: { a: "a", "foo.swp": "_foo.swp_", p: "p", s: "s" },
		},
		a: { home: ["r", "a", 0], file: "a.txt", laid: h("a"), folder: true, entries: { b: "b" } },
		b: { home: ["a", "b", 0], file: "b.txt", laid: h("old b") },
		s: {
			home: ["r", "s", 0],
			file: "s.txt",
			laid: h("s"),
			sides: ["s.FINAL.txt", "s.FINAL.FINAL.text"],
		},
	}
	const left = { ...L, a: { ...L.a, left: ["a"] } }
	scenario(
		"disk",
		"disk: every entry a layout puts on disk; left ones and what is in them are not",
		[
			ask({ op: "disk", graph: g, layout: L }),
			ask({ op: "disk", graph: g, layout: L, pass: [] }),
			ask({ op: "disk", graph: g, layout: left }),
			ask({ op: "disk", graph: g, layout: { ...L, s: { ...L.s, left: ["s.FINAL.txt"] } } }),
			ask({ op: "disk", graph: g, layout: { ...L, a: { ...L.a, away: true } } }),
			ask({ op: "disk", graph: g, layout: {} }),
		],
	)
	const d = all.at(-1)!.scenario as { steps: Step[] }
	const paths = (i: number) => Object.keys(d.steps[i].expect as J).sort()
	assertEquals(paths(0), [
		".ermine/root.txt",
		"_foo.swp_",
		"_foo.swp_.txt",
		"a",
		"a.txt",
		"a/b.txt",
		"p",
		"s.FINAL.FINAL.text",
		"s.FINAL.txt",
		"s.txt",
	], "disk: file and folder side by side, a link per other slot, a pending link, sides beside")
	assertEquals(
		(d.steps[0].expect as J)["a/b.txt"],
		{ kind: "file", id: "b", home: ["a", "b", 0], form: "txt", hash: h("old b"), info: [] },
		"disk: a file holds its laid, not the graph's value, until laid again",
	)
	assertEquals(paths(2), [
		".ermine/root.txt",
		"_foo.swp_",
		"_foo.swp_.txt",
		"a.txt",
		"p",
		"s.FINAL.FINAL.text",
		"s.FINAL.txt",
		"s.txt",
	])
}

// ============================================================ batches

sequence(
	"fresh-store",
	"a fresh store's first layout: the root's folder, a map, a string",
	(run) => {
		const l = run.lay(
			graph({
				r: node(null, { apps: ["a"], readme: ["t"] }),
				a: node({ theme: "dark" }),
				t: node("hello"),
			}),
			{ before: null },
		)
		assertEquals(
			files(l),
			[["file", null, "apps.text"], ["file", null, "readme.txt"]],
			"FILES.tex: a map is .text, a string .txt; the null root shows no file",
		)
	},
)

sequence(
	"example",
	"the paper's example, change by change: apps, clock, docs, a union, a link, a pending mount",
	(run) => {
		const a = node({ theme: "dark" }), c = node("12:00"), d1 = node("hello"), d2 = node(PNG)
		const A = node({ theme: "dark" }, { clock: ["c"] })
		run.lay(graph({ r: node(null, { apps: ["a"] }), a }))
		run.lay(graph({ r: node(null, { apps: ["a"] }), a: A, c }))
		run.lay(graph({ r: node(null, { apps: ["a"], docs: ["d1"] }), a: A, c, d1 }))
		const four = run.lay(
			graph({ r: node(null, { apps: ["a"], docs: ["d1", "d2"] }), a: A, c, d1, d2 }),
		)
		assertEquals(files(four), [["folder", null, "docs"], ["rename", "docs.txt", "docs/1.txt"], [
			"file",
			null,
			"docs/2.png",
		]], "FILES.tex example: d1 moves into the new union's folder, d2 is sniffed as png")
		run.lay(
			graph({
				r: node(null, { apps: ["a"], docs: ["d1", "d2"], pinned: ["d1"] }),
				a: A,
				c,
				d1,
				d2,
			}),
		)
		const six = run.lay(graph({
			r: node(null, { apps: ["a"], docs: ["d1", "d2"], pinned: ["d1"], Notes: ["x9"] }),
			a: A,
			c,
			d1,
			d2,
		}))
		assertEquals(files(six), [["link", null, "Notes"]])
		assertEquals(
			six.plan[0].after,
			{ link: ".ermine/id/x9" },
			"FILES.tex: a pending mount links into .ermine/id",
		)
	},
)

sequence(
	"root-value",
	"the root's own value: .ermine/root.<ext>, written again, then a new form",
	(run) => {
		run.lay(graph({ r: node("hi", { a: ["a"] }), a: node(1) }))
		run.lay(graph({ r: node("there", { a: ["a"] }), a: node(1) }))
		run.lay(graph({ r: node([1, 2], { a: ["a"] }), a: node(1) }))
		run.lay(graph({ r: node(PDF, { a: ["a"] }), a: node(1) }))
		run.lay(graph({ r: node(null, { a: ["a"] }), a: node(1) }))
	},
)

sequence(
	"add-remove",
	"children added one by one, one removed (away), then placed again",
	(run) => {
		const x = node("x"), y = node("y"), z = node("z")
		run.lay(graph({ r: node(null, { x: ["x"] }), x }))
		run.lay(graph({ r: node(null, { x: ["x"], y: ["y"] }), x, y }))
		run.lay(graph({ r: node(null, { x: ["x"], y: ["y"], z: ["z"] }), x, y, z }))
		const gone = run.lay(graph({ r: node(null, { x: ["x"], z: ["z"] }), x, y, z }))
		assertEquals(gone.layout.y.away, true, "FILES.tex: a node no shown node holds is not shown")
		assertEquals(files(gone), [["remove", "y.txt", null]])
		run.lay(graph({ r: node(null, { x: ["x"], z: ["z"], again: ["y"] }), x, y, z }))
		// and one whose node the graph drops
		run.lay(graph({ r: node(null, { x: ["x"] }), x }))
	},
)

sequence("rename-slot", "a slot renamed: the same node under a new name moves its file", (run) => {
	const x = node("x")
	run.lay(graph({ r: node(null, { old: ["x"] }), x }))
	run.lay(graph({ r: node(null, { new: ["x"] }), x }))
	run.lay(graph({ r: node(null, { "new.md": ["x"] }), x }))
	run.lay(graph({ r: node(null, { "New.md": ["x"] }), x }))
})

sequence(
	"nested",
	"folders three deep, then the middle one dropped: what it held goes too, deepest first",
	(run) => {
		const c = node("c")
		const g = (b: J) => graph({ r: node(null, { a: ["a"] }), a: node(null, { b: ["b"] }), b, c })
		run.lay(g(node("b", { c: ["c"] })))
		run.lay(g(node("b2", { c: ["c"] })))
		const out = run.lay(graph({ r: node(null, { a: ["a"] }), a: node(null), b: node("b2"), c }))
		assertEquals(
			files(out).map((x) => x[1]),
			["a/b/c.txt", "a/b", "a/b.txt"],
			"FILES.tex Writing: entries that go are removed deepest first",
		)
	},
)

sequence(
	"file-and-folder",
	"a node with a value comes to hold others: its file stays, its folder is beside it, and stays when emptied",
	(run) => {
		run.lay(graph({ r: node(null, { x: ["x"] }), x: node("hi") }))
		const held = run.lay(
			graph({ r: node(null, { x: ["x"] }), x: node("hi", { y: ["y"] }), y: node(1) }),
		)
		assertEquals(files(held), [["folder", null, "x"], ["file", null, "x/y.text"]])
		run.lay(graph({ r: node(null, { x: ["x"] }), x: node("hi"), y: node(1) }))
		assertEquals(run.old.x.folder, true, "FILES.tex: a folder stays while the node is shown")
		run.lay(graph({ r: node(null, { x: ["x"] }), x: node(null), y: node(1) }))
		run.lay(graph({ r: node(null, { x: ["x"] }), x: node("back"), y: node(1) }))
	},
)

sequence(
	"null-folder",
	"a null node holding others shows only its folder, until it has a value",
	(run) => {
		run.lay(graph({ r: node(null, { n: ["n"] }), n: node(null, { k: ["k"] }), k: node("k") }))
		run.lay(graph({ r: node(null, { n: ["n"] }), n: node({ v: 1 }, { k: ["k"] }), k: node("k") }))
		run.lay(graph({ r: node(null, { n: ["n"] }), n: node(null, { k: ["k"] }), k: node("k") }))
		// a null node holding nothing, never a folder: a file of null
		run.lay(
			graph({
				r: node(null, { n: ["n"], e: ["e"] }),
				n: node(null, { k: ["k"] }),
				k: node("k"),
				e: node(null),
			}),
		)
	},
)

sequence(
	"union-grows",
	"a slot becomes a union, grows, has its members reordered, and shrinks back to one",
	(run) => {
		const p = node("p"), q = node(PNG), s = node({ s: 1 })
		run.lay(graph({ r: node(null, { u: ["p"] }), p, q, s }))
		run.lay(graph({ r: node(null, { u: ["p", "q"] }), p, q, s }))
		run.lay(graph({ r: node(null, { u: ["p", "q", "s"] }), p, q, s }))
		run.lay(graph({ r: node(null, { u: ["s", "p", "q"] }), p, q, s }))
		run.lay(graph({ r: node(null, { u: ["s", "q"] }), p, q, s }))
		const one = run.lay(graph({ r: node(null, { u: ["q"] }), p, q, s }))
		assertEquals(entries(run).u, "u", "a union of one is a single slot again")
		assertEquals(one.layout.q.file, "u.png")
	},
)

sequence(
	"union-extension",
	"a union named README.md: a string is 1.md, a map 2.text, and more",
	(run) => {
		const g = graph({
			r: node(null, { "README.md": ["s", "m", "f"] }),
			s: node("read me"),
			m: node({ a: 1 }),
			f: node(new Float32Array([1, 2])),
		})
		const l = run.lay(g)
		assertEquals(Object.keys(run.ask({ op: "disk", graph: g, layout: l.layout }) as J).sort(), [
			"README",
			"README/1.md",
			"README/2.text",
			"README/3.float32",
		], "FILES.tex Values: a member takes its slot's extension if its value may have it")
	},
)

sequence(
	"union-words",
	"a person's words after a member's number are kept as the members are numbered again",
	(run) => {
		const p = node("p"), q = node(PNG), s = node("s")
		run.lay(graph({ r: node(null, { u: ["p", "q", "s"] }), p, q, s }))
		// a person renamed u/2.png to u/2 cat.png; the files program set the layout so
		entries(run).u = ["u", "1", "2 cat", "3"]
		run.old.q.file = "2 cat.png"
		run.disk.move("u/2.png", "u/2 cat.png")
		const two = run.lay(graph({ r: node(null, { u: ["q", "s"] }), p, q, s }))
		assertEquals(
			two.layout.r.entries,
			{ u: ["u", "1 cat", "2"] },
			"FILES.tex: numbered again, keeping a person's words",
		)
		run.lay(graph({ r: node(null, { u: ["s", "q", "p"] }), p, q, s }))
	},
)

sequence(
	"union-name",
	"a union's folder named from a slot with an extension, and a passed-over one",
	(run) => {
		const a = node("a"), b = node("b")
		run.lay(
			graph({
				r: node(null, { "x.txt": ["a", "b"], "foo.swp": ["a", "b"], ".ermine": ["b", "a"] }),
				a,
				b,
			}),
		)
	},
)

sequence(
	"pending",
	"pending ids: a link into .ermine/id, percent-encoded; it arrives and takes a new stem; pending in a union",
	(run) => {
		run.lay(graph({ r: node(null, { a: ["a"] }), a: node(null, { p: ["x/y.z"], q: ["%"] }) }))
		assertEquals(files(run.last!)[1], ["link", null, "a/p"])
		assertEquals(run.last!.plan.map((s) => s.after).slice(1), [{
			link: "../.ermine/id/x%2Fy%2Ez",
		}, { link: "../.ermine/id/%25" }], "FILES.tex Links: percent-encoded, . as %2E")
		run.lay(graph({
			r: node(null, { a: ["a"] }),
			a: node(null, { p: ["x/y.z"], q: ["%"] }),
			"x/y.z": node("here"),
		}))
		run.lay(graph({
			r: node(null, { a: ["a"], u: ["k", "later"] }),
			a: node(null, { p: ["x/y.z"], q: ["%"] }),
			"x/y.z": node("here"),
			k: node("k"),
		}))
		run.lay(graph({
			r: node(null, { a: ["a"], u: ["k", "later"] }),
			a: node(null, { p: ["x/y.z"], q: ["%"] }),
			"x/y.z": node("here"),
			k: node("k"),
			later: node([1]),
		}))
	},
)

sequence(
	"sides",
	"sides: each later version beside the file with one more .FINAL; added, changed, dropped",
	(run) => {
		run.lay(
			graph({ r: node(null, { clock: ["c"] }), c: node("12:00", {}, { sides: ["12:01"] }) }),
		)
		assertEquals(
			run.old.c.sides,
			["clock.FINAL.txt"],
			"FILES.tex Sides: clock.txt, then clock.FINAL.txt",
		)
		run.lay(
			graph({
				r: node(null, { clock: ["c"] }),
				c: node("12:00", {}, { sides: ["12:01", PNG] }),
			}),
		)
		run.lay(
			graph({
				r: node(null, { clock: ["c"] }),
				c: node("12:00", {}, { sides: ["12:02", PNG] }),
			}),
		)
		run.lay(
			graph({ r: node(null, { clock: ["c"] }), c: node("12:00", {}, { sides: [{ t: 1 }] }) }),
		)
		run.lay(graph({ r: node(null, { clock: ["c"] }), c: node("12:05") }))
	},
)

sequence(
	"sides-clash",
	"a side's name clear of a sibling's, in a union, and the root's beside .ermine/root",
	(run) => {
		run.lay(graph({
			r: node("root", { a: ["a"], "a.FINAL": ["b"], u: ["m", "n"] }, { sides: ["root2"] }),
			a: node("a", {}, { sides: ["a2"] }),
			b: node("b"),
			m: node("m", {}, { sides: ["m2"] }),
			n: node("n"),
		}))
		// a new slot whose name a side has: the new stem is clear of it
		run.lay(graph({
			r: node("root", { a: ["a"], "a.FINAL": ["b"], u: ["m", "n"], "A.FINAL.FINAL": ["z"] }, {
				sides: ["root2"],
			}),
			a: node("a", {}, { sides: ["a2"] }),
			b: node("b"),
			m: node("m", {}, { sides: ["m2"] }),
			n: node("n"),
			z: node("z"),
		}))
	},
)

sequence(
	"form-change",
	"a new form: the file is removed and made again under a new extension",
	(run) => {
		const g = (v: Value) =>
			graph({ r: node(null, { data: ["d"], "notes.md": ["n"] }), d: node(v), n: node("# hi") })
		run.lay(g("text"))
		const reform = run.lay(g({ now: "a map" }))
		assertEquals(
			files(reform),
			[["remove", "data.txt", null], ["file", null, "data.text"]],
			"FILES.tex: a new form changes only the extension, as a remove and a new file",
		)
		run.lay(g(PNG))
		run.lay(g(RAW))
		run.lay(g(new Float32Array([1.5])))
		run.lay(g(new BigInt64Array([1n])))
		run.lay(
			graph({
				r: node(null, { data: ["d"], "notes.md": ["n"] }),
				d: node(1),
				n: node({ md: false }),
			}),
		)
	},
)

sequence(
	"probe-clash",
	"others' entries: a new stem clear of them, case-insensitively; a kept stem that comes to clash moves",
	(run) => {
		run.disk.other("Doc.txt")
		run.disk.other("photos")
		run.lay(
			graph({
				r: node(null, { doc: ["d"], photos: ["p"], ok: ["o"] }),
				d: node("d"),
				p: node(null, { x: ["x"] }),
				x: node(1),
				o: node("o"),
			}),
		)
		assertEquals(
			entries(run),
			{ doc: "doc.FINAL", ok: "ok", photos: "photos.FINAL" },
			"FILES.tex Names: a stem the same as another entry's takes .FINAL",
		)
		// a person makes OK.TXT where ok.txt would be... it is ours; a person makes ok (a folder)
		run.disk.other("ok")
		run.lay(
			graph({
				r: node(null, { doc: ["d"], photos: ["p"], ok: ["o"] }),
				d: node("d"),
				p: node(null, { x: ["x"] }),
				x: node(1),
				o: node("o", { k: ["k"] }),
				k: node("k"),
			}),
		)
		// others' entries inside a union's folder
		run.lay(
			graph({
				r: node(null, { u: ["d", "o"] }),
				d: node("d"),
				o: node("o"),
				p: node(null),
				x: node(1),
				k: node("k"),
			}),
		)
		run.disk.other("u/4.txt")
		run.disk.other("u/3.txt")
		run.lay(
			graph({
				r: node(null, { u: ["o", "d", "k"] }),
				d: node("d"),
				o: node("o"),
				p: node(null),
				x: node(1),
				k: node("k"),
			}),
		)
	},
)

sequence(
	"ermine-name",
	".ermine and names passed over: never the store's own, and a custom pass list",
	(run) => {
		run.disk.other(".ermine.txt")
		run.lay(
			graph({
				r: node(null, {
					".ermine": ["e"],
					".DS_Store": ["s"],
					"foo.swp": ["w"],
					"x~": ["t"],
					"keep.me": ["k"],
				}),
				e: node("e"),
				s: node("s"),
				w: node("w"),
				t: node(null, { in: ["e"] }),
				k: node("k"),
			}),
			{ pass: [...names.PASS, "keep.*"] },
		)
		assertEquals(
			entries(run)[".ermine"],
			".ermine.FINAL",
			"FILES.tex Names: .ermine in the store's folder takes .FINAL",
		)
		assertEquals(
			entries(run)["foo.swp"],
			"_foo.swp_",
			"FILES.tex Names: a passed-over name takes _ at both ends",
		)
	},
)

sequence(
	"case",
	"names equal by case folding and NFD clash; the first in code point order keeps the name",
	(run) => {
		run.lay(graph({
			r: node(null, {
				A: ["a"],
				a: ["b"],
				"café": ["c"],
				"café": ["d"],
				"STRASSE": ["e"],
				"straße": ["f"],
				"ı": ["g"],
				"I": ["h"],
			}),
			a: node("a"),
			b: node("b"),
			c: node("c"),
			d: node("d"),
			e: node("e"),
			f: node("f"),
			g: node("g"),
			h: node("h"),
		}))
		const e = entries(run)
		assertEquals(
			[e.A, e.a],
			["A", "a.FINAL"],
			"FILES.tex Names: equal after case folding, the later takes .FINAL",
		)
		// a file and a folder of different nodes may not share a stem either
		run.lay(graph({
			r: node(null, { Doc: ["x"], doc: ["y"] }),
			x: node("x"),
			y: node(null, { k: ["c"] }),
			c: node("c"),
		}))
	},
)

sequence(
	"written-names",
	"names written as stems: / as :, : full-width, NUL, the empty name, . and ..",
	(run) => {
		run.lay(graph({
			r: node(null, {
				"a/b": ["a"],
				"c:d": ["c"],
				"n\0l": ["n"],
				"": ["u"],
				".": ["d1"],
				"..": ["d2"],
				"untitled": ["t"],
			}),
			a: node("a"),
			c: node("c"),
			n: node("n"),
			u: node("u"),
			d1: node(null, { k: ["k"] }),
			d2: node(null, { k: ["k"] }),
			k: node("k"),
			t: node("t"),
		}))
	},
)

sequence(
	"long-names",
	"a long name cut between scalar values to leave room for its extension and five .FINALs",
	(run) => {
		const long = "x".repeat(300)
		const wide = "é".repeat(200)
		const emoji = "🦊".repeat(70)
		run.lay(graph({
			r: node(null, {
				[long]: ["a"],
				[long + "y"]: ["b"],
				[wide]: ["c"],
				[emoji]: ["d"],
				u: ["e", "f"],
				[wide + ".md"]: ["g"],
			}),
			a: node("a"),
			b: node("b"),
			c: node(null, { k: ["k"] }),
			d: node(new Float64Array([1])),
			e: node("e"),
			f: node("f"),
			g: node("g"),
			k: node("k"),
		}))
		const e = entries(run)
		assertEquals(
			e[long + "y"],
			(e[long] as string) + ".FINAL",
			"two long names cut the same: the second takes .FINAL",
		)
		for (const p of run.disk.things.keys()) {
			assert(new TextEncoder().encode(base(p)).length <= 255, `${base(p)} fits in 255 bytes`)
		}
	},
)

sequence(
	"links",
	"a node held twice: a link to its file and to its folder; a home stays put when mounted higher",
	(run) => {
		const b = node("b", { k: ["k"] }), k = node("k")
		run.lay(graph({ r: node(null, { a: ["a"] }), a: node(null, { b: ["b"] }), b, k }))
		const up = run.lay(
			graph({
				r: node(null, { a: ["a"], z: ["b"], "z.md": ["b"] }),
				a: node(null, { b: ["b"] }),
				b,
				k,
			}),
		)
		assertEquals(
			up.layout.b.home,
			["a", "b", 0],
			"FILES.tex: a home stays put when a shorter path appears",
		)
		assertEquals(files(up), [["link", null, "z"], ["link", null, "z.FINAL"], [
			"link",
			null,
			"z.FINAL.md",
		], ["link", null, "z.txt"]])
		// the home's slot lets it go: it moves to the first slot holding it, the links are made again
		run.lay(graph({ r: node(null, { a: ["a"], z: ["b"], "z.md": ["b"] }), a: node(null), b, k }))
		assertEquals(run.old.b.home, ["r", "z", 0])
		// a link in a union, and in a folder deeper
		run.lay(
			graph({
				r: node(null, { a: ["a"], z: ["b"], u: ["k", "b"] }),
				a: node(null, { deep: ["d"] }),
				d: node(null, { kk: ["k"] }),
				b,
				k,
			}),
		)
	},
)

sequence(
	"breadth-first",
	"a new home is the first slot breadth first, a holder's slots in code point order",
	(run) => {
		run.lay(graph({
			r: node(null, { b: ["x"], a: ["deep"], B: ["y"], é: ["z"], e: ["z"] }),
			deep: node(null, { x: ["x"], y: ["y"], a: ["w"] }),
			x: node("x"),
			y: node("y"),
			z: node("z"),
			w: node("w"),
		}))
		assertEquals([run.old.x.home, run.old.y.home, run.old.z.home], [
			["r", "b", 0],
			["r", "B", 0],
			["r", "e", 0],
		])
	},
)

sequence(
	"cycles",
	"a node mounted inside itself, and the root mounted in a slot: links back up",
	(run) => {
		run.lay(graph({ r: node("root", { a: ["a"] }), a: node("a", { self: ["a"], top: ["r"] }) }))
		run.lay(
			graph({
				r: node("root", { a: ["a"], me: ["r"] }),
				a: node("a", { self: ["a"], top: ["r"] }),
			}),
		)
		run.lay(graph({ r: node(null, { a: ["a"], me: ["r"] }), a: node("a", { self: ["a"] }) }))
	},
)

sequence(
	"away",
	"a holder dropped: its subtree goes away; placed again elsewhere it is laid out anew",
	(run) => {
		const a = node(null, { b: ["b"], c: ["c"] }),
			b = node("b"),
			c = node(null, { d: ["d"] }),
			d = node("d")
		run.lay(graph({ r: node(null, { a: ["a"] }), a, b, c, d }))
		run.lay(graph({ r: node(null, {}), a, b, c, d }))
		assertEquals(["a", "b", "c", "d"].map((id) => run.old[id].away), [true, true, true, true])
		run.lay(graph({ r: node(null, { other: ["c"] }), a, b, c, d }))
		run.lay(graph({ r: node(null, { other: ["c"], a: ["a"] }), a, b, c, d }))
	},
)

sequence("moves", "nodes move between folders, with their folders, in one batch", (run) => {
	const x = node("x", { in: ["i"] }), i = node("i"), y = node("y")
	run.lay(
		graph({
			r: node(null, { a: ["a"], b: ["b"] }),
			a: node(null, { x: ["x"], y: ["y"] }),
			b: node(null, { k: ["k"] }),
			k: node("k"),
			x,
			i,
			y,
		}),
	)
	run.lay(
		graph({
			r: node(null, { a: ["a"], b: ["b"] }),
			a: node(null, { y: ["y"] }),
			b: node(null, { k: ["k"], x: ["x"] }),
			k: node("k"),
			x,
			i,
			y,
		}),
	)
	// a folder that goes, with an entry moving out of it first
	const out = run.lay(
		graph({
			r: node(null, { b: ["b"], y: ["y"] }),
			a: node(null, { y: ["y"] }),
			b: node(null, { k: ["k"], x: ["x"] }),
			k: node("k"),
			x,
			i,
			y,
		}),
	)
	assertEquals(
		out.plan[0].what,
		"rename",
		"FILES.tex Writing: what moves out of a folder that goes waits in .ermine/tmp first",
	)
	run.lay(
		graph({
			r: node(null, { b: ["b"], x: ["x"] }),
			b: node(null, { k: ["k"], y: ["y"] }),
			k: node("k"),
			x,
			i,
			y,
		}),
	)
})

sequence(
	"swaps",
	"two names swapped, three rotated, and a swap across folders, through .ermine/tmp",
	(run) => {
		const x = node("x"), y = node("y"), z = node("z")
		run.lay(graph({ r: node(null, { a: ["x"], b: ["y"], c: ["z"] }), x, y, z }))
		const swap = run.lay(graph({ r: node(null, { a: ["y"], b: ["x"], c: ["z"] }), x, y, z }))
		assert(
			swap.plan.some((s) => s.to?.startsWith(".ermine/tmp/2.")),
			"a swap goes through .ermine/tmp",
		)
		run.lay(graph({ r: node(null, { a: ["z"], b: ["y"], c: ["x"] }), x, y, z }))
		run.lay(graph({ r: node(null, { a: ["y"], b: ["z"], c: ["x"] }), x, y, z }))
		const f = node(null, { a: ["z"] }), g = node(null, { a: ["x"] })
		run.lay(graph({ r: node(null, { f: ["f"], g: ["g"] }), f, g, x, y, z }))
		run.lay(
			graph({
				r: node(null, { f: ["f"], g: ["g"] }),
				f: node(null, { a: ["x"] }),
				g: node(null, { a: ["z"] }),
				x,
				y,
				z,
			}),
		)
		// and a folder with a file swapped
		run.lay(
			graph({
				r: node(null, { f: ["g"], g: ["f"] }),
				f: node(null, { a: ["x"] }),
				g: node(null, { a: ["z"] }),
				x,
				y,
				z,
			}),
		)
	},
)

sequence("left", "entries in left: not on disk, tried again under a new name", (run) => {
	const g = graph({
		r: node(null, { a: ["a"], u: ["m", "n"] }),
		a: node("a", { k: ["k"] }),
		k: node("k"),
		m: node("m"),
		n: node("n"),
	})
	run.lay(g)
	// the store could not lay a.txt and the union's folder: they are left, and not on disk
	run.old.a.left = ["a.txt"]
	run.old.r.left = ["u"]
	run.disk.things.delete("a.txt")
	for (const p of [...run.disk.things.keys()]) {
		if (p === "u" || p.startsWith("u/")) run.disk.things.delete(p)
	}
	run.disk.other("a.txt")
	const again = run.lay(g)
	assert(!("left" in again.layout.a), "a new layout has no left")
	run.lay(g)
})

sequence(
	"files-program",
	"a node the files program made since: its record counts, though the old graph lacks it",
	(run) => {
		const g1 = graph({ r: node(null, { a: ["a"] }), a: node("a") })
		run.lay(g1)
		// a person made b.txt; the files program took it in as node b, with its record
		run.disk.things.set("b.txt", { kind: "file", hash: h("made") })
		run.old.r.entries = { ...entries(run), b: "b" }
		run.old.b = { home: ["r", "b", 0], file: "b.txt", laid: h("made") }
		const taken = run.lay(
			graph({ r: node(null, { a: ["a"], b: ["b"] }), a: node("a"), b: node("made") }),
		)
		assertEquals(
			taken.plan,
			[],
			"FILES.tex Writing: a file whose laid is already the value is not laid again",
		)
		// laid already the new value: no step
		run.disk.things.set("a.txt", { kind: "file", hash: h("edit") })
		run.old.a.laid = h("edit")
		run.lay(graph({ r: node(null, { a: ["a"], b: ["b"] }), a: node("edit"), b: node("made") }))
	},
)

sequence(
	"again",
	"laid out again: the same graph with no before gives no plan; with no ino a folder is expected as any",
	(run) => {
		const g = graph({ r: node(null, { a: ["a"] }), a: node(null, { k: ["k"] }), k: node("k") })
		run.lay(g)
		const same = run.lay(g, { before: null })
		assertEquals(same.plan, [])
		assertEquals(same.changed, {})
		run.lay(graph({ r: node(null, { b: ["a"] }), a: node(null, { k: ["k"] }), k: node("k") }), {
			ino: false,
		})
		run.lay(graph({ r: node(null, {}), a: node(null, { k: ["k"] }), k: node("k") }))
	},
)

sequence("no-root", "a graph without its root lays nothing and keeps the old layout", (run) => {
	run.lay(graph({ r: node(null, { a: ["a"] }), a: node("a") }))
	const none = run.lay(graph({ a: node("a") }), { carry: false })
	assertEquals(none.plan, [])
})

sequence(
	"info",
	"info: set on a file and a folder, changed, and dropped; each an info step",
	(run) => {
		const t = (v: Value) => [["tags", v]] as [string, Value][]
		run.lay(
			graph({
				r: node(null, { a: ["a"], f: ["f"] }),
				a: node("a", {}, { info: t(["red"]) }),
				f: node(null, { k: ["k"] }, { info: t("x") }),
				k: node("k"),
			}),
		)
		const changed = run.lay(
			graph({
				r: node(null, { a: ["a"], f: ["f"] }),
				a: node("a", {}, { info: t(["blue"]) }),
				f: node(null, { k: ["k"] }, { info: t("y") }),
				k: node("k"),
			}),
		)
		assertEquals(changed.plan.map((s) => s.what), ["info", "info"])
		run.lay(
			graph({
				r: node(null, { a: ["a"], f: ["f"] }),
				a: node("b", {}, { info: t(["blue"]) }),
				f: node(null, { k: ["k"] }),
				k: node("k"),
			}),
		)
		run.lay(
			graph({
				r: node(null, { a: ["a"], f: ["f"] }),
				a: node("b", {}, { info: [["x", 1], ["tags", ["blue"]]] }),
				f: node(null, { k: ["k"] }),
				k: node("k"),
			}),
		)
	},
)

sequence(
	"link-becomes-file",
	"the home's slot let go while a link stays: the link goes, the file moves to it",
	(run) => {
		const x = node("x")
		run.lay(graph({ r: node(null, { a: ["x"], b: ["x"] }), x }))
		const l = run.lay(graph({ r: node(null, { b: ["x"] }), x }))
		assertEquals(files(l), [["remove", "b.txt", null], ["rename", "a.txt", "b.txt"]])
		// and a link whose name changes is made again
		run.lay(graph({ r: node(null, { b: ["x"], c: ["x"] }), x }))
		run.lay(graph({ r: node(null, { b: ["x"], d: ["x"] }), x }))
	},
)

sequence(
	"slot-shape",
	"a slot that becomes a union and one that stops being one get new stems; the free name is found again",
	(run) => {
		run.disk.other("u")
		const a = node("a"), b = node("b")
		run.lay(graph({ r: node(null, { u: ["a"] }), a, b }))
		run.lay(graph({ r: node(null, { u: ["a", "b"] }), a, b }))
		run.disk.things.delete("u")
		run.lay(graph({ r: node(null, { u: ["b"] }), a, b }))
	},
)

sequence(
	"many",
	"a busier store: several folders, unions, links and sides changing at once",
	(run) => {
		const base = {
			docs: node(null, { "notes.md": ["n1", "n2"], img: ["p"], todo: ["t"] }),
			n1: node("# one"),
			n2: node("# two", {}, { sides: ["# two, too"] }),
			p: node(PNG),
			t: node(["milk"]),
			apps: node({ list: true }, { clock: ["c"] }),
			c: node("12:00"),
		}
		run.lay(graph({ r: node(null, { docs: ["docs"], apps: ["apps"], star: ["n2"] }), ...base }))
		run.lay(graph({
			r: node(null, { docs: ["docs"], apps: ["apps"], star: ["n2", "c"], Docs: ["t"] }),
			...base,
			docs: node(null, { "notes.md": ["n2", "n1", "x"], img: ["p"], todo: ["t"] }),
			x: node("# three"),
			t: node(["milk", "eggs"]),
		}))
		run.lay(graph({
			r: node(null, { docs: ["apps"], apps: ["docs"], Docs: ["t"] }),
			...base,
			docs: node(null, { "notes.md": ["n2", "x"], todo: ["t"] }),
			x: node("# three"),
			t: node(["milk", "eggs"]),
		}))
	},
)

// ---- write
await Deno.mkdir(out, { recursive: true })
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
all.forEach(({ name, scenario }, i) => {
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	Deno.writeTextFileSync(new URL(file, out), JSON.stringify(scenario, null, "\t") + "\n")
})
console.log(`${all.length} scenarios`)
