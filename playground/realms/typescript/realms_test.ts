// realms on a real page: a scheduler, table, places, boxes and programs as ermine/api's tests make
// them, javascript programs (source text) in a folder W, run in a worker by realms.run boxed at /run
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { createScheduler, PENDING } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { box, createBox } from "@ermine/boxes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createBuilds } from "@ermine/compilers"
import { satisfy } from "@ermine/programs"
import { createPrograms, type Process, type Programs } from "@ermine/programs/start"
import { no, type Policy, yes } from "@ermine/protect"
import { createProcessAPIs, SCOPE } from "@ermine/programs/api"
import { createRealms, type Realm } from "./realms.ts"

const JS = "com.netscape.javascript-source"

// f true, waited for: a few ms at a time
// (a first worker after an edit waits for deno test to check its modules: seconds)
export async function until(f: () => boolean, ms = 30_000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("waited too long")
		await new Promise((r) => setTimeout(r, 2))
	}
}

export function world(o: { may?: Policy } = {}) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	const above = s.createScope({ role: "programs" }, host)
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	// every message a realm gets to the page, counted
	const workers: Worker[] = []
	let heard = 0
	const realms = createRealms({
		commit,
		may: o.may,
		createProcessAPI: (ctx) => apis.createProcessAPI(ctx),
		worker: () => {
			const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
			w.addEventListener("message", () => void heard++)
			workers.push(w)
			return w as unknown as Realm
		},
	})
	let programs!: Programs
	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => programs,
		may: o.may,
	})
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	put("children", "W", {})
	put("value", "REALM", realms.run)
	put("attributes", "REALM", { "ermine.programs.takes": [JS] })
	const b = createBox({ places, table, scheduler: s, commit }, { id: "W" })
	hosted(() => box(b, ["run"], "REALM", header()))
	programs = s.runWithScope(above, () => {
		const writes = { readValue: places.readValue, commit }
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "CACHE" })
		return createPrograms({ scheduler: s, table, places, builds, scopes })
	})
	// a node in W at name, holding v
	const node = (name: string, v: unknown) =>
		hosted(() => {
			const id = `n:${name}`
			table.sub("value", id, createEntry<unknown>(v, header()))
			const w = table.get("children", "W")!
			update(w, [{ path: [name], value: id }], header())
			commit([w])
			return id
		})
	// a program's source at name in W
	const program = (name: string, source: string) =>
		hosted(() => {
			const id = `prog:${name}`
			table.sub("value", id, createEntry<unknown>(source, header()))
			table.sub("attributes", id, createEntry({ "ermine.type": JS }, header()))
			const w = table.get("children", "W")!
			update(w, [{ path: [name], value: id }], header())
			commit([w])
		})
	const running: Process[] = []
	const start = (name: string, at: string[]): Process => {
		for (const way of satisfy(b.places, name, [])) {
			const p = hosted(() => programs.start(b, way, at))
			if ("refused" in p) throw new Error(p.refused)
			running.push(p)
			s.pulse()
			return p
		}
		throw new Error(`no way for ${name}`)
	}
	// a write from outside: the host's
	const write = (id: Id, v: unknown) =>
		hosted(() => {
			const e = table.get("value", id) as Entry<unknown>
			update(e, [{ path: [], value: v }], header())
			commit([e])
			s.pulse()
		})
	const value = (path: string[]) => {
		const id = get(b.places, path)
		return id === undefined ? undefined : table.get("value", id)?.value
	}
	const attributes = (id: Id | undefined) =>
		id === undefined
			? undefined
			: table.get("attributes", id)?.value as Record<string, unknown> | undefined
	// the host's own api, at W's root
	const hostAPI = apis.createProcessAPI({
		box: b,
		places: b.places,
		process: { id: "host", at: [], args: [], cwd: [] },
		scheduler: s,
		table,
		scope: host,
	})
	const done = () => {
		for (const p of running) apis.stop(p)
		for (const w of workers) w.terminate()
	}
	return {
		s,
		table,
		places,
		b,
		apis,
		node,
		program,
		start,
		write,
		value,
		attributes,
		hostAPI,
		hosted,
		done,
		heard: () => heard,
	}
}

Deno.test("a read of ./n: its first run pending, then the value lands and it runs with it; a write from outside runs it again", async () => {
	const w = world()
	const n = w.node("n", 7)
	w.program(
		"reader.js",
		`export default function ({ open, read, edit, effect }) {
			const seen = open("./seen", [])
			effect("./watcher", () => read("./n"), (v) => edit(seen, (d) => void d.push(v)))
		}`,
	)
	const statuses: unknown[] = []
	w.places.watchAll((f) => {
		// its id a new one: found at its name
		if (f.part !== "attributes" || f.id !== get(w.b.places, ["watcher"])) return
		statuses.push((f.entry?.value as Record<string, unknown> | undefined)?.[STATUS])
	})
	w.start("reader.js", ["reader"])
	await until(() => (w.value(["seen"]) as number[] | undefined)?.length === 1)
	assertEquals(w.value(["seen"]), [7])
	// pending, as the first run ended; done, gone
	assert(statuses.includes(PENDING))
	assertEquals(statuses.at(-1), undefined)
	w.write(n, 8)
	await until(() => (w.value(["seen"]) as number[]).length === 2)
	assertEquals(w.value(["seen"]), [7, 8])
	w.done()
})

Deno.test("an edit from the worker lands as its effect: the page's actor, the effect's node, the program's site", async () => {
	const w = world()
	const note = w.node("note", "a")
	w.program(
		"editor.js",
		`export default function ({ read, edit, effect }) {
			effect("watch", () => read("./note"), (v) => {
				if (v === "a") edit("./note", () => "b")
			})
		}`,
	)
	const p = w.start("editor.js", ["editor"])
	await until(() => w.value(["note"]) === "b")
	const change = w.table.get("value", note)!.change as ChangeHeader
	// the page's idea of who: the host's actor; the metadata the realm's, ending at the effect's
	// node (its act's run), the node's scope the process; never the worker's own root
	assertEquals(change.actor, "host")
	const watch = get(w.b.places, ["editor", "watch"])!
	assertEquals(change.metadata?.[NODE], watch)
	assertEquals(w.attributes(watch)?.[SCOPE], p.id)
	assert(!JSON.stringify(change.metadata).includes("realm"))
	// the site: the realm's, not the page's realms.ts: written in the effect's act (a run), the
	// effect's own, its line in the program (the worker's sites)
	assert(change.external?.length, "a site")
	assert(!change.external![0].file.endsWith("realms.ts"), change.external![0].file)
	assertEquals(change.external![0].line, 2, JSON.stringify(change.external))
	assertEquals(p.at, ["editor"])
	w.done()
})

Deno.test("a memo in the worker: its result node on the page (its run record stays in the worker)", async () => {
	const w = world()
	const n = w.node("n", 7)
	w.program(
		"double.js",
		`export default function ({ read, memo }) {
			memo("./double", () => read("./n") * 2)
		}`,
	)
	w.start("double.js", ["doubler"])
	await until(() => w.value(["double"]) === 14)
	const id = get(w.b.places, ["double"])!
	// its id a new one, never from its name
	assert(!String(id).includes("double"), String(id))
	// a record is the worker's runs table's: no wire message carries it, so the page has none
	assertEquals(w.apis.runs(id), undefined)
	w.write(n, 8)
	await until(() => w.value(["double"]) === 16)
	w.done()
	// stopped: its node taken out, as ermine/api takes one out
	assertEquals(get(w.b.places, ["double"]), undefined)
	assertEquals(w.table.get(id).length, 0)
})

Deno.test("send from the page to a method in the worker, the caller on its writes; and from the worker to one on the page", async () => {
	const w = world()
	w.node("last", "nobody")
	w.hosted(() => w.hostAPI.method("/echo", (x: string) => `echo ${x}`))
	w.program(
		"greeter.js",
		`export default function ({ open, read, edit, effect, method, send }) {
			method("on/greet", (name) => {
				edit("./last", () => name)
				return "hi " + name
			})
			const answer = open("./answer", "")
			effect("peek", () => typeof read("./echo"), (t) => {
				if (t === "function") send("./echo", "owl").then((v) => edit(answer, () => v))
			})
		}`,
	)
	w.start("greeter.js", ["greeter"])
	await until(() => w.value(["greeter", "on", "greet"]) !== undefined)
	const back = await w.hosted(() => w.hostAPI.send("/greeter/on/greet", "frog"))
	assertEquals(back, "hi frog")
	await until(() => w.value(["last"]) === "frog")
	const change = w.table.get("value", get(w.b.places, ["last"])!)!.change
	assertEquals(change.metadata?.caller, "host")
	await until(() => w.value(["answer"]) === "echo owl")
	w.done()
})

Deno.test("stop terminates the worker: no message arrives after", async () => {
	const w = world()
	w.program(
		"ticker.js",
		`export default function ({ open, edit }) {
			const tick = open("./tick", 0)
			setInterval(() => edit(tick, (d) => d + 1), 2)
		}`,
	)
	const p = w.start("ticker.js", ["ticker"])
	await until(() => (w.value(["tick"]) as number) > 2)
	w.apis.stop(p)
	const [tick, heard] = [w.value(["tick"]), w.heard()]
	await new Promise((r) => setTimeout(r, 40))
	assertEquals(w.value(["tick"]), tick)
	assertEquals(w.heard(), heard)
	w.done()
})

Deno.test("a worker error is the process's error status; a setup that throws, too", async () => {
	const w = world()
	w.program(
		"boom.js",
		`export default function () {
			setTimeout(() => { throw new Error("boom") }, 5)
			return "running"
		}`,
	)
	w.program("broken.js", `export default function () { throw new Error("setup") }`)
	const p = w.start("boom.js", ["boom"])
	const q = w.start("broken.js", ["broken"])
	await until(() => w.attributes(p.id)?.[STATUS] instanceof Error)
	assertEquals((w.attributes(p.id)?.[STATUS] as Error).message, "boom")
	assertEquals(w.table.get("value", p.id)?.value, "running")
	await until(() => w.attributes(q.id)?.[STATUS] instanceof Error)
	assertEquals((w.attributes(q.id)?.[STATUS] as Error).message, "setup")
	w.done()
})

Deno.test("a value that won't clone: a plain Error, from the worker's write and in the worker's read", async () => {
	const w = world()
	w.node("live", { f: () => 1 })
	w.program(
		"cloner.js",
		`export default function ({ open, read, edit, effect, PENDING }) {
			const out = open("./out", "")
			try {
				edit(out, () => ({ f: () => 1 }))
			} catch (e) {
				edit("./out", () => e.constructor.name + ": " + e.message)
			}
			effect("live", () => {
				try { return read("./live") } catch (e) {
					if (e === PENDING) throw e
					return e.constructor.name + ": " + e.message
				}
			}, (v) => open("./read", v))
		}`,
	)
	w.start("cloner.js", ["cloner"])
	await until(() => w.value(["read"]) !== undefined)
	const wrote = w.value(["out"]) as string
	assert(wrote.startsWith("Error: won't cross"), wrote)
	const read = w.value(["read"]) as string
	assert(read.startsWith("Error: won't cross"), read)
	w.done()
})

Deno.test("protect: the page asks its policy; a refused write is put back in the worker, the refusal the process's status", async () => {
	const may: Policy = (ask) =>
		ask.op === "edit" && ask.target.path?.join("/") === "secret" ? no("not yours") : yes
	const w = world({ may })
	w.node("secret", 1)
	w.program(
		"sneak.js",
		`export default function ({ open, read, edit, effect, method }) {
			const seen = open("./seen", [])
			effect("watch", () => read("./secret"), (v) => edit(seen, (d) => void d.push(v)))
			method("on/sneak", () => edit("./secret", () => 2))
		}`,
	)
	const p = w.start("sneak.js", ["sneak"])
	await until(() => (w.value(["seen"]) as number[] | undefined)?.length === 1)
	await w.hosted(() => w.hostAPI.send("/sneak/on/sneak"))
	await until(() => w.attributes(p.id)?.[STATUS] instanceof Error)
	assert((w.attributes(p.id)?.[STATUS] as Error).message.includes("not yours"))
	assertEquals(w.value(["secret"]), 1)
	// the worker saw its own write, then the page's entry put back
	await until(() => (w.value(["seen"]) as number[]).length === 3)
	assertEquals(w.value(["seen"]), [1, 2, 1])
	w.done()
})

Deno.test("a write on each side at once, to one node: both end the same, in the page's order", async () => {
	const w = world()
	const x = w.node("x", "start")
	w.program(
		"racer.js",
		`export default function ({ open, read, edit, effect, method }) {
			const seen = open("./seen", [])
			effect("watch", () => read("./x"), (v) => edit(seen, (d) => void d.push(v)))
			method("on/race", () => edit("./x", () => "worker"))
		}`,
	)
	w.start("racer.js", ["racer"])
	await until(() => (w.value(["seen"]) as unknown[] | undefined)?.length === 1)
	// the call crosses first, the page's write after it: the realm writes before it lands the page's
	const call = w.hosted(() => w.hostAPI.send("/racer/on/race")) as Promise<unknown>
	w.write(x, "page")
	await call
	await until(() => (w.value(["seen"]) as unknown[]).at(-1) === w.value(["x"]))
	assertEquals(w.value(["x"]), "worker")
	await new Promise((r) => setTimeout(r, 20))
	// the realm: its own write, the page's landing on it, then the page's entry whole (reset)
	assertEquals(w.value(["seen"]), ["start", "worker", "page", "worker"])
	w.done()
})

Deno.test("run given a start's facts: the api made with setup.createProcessAPI from them; none given: refused", () => {
	const s = createScheduler()
	const table = createTable(() => {})
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const start = {
		box: { root: "R", places },
		places,
		process: { id: "proc:a", at: ["a"], args: [], cwd: [] },
		scheduler: s,
		table,
		scope: s.createRootScope({ process: ["a"] }),
	}
	const bare = createRealms({ worker: () => assert(false, "no worker") as never })
	assertThrows(
		() => bare.run.start("export default () => {}", start),
		Error,
		"createRealms({ createProcessAPI })",
	)
	const given: unknown[] = []
	const realms = createRealms({
		worker: () => assert(false, "no worker") as never,
		createProcessAPI: (ctx) => {
			given.push(ctx)
			throw new Error("made from the start")
		},
	})
	assertThrows(
		() => realms.run.start("export default () => {}", start),
		Error,
		"made from the start",
	)
	assertEquals(given, [start])
})
