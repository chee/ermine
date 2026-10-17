// the process api on a real scheduler, table, places, boxes and programs: javascript programs in a
// folder W, run by a host runner RUN (apis.run) boxed at /run, each started in W's box
import {
	assert,
	assertEquals,
	assertInstanceOf,
	assertStrictEquals,
	assertThrows,
} from "@std/assert"
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createPlaces } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { type Read, RUN, type Run } from "@ermine/places/runs"
import { box, createBox } from "@ermine/boxes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createBuilds } from "@ermine/build"
import { satisfy } from "@ermine/programs"
import { createPrograms, type Process, type Programs } from "@ermine/programs/start"
import { no, type Policy, yes } from "@ermine/protect"
import { Refusal } from "@ermine/places/guard"
import type { World } from "@ermine/presence"
import { createOverlay, type Overlay } from "@ermine/patch-nodes"
import { createSites } from "@ermine/sites"
import { type API, createProcessAPIs, type Noticed, SendError, uuidv7 } from "./api.ts"

const JS = "com.netscape.javascript-source"
const tick = () => new Promise((r) => setTimeout(r, 0))

function world(o: { may?: Policy; presence?: boolean; overlay?: boolean; sites?: boolean } = {}) {
	const s = createScheduler()
	const table = createTable((part, id) =>
		overlay ? overlay.onTableChange(part as Key, id) : places.onTableChange(part as Key, id)
	)
	const overlay: Overlay | undefined = o.overlay ? createOverlay(table, () => places) : undefined
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table: overlay ?? table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope([["actor", "host"]])
	const above = s.createScope([["role", "programs"]], host)
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) =>
		overlay ? overlay.commit(changed) : places.commit(changed)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	let now = 1000
	const presence: World | undefined = o.presence
		? {
			table,
			places: { commit, readValue: places.readValue },
			scheduler: s,
			scope: host,
			now: () => now,
		}
		: undefined
	let programs!: Programs
	// sites: the api, start and the scheduler are ours, so a site is the program's line
	const sites = o.sites
		? createSites(s, {
			ours: [
				new URL("./api.ts", import.meta.url).href,
				import.meta.resolve("@ermine/programs/start"),
				import.meta.resolve("@ermine/processes/start"),
				import.meta.resolve("@ermine/scheduler"),
			],
		})
		: undefined
	const noticed: Noticed[] = []
	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => programs,
		may: o.may,
		presence,
		who: "laptop",
		overlay,
		sites,
		notice: (made) => void noticed.push(made),
		scopes,
	})
	put("children", "W", { lib: "LIB" })
	put("children", "LIB", {})
	put("value", "RUN", apis.run)
	put("attributes", "RUN", { "ermine.programs.takes": [JS] })
	const b = createBox({ places, table, scheduler: s, commit }, { id: "W" })
	hosted(() => box(b, ["run"], "RUN", header()))
	programs = s.runWithScope(above, () => {
		const writes = { readValue: places.readValue, commit }
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "CACHE" })
		return createPrograms({ // where the programs are made
			scheduler: s,
			table,
			places: writes,
			builds,
			scopes,
			createProcessAPI: apis.createProcessAPI,
			sites,
		})
	})
	// a javascript program at name in W (or a folder in W), attributes beside its type
	const program = (
		name: string,
		setup: (api: API) => unknown,
		attributes: Record<string, unknown> = {},
		folder: Id = "W",
	) =>
		hosted(() => {
			const id = `prog:${name}`
			table.sub("value", id, createEntry<unknown>(setup, header()))
			table.sub("attributes", id, createEntry({ "ermine.type": JS, ...attributes }, header()))
			const w = table.get("children", folder)!
			update(w, [{ path: [name], value: id }], header())
			commit([w])
		})
	const start = (name: string, at: string[]): Process => {
		for (const way of satisfy(b.places, name, [])) {
			const p = hosted(() => programs.start(b, way, at)) // where start is called
			if ("refused" in p) throw new Error(p.refused)
			s.pulse()
			return p
		}
		throw new Error(`no way for ${name}`)
	}
	const inW = (name: string) => (table.get("children", "W")?.value as Record<string, Id>)[name]
	const later = (ms: number) => (now += ms)
	return { s, table, b, apis, program, start, inW, put, hosted, later, sites, noticed }
}

Deno.test("open makes once; edit takes a recipe or patches; a write from outside needs no method, and pulses by itself", async () => {
	const w = world()
	const seen: unknown[] = []
	let api!: API
	w.program("clock.js", (a) => {
		api = a
		const notes = a.open("./notes", { a: 1 })
		a.open("./notes", { a: 99 })
		const n = a.memo("n", () => a.read(notes, ["a"]))
		a.effect("seen", () => a.read(n), (v) => void seen.push(v))
		a.edit(notes, (d: { a: number }) => void d.a++)
		return "ticking"
	})
	const p = w.start("clock.js", ["clock"])
	await tick()
	assertEquals(seen, [2])
	// ./notes is in the folder the process is in: W
	assertEquals(w.table.get("value", w.inW("notes"))?.value, { a: 2 })
	// setup's return: the process's value
	assertEquals(w.table.get("value", p.id)?.value, "ticking")
	api.edit("./notes", [{ path: ["a"], value: 5 }])
	assertEquals(api.read("./notes"), { a: 5 })
	await tick()
	assertEquals(seen, [2, 5])
	api.edit("./notes", () => "whole")
	await tick()
	assertEquals(api.read("./notes"), "whole")
})

Deno.test("a memo's node holds its latest run: what it read, with the change it saw, and wrote; an effect's, its act's writes", async () => {
	const w = world()
	w.program("runs.js", (a) => {
		const notes = a.open("./notes", { a: 1 })
		const out = a.open("./out", 0)
		const n = a.memo("n", () => a.read(notes, ["a"]))
		a.effect("copy", () => a.read(n), (v) => a.edit(out, [{ path: [], value: v }]))
	})
	w.start("runs.js", ["runs"])
	await tick()
	const [memo, effect] = w.noticed
	const run = w.table.get("attributes", memo.id)?.value?.[RUN] as Run
	assertEquals([run.n, run.end], [1, "done"])
	const notes = w.inW("notes")
	const named = run.reads.filter((r): r is Exclude<Read, { key: unknown }> => !("key" in r))
	const read = named.find((r) => r.id === notes)!
	assertEquals([read.part, read.path], ["value", ["a"]])
	assertStrictEquals(read.change, w.table.get("value", notes)!.change)
	// its result, written to its own node by its set
	assertEquals(run.writes.map((x) => [x.part, x.id]), [["value", memo.id]])
	const acted = w.table.get("attributes", effect.id)?.value?.[RUN] as Run
	const out = w.inW("out")
	assertEquals(acted.writes.map((x) => [x.part, x.id]), [["value", effect.id], ["value", out]])
})

Deno.test("a bare name is inside the process: reached through its path, gone at its stop; teardown is told why", async () => {
	const w = world()
	const whys: string[] = []
	const xs: unknown[] = []
	const setup = (a: API) => {
		a.open("scratch", { x: 1 })
		a.teardown((why) => void whys.push(why))
		a.effect("peek", () => a.read("scratch", ["x"]), (x) => void xs.push(x))
	}
	w.program("scratch.js", setup)
	const p = w.start("scratch.js", ["s"])
	await tick()
	assertEquals(xs, [1])
	assert(get(w.b.places, ["s", "scratch"]) !== undefined)
	assertEquals(w.inW("scratch"), undefined)
	w.apis.stop(p, "replaced")
	assertEquals(whys, ["replaced"])
	assertEquals(get(w.b.places, ["s", "scratch"]), undefined)
	const q = w.start("scratch.js", ["s"])
	await tick()
	w.apis.stop(q)
	assertEquals(whys, ["replaced", "ended"])
})

Deno.test("a teardown under a computer is told replaced as it runs again", async () => {
	const w = world()
	const whys: string[] = []
	let api!: API
	w.program("again.js", (a) => {
		api = a
		const n = a.open("./n", 1)
		a.effect("tear", () => a.read(n), () => a.teardown((why) => void whys.push(why)))
	})
	w.start("again.js", ["again"])
	await tick()
	api.edit("./n", () => 2)
	await tick()
	assertEquals(whys, ["replaced"])
})

Deno.test("method and send: the method's return given back, the caller on the change", async () => {
	const w = world()
	let caller!: API
	w.program("greeter.js", (a) => {
		const last = a.open("./last", "nobody")
		a.method("on/greet", (name: string) => {
			a.edit(last, () => name)
			return `hi ${name}`
		})
	})
	w.program("caller.js", (a) => void (caller = a))
	w.start("greeter.js", ["greeter"])
	const c = w.start("caller.js", ["caller"])
	await tick()
	assertEquals(caller.send("./greeter/on/greet", "frog"), "hi frog")
	assertEquals(caller.read("./last"), "frog")
	const change = w.table.get("value", w.inW("last"))!.change
	assert(change.metadata?.some(([k, v]) => k === "caller" && v === c.id))
	assertInstanceOf(assertThrows(() => caller.send("./last")), SendError)
})

Deno.test("an async memo: its readers pending (PENDING) till it lands, and it lands with no pulse by hand", async () => {
	const w = world()
	const seen: unknown[] = []
	let resolve!: (v: number) => void
	w.program("slow.js", (a) => {
		const m = a.memo("m", () => new Promise<number>((r) => (resolve = r)))
		a.effect("seen", () => a.read(m), (v) => void seen.push(v))
	})
	w.start("slow.js", ["slow"])
	await tick()
	assertEquals(seen, [])
	resolve(7)
	await tick()
	await tick()
	assertEquals(seen, [7])
})

Deno.test("info, entries, list, create, place, move, unplace, remove, ref", async () => {
	const w = world()
	let api!: API
	w.program("files.js", (a) => void (api = a))
	w.start("files.js", ["files"])
	await tick()
	const notes = api.open("./notes", "hello")
	api.edit(
		api.info(notes),
		(d: Record<string, unknown>) => void (d["ermine.type"] = "public.plain-text"),
	)
	assertEquals(api.read(api.info(notes), ["ermine.type"]), "public.plain-text")
	assertEquals(api.entries("./nothing"), [])
	assertEquals(api.read("./nothing"), undefined)
	assertEquals(api.entries(notes).map((e) => [e.value, e.from]), [["hello", "children"]])
	const card = api.create("./cards", { text: "a" })
	const name = card.path![card.path!.length - 1]
	assertEquals(api.list("./cards"), [name])
	api.place("./cards/pinned", card)
	assertEquals(api.read("./cards/pinned"), { text: "a" })
	api.move("./cards/pinned", "./cards/top")
	assertEquals(api.list("./cards").sort(), [name, "top"].sort())
	api.unplace("./cards/top")
	assertEquals(api.read(card), { text: "a" })
	api.remove(card)
	assertEquals(api.list("./cards"), [])
	assert(api.list("./").includes("notes"))
	const r = api.ref("audio", () => ({ live: 1 }))
	const again = api.ref("audio", () => ({ live: 2 }))
	assertStrictEquals(api.read(r), api.read(again))
	assertEquals(api.read(r), { live: 1 })
})

Deno.test("watch is told each write at the node, as it lands", async () => {
	const w = world()
	let api!: API
	w.program("watcher.js", (a) => void (api = a))
	w.start("watcher.js", ["watcher"])
	await tick()
	const box = api.open("./mailbox", [] as string[])
	const got: unknown[] = []
	api.watch(box, (x) => void got.push(x.patches))
	api.edit(box, (d: string[]) => void d.push("owl"))
	api.edit(box, (d: string[]) => void d.push("frog"))
	assertEquals(got.length, 2)
	assertEquals(api.read(box), ["owl", "frog"])
})

Deno.test("start by name from a program, refused with its whynots, and stopped with the one that started it", async () => {
	const w = world()
	const whys: string[] = []
	const started: unknown[] = []
	w.program("kid.js", (a) => void a.teardown((why) => void whys.push(why)))
	w.program("parent.js", (a) => {
		started.push(a.start("kid.js", "./kid"))
		started.push(a.start("nope.js", "./nope"))
	})
	const p = w.start("parent.js", ["parent"])
	await tick()
	const [kid, nope] = started as [Process, { refused: string; why: unknown[] }]
	assert(get(w.b.places, ["kid"]) === kid.id)
	assertEquals(nope.refused, "no-way")
	assert(nope.why.length > 0)
	w.apis.stop(p)
	assertEquals(whys, ["ended"])
	assertEquals(get(w.b.places, ["kid"]), undefined)
})

Deno.test("openwith: the ways to open a node, from the process's place", async () => {
	const w = world()
	let api!: API
	w.program("viewer.js", () => {}, { "ermine.programs.opens": ["public.plain-text"] })
	w.program("files.js", (a) => void (api = a))
	w.start("files.js", ["files"])
	await tick()
	const notes = api.open("./notes", "hello")
	api.edit(api.info(notes), () => ({ "ermine.type": "public.plain-text" }))
	const ways = [...api.openwith(notes)]
	assertEquals(ways.map((x) => x.program.at), [["viewer.js"]])
})

Deno.test("box: a child in a box of a folder, seeing only what is boxed into it", async () => {
	const w = world()
	let child!: API
	w.program("inside.js", (a) => void (child = a), {}, "LIB")
	w.program("boxer.js", (a) => {
		const b = a.box("./lib")
		b.place("run", "./run")
		const p = a.start("inside.js", "k", { box: b, args: ["hehe.txt"] })
		assert(!("refused" in p))
	})
	w.start("boxer.js", ["boxer"])
	await tick()
	assertEquals(child.args, ["hehe.txt"])
	// its "/" is lib: W's own names are not there
	assertEquals(child.read("/lib"), undefined)
	assert(child.list("/").includes("inside.js"))
})

Deno.test("protect: a policy's no refuses a read (Refusal) and a write; a list keeps a refused item, its id REFUSED", async () => {
	const may: Policy = (ask) => {
		const path = ask.target.path?.join("/")
		if (ask.op === "edit" && path === "secret") return no("not yours")
		if (ask.op === "read" && path === "hidden") return no("hidden")
		return yes
	}
	const w = world({ may })
	let api!: API
	w.program("files.js", (a) => void (api = a))
	w.start("files.js", ["files"])
	await tick()
	api.open("./secret", 1)
	api.open("./hidden", 2)
	api.open("./open", 3)
	assertInstanceOf(assertThrows(() => api.edit("./secret", () => 9)), Refusal)
	assertEquals(api.read("./secret"), 1)
	assertInstanceOf(assertThrows(() => api.read("./hidden")), Refusal)
	assertEquals(api.entries("./hidden").map((e) => [e.id === api.REFUSED, e.value]), [[
		true,
		undefined,
	]])
	api.edit("./open", () => 4)
	assertEquals(api.read("./open"), 4)
})

Deno.test("presence: my row at a node, read live by a computation, gone when I am absent", async () => {
	const w = world({ presence: true })
	let api!: API
	const seen: unknown[] = []
	w.program("cursor.js", (a) => {
		api = a
		const doc = a.open("./doc", "hello")
		a.effect(
			"rows",
			() => a.presence(doc).map((r) => [r.who, r.value]),
			(rows) => void seen.push(rows),
		)
	})
	w.start("cursor.js", ["cursor"])
	await tick()
	api.present("./doc", { at: 3 })
	await tick()
	api.absent("./doc")
	await tick()
	assertEquals(seen, [[], [["laptop", { at: 3 }]], []])
})

Deno.test("patch nodes: one over another node, read through the overlay, its layers, landed for real", async () => {
	const w = world({ overlay: true })
	let api!: API
	w.program("skins.js", (a) => void (api = a))
	w.start("skins.js", ["skins"])
	await tick()
	const face = api.open("./face", { accent: "red", n: 1 })
	const skin = api.patch("cherry", face, (d: { accent: string }) => void (d.accent = "cherry"))
	assertEquals(api.read(face), { accent: "cherry", n: 1 })
	const layers = api.layers(face, ["accent"])
	assertEquals(layers.map((l) => l.value), ["cherry", "red"])
	assertEquals(w.table.get("value", w.inW("face"))?.value, { accent: "red", n: 1 })
	api.land(skin)
	assertEquals(w.table.get("value", w.inW("face"))?.value, { accent: "cherry", n: 1 })
	assertEquals(api.layers(face).length, 1)
})

Deno.test("sites: a memo made in a program reports the program's line; its chain goes through the process, made where start was called, to where the programs were made", () => {
	const w = world({ sites: true })
	w.program("memo.js", (a) => void a.memo("one", () => 1)) // the program's line
	const p = w.start("memo.js", ["memo"])
	const [made] = w.noticed
	const text = Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
	const line = (mark: string) => text.findIndex((l) => l.endsWith(mark)) + 1
	const at = (x: { file: string; line: number }) => [x.file.split("/").pop(), x.line]
	assertEquals(made.kind, "memo")
	assertEquals(w.sites!.sitesOf(made.computer!).map(at), [
		["api_test.ts", line("// the program's line")],
		["api_test.ts", line("// where start is called")],
		["api_test.ts", line("// where the programs are made")],
	])
	assertEquals(w.sites!.sitesOf(p.scope).map(at).slice(0, 1), [
		["api_test.ts", line("// where start is called")],
	])
})

Deno.test("early: its first act happened by the time early returns, and a later change's early act comes before an ordinary effect's", async () => {
	const w = world()
	const seen: unknown[] = []
	let at: unknown[] = []
	let api!: API
	w.program("early.js", (a) => {
		api = a
		const n = a.open("./n", 1)
		a.effect("effect", () => a.read(n), (v) => void seen.push(["effect", v]))
		const e = a.early("early", () => a.read(n), (v) => void seen.push(["early", v]))
		at = [...seen]
		assertEquals(a.read(e), 1)
	})
	w.start("early.js", ["early"])
	await tick()
	assertEquals(at, [["early", 1]])
	assertEquals(seen, [["early", 1], ["effect", 1]])
	api.edit("./n", [{ path: [], value: 2 }])
	await tick()
	assertEquals(seen.slice(2), [["early", 2], ["effect", 2]])
	// its node has its status and run record, as an effect's
	const [, early] = w.noticed
	const run = w.table.get("attributes", early.id)?.value?.[RUN] as Run
	assertEquals(run.end, "done")
	assertEquals(w.table.get("value", early.id)?.value, 2)
})

Deno.test("uuidv7: a new id, time-ordered: each after the one before, many in one ms too", () => {
	const ids = Array.from({ length: 5000 }, () => uuidv7())
	for (const id of ids) {
		assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), id)
	}
	for (let i = 1; i < ids.length; i++) assert(ids[i] > ids[i - 1], `${ids[i - 1]} ${ids[i]}`)
})
