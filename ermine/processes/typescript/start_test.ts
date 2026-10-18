// a process's life (start.ts) on a real scheduler, table and paths: places rooted at R, asked the
// processes' rows and children; the host's scope { actor: "host" }, the processes' owner under it
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import type { Entry } from "@ermine/node/entry"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
import { STATUS } from "@ermine/places/status"
import { PROCESS, processes as rows } from "./processes.ts"
import { createScopeNodes } from "./scopes.ts"
import { ARGS, createProcesses, CWD, type Inside, PIN, type Process } from "./start.ts"

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
	return { s, table, places, life, start, attrs, hosted }
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
	assertEquals([p.at, p.cwd], [["work", "clock"], ["work"]])
	assertEquals(w.attrs(p), {
		[ARGS]: ["a.txt"],
		[CWD]: ["work"],
		[PIN]: { chosen: 1 },
		[STATUS]: PENDING,
	})
	assertEquals(w.table.get(PROCESS, "R")?.value, { work: { clock: p.id } })
	assertStrictEquals(open, p.scope)
	assertEquals([given?.id, given?.args, given?.box.root], [p.id, ["a.txt"], "R"])
	w.hosted(() => w.life.stop(p))
	assertEquals(log, ["body", `stop {"work":{"clock":"${String(p.id)}"}}`])
	assertEquals(w.table.get(PROCESS, "R")?.value, {})
	assertEquals([p.scope.state, w.table.get(p.id)], ["gone", []])
	w.hosted(() => w.life.stop(p))
	assertEquals(log.length, 2)
})

Deno.test("start: a process at the path, above it or under it: taken, nothing made, body not called", () => {
	const w = world()
	w.start(w.places, ["work", "clock"])
	let called = false
	for (const at of [["work", "clock"], ["work"], ["work", "clock", "hand"]]) {
		const r = w.hosted(() => w.life.start(w.places, at, {}, () => void (called = true)))
		assertEquals(r, { refused: "taken", at })
	}
	assert(!called)
})

Deno.test("give: a computer's status on the process's node; torn down from above: body's stop, the row out", async () => {
	const w = world()
	let stops = 0
	let release!: () => void
	const p = w.start(w.places, "clock", { cwd: "/" }, (inside) => {
		const c = w.s.createComputer(() => new Promise<number>((r) => release = () => r(1)), () => {})
		inside.give(c)
		return () => void stops++
	})
	w.s.pulse()
	assertEquals(w.attrs(p)[CWD], [])
	assertEquals(w.attrs(p)[STATUS], PENDING)
	release()
	await new Promise((r) => setTimeout(r, 0))
	w.s.pulse()
	assertEquals(Object.hasOwn(w.attrs(p), STATUS), false)
	w.s.teardown(p.scope)
	assertEquals([stops, w.table.get(PROCESS, "R")?.value, p.scope.state], [1, {}, "gone"])
})

Deno.test("start: options.attributes in the one entry, beside the cwd and the status", () => {
	const w = world()
	const p = w.start(w.places, "work/clock", {
		attributes: { "ermine.type": "ermine.process", "ermine.den.id": "mac" },
	})
	assertEquals(w.attrs(p), {
		"ermine.type": "ermine.process",
		"ermine.den.id": "mac",
		[CWD]: ["work"],
		[STATUS]: PENDING,
	})
	assertEquals(w.table.get(p.id).map(([part]) => part), ["attributes"])
})

Deno.test("start: a name options.attributes shares with processes' own is processes'", () => {
	const w = world()
	const p = w.start(w.places, "work/clock", {
		args: ["a.txt"],
		attributes: { [CWD]: ["elsewhere"], [ARGS]: ["b.txt"], [STATUS]: "mine", kept: 1 },
	})
	assertEquals(w.attrs(p), { [CWD]: ["work"], [ARGS]: ["a.txt"], [STATUS]: PENDING, kept: 1 })
})
