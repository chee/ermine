import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import type { Entry } from "@ermine/graph/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { STATUS } from "./status.ts"
import { PROCESS, processes as rows } from "./processes.ts"
import { createScopeNodes } from "./scopes.ts"
import { ARGS, createProcesses, FOLDER, type Inside, PIN, type Process } from "./start.ts"

function world() {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({
		root: "R",
		table,
		paths,
		scheduler: s,
		contributors: [rows("R"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const life = hosted(() => createProcesses({ scheduler: s, table, places: { commit }, scopes }))
	const start = (...a: Parameters<typeof life.start>) => {
		const p = hosted(() => life.start(...a))
		if ("refused" in p) throw new Error(p.refused)
		return p
	}
	const attrs = (p: Process) => table.get("attributes", p.id)?.value as Record<string, unknown>
	const status = (p: Process) => table.get("status", p.id)?.value as Record<string, unknown>
	return { s, table, places, life, start, attrs, status, hosted }
}

Deno.test("start: the node's attributes, the row at the path, then body with the scope open; stop: body's stop, the row out, the scope gone", () => {
	const w = world()
	const log: string[] = []
	let given: Inside | undefined
	let open: Scope | undefined
	const p = w.start(w.places, "work/clock", { args: ["a.txt"], pin: { chosen: 1 } }, (inside) => {
		given = inside
		open = w.s.getCurrentScope()
		log.push("body")
		return () => {
			log.push(`stop ${JSON.stringify(w.table.get(PROCESS, "R")?.value)}`)
		}
	})
	assertEquals([p.at, p.folder], [["work", "clock"], ["work"]])
	assertEquals(w.attrs(p), {
		[ARGS]: ["a.txt"],
		[FOLDER]: ["work"],
		[PIN]: { chosen: 1 },
	})
	assertEquals(w.status(p), { [STATUS]: PENDING })
	assertEquals(w.table.get(PROCESS, "R")?.value, { work: { clock: p.id } })
	assertStrictEquals(open, p.scope)
	assertEquals([given?.id, given?.args], [p.id, ["a.txt"]])
	w.hosted(() => w.life.stop(p))
	assertEquals(log, ["body", `stop {"work":{"clock":"${String(p.id)}"}}`])
	assertEquals(w.table.get(PROCESS, "R")?.value, {})
	assertEquals([p.scope.state, w.table.get(p.id)], ["gone", []])
	w.hosted(() => w.life.stop(p))
	assertEquals(log.length, 2)
})

Deno.test("start: a process at exactly the path: taken, nothing made, body not called; above or under it is fine", () => {
	const w = world()
	w.start(w.places, ["work", "clock"])
	let called = false
	const at = ["work", "clock"]
	const r = w.hosted(() => w.life.start(w.places, at, {}, () => void (called = true)))
	assertEquals(r, { refused: "taken", at })
	assert(!called)
	const above = w.start(w.places, ["work"])
	const under = w.start(w.places, ["work", "clock", "hand"])
	assert("id" in above && "id" in under)
	w.hosted(() => w.life.stop(above))
	w.hosted(() => w.life.stop(under))
})

Deno.test("give: a computer's status on the process's node; torn down from above: body's stop, the row out", async () => {
	const w = world()
	let stops = 0
	let release!: () => void
	const p = w.start(w.places, "clock", { folder: "/" }, (inside) => {
		const c = w.s.createComputer(() => new Promise<number>((r) => release = () => r(1)), () => {})
		inside.give(c)
		return () => void stops++
	})
	w.s.pulse()
	assertEquals(w.attrs(p)[FOLDER], [])
	assertEquals(w.status(p)[STATUS], PENDING)
	release()
	await new Promise((r) => setTimeout(r, 0))
	w.s.pulse()
	assertEquals(Object.hasOwn(w.status(p), STATUS), false)
	w.s.teardown(p.scope)
	assertEquals([stops, w.table.get(PROCESS, "R")?.value, p.scope.state], [1, {}, "gone"])
})

Deno.test("start: options.attributes in the one entry, beside the folder; the status in its own table", () => {
	const w = world()
	const p = w.start(w.places, "work/clock", {
		attributes: { "ermine.type": "ermine.process", "ermine.den.id": "mac" },
	})
	assertEquals(w.attrs(p), {
		"ermine.type": "ermine.process",
		"ermine.den.id": "mac",
		[FOLDER]: ["work"],
	})
	assertEquals(w.table.get(p.id).map(([part]) => part), ["attributes", "status"])
})

Deno.test("start: a name options.attributes shares with processes' own is processes'; a status there is only an attribute", () => {
	const w = world()
	const p = w.start(w.places, "work/clock", {
		args: ["a.txt"],
		attributes: { [FOLDER]: ["elsewhere"], [ARGS]: ["b.txt"], [STATUS]: "mine", kept: 1 },
	})
	assertEquals(w.attrs(p), { [FOLDER]: ["work"], [ARGS]: ["a.txt"], [STATUS]: "mine", kept: 1 })
	assertEquals(w.status(p), { [STATUS]: PENDING })
})

Deno.test("start under a scope given: its scope under it; that scope torn down, the process goes (body's stop, the row out)", () => {
	const w = world()
	const above = w.hosted(() => w.s.createScope({ runner: "R" }))
	let stops = 0
	const p = w.start(w.places, "clock", { under: above }, () => () => void stops++)
	assertStrictEquals(p.scope.parent, above)
	w.s.teardown(above)
	assertEquals([stops, w.table.get(PROCESS, "R")?.value, p.scope.state], [1, {}, "gone"])
	w.life.stop(p)
	assertEquals(stops, 1)
})

Deno.test("start: attributes that throw as they are written: the row rolled back, the path free to start again", () => {
	const w = world()
	const bad = {
		get boom(): never {
			throw new Error("no")
		},
	}
	let thrown: unknown
	try {
		w.start(w.places, "a/b", { attributes: bad })
	} catch (e) {
		thrown = e
	}
	assertEquals((thrown as Error | undefined)?.message, "no")
	const p = w.start(w.places, "a/b")
	assertEquals(p.at, ["a", "b"])
})

Deno.test("stop: from inside body, with the process body was given: the row out, the scope gone", () => {
	const w = world()
	const log: string[] = []
	const p = w.start(w.places, "a", {}, (inside) => {
		w.life.stop(inside)
		log.push("stopped")
		return () => void log.push("done")
	})
	assertEquals(log, ["stopped"])
	assertEquals(p.scope.state === "alive", false)
	assertEquals(w.start(w.places, "a").at, ["a"])
})
