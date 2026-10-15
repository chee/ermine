// Writes the store scenarios to newcore/files/conformance/store/NN-short-name.json.
//   deno run --allow-all conformance/store/fixtures.ts
// A scenario: {title, steps} (run.ts has the shape, harness.ts the protocol). The steps are
// written here; every expected answer and snapshot is the reference's, recorded by running the
// scenario against harness.ts, and read over by hand against FILES.tex when it was written. So
// the suite pins store.ts as it is: a C store that differs is wrong, or store.ts is.
// A crashed batch is made portable by its state, not by where a crash fell: store.ts is run here
// on a scratch folder through the same writes, and the batch's first frame (the plan) and the
// values it kept are caught as it appends; the scenario then gives them back as edits, with a
// folder's file id in the plan written as the path that holds it, and lays out by hand, as
// edits, whatever part of the plan the crash is to have done.
import createNode, { type Node } from "../../playground/files/typescript/saved.ts"
import * as cbor from "@ermine/encoding/cbor"
import * as manifest from "@ermine/files/manifest"
import { mirror, type Saving, store } from "@ermine/files/store"
import { fake, type Sys, system } from "@ermine/files/sys"
import { toJson } from "../pack/form.ts"
import { planOf, run, type Scenario, type Step } from "./run.ts"

const out = new URL("../suites-aside/playground/files/conformance/store/", import.meta.url)
const here = new URL(".", import.meta.url).pathname
const reference = ["deno", "run", "--quiet", "--allow-all", `${here}harness.ts`]
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const utf8 = new TextEncoder()
const bytes = (...xs: number[]) => Uint8Array.from(xs)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const TAG = "com.apple.metadata:_kMDItemUserTags"

// ---- a host's graph, changed by hand as its table would hold it

type V = { content: unknown; change: unknown }
type Held = { value: V[]; info: Map<string, V[]>; children: Map<string, V[]> }

class Model {
	time = 0
	nodes = new Map<string, Held>()
	constructor(readonly root = "r") {
		this.nodes.set(root, { value: [], info: new Map(), children: new Map() })
	}
	#change(node: string) {
		return { time: this.time, actor: "host", node }
	}
	#list(at: string, name: string): string[] {
		return (this.nodes.get(at)!.children.get(name)?.[0]?.content ?? []) as string[]
	}
	#set(at: string, name: string, list: string[]) {
		this.nodes.get(at)!.children.set(name, [{ content: list, change: this.#change(at) }])
	}
	/** A node made, with no slot: unreachable until placed. */
	make(id: string, value: unknown) {
		this.time++
		this.nodes.set(id, {
			value: [{ content: value, change: this.#change(id) }],
			info: new Map(),
			children: new Map(),
		})
	}
	/** Places id in at's slot name, at position or the end; a value makes the node. */
	place(at: string, name: string, id: string, value?: unknown, position?: number) {
		if (value !== undefined) this.make(id, value)
		this.time++
		const list = this.#list(at, name).filter((x) => x !== id)
		list.splice(position ?? list.length, 0, id)
		this.#set(at, name, list)
	}
	unplace(at: string, name: string, id: string) {
		this.time++
		this.#set(at, name, this.#list(at, name).filter((x) => x !== id))
	}
	write(id: string, value: unknown) {
		this.time++
		const n = this.nodes.get(id)!
		n.value = [{ content: value, change: this.#change(id) }, ...n.value.slice(1)]
	}
	/** Every version after the first. */
	sides(id: string, values: unknown[]) {
		this.time++
		const n = this.nodes.get(id)!
		n.value = [n.value[0], ...values.map((content) => ({ content, change: this.#change(id) }))]
	}
	info(id: string, name: string, value?: unknown) {
		this.time++
		const n = this.nodes.get(id)!
		if (value === undefined) n.info.delete(name)
		else n.info.set(name, [{ content: value, change: this.#change(id) }])
	}
	tick() {
		this.time++
	}
	/** The write request: every node the host holds, in its JSON form. */
	request(more: { ephemeral?: string[]; records?: Record<string, string | null> } = {}) {
		const vs = (xs: V[]) => xs.map((v) => ({ content: toJson(v.content), change: v.change }))
		const nodes = [...this.nodes].map(([id, n]) => ({
			id,
			value: vs(n.value),
			info: [...n.info].map(([k, x]) => [k, vs(x)]),
			children: [...n.children].map(([k, x]) => [k, x.map((v) => ({ ...v }))]),
		}))
		return { op: "write", root: this.root, time: this.time, nodes, ...more }
	}
	/** The same, as store.ts takes it: new node objects. */
	saving(ephemeral: string[] = []): Saving {
		const table = new Map<string, Node<unknown, unknown>>()
		for (const [id, n] of this.nodes) {
			table.set(
				id,
				createNode(id, {
					value: n.value.map((v) => ({ ...v })),
					attributes: [...n.info].map(([k, x]) => [k, x.map((v) => ({ ...v }))] as const),
					children: [...n.children].map((
						[k, x],
					) => [k, x.map((v) => ({ ...v, content: [...(v.content as string[])] }))] as const),
				}),
			)
		}
		return {
			root: this.root,
			time: this.time,
			get: (id) => table.get(id),
			ephemeral: (id) => ephemeral.includes(id),
		}
	}
}

// ---- steps

const ask = (request: Record<string, unknown> & { op: string }): Step => ({ request })
const open = (more: Record<string, unknown> = {}) => ask({ op: "open", ...more })
const read = () => ask({ op: "read" })
const write = (m: Model, more?: Parameters<Model["request"]>[0]) => ask(m.request(more))
const graph = () => ask({ op: "graph" })
const others = () => ask({ op: "others" })
const differences = (touched?: string[]) =>
	ask(touched ? { op: "differences", touched } : { op: "differences" })
const mend = (paths?: string[]) => ask(paths ? { op: "mend", paths } : { op: "mend" })
const observe = (attrs?: string[]): Step => ({ observe: attrs ? { attrs } : {} })
const edit = (what: string, more: Record<string, unknown>): Step =>
	({ edit: what, ...more }) as Step
const put = (path: string, text: string, keep?: boolean) =>
	edit("write", keep ? { path, text, keep } : { path, text })

type Fixture = { name: string; scenario: Scenario }
const all: Fixture[] = []
const scenario = (name: string, title: string, steps: Step[]) =>
	all.push({ name, scenario: { title, steps } })

/** The paper's example (FILES.tex, An example): a write for each change, a snapshot after some. */
function example(m: Model, look: number[] = []): Step[] {
	const changes: (() => void)[] = [
		() => m.place("r", "apps", "a", { theme: "dark" }),
		() => m.place("a", "clock", "c", "12:00"),
		() => m.place("r", "docs", "d1", "hello"),
		() => m.place("r", "docs", "d2", PNG),
		() => m.place("r", "pinned", "d1"),
		() => m.place("r", "Notes", "x9"),
	]
	const steps: Step[] = []
	changes.forEach((c, i) => {
		c()
		steps.push(write(m))
		if (look.includes(i + 1)) steps.push(observe())
	})
	return steps
}

// ---- a batch caught at its plan

type Caught = { values: [string, string][]; records: Record<string, unknown> }

/**
 * Runs store.ts on a scratch folder through prior's writes, then batch's, and catches the
 * batch's first frame, the one with the plan, and the kept files written for it.
 */
async function catching(prior: Saving[], batch: Saving, files = false): Promise<Caught> {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-store-fix-" }))
	const folder = `${dir}/Store`
	const log = `${folder}/.ermine/manifest`
	let caught: Caught | undefined
	let before = new Set<string>()
	const base = system()
	const sys: Sys = {
		...base,
		trash: () => Promise.reject(new Error("never the real Trash")),
		async sync(path) {
			await base.sync(path)
			if (path !== log || caught || !armed) return
			const all = await Deno.readFile(log)
			const view = new DataView(all.buffer)
			let at = 0, last = 0
			while (at + 4 <= all.length) last = at, at += 4 + view.getUint32(at)
			const f = cbor.decode(all.subarray(last + 4, at)) as Record<string, Uint8Array | null>
			if (!f.plan) return
			const inos = new Map<number, string>()
			const walk = (abs: string, path: string) => {
				const st = Deno.lstatSync(abs)
				if (!st.isDirectory) return
				inos.set(st.ino!, path)
				for (const e of Deno.readDirSync(abs)) {
					walk(`${abs}/${e.name}`, path === "" ? e.name : `${path}/${e.name}`)
				}
			}
			walk(folder, "")
			const records: Record<string, unknown> = {}
			for (const [k, v] of Object.entries(f)) {
				records[k] = v === null ? null : k === "plan" ? planOf(v, (n) => inos.get(n)!) : hex(v)
			}
			const values: [string, string][] = []
			for (const e of Deno.readDirSync(`${folder}/.ermine/values`)) {
				if (before.has(e.name)) continue
				values.push([e.name, hex(Deno.readFileSync(`${folder}/.ermine/values/${e.name}`))])
			}
			values.sort(([a], [b]) => (a < b ? -1 : 1))
			caught = { values, records }
		},
	}
	let armed = false
	try {
		const t = store(folder, { sys, trash: fake(`${dir}/Trash`), files, home: `${dir}/Home` })
		await t.read()
		for (const s of prior) await t.write(s)
		before = new Set([...Deno.readDirSync(`${folder}/.ermine/values`)].map((e) => e.name))
		armed = true
		await t.write(batch)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
	if (!caught) throw new Error("the batch had no plan")
	return caught
}

/** The edits that give a caught batch back: its kept files, then its frame. */
const kept = (c: Caught): Step[] => [
	...c.values.map(([name, h]) => edit("write", { path: `.ermine/values/${name}`, hex: h })),
	edit("frame", { records: c.records }),
]

// =================================================================================================
// new stores

scenario("new-missing-folder", "a folder that is not there becomes a new store: read gives null", [
	open(),
	read(),
	observe(),
	read(),
	graph(),
	others(),
	differences(),
])

scenario(
	"new-passed-names",
	"a folder holding only names passed over (.DS_Store, ._x) becomes a new store",
	[
		edit("mkdir", { path: "" }),
		put(".DS_Store", "finder"),
		put("._x", "resource fork"),
		open(),
		read(),
		observe(),
	],
)

scenario(
	"new-refused",
	"a folder holding others' entries is refused, changed in nothing, by a host with no files program",
	[
		edit("mkdir", { path: "" }),
		put("notes.md", "# hi"),
		edit("mkdir", { path: "photos" }),
		open(),
		read(),
		observe(),
	],
)

scenario(
	"new-files-program",
	"a folder holding others' entries becomes a store for a host running the files program; they are differences",
	[
		edit("mkdir", { path: "" }),
		put("notes.md", "# hi"),
		edit("mkdir", { path: "photos" }),
		put("photos/cat.png", "meow"),
		open({ files: true }),
		read(),
		differences(),
		observe(),
	],
)

// =================================================================================================
// the paper's example, and rewrites

{
	const m = new Model()
	scenario("paper-example", "the paper's example is saved as FILES.tex shows it, batch by batch", [
		open(),
		read(),
		...example(m, [1, 2, 3, 4, 5, 6]),
		differences(),
		graph(),
		others(),
		ask({ op: "listed" }),
	])
}

{
	const m = new Model()
	scenario(
		"paper-example-reload",
		"the paper's example loads back as the host had it, x9 missing; a second read gives the same",
		[
			open(),
			read(),
			...example(m),
			open(),
			read(),
			graph(),
			differences(),
			read(),
			observe(),
		],
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m), observe())
	m.tick()
	steps.push(write(m), observe())
	steps.push(write(m), observe())
	scenario(
		"time-only",
		"a batch that changes only the time is one frame of meta and store; the same graph again writes nothing",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read(), ...example(m)]
	m.unplace("r", "pinned", "d1")
	steps.push(write(m), observe())
	m.unplace("r", "docs", "d2")
	steps.push(write(m), observe(), open(), read())
	m.place("r", "back", "d2")
	steps.push(write(m), observe(), differences())
	scenario(
		"link-goes-union-folds",
		"a link goes with its slot; a union of one is a file again; the node unplaced is kept, away, and shown again when placed",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "clock", "c", "12:00")
	steps.push(write(m))
	m.write("c", "12:01")
	steps.push(write(m), observe())
	m.write("c", { at: 12 })
	steps.push(write(m), observe())
	m.write("c", PNG)
	steps.push(write(m), observe())
	m.write("c", "back to text")
	steps.push(write(m), observe(), open(), read())
	scenario(
		"rewrites-and-forms",
		"a value written again replaces its file; a new form changes only the extension",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "one", "n", "moving")
	m.place("n", "inner", "i", "in")
	m.place("r", "two", "n")
	steps.push(write(m), observe())
	m.unplace("r", "one", "n")
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"home-moves",
		"a node unplaced from its home moves, file and folder, to the slot that still holds it",
		steps,
	)
}

// =================================================================================================
// values of every form

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "plain", "s1", "hello")
	m.place("r", "empty", "s2", "")
	m.place("r", "accents", "s3", "ünï\n")
	m.place("r", "png", "b1", PNG)
	m.place("r", "jpg", "b2", bytes(0xff, 0xd8, 0xff, 0xe0, 1))
	m.place("r", "gif", "b3", utf8.encode("GIF89a!"))
	m.place("r", "pdf", "b4", utf8.encode("%PDF-1.7"))
	m.place("r", "webp", "b5", utf8.encode("RIFF\0\0\0\0WEBPVP8"))
	m.place("r", "raw", "b6", bytes(1, 2, 3))
	m.place("r", "notutf8", "b7", bytes(0xff, 0xfe))
	m.place("r", "nothing", "b8", bytes())
	steps.push(write(m), observe(), open(), read())
	scenario(
		"forms-text-and-bytes",
		"strings are .txt as UTF-8; bytes take the extension how they start gives: png, jpg, gif, pdf, webp, else bin",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "i8", "t1", new Int8Array([-1, 2]))
	// no uint8 kind (the designer, 10-12): a Uint8Array is bytes, u8.bin
	m.place("r", "u8", "t2", new Uint8Array([7, 255]))
	m.place("r", "i16", "t3", new Int16Array([-300]))
	m.place("r", "u16", "t4", new Uint16Array([65535]))
	m.place("r", "i32", "t5", new Int32Array([-70000]))
	m.place("r", "u32", "t6", new Uint32Array([4000000000]))
	m.place("r", "i64", "t7", new BigInt64Array([-5n, 9007199254740993n]))
	m.place("r", "u64", "t8", new BigUint64Array([18446744073709551615n]))
	m.place("r", "f32", "t9", new Float32Array([1, NaN, -0]))
	m.place("r", "f64", "t10", new Float64Array([0.1, -Infinity]))
	m.place("r", "data.raw", "t11", new Float32Array([2]))
	steps.push(write(m), observe(), open(), read())
	scenario(
		"forms-typed-arrays",
		"a typed array is its elements little-endian, named .<kind>; data.raw holding float32 is data.raw.float32; a Uint8Array is bytes, no kind",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "null", "c1", null)
	m.place("r", "yes", "c2", true)
	m.place("r", "half", "c3", 1.5)
	m.place("r", "minus zero", "c4", -0)
	m.place("r", "nan", "c5", NaN)
	m.place("r", "inf", "c6", Infinity)
	m.place("r", "list", "c7", [1, "x", true, null])
	m.place("r", "map", "c8", {
		zeta: 1,
		alpha: { bytes: bytes(1, 2), floats: new Float32Array([1]) },
		"": [],
	})
	m.place("r", "slash", "c9", { "/": "a map whose one key is /" })
	m.place("r", "big", "c10", 1e300)
	steps.push(write(m), observe(), open(), read())
	scenario(
		"forms-cbor",
		"anything else is CBOR diagnostic notation in .text: null, booleans, numbers with a point, NaN, -0.0, lists, maps, bytes and typed arrays inside",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "README.md", "e1", "# readme")
	m.place("r", "x.text", "e2", { a: 1 })
	m.place("r", "y.text", "e3", "a string is never .text")
	m.place("r", "photo.png", "e4", "a string may be .png")
	m.place("r", "floats.float32", "e5", new Float64Array([1]))
	m.place("r", "both.md", "e6", "first")
	m.place("r", "both.md", "e7", { second: true })
	m.place("r", "archive.tar.gz", "e8", bytes(0x1f, 0x8b))
	steps.push(write(m), observe(), open(), read())
	scenario(
		"names-extensions",
		"a slot's extension is kept when its value may have it, else the form's is added; a union's members take the slot's where they may",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a/b", "n1", "slash")
	m.place("r", "x:y", "n2", "colon")
	m.place("r", "", "n3", "empty name")
	m.place("r", ".DS_Store", "n4", "a passed name")
	m.place("r", ".ermine", "n5", "the store's own name")
	m.place("r", "Case", "n6", "upper")
	m.place("r", "case", "n7", "lower")
	m.place("r", "café", "n8", "composed")
	m.place("r", "café", "n9", "decomposed")
	m.place("r", "nul\0name", "n10", "a NUL")
	m.place("r", "long " + "x".repeat(300), "n11", "cut")
	m.place("r", "long " + "x".repeat(299), "n12", "cut too")
	m.place("r", "ß", "n13", "sharp s")
	m.place("r", "SS", "n14", "folded")
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"names-written",
		"names as written: / as :, : as full-width, empty as untitled, passed names in _, clashes by case folding and NFD take .FINAL, long ones cut",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [
		edit("mkdir", { path: "" }),
		put("junk.tmp", "a person's"),
		open({ pass: ["*.tmp", ".DS_Store"] }),
		read(),
	]
	m.place("r", "x.tmp", "p1", "named as a passed name")
	m.place("r", "plain", "p2", "plain")
	steps.push(
		write(m),
		put(".DS_Store", "finder"),
		put("Icon\r", "no longer passed"),
		observe(),
		differences(),
		open({ files: true }),
		read(),
		differences(),
	)
	scenario(
		"pass-given",
		"a store made with its own pass keeps it in its store record; a passed name is written in _ and is never a difference",
		steps,
	)
}

// =================================================================================================
// info, sides, unions, links

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "clock", "c", "12:00")
	m.place("c", "inner", "i", 1)
	m.info("c", "color", "red")
	m.info("c", "shape", { round: true })
	m.info("c", "bytes", bytes(0, 1, 0xff))
	steps.push(write(m), observe())
	steps.push(edit("attr", { path: "clock.txt", name: TAG, text: "Red" }))
	m.write("c", "12:01")
	m.info("c", "color")
	m.info("c", "size", 3)
	steps.push(write(m), observe([TAG]))
	m.info("c", "size", 4)
	steps.push(write(m), observe([TAG]), differences(), open(), read())
	scenario(
		"info-attributes",
		"info is party.chee.ermine.info.<name> on the file and the folder, rendered in its form; a value written again keeps a Finder tag",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	m.info("a", "x".repeat(200), "a name too long for an attribute")
	m.info("a", "ok", "fits")
	steps.push(write(m), observe(), open(), read(), differences())
	scenario(
		"info-too-long",
		"info that does not fit an extended attribute is listed, and the rest is laid",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "clock", "c", "12:00")
	m.sides("c", ["13:00", { at: 14 }])
	steps.push(write(m), observe())
	m.sides("c", ["13:30"])
	steps.push(write(m), observe())
	m.sides("c", [])
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"sides",
		"each later value version is a side beside the file, its stem with one more .FINAL each, with party.chee.ermine.side; one that goes is removed",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "pile", "u1", "first")
	m.place("r", "pile", "u2", PNG)
	m.place("r", "pile", "u3", { third: 3 })
	m.place("u2", "under", "u4", "inside a member")
	steps.push(write(m), observe())
	m.unplace("r", "pile", "u1")
	steps.push(write(m), observe())
	m.place("r", "pile", "u5", "new first", 0)
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"unions",
		"a slot holding several is a folder carrying party.chee.ermine.slot, members 1, 2, ... in slot order, numbered again as members come and go",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "docs", "d", "a doc")
	m.place("d", "child", "k", "a child")
	m.place("r", "alias", "d")
	m.place("r", "alias.md", "d")
	m.place("d", "self", "d")
	m.place("r", "later", "a.b")
	m.place("r", "far", "z/y")
	steps.push(write(m), observe())
	m.make("a.b", "arrived")
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"links",
		"a node in a second slot is links to its file and folder; a pending mount links into .ermine/id/ percent-encoded; it is laid when it arrives",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.write("r", "the root's own value")
	m.info("r", "title", "root")
	m.place("r", "kid", "k", "kid")
	steps.push(write(m), observe())
	m.write("r", { now: "a map" })
	steps.push(write(m), observe(), differences(), open(), read())
	scenario(
		"root-value",
		"the root's value is .ermine/root.<ext>; the store's folder carries its id",
		steps,
	)
}

// =================================================================================================
// what is and is not saved

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "keep", "a", "kept")
	m.place("r", "go", "g", "unplaced later")
	m.place("g", "inner", "gi", "held by g only")
	m.make("loose", "never placed")
	steps.push(write(m), observe())
	m.unplace("r", "go", "g")
	steps.push(write(m), observe(), graph(), open(), read(), differences())
	scenario(
		"unreachable-kept",
		"a node no longer reached keeps its record and is no longer shown; it loads among others; a node never reached is never saved",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "list", "a", "ordinary")
	m.place("r", "list", "e", "ephemeral")
	m.place("e", "held", "h", "held only by an ephemeral node")
	m.place("r", "only", "e")
	steps.push(write(m, { ephemeral: ["e"] }), observe(), open(), read())
	scenario(
		"ephemeral-nodes",
		"an ephemeral node is never saved and is left out of every list; what only it holds is not saved",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m, { records: { "sync:heads": hex(utf8.encode("theirs")), "x": "00ff" } }))
	steps.push(others(), observe())
	m.write("a", "two")
	steps.push(write(m, { records: { "sync:heads": hex(utf8.encode("later")) } }), others())
	steps.push(write(m, { records: { "x": null } }), others(), open(), read(), others())
	steps.push(write(m, { records: { "meta": null } }), write(m, { records: { "node:a": "00" } }))
	steps.push(write(m, { records: { "store": "00" } }), others(), observe())
	scenario(
		"host-records",
		"a host's records are kept in the batch's frame, changed, and removed by null; a key of the store's own is refused",
		steps,
	)
}

{
	const steps: Step[] = [open(), read()]
	steps.push(ask({ op: "write", root: "r", time: 1, nodes: [] }), read(), observe())
	scenario("root-not-loaded", "a write whose root is not loaded is refused", steps)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	const w = m.request() // a's value made at time 9, the graph given at time 2
	;(w.nodes.find((n) => n.id === "a")!.value[0].change as { time: number }).time = 9
	steps.push(ask(w), observe(), open(), read(), observe())
	scenario(
		"late-change-invalid",
		"a store holding a change later than meta's time is invalid: loading refuses it and changes nothing",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open({ slack: 0 }), read()]
	m.place("r", "a", "a", "zero")
	m.place("r", "b", "b", PNG)
	steps.push(write(m))
	for (let i = 1; i <= 4; i++) {
		m.write("a", `value ${i}`)
		steps.push(write(m))
	}
	steps.push(observe(), open({ slack: 0 }), read())
	scenario(
		"folding",
		"a manifest grown past four times what it holds and slack is folded to one frame once a batch is done; kept files no record names go",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m), read())
	m.write("a", "two")
	m.place("r", "b", "b", "new")
	steps.push(write(m), read(), graph())
	scenario("read-again", "read again gives the graph as last written", steps)
}

// =================================================================================================
// the manifest cut short or broken

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m))
	m.write("a", "two")
	steps.push(write(m), edit("unframe", { count: 1, leave: 5 }), open(), read(), observe())
	scenario(
		"done-frame-cut-short",
		"a batch whose done frame was cut short is laid out again and written done: it loads as after it",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m))
	m.write("a", "two")
	steps.push(
		write(m),
		edit("unframe", { count: 2, leave: 7 }),
		observe(),
		open(),
		read(),
		observe(),
	)
	scenario(
		"batch-frame-cut-short",
		"a batch whose first frame was cut short is dropped: it loads as before it, and the folder is laid out again as that",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	steps.push(write(m))
	steps.push(
		edit("append", { path: ".ermine/manifest", hex: "00000001ff" }),
		edit("append", { path: ".ermine/manifest", hex: "00000001a0" }),
		observe(),
		open(),
		read(),
		observe(),
	)
	scenario(
		"broken-frame-invalid",
		"a frame before the last that does not decode makes the store invalid; loading changes nothing",
		steps,
	)
}

{
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "a", "a", "one")
	m.place("r", "b", "b", PNG)
	steps.push(write(m))
	steps.push(
		edit("remove", { path: `.ermine/values/${manifest.hash("one")}` }),
		open(),
		read(),
		edit("write", { path: `.ermine/values/${manifest.hash("one")}`, text: "not one" }),
		open(),
		read(),
		edit("write", { path: `.ermine/values/${manifest.hash("one")}`, text: "one" }),
		open(),
		read(),
		observe(),
	)
	scenario(
		"kept-file-invalid",
		"a kept file missing, or not hashing to its name, makes the store invalid; put back, it loads",
		steps,
	)
}

// =================================================================================================
// a batch crashed mid-plan

const crashes: Promise<void>[] = []

/** A crash scenario: prior batches (each commit), then the batch caught at its plan, then the edits a crash left. */
function crash(
	name: string,
	title: string,
	build: (m: Model, commit: () => void) => { done?: Step[]; after?: Step[]; files?: boolean },
) {
	const m = new Model()
	const savings: Saving[] = []
	const requests: Step[] = []
	const plan = build(m, () => {
		savings.push(m.saving())
		requests.push(write(m))
	})
	const batch = m.saving()
	const index = all.length
	all.push({ name, scenario: { title, steps: [] } })
	const how = plan.files ? { files: true } : {}
	crashes.push((async () => {
		const c = await catching(savings, batch, plan.files)
		all[index].scenario.steps = [
			open(how),
			read(),
			...requests,
			observe(),
			...kept(c),
			...(plan.done ?? []),
			observe(),
			open(how),
			read(),
			observe(),
			differences(),
			...(plan.after ?? []),
		]
	})())
}

crash(
	"crash-plan-only",
	"a batch kept but not laid out (its plan frame and kept files only) is laid out on loading",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		c.place("r", "b", "b", PNG)
		return {}
	},
)

crash(
	"crash-tmp-written",
	"a batch whose new file waits in .ermine/tmp, not yet swapped in, is laid out on loading",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		return {
			done: [
				put(".ermine/tmp/3.1", "two"),
				edit("attr", { path: ".ermine/tmp/3.1", name: "party.chee.ermine.id", text: "a" }),
			],
		}
	},
)

crash(
	"crash-swapped",
	"a batch crashed just after its swap: the new file in place, the old in .ermine/tmp; loading finishes it",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		return {
			done: [
				edit("rename", { from: "a.txt", to: ".ermine/tmp/3.1" }),
				put("a.txt", "two"),
				edit("attr", { path: "a.txt", name: "party.chee.ermine.id", text: "a" }),
			],
		}
	},
)

crash(
	"crash-laid-not-done",
	"a batch laid out whole but not written done is found done on loading, and written done",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		return {
			done: [
				put("a.txt", "two"),
				edit("attr", { path: "a.txt", name: "party.chee.ermine.id", text: "a" }),
			],
		}
	},
)

crash(
	"crash-person-edit",
	"a person's edit to a file the crashed batch writes is left as it is, a difference for the files program",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		return { files: true, done: [put("a.txt", "mine")] }
	},
)

crash(
	"crash-person-edit-trashed",
	"for a host with no files program, a person's edit met by a crashed batch goes to the Trash once loaded",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.write("a", "two")
		return { done: [put("a.txt", "mine")] }
	},
)

crash(
	"crash-place-taken",
	"a person's entry where the crashed batch lays a new one stays; the step is listed and left, and the next batch lays it elsewhere",
	(c, commit) => {
		c.place("r", "a", "a", "one")
		commit()
		c.place("r", "b", "b", "the store's")
		return {
			files: true,
			done: [put("b.txt", "a person's")],
			after: [
				ask({ ...c.request(), time: c.time + 1 }),
				observe(),
				differences(),
			],
		}
	},
)

crash(
	"crash-union-made",
	"a crashed batch that makes a union: plan only, the store's moves carried out on loading",
	(c, commit) => {
		c.place("r", "docs", "d1", "hello")
		c.place("d1", "kid", "k", "kid")
		commit()
		c.place("r", "docs", "d2", PNG)
		return {}
	},
)

crash(
	"crash-folder-removed-holding-work",
	"a crashed batch that removes a folder holding a person's file sends that folder to the Trash whole on loading",
	(c, commit) => {
		c.place("r", "keep", "a", "kept")
		c.place("r", "gone", "g", "bye")
		c.place("g", "child", "k", PNG)
		commit()
		c.unplace("r", "gone", "g")
		return { done: [put("gone/notes.txt", "a person's notes")] }
	},
)

crash(
	"crash-home-moved-partly",
	"a crashed batch moving a node's home: its folder renamed already, its file not; loading finishes the moves",
	(c, commit) => {
		c.place("r", "one", "n", "moving")
		c.place("n", "inner", "i", "in")
		c.place("r", "two", "n")
		commit()
		c.unplace("r", "one", "n")
		return {}
	},
)

// =================================================================================================
// edits made while nothing watched, differences and mending

/** The paper's example, then a person's edits. */
function edited(): Step[] {
	return [
		put("apps/clock.txt", "12:30"),
		edit("remove", { path: "docs/1.txt" }),
		put("new.txt", "new"),
		put(".DS_Store", "passed over"),
		edit("rename", { from: "apps.text", to: "apps.json" }),
		edit("mkdir", { path: "made" }),
		edit("remove", { path: "pinned.txt" }),
		edit("link", { path: "pinned.txt", target: "docs/2.png" }),
		edit("unattr", { path: "docs/2.png", name: "party.chee.ermine.id" }),
	]
}

{
	const m = new Model()
	scenario(
		"edits-for-files-program",
		"edits made while nothing watched are differences a host running the files program is given; the graph is as the manifest says",
		[
			open(),
			read(),
			...example(m),
			...edited(),
			open({ files: true }),
			read(),
			differences(),
			observe(),
			differences(["apps"]),
			differences([""]),
			differences(["nowhere", ".ermine/tmp"]),
		],
	)
}

{
	const m = new Model()
	scenario(
		"edits-trashed",
		"for a host running no files program, loading lays the folder out again, each edit sent to the Trash",
		[
			open(),
			read(),
			...example(m),
			...edited(),
			open(),
			read(),
			observe(),
			differences(),
		],
	)
}

{
	const m = new Model()
	scenario(
		"mend",
		"mend lays given paths out again, sending what is there to the Trash; with none given, every path that differs",
		[
			open(),
			read(),
			...example(m),
			...edited(),
			open({ files: true }),
			read(),
			mend(["apps/clock.txt", "new.txt"]),
			observe(),
			differences(),
			mend(),
			observe(),
			differences(),
		],
	)
}

{
	const m = new Model()
	m.place("r", "a", "a", "one")
	m.place("r", "b", "b", "two")
	scenario(
		"in-place-edits",
		"a file written in place is a difference; one whose id an app dropped is no difference and gets its id again",
		[
			open(),
			read(),
			write(m),
			put("a.txt", "eno", true),
			edit("unattr", { path: "b.txt", name: "party.chee.ermine.id" }),
			differences(),
			observe(),
		],
	)
}

{
	const m = new Model()
	m.place("r", "a", "a", "one")
	m.write("r", "root value")
	scenario(
		"root-file-edited",
		"the root's file in .ermine is compared too; nothing else in .ermine is ever a difference",
		[
			open(),
			read(),
			write(m),
			put(".ermine/root.txt", "edited"),
			put(".ermine/tmp/stray", "the store's own leftovers"),
			differences(),
			open({ files: true }),
			read(),
			observe(),
		],
	)
}

{
	const m = new Model()
	m.place("r", "a", "a", "one")
	scenario(
		"trash-and-lock",
		"trash sends an entry to the Trash and lists it; lock runs what it is given",
		[
			open(),
			read(),
			write(m),
			put("mine.txt", "mine"),
			put("other.txt", "other"),
			ask({ op: "trash", path: "mine.txt", why: "asked" }),
			edit("mkdir", { path: "x" }),
			put("x/mine.txt", "a second of the same name"),
			ask({ op: "trash", path: "x/mine.txt", why: "asked again" }),
			ask({ op: "lock", run: { op: "differences" } }),
			ask({ op: "lock", run: { op: "mend" } }),
			ask({ op: "lock", run: { op: "graph" } }),
			observe(),
		],
	)
}

// =================================================================================================
// outside manifests, the list of stores, copies, mirrors

const readWith = (m: Model): Step => ask({ ...m.request(), op: "read" })
const stores = () => ask({ op: "stores" })
const find = (uuid: string) => ask({ op: "find", uuid })
const external = "@Home/.ermine/external"
const look = (folder: string, ...at: string[]): Step => ({
	observe: { folder, at },
})
/** The paper's example, saved in a folder opened on a path of the temp folder. */
const exampleIn = (folder: string, more: Record<string, unknown> = {}): [Model, Step[]] => {
	const m = new Model()
	return [m, [open({ folder, ...more }), read(), ...example(m)]]
}

{
	const [, steps] = exampleIn("@Outside/Store")
	scenario(
		"outside-manifest",
		"a folder under a place the host names keeps its manifest in home's .ermine/external/<uuid>; the folder has nothing of ermine's, and the list of stores has it",
		[edit("mkdir", { path: "@Outside" }), ...steps, look("@Outside/Store", external), stores()],
	)
}

{
	const [m, steps] = exampleIn("@Outside/Store")
	scenario(
		"outside-links",
		"a link into .ermine/id/ is relative to the store's folder, outside as inside, and leads nowhere in both; loading finds the outside manifest by the folder's uuid",
		[
			edit("mkdir", { path: "@Outside" }),
			...steps,
			ask({ op: "graph" }),
			open({ folder: "@Outside/Store" }),
			read(),
			differences(),
			(m.write("c", "13:00"), write(m)),
			look("@Outside/Store", external),
			// the same, inside
			...exampleIn("@Inside")[1],
			look("@Inside"),
		],
	)
}

{
	const [, steps] = exampleIn("@Store")
	scenario(
		"stores-list-follows-move",
		"a folder moved or renamed is found by its uuid; the list of stores has its new path once it is loaded, and find leads to it; a store that is gone is not found",
		[
			...steps,
			stores(),
			edit("rename", { from: "@Store", to: "@Moved" }),
			open({ folder: "@Moved" }),
			read(),
			stores(),
			find("uuid"),
			find("no-such-uuid"),
			edit("remove", { path: "@Moved" }),
			find("uuid"),
			stores(),
		],
	)
}

for (const place of ["Inside", "Outside"]) {
	const where = place === "Outside" ? "@Outside/Store" : "@Store"
	const copy = place === "Outside" ? "@Outside/Copy" : "@Copy"
	const [, steps] = exampleIn(where)
	scenario(
		`copy-${place.toLowerCase()}`,
		`a copy of a store ${
			place === "Outside" ? "kept outside" : "kept inside"
		}, as Duplicate makes one, has a uuid of its own and an empty manifest; the original is as it was`,
		[
			...(place === "Outside" ? [edit("mkdir", { path: "@Outside" })] : []),
			...steps,
			edit("copy", { from: where, to: copy }),
			look(copy, where, external),
			// a host with no files program does not write into it
			open({ folder: copy }),
			read(),
			open({ folder: copy, files: true }),
			read(),
			differences(),
			look(copy, where, external),
			stores(),
			open({ folder: where }),
			read(),
			graph(),
			differences(),
		],
	)
}

scenario(
	"uuid-no-manifest",
	"a folder carrying a uuid and no manifest here, as iCloud brings one from another Mac, is a new store that keeps the uuid",
	[
		edit("mkdir", { path: "@Outside/Brought" }),
		edit("attr", {
			path: "@Outside/Brought",
			name: "party.chee.ermine.store",
			text: "from-another-mac",
		}),
		open({ folder: "@Outside/Brought" }),
		read(),
		look("@Outside/Brought", external),
		stores(),
	],
)

{
	const [m, steps] = exampleIn("@Store")
	scenario(
		"moved-into-and-out-of-outside",
		"a store's folder moved into a place the host names has its .ermine moved out when next loaded, and back in when it leaves; the graph is as it was and a batch after is laid as ever",
		[
			edit("mkdir", { path: "@Outside" }),
			...steps,
			look("@Store", external),
			edit("rename", { from: "@Store", to: "@Outside/Moved" }),
			open({ folder: "@Outside/Moved" }),
			read(),
			graph(),
			differences(),
			look("@Outside/Moved", external),
			stores(),
			edit("rename", { from: "@Outside/Moved", to: "@Back" }),
			open({ folder: "@Back" }),
			read(),
			graph(),
			(m.write("c", "13:00"), write(m)),
			look("@Back", external),
			stores(),
		],
	)
}

{
	const m = new Model()
	const steps: Step[] = []
	steps.push(open({ folder: "@Mirror", mirror: true }), readWith(m))
	for (
		const c of [
			() => m.write("r", "the document"),
			() => m.place("r", "apps", "a", { theme: "dark" }),
			() => m.place("a", "clock", "c", "12:00"),
			() => m.place("r", "docs", "d1", "hello"),
			() => m.place("r", "docs", "d2", PNG),
			() => m.place("r", "pinned", "d1"),
			() => m.place("r", "Notes", "x9"),
		]
	) {
		c()
		steps.push(write(m), observe())
	}
	// the host's time moves, nothing in the folder does
	m.time += 10
	steps.push(write(m), observe())
	scenario(
		"mirror-frames",
		"a mirror lays a node's subtree out as a store does: its manifest has only shown:* and store, no values/ folder, and each batch's time counts up from done, whatever the host's time is",
		steps,
	)
}

{
	const m = new Model()
	m.write("r", "the document")
	m.place("r", "a", "a", "one")
	scenario(
		"mirror-loads-again",
		"a mirror loaded again is given the graph the host has now: what changed while nothing ran is laid out, nothing is a difference, and the times go on counting",
		[
			open({ folder: "@Mirror", mirror: true }),
			readWith(m),
			write(m),
			open({ folder: "@Mirror", mirror: true }),
			readWith(m),
			differences(),
			open({ folder: "@Mirror", mirror: true }),
			(m.write("a", "two"), m.place("r", "b", "b", "new"), readWith(m)),
			observe(),
			(m.write("b", "newer"), write(m)),
			observe(),
		],
	)
}

{
	const m = new Model()
	m.place("r", "a", "a", "one")
	scenario(
		"mirror-refuses-records",
		"a mirror keeps no records of the host's, and no graph: a write that has some is refused and lays nothing",
		[
			open({ folder: "@Mirror", mirror: true }),
			readWith(m),
			write(m),
			(m.write("a", "two"), write(m, { records: { sync: "01" } })),
			observe(),
			write(m, { records: {} }),
			observe(),
		],
	)
}

{
	const m = new Model()
	m.place("r", "a", "a", "one")
	scenario(
		"mirror-others-entries",
		"a folder holding others' entries is a mirror only for a host running the files program; they are differences",
		[
			edit("mkdir", { path: "@Mirror" }),
			edit("write", { path: "@Mirror/mine.txt", text: "mine" }),
			open({ folder: "@Mirror", mirror: true }),
			readWith(m),
			open({ folder: "@Mirror", mirror: true, files: true }),
			readWith(m),
			write(m),
			differences(),
			observe(),
		],
	)
}

{
	const m = new Model()
	scenario(
		"mirror-outside",
		"a mirror in a place the host names keeps its manifest outside, as a store does: layout records and store only",
		[
			edit("mkdir", { path: "@Outside" }),
			open({ folder: "@Outside/Mirror", mirror: true }),
			readWith(m),
			(m.write("r", "doc"), m.place("r", "a", "a", "one"), write(m)),
			look("@Outside/Mirror", external),
			stores(),
		],
	)
}

/** A mirror's batch caught at its plan: the first frame the batch appends, which has the plan (no kept files: a mirror has none). */
async function catchingMirror(first: Saving, prior: Saving[], batch: Saving): Promise<Caught> {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-store-fix-" }))
	const folder = `${dir}/Mirror`
	const log = `${folder}/.ermine/manifest`
	let caught: Caught | undefined
	let armed = false
	const base = system()
	const sys: Sys = {
		...base,
		trash: () => Promise.reject(new Error("never the real Trash")),
		async sync(path) {
			await base.sync(path)
			if (path !== log || caught || !armed) return
			const all = await Deno.readFile(log)
			const view = new DataView(all.buffer)
			let at = 0, last = 0
			while (at + 4 <= all.length) last = at, at += 4 + view.getUint32(at)
			const f = cbor.decode(all.subarray(last + 4, at)) as Record<string, Uint8Array | null>
			if (!f.plan) return
			const inos = new Map<number, string>()
			const walk = (abs: string, path: string) => {
				const st = Deno.lstatSync(abs)
				if (!st.isDirectory) return
				inos.set(st.ino!, path)
				for (const e of Deno.readDirSync(abs)) {
					walk(`${abs}/${e.name}`, path === "" ? e.name : `${path}/${e.name}`)
				}
			}
			walk(folder, "")
			const records: Record<string, unknown> = {}
			for (const [k, v] of Object.entries(f)) {
				records[k] = v === null ? null : k === "plan" ? planOf(v, (n) => inos.get(n)!) : hex(v)
			}
			caught = { values: [], records }
		},
	}
	try {
		const t = mirror(folder, { sys, trash: fake(`${dir}/Trash`), home: `${dir}/Home` })
		await t.read(first)
		for (const s of prior) await t.write(s)
		armed = true
		await t.write(batch)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
	if (!caught) throw new Error("the batch had no plan")
	return caught
}

/** A mirror's crash scenario: prior batches, then the batch caught at its plan, then the edits a crash left; loaded again with the graph the host has. */
function mirrorCrash(
	name: string,
	title: string,
	build: (m: Model, commit: () => void) => { done?: Step[] },
) {
	const m = new Model()
	const first = m.saving()
	const start = readWith(m)
	const savings: Saving[] = []
	const requests: Step[] = []
	const plan = build(m, () => {
		savings.push(m.saving())
		requests.push(write(m))
	})
	const batch = m.saving()
	const final = readWith(m)
	const index = all.length
	all.push({ name, scenario: { title, steps: [] } })
	crashes.push((async () => {
		const c = await catchingMirror(first, savings, batch)
		const mirrored = { folder: "@Mirror", mirror: true }
		all[index].scenario.steps = [
			open(mirrored),
			start,
			...requests,
			observe(),
			edit("frame", { records: c.records }),
			...(plan.done ?? []),
			observe(),
			open(mirrored),
			final,
			observe(),
			differences(),
		]
	})())
}

mirrorCrash(
	"mirror-crash-plan-only",
	"a mirror's batch kept but not laid out (its plan frame only) is carried out again on loading, its values from the graph the host gives",
	(m, commit) => {
		m.write("r", "the document")
		m.place("r", "a", "a", "one")
		commit()
		m.write("a", "two")
		m.place("r", "b", "b", PNG)
		return {}
	},
)

mirrorCrash(
	"mirror-crash-tmp-written",
	"a mirror's batch whose new file waits in .ermine/tmp, not yet swapped in, is carried out again on loading",
	(m, commit) => {
		m.place("r", "a", "a", "one")
		commit()
		m.write("a", "two")
		return {
			done: [
				put(".ermine/tmp/2.1", "two"),
				edit("attr", { path: ".ermine/tmp/2.1", name: "party.chee.ermine.id", text: "a" }),
			],
		}
	},
)

mirrorCrash(
	"mirror-crash-swapped",
	"a mirror's batch crashed just after its swap: the new file in place, the old in .ermine/tmp; loading finishes it and the graph's value stands",
	(m, commit) => {
		m.place("r", "a", "a", "one")
		commit()
		m.write("a", "two")
		return {
			done: [
				edit("rename", { from: "a.txt", to: ".ermine/tmp/2.1" }),
				put("a.txt", "two"),
				edit("attr", { path: "a.txt", name: "party.chee.ermine.id", text: "a" }),
			],
		}
	},
)

{
	// a case-insensitive volume has new.md and New.md as one name: the rename must still land
	const m = new Model()
	const steps: Step[] = [open(), read()]
	m.place("r", "new.md", "n", "hello")
	m.place("r", "docs", "d", null)
	m.place("d", "a", "a", "one")
	steps.push(write(m), observe())
	m.unplace("r", "new.md", "n")
	m.place("r", "New.md", "n")
	steps.push(write(m), observe())
	m.unplace("r", "docs", "d")
	m.place("r", "Docs", "d")
	steps.push(write(m), observe(), open(), read(), differences())
	scenario(
		"case-rename",
		"a slot renamed only in case, a file's and a folder's: each is renamed in place, on a case-insensitive volume too",
		steps,
	)
}

// ---- write

/** JSON with tabs, -0 written -0, as form.ts's line writes it. */
function pretty(x: unknown): string {
	const MINUS = "\u0000-0\u0000"
	return JSON.stringify(x, (_, v) => (Object.is(v, -0) ? MINUS : v), "\t")
		.replaceAll(JSON.stringify(MINUS), "-0")
}

await Promise.all(crashes)
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
await Deno.mkdir(out, { recursive: true })
for (const [i, { name, scenario: s }] of all.entries()) {
	const got = await run(s, reference)
	const steps = s.steps.map((step, j) => ("edit" in step ? step : { ...step, expect: got[j] }))
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	await Deno.writeTextFile(
		new URL(file, out),
		pretty({ title: s.title, steps }) + "\n",
	)
}
console.log(`${all.length} scenarios written`)
