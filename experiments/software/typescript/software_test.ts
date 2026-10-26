// software: offers and runs, on processes, with no den. one world: a scheduler, table and places
// (root R; processes' rows, then children), the host's scope { actor: "host" }, a program
// /apps/clock.js ("hi", javascript source), and a session: a process at /system/session the host
// started with processes of its own, the owner of the host's offers
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { children, createPlaces, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { processes as trie } from "@ermine/processes"
import { createProcesses } from "@ermine/processes/start"
import { createScopeNodes } from "@ermine/processes/scopes"
import { installTypes } from "@ermine/types"
import {
	createSoftware,
	hashOf,
	type Place,
	PROGRAM,
	REASONS,
	type Runnable,
	RUNNER,
	TAKES,
} from "./software.ts"

const JS = "com.netscape.javascript-source"
const RUNNERS = ["system", "session", "runners", "javascript"]

function world() {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "R",
		table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [trie("R"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v as never, createChangeHeader(s))))
	put("children", "R", { apps: "APPS" })
	put("children", "APPS", { "clock.js": "CLOCK" })
	put("value", "CLOCK", "hi")
	put("attributes", "CLOCK", { "ermine.type": JS })
	const processes = createProcesses({ scheduler: s, table, places, scopes, owner: host })
	const session = hosted(() => processes.start(places, "/system/session", {}, () => {}))
	if ("refused" in session) throw new Error("no session")
	const software = createSoftware({
		scheduler: s,
		table,
		places,
		scopes,
		scope: host,
		schedule: () => {},
	})
	// a runner recording what it ran and how each was stopped
	const ran: unknown[] = []
	const record: Runnable = (code, start) => {
		ran.push(["ran", code, start.process.at])
		return { stop: (reason) => void ran.push(["stopped", start.process.at, reason]) }
	}
	const offer = (by: Place = session, live: unknown = record) =>
		hosted(() => software.offer(by, "runners", "javascript", { [TAKES]: JS }, live))
	return { s, table, places, hosted, put, processes, session, software, ran, offer }
}

Deno.test("an offer is a node under its owner, in a folder of its kind; a program runs on it as a process, the runner given its code at the first pulse", () => {
	const w = world()
	const o = w.offer()
	assert(!("refused" in o))
	assertEquals(o.id, `${String(w.session.id)}/runners/javascript`)
	assertEquals(w.places.peep(() => get(w.places, RUNNERS)), o.id)
	assertEquals(w.table.get("attributes", o.id)?.value, {
		[TAKES]: JS,
		"ermine.type": "ermine.runner",
	})
	const p = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/work/clock"))
	assert(!("refused" in p))
	assertEquals(w.ran, [])
	w.s.pulse()
	assertEquals(w.ran, [["ran", "hi", ["work", "clock"]]])
	assertEquals(w.table.get("attributes", p.id)?.value?.[RUNNER], { id: o.id, at: RUNNERS })
	assertEquals(w.table.get("attributes", p.id)?.value?.[PROGRAM], {
		id: "CLOCK",
		at: ["apps", "clock.js"],
		hash: hashOf("hi"),
	})
	assertEquals(w.software.running().map((q) => q.id), [p.id])
})

Deno.test("refused, nothing made, the first that holds: not-a-runner, not-there, wrong-form, taken; no policy asked", () => {
	const w = world()
	w.offer()
	const run = (runner: string[], program: string, at: string) =>
		w.hosted(() => w.software.run(runner, program, at))
	assertEquals(run(["nowhere"], "/apps/clock.js", "/a"), {
		refused: "not-a-runner",
		runner: ["nowhere"],
	})
	assertEquals(run(RUNNERS, "/apps/none.js", "/a"), {
		refused: "not-there",
		program: ["apps", "none.js"],
	})
	w.put("attributes", "CLOCK", { "ermine.type": "x-lisp" })
	assertEquals(run(RUNNERS, "/apps/clock.js", "/a"), {
		refused: "wrong-form",
		program: { type: "x-lisp" },
		runner: { takes: [JS] },
	})
	w.put("attributes", "CLOCK", { "ermine.type": JS })
	assert(!("refused" in run(RUNNERS, "/apps/clock.js", "/a")))
	assertEquals(run(RUNNERS, "/apps/clock.js", "/a"), { refused: "taken", at: ["a"] })
	assertEquals(w.software.running().length, 1)
})

Deno.test("stop: the reason told to the handle; withdrawn: what runs on it stopped withdrawn, its name and attributes out; the owner going: runner-stopped", () => {
	const w = world()
	const o = w.offer()
	assert(!("refused" in o))
	const a = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/a"))
	const b = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/b"))
	assert(!("refused" in a) && !("refused" in b))
	w.s.pulse()
	w.hosted(() => w.software.stop(a, "SIGHUP"))
	w.hosted(() => w.software.withdraw(o))
	assertEquals(w.ran.slice(2), [["stopped", ["a"], "SIGHUP"], [
		"stopped",
		["b"],
		REASONS.withdrawn,
	]])
	assertEquals(w.places.peep(() => get(w.places, RUNNERS)), undefined)
	assertEquals(w.table.get("attributes", o.id), undefined)
	w.offer()
	const c = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/c"))
	assert(!("refused" in c))
	w.s.pulse()
	w.s.teardown(w.session.scope)
	assertEquals(w.ran.at(-1), ["stopped", ["c"], REASONS.runner])
	assertEquals(w.software.running(), [])
})

Deno.test("an install's node as a stored owner: when its scope goes, its offers' attributes and folders stay, the live value goes; offered again over them", () => {
	const w = world()
	const scope = w.hosted(() => w.s.createScope({ install: "I" }))
	const install: Place = { id: "INSTALL", at: ["system", "den"], scope, stored: true }
	const o = w.offer(install)
	assert(!("refused" in o))
	w.s.teardown(scope)
	assertEquals(w.table.get(o.id).map(([part]) => part), ["attributes"])
	assertEquals(w.table.get("children", "INSTALL/runners")?.value, { javascript: o.id })
	const again = w.hosted(() => w.s.createScope({ install: "I" }))
	const back = w.offer({ ...install, scope: again })
	assert(!("refused" in back))
	assertEquals(back.id, o.id)
	assertEquals(typeof w.table.get("value", o.id)?.value, "function")
})

Deno.test("a process run here offers under its own node; what runs on that goes first when it stops", () => {
	const w = world()
	const xs: Runnable = (code, start) => {
		w.ran.push(["x ran", code, start.process.at])
		return { stop: (reason) => void w.ran.push(["x stopped", start.process.at, reason]) }
	}
	const lisp: Runnable = (_, start) => {
		const made = w.software.offer(
			{ id: start.process.id, at: start.process.at, scope: start.scope },
			"runners",
			"x",
			{ [TAKES]: "ermine.x-source" },
			xs,
		)
		w.ran.push(["offered", "refused" in made ? made : made.at])
		return { stop: (reason) => void w.ran.push(["lisp stopped", reason]) }
	}
	w.offer(w.session, lisp)
	w.put("value", "X", "(x)")
	w.put("attributes", "X", { "ermine.type": "ermine.x-source" })
	const l = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/lisp"))
	assert(!("refused" in l))
	w.s.pulse()
	const x = w.hosted(() => w.software.run(["lisp", "runners", "x"], { id: "X" }, "/x"))
	assert(!("refused" in x))
	w.s.pulse()
	w.hosted(() => w.software.stop(l, "SIGTERM"))
	assertEquals(w.ran, [
		["offered", ["lisp", "runners", "x"]],
		["x ran", "(x)", ["x"]],
		["x stopped", ["x"], REASONS.runner],
		["lisp stopped", "SIGTERM"],
	])
})

Deno.test("a load is no process: its live form held by its owner, let go at release or at the owner's stop, newest first; a runner with no load: not-a-runner", () => {
	const w = world()
	const order: unknown[] = []
	const live = (name: string) => ({ [Symbol.dispose]: () => void order.push(name) })
	const loader = Object.assign(() => ({ stop: () => {} }), {
		load: (code: unknown) => live(String(code)),
	})
	w.offer(w.session, loader)
	const one = w.hosted(() => w.software.load(RUNNERS, "/apps/clock.js", { by: w.session }))
	assert(!("refused" in one))
	w.put("value", "CLOCK", "two")
	w.hosted(() => w.software.load(RUNNERS, "/apps/clock.js", { by: w.session }))
	w.put("value", "CLOCK", "three")
	const three = w.hosted(() => w.software.load(RUNNERS, "/apps/clock.js", { by: w.session }))
	assert(!("refused" in three))
	three.release()
	w.s.teardown(w.session.scope)
	assertEquals(order, ["three", "two", "hi"])
	const v = world()
	v.offer()
	assertEquals(v.hosted(() => v.software.load(RUNNERS, "/apps/clock.js", { by: v.session })), {
		refused: "not-a-runner",
		runner: RUNNERS,
	})
})

Deno.test("a runner not offered here (a node someone else put there): run on it, under setup's scope", () => {
	const w = world()
	w.put("children", "R", { apps: "APPS", far: "FAR" })
	w.put("attributes", "FAR", { "ermine.type": "ermine.runner", [TAKES]: JS })
	w.put("value", "FAR", (code: unknown) => void w.ran.push(["far", code]))
	const p = w.hosted(() => w.software.run(["far"], "/apps/clock.js", "/f"))
	assert(!("refused" in p))
	w.s.pulse()
	assertEquals(w.ran, [["far", "hi"]])
})

Deno.test("an owner whose scope is gone: nothing-there; not a name: not-a-name", () => {
	const w = world()
	const gone = w.hosted(() => w.s.createScope({ gone: true }))
	w.s.teardown(gone)
	assertThrows(() => w.offer({ id: "G", at: ["g"], scope: gone }), PlacesError, "nothing-there")
	assertThrows(
		() => w.hosted(() => w.software.offer(w.session, "runners", "..", {}, () => {})),
		PlacesError,
		"not-a-name",
	)
})

Deno.test("a write's site is the call outside software that made it: an offer's, and a run process's", () => {
	const w = world()
	const o = w.offer() as { id: Id }
	const offered = w.table.get("attributes", o.id)?.change.external?.[0]
	assert(offered?.file.endsWith("software_test.ts"), JSON.stringify(offered))
	const folder = w.table.get("children", `${String(w.session.id)}/runners`)?.change.external?.[0]
	assert(folder?.file.endsWith("software_test.ts"), JSON.stringify(folder))
	const p = w.hosted(() => w.software.run(RUNNERS, "/apps/clock.js", "/work/clock"))
	assert(!("refused" in p))
	const ran = w.table.get("attributes", p.id)?.change.external?.[0]
	assert(ran?.file.endsWith("software_test.ts"), JSON.stringify(ran))
})

Deno.test("a program fits by conformance: a runner taking a type takes what conforms to it, the type from ermine.type or the name's extension, by the nearest ermine/types", () => {
	const w = world()
	const C = "public.c-source"
	w.put("children", "APPS", { "clock.js": "CLOCK", "main.c": "MAIN", "plain": "PLAIN" })
	w.put("value", "MAIN", "int main;")
	w.put("value", "PLAIN", "words")
	w.put("attributes", "PLAIN", { "ermine.type": "public.plain-text" })
	const run = (program: string, at: string) =>
		w.hosted(() => w.software.run(["source"], program, at))
	w.put("children", "R", { apps: "APPS", source: "SOURCE" })
	w.put("attributes", "SOURCE", { "ermine.type": "ermine.runner", [TAKES]: "public.source-code" })
	w.put("value", "SOURCE", (code: unknown) => void w.ran.push(["source", code]))
	// no types: main.c has no type, and C conforms to nothing but itself
	assertEquals(run("/apps/main.c", "/a"), {
		refused: "wrong-form",
		program: {},
		runner: { takes: ["public.source-code"] },
	})
	w.hosted(() =>
		w.places.commit(
			installTypes(w.table, "R", createChangeHeader(w.s), [
				{ name: "public.source-code", conformsTo: "public.plain-text" },
				{ name: C, conformsTo: "public.source-code", fileNameExtension: ".c" },
				{ name: "public.plain-text" },
			], (path) => `T:${path.join("/")}`),
		)
	)
	assert(!("refused" in run("/apps/main.c", "/a")))
	// a supertype is not its subtype: plain text is no source code
	assertEquals(run("/apps/plain", "/b"), {
		refused: "wrong-form",
		program: { type: "public.plain-text" },
		runner: { takes: ["public.source-code"] },
	})
	// a list: any one of them
	w.put("attributes", "SOURCE", {
		"ermine.type": "ermine.runner",
		[TAKES]: [JS, "public.plain-text"],
	})
	assert(!("refused" in run("/apps/plain", "/b")))
	assert(!("refused" in run("/apps/main.c", "/c")))
	assert(!("refused" in run("/apps/clock.js", "/d")))
	w.s.pulse()
	assertEquals(w.ran, [["source", "int main;"], ["source", "words"], ["source", "int main;"], [
		"source",
		"hi",
	]])
})

Deno.test("a load is shared: the same program on the same runner, by any holder, loaded once; let go at the last hold; a new key, a new load", () => {
	const w = world()
	const order: unknown[] = []
	const loader = Object.assign(() => ({ stop: () => {} }), {
		load: (code: unknown, start: { scope: unknown }) => {
			order.push(["loaded", code, w.s.getCurrentScope() === start.scope])
			return { [Symbol.dispose]: () => void order.push(["disposed", code]) }
		},
	})
	w.offer(w.session, loader)
	const desk = w.hosted(() => w.s.createScope({ desk: true }))
	const by: Place = { id: "DESK", at: ["home", "desk"], scope: desk }
	const load = (o: Place, chain?: string[]) =>
		w.hosted(() => w.software.load(RUNNERS, "/apps/clock.js", { by: o, chain }))
	const one = load(w.session)
	const two = load(by)
	assert(!("refused" in one) && !("refused" in two))
	assertEquals(one.live, two.live)
	// the same by again: another hold on the same load
	const three = load(w.session)
	assert(!("refused" in three))
	assertEquals(three.live, one.live)
	// another chain: its own
	const other = load(w.session, ["compiled"])
	assert(!("refused" in other))
	assert(other.live !== one.live)
	assertEquals(order, [["loaded", "hi", true], ["loaded", "hi", true]])
	one.release()
	one.release()
	w.s.teardown(desk)
	assertEquals(order.length, 2)
	three.release()
	assertEquals(order.slice(2), [["disposed", "hi"]])
	// let go: loaded again
	const again = load(w.session)
	assert(!("refused" in again))
	assertEquals(order.slice(3), [["loaded", "hi", true]])
	w.s.teardown(w.session.scope)
	assertEquals(order.slice(4), [["disposed", "hi"], ["disposed", "hi"]])
})
