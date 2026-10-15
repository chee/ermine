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
import { box, createBoxes } from "@ermine/boxes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createBuilds } from "@ermine/programs/build"
import { satisfy } from "@ermine/programs"
import { createPrograms, type Process, type Programs } from "@ermine/programs/start"
import { type API, createProcessAPIs, SendError } from "./api.ts"

const JS = "com.netscape.javascript-source"
const tick = () => new Promise((r) => setTimeout(r, 0))

function world() {
	const s = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part as Key, id)
		boxes.onTableChange(part as Key, id)
	})
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const boxes = createBoxes({ table, paths, scheduler: s })
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope([["actor", "host"]])
	const above = s.createScope([], host)
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => (
		places.commit(changed), boxes.commit(changed)
	)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	let programs!: Programs
	const apis = createProcessAPIs({ scheduler: s, table, commit, boxes, programs: () => programs })
	put("children", "W", { lib: "LIB" })
	put("children", "LIB", {})
	put("value", "RUN", apis.run)
	put("attributes", "RUN", { "ermine.programs.takes": [JS] })
	const b = boxes.createBox("W")
	hosted(() => box(b, ["run"], "RUN"))
	programs = s.runWithScope(above, () => {
		const writes = { readValue: places.readValue, commit }
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "CACHE" })
		return createPrograms({
			scheduler: s,
			table,
			places: writes,
			builds,
			scopes,
			createProcessAPI: apis.createProcessAPI,
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
			const p = hosted(() => programs.start(b, way, at))
			if ("refused" in p) throw new Error(p.refused)
			s.pulse()
			return p
		}
		throw new Error(`no way for ${name}`)
	}
	const inW = (name: string) => (table.get("children", "W")?.value as Record<string, Id>)[name]
	return { s, table, b, apis, program, start, inW, put, hosted }
}

Deno.test("open makes once; edit takes a recipe or patches; a write from outside needs no method, and pulses by itself", async () => {
	const w = world()
	const seen: unknown[] = []
	let api!: API
	w.program("clock.js", (a) => {
		api = a
		const notes = a.open("./notes", { a: 1 })
		a.open("./notes", { a: 99 })
		const n = a.memo(() => a.read(notes, ["a"]))
		a.effect(() => a.read(n), (v) => void seen.push(v))
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

Deno.test("a bare name is inside the process: reached through its path, gone at its stop; teardown is told why", async () => {
	const w = world()
	const whys: string[] = []
	const xs: unknown[] = []
	const setup = (a: API) => {
		a.open("scratch", { x: 1 })
		a.teardown((why) => void whys.push(why))
		a.effect(() => a.read("scratch", ["x"]), (x) => void xs.push(x))
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
		a.effect(() => a.read(n), () => a.teardown((why) => void whys.push(why)))
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
		const m = a.memo(() => new Promise<number>((r) => (resolve = r)))
		a.effect(() => a.read(m), (v) => void seen.push(v))
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
