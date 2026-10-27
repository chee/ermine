// satisfy and openwith on a real scheduler, table and paths, in boxes made over a folder W
// (R/work), or over a new node of their own with W's clocks and loaders boxed in, from the host's
// places (root R, children alone); types installed at R/ermine/types
import { assertEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import type { Id, Key } from "@ermine/core/table"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/core/places/upsert"
import { createBox } from "@ermine/boxes"
import { createErmine } from "@ermine/system"
import {
	ATTRIBUTES as A,
	type Chain,
	openwith,
	type Options,
	type Place,
	type Reason,
	satisfy,
	type Step,
	type Way,
	type Why,
	type Whynot,
} from "./programs.ts"
import { conformance, installTypes, type Known, TYPES, typesAt } from "@ermine/types"

const C = "public.c-source"
const JS = "com.netscape.javascript-source"
const WASM = "public.wasm-executable"
const ARM = "party.chee.ermine.arm64-executable"

type Loader = {
	type?: string
	takes?: string[]
	gives?: string
	needs?: string[]
	provides?: string[]
	opens?: string[]
	loader?: string
}

function world() {
	const s = createScheduler()
	const over = createErmine({ scheduler: s, root: "R", info: { actor: "host" } })
	const { table, places } = over
	const watcher = s.createRootScope({ actor: "watcher" })
	const hosted = over.within
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, header())))
	const attrs = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("attributes", id, createEntry(v, header())))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry(v, header())))
	const put = (part: Key, id: Id, path: string[], v: unknown) =>
		hosted(() => commit(upsert(table, part, id, path, v, header())))
	// a node's attributes, by ATTRIBUTES' names
	const says = (id: Id, l: Loader) =>
		attrs(
			id,
			Object.fromEntries(Object.entries(l).map(([k, v]) => [A[k as keyof Loader], v])),
		)
	// a host runner: a live function, and what it says
	const hostRunner = (id: Id, l: Loader) => (value(id, () => {}), says(id, l))
	const types = (list?: Known[]) =>
		hosted(() => commit(installTypes(table, "R", header(), list, (p) => p.join("/"))))
	function watch<T>(f: () => T) {
		const w = { runs: 0, values: [] as T[] }
		s.runWithScope(
			watcher,
			() => s.createComputer(() => (w.runs++, f()), (v) => void w.values.push(v)),
		)
		return w
	}
	// R/work is W: its clocks CL with catclock.c (CAT, C source), its loaders L (a loaders folder);
	// R/ermine/types installed. the loaders, said (none placed)
	function tree() {
		kids("R", { work: "W" })
		types()
		kids("W", { clocks: "CL", loaders: "L" })
		kids("CL", { "catclock.c": "CAT" })
		attrs("L", { [A.loaders]: true })
		says("CAT", { type: C })
		says("SCLANG", { type: JS, takes: [C], gives: WASM, needs: ["javascript", "fetch"] })
		says("WCLANG", { type: WASM, takes: [C], gives: WASM, needs: ["wasm32"] })
		says("WASMRUN", { type: JS, takes: [WASM], provides: ["wasm32"], needs: ["javascript"] })
		hostRunner("PAGE", { takes: [JS], provides: ["javascript", "dom", "fetch"] })
	}
	// a box from W (own: a new empty node, W's clocks and loaders boxed in), the types
	// boxed in, and the things given boxed at their paths
	function web(items: Record<string, Id>, own = false) {
		const b = hosted(() => createBox(over, own ? undefined : { id: "W" }))
		if (own) hosted(() => (b.put(["clocks"], "CL"), b.put(["loaders"], "L")))
		hosted(() => {
			b.put(TYPES, TYPES.join("/"))
			for (const [path, id] of Object.entries(items)) b.put(path.split("/"), id)
		})
		return b
	}
	return {
		s,
		table,
		places,
		over,
		hosted,
		kids,
		attrs,
		value,
		put,
		says,
		hostRunner,
		types,
		watch,
		tree,
		web,
		header,
	}
}

const cat = { id: "CAT", at: ["clocks", "catclock.c"] }
const step = (id: Id, at: string, by: Step[] = []): Step => ({ id, at: at.split("/"), by })
const page = step("PAGE", "page")
const server = step("SCLANG", "clocks/clang", [page])
const wasm = step("WASMRUN", "loaders/wasm", [page])
const wclang = step("WCLANG", "loaders/clang", [wasm])
const not = (id: Id, at: string, f: Id, type: string, why: Reason, missing?: string[]): Why => ({
	id,
	at: at.split("/"),
	for: f,
	type,
	why,
	...(missing && { missing }),
})

// a search taken whole: its ways, and every whynot told, in order
function whole(search: (o: Options) => Iterable<Way>) {
	const why: Whynot[] = []
	const ways = [...search({ onwhynot: (w) => why.push(w) })]
	return { ways, why }
}
const ways = (program: Place, chains: Chain[]): Way[] => chains.map((chain) => ({ program, chain }))
const chains = (search: Iterable<Way>) => [...search].map((w) => w.chain)

const everyWeb = { "clocks/clang": "SCLANG", "loaders/clang": "WCLANG", "loaders/wasm": "WASMRUN" }

Deno.test("types: installed at R/ermine/types, conformance followed, and found from a box", () => {
	const w = world()
	w.tree()
	const t = typesAt(w.places, ["work", "clocks"])
	assertEquals(t, { id: "ermine/types", path: ["ermine", "types"] })
	assertEquals(conformance(w.places, t, C), {
		known: true,
		all: [
			C,
			"public.source-code",
			"public.plain-text",
			"public.text",
			"public.data",
			"public.content",
			"public.item",
		],
	})
	assertEquals(conformance(w.places, t, "party.chee.ermine.nope"), {
		known: false,
		all: ["party.chee.ermine.nope"],
	})
	// a box sees none but what is boxed
	const bare = createBox(w.over, { id: "W" })
	assertEquals(typesAt(bare.places, ["clocks"]), undefined)
	const b = w.web({})
	assertEquals(typesAt(b.places, ["clocks"]), { id: "ermine/types", path: ["ermine", "types"] })
	// installed again: nothing changed
	const before = JSON.stringify(w.table.get("children", "ermine/types")?.value)
	const again = w.hosted(() =>
		installTypes(w.table, "R", w.header(), undefined, (p) => p.join("/"))
	)
	assertEquals(again, [])
	assertEquals(JSON.stringify(w.table.get("children", "ermine/types")?.value), before)
	// one more, into the folder there
	w.types([{ name: "party.chee.ermine.clockface", conformsTo: "public.json" }])
	assertEquals(
		conformance(w.places, t, "party.chee.ermine.clockface").all.slice(0, 3),
		["party.chee.ermine.clockface", "public.json", "public.text"],
	)
})

Deno.test("web: catclock.c two ways, nearest first: server clang (run by the page), wasm clang (run by the wasm runner, on the page)", () => {
	const w = world()
	w.tree()
	const b = w.web({ ...everyWeb, page: "PAGE" })
	assertEquals(whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o)), {
		ways: ways(cat, [[server, wasm], [wclang, wasm]]),
		why: [
			not("SCLANG", "clocks/clang", "SCLANG", JS, "wrong-type"),
			not("PAGE", "page", "CAT", C, "wrong-type"),
			not("WASMRUN", "loaders/wasm", "CAT", C, "wrong-type"),
			not("SCLANG", "clocks/clang", "WCLANG", WASM, "wrong-type"),
			not("PAGE", "page", "WCLANG", WASM, "wrong-type"),
			not("SCLANG", "clocks/clang", "WASMRUN", JS, "wrong-type"),
			not("SCLANG", "clocks/clang", "CAT", WASM, "wrong-type"),
			not("PAGE", "page", "CAT", WASM, "wrong-type"),
			not("WCLANG", "loaders/clang", "CAT", WASM, "wrong-type"),
		],
	})
	// the same from the box's "/", by a path with a name in it
	assertEquals(chains(satisfy(b.places, "clocks/catclock.c", [])), [[server, wasm], [
		wclang,
		wasm,
	]])
})

Deno.test("ermineOS: catclock.c in another box over the same folder: native clang, run by exec", () => {
	const w = world()
	w.tree()
	w.says("NCLANG", { type: ARM, takes: [C], gives: ARM })
	w.hostRunner("EXEC", { takes: [ARM], provides: ["arm64", "posix"] })
	const os = w.web({ "loaders/clang": "NCLANG", exec: "EXEC" })
	const exec = step("EXEC", "exec")
	assertEquals(whole((o) => satisfy(os.places, "catclock.c", ["clocks"], o)), {
		ways: ways(cat, [[step("NCLANG", "loaders/clang", [exec]), exec]]),
		why: [
			not("EXEC", "exec", "CAT", C, "wrong-type"),
			not("NCLANG", "loaders/clang", "CAT", ARM, "wrong-type"),
		],
	})
})

Deno.test("worker: server clang still fits; a runner needing dom does not, and why says so", () => {
	const w = world()
	w.tree()
	w.hostRunner("WORKER", { takes: [JS], provides: ["javascript", "fetch"] })
	w.says("CANVAS", {
		type: JS,
		takes: [WASM],
		provides: ["wasm32", "canvas"],
		needs: ["javascript", "dom"],
	})
	const b = w.web({
		"clocks/clang": "SCLANG",
		"loaders/wasm": "WASMRUN",
		"loaders/canvas": "CANVAS",
		worker: "WORKER",
	})
	const worker = step("WORKER", "worker")
	const found = whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o))
	assertEquals(found.ways.map((w) => w.chain), [[
		step("SCLANG", "clocks/clang", [worker]),
		step("WASMRUN", "loaders/wasm", [worker]),
	]])
	assertEquals(found.why.filter((x) => x.why !== "wrong-type"), [
		not("WORKER", "worker", "CANVAS", JS, "needs", ["dom"]),
		not("CANVAS", "loaders/canvas", "CAT", WASM, "no-chain"),
	])
})

Deno.test("no whole chain: nothing yielded; every candidate's why, then the program's no-chain", () => {
	const w = world()
	w.tree()
	const b = w.web({ "clocks/clang": "SCLANG", "loaders/clang": "WCLANG", page: "PAGE" })
	assertEquals(whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o)), {
		ways: [],
		why: [
			not("SCLANG", "clocks/clang", "SCLANG", JS, "wrong-type"),
			not("PAGE", "page", "CAT", C, "wrong-type"),
			not("SCLANG", "clocks/clang", "WCLANG", WASM, "wrong-type"),
			not("PAGE", "page", "WCLANG", WASM, "wrong-type"),
			not("WCLANG", "loaders/clang", "WCLANG", WASM, "wrong-type"),
			not("WCLANG", "loaders/clang", "CAT", C, "no-chain"),
			not("SCLANG", "clocks/clang", "CAT", WASM, "wrong-type"),
			not("PAGE", "page", "CAT", WASM, "wrong-type"),
			not("WCLANG", "loaders/clang", "CAT", WASM, "wrong-type"),
			not("SCLANG", "clocks/clang", "CAT", C, "no-chain"),
			{ why: "no-chain", id: "CAT", at: cat.at },
		],
	})
	// the program's name finding nothing; no type; a host function runs itself
	assertEquals(whole((o) => satisfy(b.places, "dogclock.c", ["clocks"], o)), {
		ways: [],
		why: [{ why: "nothing-there", path: "dogclock.c", from: ["clocks"] }],
	})
	w.kids("CL", { "catclock.c": "CAT", "notes.xyz": "NOTES", "now": "NOW" })
	w.value("NOW", () => {})
	assertEquals(whole((o) => satisfy(b.places, "notes.xyz", ["clocks"], o)), {
		ways: [],
		why: [{ why: "no-type", id: "NOTES", at: ["clocks", "notes.xyz"] }],
	})
	assertEquals(whole((o) => satisfy(b.places, "now", ["clocks"], o)), {
		ways: [{ program: { id: "NOW", at: ["clocks", "now"] }, chain: [] }],
		why: [],
	})
	// no onwhynot: nothing yielded, and nothing else
	assertEquals([...satisfy(b.places, "dogclock.c", ["clocks"])], [])
})

Deno.test("a type missing from ermine/types: unknown-type; installed, it fits", () => {
	const w = world()
	w.tree()
	w.kids("CL", { "catclock.c": "CAT", "face.clock": "FACE" })
	w.says("FACE", { type: "party.chee.ermine.clockface" })
	w.hostRunner("JSON", { takes: ["public.json"] })
	w.kids("R", { work: "W", ermine: "ermine", json: "JSON" })
	const face = { id: "FACE", at: ["work", "clocks", "face.clock"] }
	const ran = w.watch(() => whole((o) => satisfy(w.places, "face.clock", ["work", "clocks"], o)))
	w.s.pulse()
	assertEquals(ran.values, [{
		ways: [],
		why: [{
			id: "JSON",
			at: ["json"],
			for: "FACE",
			type: "party.chee.ermine.clockface",
			why: "unknown-type",
		}, { why: "no-chain", ...face }],
	}])
	w.types([{ name: "party.chee.ermine.clockface", conformsTo: "public.json" }])
	w.s.pulse()
	assertEquals(ran.runs, 2)
	assertEquals(ran.values[1], {
		ways: ways(face, [[{ id: "JSON", at: ["json"], by: [] }]]),
		why: [],
	})
})

Deno.test("a pin is tried first: the wasm clang over the nearer server clang; a pin finding nothing is refused", () => {
	const w = world()
	w.tree()
	const b = w.web({ ...everyWeb, page: "PAGE" })
	w.says("CAT", { type: C, loader: "loaders/clang" })
	assertEquals(chains(satisfy(b.places, "catclock.c", ["clocks"])), [[wclang, wasm], [
		server,
		wasm,
	]])
	w.says("CAT", { type: C, loader: "./clang" })
	assertEquals(chains(satisfy(b.places, "catclock.c", ["clocks"])), [[server, wasm], [
		wclang,
		wasm,
	]])
	// a pin that does not fit: looked at first, and the others still
	w.says("CAT", { type: C, loader: "/page" })
	const page1 = whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o))
	assertEquals(page1.ways.map((w) => w.chain), [[server, wasm], [wclang, wasm]])
	assertEquals(page1.why[0], not("PAGE", "page", "CAT", C, "wrong-type"))
	// a pin finding nothing: told from the program's folder, nothing yielded
	w.says("CAT", { type: C, loader: "loaders/gcc" })
	assertEquals(whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o)), {
		ways: [],
		why: [{ why: "nothing-there", path: "loaders/gcc", from: ["clocks"] }],
	})
})

Deno.test("never down: a folder not marked is never entered; marked, its children are candidates in its place", () => {
	const w = world()
	w.tree()
	w.kids("W", { clocks: "CL", loaders: "L", tools: "T" })
	w.kids("T", { clang: "SCLANG", more: "M" })
	w.kids("M", { wasm: "WASMRUN" })
	const b = w.web({ page: "PAGE" })
	assertEquals(whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o)), {
		ways: [],
		why: [not("PAGE", "page", "CAT", C, "wrong-type"), { why: "no-chain", ...cat }],
	})
	// tools marked: its clang a candidate; tools/more is not marked, never entered
	w.attrs("T", { [A.loaders]: true })
	const found = whole((o) => satisfy(b.places, "catclock.c", ["clocks"], o))
	assertEquals(found.ways, [])
	assertEquals(
		found.why.filter((x) => "for" in x && x.for === "CAT" && x.type === C),
		[
			not("PAGE", "page", "CAT", C, "wrong-type"),
			not("SCLANG", "tools/clang", "CAT", C, "no-chain"),
		],
	)
	// more marked too: its wasm runner, in its place inside tools
	w.attrs("M", { [A.loaders]: true })
	assertEquals(chains(satisfy(b.places, "catclock.c", ["clocks"])), [[
		step("SCLANG", "tools/clang", [page]),
		step("WASMRUN", "tools/more/wasm", [page]),
	]])
})

Deno.test("no node twice: a runner that would run itself, and compilers that would loop", () => {
	const w = world()
	w.tree()
	w.kids("CL", { "catclock.c": "CAT", "clock.js": "CLOCK" })
	w.says("CLOCK", { type: JS })
	w.says("SELF", { type: JS, takes: [JS], provides: ["javascript"] })
	const b = w.web({ self: "SELF" })
	const clock = { id: "CLOCK", at: ["clocks", "clock.js"] }
	assertEquals(whole((o) => satisfy(b.places, "clock.js", ["clocks"], o)), {
		ways: [],
		why: [
			not("SELF", "self", "SELF", JS, "in-the-chain"),
			not("SELF", "self", "CLOCK", JS, "no-chain"),
			{ why: "no-chain", ...clock },
		],
	})
	// js to wasm to js to ...: each once in a chain, no runner: no chain
	w.hostRunner("J2W", { takes: [JS], gives: WASM })
	w.hostRunner("W2J", { takes: [WASM], gives: JS })
	const loop = w.web({ j2w: "J2W", w2j: "W2J" }, true)
	assertEquals(whole((o) => satisfy(loop.places, "clock.js", ["clocks"], o)), {
		ways: [],
		why: [
			not("W2J", "w2j", "CLOCK", JS, "wrong-type"),
			not("J2W", "j2w", "CLOCK", WASM, "wrong-type"),
			not("J2W", "j2w", "CLOCK", JS, "in-the-chain"),
			not("W2J", "w2j", "CLOCK", WASM, "no-chain"),
			not("J2W", "j2w", "CLOCK", JS, "no-chain"),
			{ why: "no-chain", ...clock },
		],
	})
})

Deno.test("no bound: a long chain is found whole", () => {
	const n = 40
	const w = world()
	w.tree()
	const t = (i: number) => `party.chee.ermine.t${i}`
	w.kids("CL", { p: "P" })
	w.says("P", { type: t(0) })
	const items: Record<string, Id> = {}
	for (let i = 0; i < n; i++) {
		w.hostRunner(`C${i}`, { takes: [t(i)], gives: t(i + 1) })
		items[`c${i}`] = `C${i}`
	}
	w.hostRunner("RUN", { takes: [t(n)] })
	items.run = "RUN"
	const b = w.web(items)
	const [first] = satisfy(b.places, "p", ["clocks"])
	assertEquals(first.chain.length, n + 1)
})

Deno.test("openwith: every way to open a file, by conformance, nearest first; an opener with two chains twice", () => {
	const w = world()
	w.tree()
	w.says("TEXT", { type: JS, opens: ["public.plain-text"], needs: ["javascript", "dom"] })
	w.says("IMAGE", { type: JS, opens: ["public.image"] })
	w.says("HEX", { type: C, opens: ["public.data"] })
	w.says("GPU", { type: JS, opens: ["public.text"], needs: ["webgpu"] })
	const b = w.web({
		...everyWeb,
		page: "PAGE",
		text: "TEXT",
		image: "IMAGE",
		hex: "HEX",
		gpu: "GPU",
	})
	const hex = { id: "HEX", at: ["hex"] }
	assertEquals(whole((o) => openwith(b.places, "CAT", ["clocks"], o)), {
		ways: [
			{ program: hex, chain: [server, wasm] },
			{ program: hex, chain: [wclang, wasm] },
			{ program: { id: "TEXT", at: ["text"] }, chain: [page] },
		],
		why: [
			not("SCLANG", "clocks/clang", "GPU", JS, "wrong-type"),
			not("PAGE", "page", "GPU", JS, "needs", ["webgpu"]),
			not("WASMRUN", "loaders/wasm", "GPU", JS, "wrong-type"),
			not("WCLANG", "loaders/clang", "GPU", JS, "wrong-type"),
			not("GPU", "gpu", "CAT", C, "no-chain"),
			not("SCLANG", "clocks/clang", "SCLANG", JS, "wrong-type"),
			not("PAGE", "page", "HEX", C, "wrong-type"),
			not("WASMRUN", "loaders/wasm", "HEX", C, "wrong-type"),
			not("SCLANG", "clocks/clang", "WCLANG", WASM, "wrong-type"),
			not("PAGE", "page", "WCLANG", WASM, "wrong-type"),
			not("SCLANG", "clocks/clang", "WASMRUN", JS, "wrong-type"),
			not("SCLANG", "clocks/clang", "HEX", WASM, "wrong-type"),
			not("PAGE", "page", "HEX", WASM, "wrong-type"),
			not("WCLANG", "loaders/clang", "HEX", WASM, "wrong-type"),
			not("SCLANG", "clocks/clang", "TEXT", JS, "wrong-type"),
			not("WASMRUN", "loaders/wasm", "TEXT", JS, "wrong-type"),
			not("WCLANG", "loaders/clang", "TEXT", JS, "wrong-type"),
			not("IMAGE", "image", "CAT", C, "wrong-type"),
			// gpu (before hex: canonical CBOR's order): nothing provides webgpu
			// hex's chains, as satisfy's
			// text: every chain looked for, the page's the one
		],
	})
	// the ways alone, without onwhynot
	assertEquals([...openwith(b.places, "CAT", ["clocks"])].map((w) => w.program.id), [
		"HEX",
		"HEX",
		"TEXT",
	])
	// a file with no type: told, nothing yielded
	assertEquals(whole((o) => openwith(b.places, "NOTES", ["clocks"], o)), {
		ways: [],
		why: [{ why: "no-type", id: "NOTES" }],
	})
})

Deno.test("tracked: a nearer loader boxed reorders the chains; only writes satisfy read rerun it", () => {
	const w = world()
	w.tree()
	w.kids("W", { clocks: "CL", loaders: "L", fonts: "F" })
	w.attrs("OTHER", { [A.takes]: [C] })
	const b = w.web({
		"loaders/server": "SCLANG",
		"loaders/clang": "WCLANG",
		"loaders/wasm": "WASMRUN",
		page: "PAGE",
	})
	const ran = w.watch(() => chains(satisfy(b.places, "catclock.c", ["clocks"])))
	const last = () => ran.values[ran.values.length - 1]
	w.s.pulse()
	assertEquals(ran.runs, 1)
	const far = step("SCLANG", "loaders/server", [page])
	assertEquals(last(), [[wclang, wasm], [far, wasm]])
	// not read: another node's attributes, a folder's children off the walk, the program's value,
	// an attribute not named here, a type's mimeType
	w.attrs("OTHER", { [A.takes]: [JS] })
	w.kids("F", { sans: "SANS" })
	w.value("CAT", "int main() {}")
	w.put("attributes", "WCLANG", ["ermine.programs.compiler"], { name: "clang", version: "19" })
	w.put("value", `ermine/types/${C}`, ["mimeType"], ["text/x-c"])
	w.s.pulse()
	assertEquals(ran.runs, 1)
	// the server clang boxed nearer: first
	w.hosted(() => b.put(["clocks", "clang"], "SCLANG"))
	w.s.pulse()
	assertEquals(ran.runs, 2)
	assertEquals(last(), [[server, wasm], [wclang, wasm]])
	w.hosted(() => b.take(["clocks", "clang"]))
	w.s.pulse()
	assertEquals(ran.runs, 3)
	assertEquals(last(), [[wclang, wasm], [far, wasm]])
	// read: a loader's needs written
	w.put("attributes", "WCLANG", [A.needs], ["wasm64"])
	w.s.pulse()
	assertEquals(ran.runs, 4)
	assertEquals(last(), [[far, wasm]])
})

Deno.test("lazy: the first way taken, the search goes no further; a level it never read reruns nothing", () => {
	const w = world()
	w.tree()
	w.hostRunner("CC", { takes: [C] })
	w.hostRunner("TCC", { takes: [C] })
	const b = w.web({ "clocks/cc": "CC", page: "PAGE" })
	const cc = step("CC", "clocks/cc")
	const first = w.watch(() => {
		for (const way of satisfy(b.places, "catclock.c", ["clocks"])) return way.chain
	})
	const all = w.watch(() => chains(satisfy(b.places, "catclock.c", ["clocks"])))
	// made, never iterated: nothing read
	const none = w.watch(() => (satisfy(b.places, "catclock.c", ["clocks"]), 0))
	w.s.pulse()
	assertEquals(first.values, [[cc]])
	assertEquals(all.values, [[[cc]]])
	// another runner at "/": a level only the whole search read
	w.hosted(() => b.put(["tcc"], "TCC"))
	w.s.pulse()
	assertEquals([first.runs, all.runs, none.runs], [1, 2, 1])
	assertEquals(all.values[1], [[cc], [step("TCC", "tcc")]])
	// the first's runner unboxed: it reruns, now reading "/"
	w.hosted(() => b.take(["clocks", "cc"]))
	w.s.pulse()
	assertEquals([first.runs, all.runs, none.runs], [2, 3, 1])
	assertEquals(first.values[1], [step("TCC", "tcc")])
})
