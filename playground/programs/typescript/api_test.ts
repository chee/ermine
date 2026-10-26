// programs' process api (api.ts) on a real scheduler, table, places, boxes and programs: javascript
// programs in a folder W, run by a host runner RUN (apis.run, or apis.runner's) boxed at /run, each
// started in W's box. what it adds to ermine/api's: start, stop and openwith on each api, and the
// runners
import { assert, assertEquals, assertInstanceOf } from "@std/assert"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { STATUS } from "@ermine/core/places/status"
import { box, createBox } from "@ermine/boxes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createBuilds } from "@ermine/compilers"
import { createSites } from "@ermine/sites"
import { satisfy } from "./programs.ts"
import { createPrograms, ours, type Process, type Programs } from "./start.ts"
import { type API, createProcessAPIs, type Noticed } from "./api.ts"

const JS = "com.netscape.javascript-source"
const tick = () => new Promise((r) => setTimeout(r, 0))

// more: what the host's api adds over this one's, each api a copy ({ ...createProcessAPI(ctx), more })
function world(
	o: {
		sites?: boolean
		show?: (value: unknown, api: API) => unknown
		more?: Record<string, unknown>
	} = {},
) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	const above = s.createScope({ role: "programs" }, host)
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	let programs!: Programs
	// sites: the apis, programs, software and the scheduler are ours, so a site is the program's line
	const sites = o.sites
		? createSites(s, {
			ours: [
				new URL("./api.ts", import.meta.url).href,
				import.meta.resolve("@ermine/api"),
				...ours,
				import.meta.resolve("@ermine/processes/start"),
				import.meta.resolve("@ermine/core/scheduler"),
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
		sites,
		notice: (made) => void noticed.push(made),
	})
	put("children", "W", { lib: "LIB" })
	put("children", "LIB", {})
	// the runner's api: createProcessAPI's, or a host's own over it
	const api = o.more === undefined
		? undefined
		: (ctx: Parameters<typeof apis.createProcessAPI>[0]) => ({
			...apis.createProcessAPI(ctx),
			...o.more,
		})
	put("value", "RUN", o.show || api ? apis.runner({ show: o.show, api }) : apis.run)
	put("attributes", "RUN", { "ermine.programs.takes": [JS] })
	const b = createBox({ places, table, scheduler: s, commit }, { id: "W" })
	hosted(() => box(b, ["run"], "RUN", header()))
	programs = s.runWithScope(above, () => {
		const writes = { readValue: places.readValue, commit }
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "CACHE" })
		return createPrograms({ // where the programs are made
			scheduler: s,
			table,
			places,
			builds,
			scopes,
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
	return { s, table, b, apis, program, start, sites, noticed }
}

Deno.test("run: setup's return is the process's value, written with its scope open; none: nothing written", async () => {
	const w = world()
	w.program("clock.js", () => "ticking")
	w.program("quiet.js", () => {})
	const p = w.start("clock.js", ["clock"])
	const q = w.start("quiet.js", ["quiet"])
	await tick()
	const entry = w.table.get("value", p.id)!
	assertEquals(entry.value, "ticking")
	assertEquals(entry.change.actor, "host")
	assertEquals(w.table.get("value", q.id), undefined)
})

Deno.test("a runner's own api over createProcessAPI's ({ ...api, more }): a copy, not the api made, and still its process's: setup's return its value, a memo's status and run on its node, a teardown told", async () => {
	const w = world({ more: { hello: () => "hi" } })
	const whys: string[] = []
	let given!: API & { hello: () => string }
	w.program("more.js", (a) => {
		given = a as typeof given
		const m = a.memo("m", () => {
			throw new Error("no")
		})
		a.effect("e", () => a.read(m), () => {})
		a.teardown((why) => void whys.push(why))
		return given.hello()
	})
	const p = w.start("more.js", ["more"])
	await tick()
	assertEquals(w.table.get("value", p.id)?.value, "hi")
	const [memo] = w.noticed
	const st = w.table.get("attributes", memo.id)?.value as Record<string, unknown> | undefined
	assertInstanceOf(st?.[STATUS], Error)
	assertEquals(w.apis.runs(memo.id)?.end, "failed")
	w.apis.stop(p, "replaced")
	assertEquals(whys, ["replaced"])
})

Deno.test("runner({ show }): show's return is the process's value, given setup's return and the api", async () => {
	const seen: unknown[] = []
	const w = world({
		show: (value, api) => {
			seen.push(typeof api.read)
			return { shown: value }
		},
	})
	w.program("view.js", () => "made")
	const p = w.start("view.js", ["view"])
	await tick()
	assertEquals(seen, ["function"])
	assertEquals(w.table.get("value", p.id)?.value, { shown: "made" })
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

Deno.test("a process started by another is told the starter's why as the starter stops; stop stops one it started", async () => {
	const w = world()
	const whys: string[] = []
	const kids: Process[] = []
	let api!: API
	w.program("kid.js", (a) => void a.teardown((why) => void whys.push(why)))
	w.program("parent.js", (a) => {
		api = a
		kids.push(a.start("kid.js", "./one") as Process)
		kids.push(a.start("kid.js", "./two") as Process)
	})
	const p = w.start("parent.js", ["parent"])
	await tick()
	api.stop(kids[0])
	assertEquals(whys, ["ended"])
	assertEquals(get(w.b.places, ["one"]), undefined)
	w.apis.stop(p, "replaced")
	assertEquals(whys, ["ended", "replaced"])
	assertEquals(get(w.b.places, ["two"]), undefined)
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
	assertEquals([...api.openwith("./notes")].map((x) => x.program.at), [["viewer.js"]])
})

Deno.test("box: a child started in a box of a folder, seeing only what is boxed into it", async () => {
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
		["api_test.ts", line("// where start is called")],
		["api_test.ts", line("// where the programs are made")],
	])
	assertEquals(w.sites!.sitesOf(p.scope).map(at).slice(0, 1), [
		["api_test.ts", line("// where start is called")],
	])
})
