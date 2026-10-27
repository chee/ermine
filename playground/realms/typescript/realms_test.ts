// realms on a real page: a createErmine (@ermine/system), javascript programs (source text) run as
// processes of it by realms.start, each in a worker, at /work/<name>: its folder /work, so ./n is
// /work/n. a program imports @ermine/system's functions, and the worker's own ermine answers them
import { assert, assertEquals, assertThrows } from "@std/assert"
import { type ChangeHeader } from "@ermine/core/node/entry"
import { PENDING } from "@ermine/core/scheduler"
import type { Id } from "@ermine/core/table"
import { get } from "@ermine/core/places/lib"
import { NODE } from "@ermine/core/places/header"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import { no, type Policy, yes } from "@ermine/core/protect"
import { createErmine, SCOPE, type Started } from "@ermine/system"
import { createRealms, type Realm } from "./realms.ts"

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
	const ermine = createErmine({ info: { actor: "host" } })
	const { scheduler: s, table, places } = ermine
	// every message a realm gets to the page, counted
	const workers: Worker[] = []
	let heard = 0
	const realms = createRealms({
		ermine,
		may: o.may,
		worker: () => {
			const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
			w.addEventListener("message", () => void heard++)
			workers.push(w)
			return w as unknown as Realm
		},
	})
	ermine.ensureNode("/work", null)
	// a node in /work at name, holding v: its id
	const node = (name: string, v: unknown): Id => {
		ermine.ensureNode(`/work/${name}`, v)
		return get(places, ["work", name])!
	}
	// a program's source at name
	const sources = new Map<string, string>()
	const program = (name: string, source: string) => void sources.set(name, source)
	const running: Started[] = []
	const start = (name: string, at: string[]): Started => {
		const source = sources.get(name)
		if (source === undefined) throw new Error(`no program ${name}`)
		const p = realms.start(source, ["work", ...at])
		if ("refused" in p) throw new Error(p.refused)
		running.push(p)
		ermine.pulse()
		return p
	}
	// a write from outside: the host's
	const write = (id: Id, v: unknown) => {
		ermine.patch(ermine.handleOf({ id, part: "value" }), [{ path: [], value: v }])
		ermine.pulse()
	}
	const value = (path: string[]) => {
		const id = get(places, ["work", ...path])
		return id === undefined ? undefined : table.get("value", id)?.value
	}
	const attributes = (id: Id | undefined) =>
		id === undefined
			? undefined
			: table.get("attributes", id)?.value as Record<string, unknown> | undefined
	// a node's status, which is in its own table
	const status = (id: Id | undefined) =>
		id === undefined
			? undefined
			: (table.get(STATUS_TABLE, id)?.value as Record<string, unknown> | undefined)?.[STATUS]
	const done = () => {
		for (const p of running) p.stop()
		for (const w of workers) w.terminate()
	}
	return {
		s,
		table,
		places,
		ermine,
		node,
		program,
		start,
		write,
		value,
		attributes,
		status,
		done,
		heard: () => heard,
	}
}

Deno.test("a read of ./n: its first run pending, then the value lands and it runs with it; a write from outside runs it again", async () => {
	const w = world()
	const n = w.node("n", 7)
	w.program(
		"reader.js",
		`import { createEffect, ensureNode, patch, peep, read } from "@ermine/system"
		export default function () {
			const seen = ensureNode("./seen", [])
			createEffect("./watcher", () => read("./n"), (v) => {
				patch(seen, [{ path: [], value: [...peep(() => read(seen)), v] }])
			})
		}`,
	)
	const statuses: unknown[] = []
	w.places.watchAll((f) => {
		// its id a new one: found at its name
		if (f.part !== STATUS_TABLE || f.id !== get(w.places, ["work", "watcher"])) return
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

Deno.test("a write from the worker lands as its effect: the page's actor, the effect's node, the program's site", async () => {
	const w = world()
	const note = w.node("note", "a")
	w.program(
		"editor.js",
		`import { createEffect, patch, read } from "@ermine/system"
		export default function () {
			createEffect("watch", () => read("./note"), (v) => {
				if (v === "a") patch("./note", [{ path: [], value: "b" }])
			})
		}`,
	)
	const p = w.start("editor.js", ["editor"])
	await until(() => w.value(["note"]) === "b")
	const change = w.table.get("value", note)!.change as ChangeHeader
	// the page's idea of who: the host's actor; the metadata the realm's, ending at the effect's
	// node (its act's run), the node's scope the process; never the worker's own root
	assertEquals(change.actor, "host")
	const watch = get(w.places, ["work", "editor", "watch"])!
	assertEquals(change.metadata?.[NODE], watch)
	assertEquals(w.attributes(watch)?.[SCOPE], p.process.id)
	assert(!JSON.stringify(change.metadata).includes("realm"))
	// the site: the realm's, not the page's realms.ts: written in the effect's act (a run), the
	// effect's own, its line in the program (the worker's sites)
	assert(change.external?.length, "a site")
	assert(!change.external![0].file.endsWith("realms.ts"), change.external![0].file)
	assertEquals(change.external![0].line, 3, JSON.stringify(change.external))
	assertEquals(p.process.at, ["work", "editor"])
	w.done()
})

Deno.test("a memo in the worker: its result node on the page (its run record stays in the worker)", async () => {
	const w = world()
	const n = w.node("n", 7)
	w.program(
		"double.js",
		`import { createMemo, read } from "@ermine/system"
		export default function () {
			createMemo("./double", () => read("./n") * 2)
		}`,
	)
	w.start("double.js", ["doubler"])
	await until(() => w.value(["double"]) === 14)
	const id = get(w.places, ["work", "double"])!
	// its id a new one, never from its name
	assert(!String(id).includes("double"), String(id))
	// a record is the worker's runs table's: no wire message carries it, so the page has none
	assertEquals(w.ermine.records.run(id), undefined)
	w.write(n, 8)
	await until(() => w.value(["double"]) === 16)
	w.done()
	// stopped: its node taken out, as @ermine/system takes one out
	assertEquals(get(w.places, ["work", "double"]), undefined)
	assertEquals(w.table.get(id).length, 0)
})

Deno.test("an action called from the page, the caller on its writes; and a call from the worker to one on the page", async () => {
	const w = world()
	w.node("last", "nobody")
	w.ermine.createAction("/echo", (x: string) => `echo ${x}`)
	w.program(
		"greeter.js",
		`import { createAction, createEffect, createMemo, ensureNode, executeAction, patch, read } from "@ermine/system"
		export default function () {
			createAction("on/greet", (name) => {
				patch("./last", [{ path: [], value: name }])
				return "hi " + name
			})
			// a call to nothing waits (PENDING) till the action is there; a promise's value comes when it
			// settles, and an effect writes it (nothing is open after an await)
			const echoed = createMemo("echoed", () => executeAction("/echo", "owl"))
			const answer = ensureNode("./answer", "")
			createEffect("answer", () => read(echoed), (v) => patch(answer, [{ path: [], value: v }]))
		}`,
	)
	w.start("greeter.js", ["greeter"])
	await until(() => w.value(["greeter", "on", "greet"]) !== undefined)
	const back = await w.ermine.executeAction("/work/greeter/on/greet", "frog")
	assertEquals(back, "hi frog")
	await until(() => w.value(["last"]) === "frog")
	const change = w.table.get("value", get(w.places, ["work", "last"])!)!.change
	assertEquals((change.metadata?.caller as { node: unknown }).node, w.ermine.node)
	await until(() => w.value(["answer"]) === "echo owl")
	w.done()
})

Deno.test("stop terminates the worker: no message arrives after", async () => {
	const w = world()
	const n = w.node("n", 0)
	// the worker answers each write of the page's with a write of its own (a timer's callback has
	// nothing open to write with, so the page's writes are the ticking)
	w.program(
		"ticker.js",
		`import { createEffect, ensureNode, patch, read } from "@ermine/system"
		export default function () {
			const tick = ensureNode("./tick", 0)
			createEffect("echo", () => read("./n"), (v) => patch(tick, [{ path: [], value: v }]))
		}`,
	)
	const p = w.start("ticker.js", ["ticker"])
	let i = 0
	const ticking = setInterval(() => w.write(n, ++i), 2)
	try {
		await until(() => ((w.value(["tick"]) as number | undefined) ?? 0) > 2)
		p.stop()
		const [tick, heard] = [w.value(["tick"]), w.heard()]
		await new Promise((r) => setTimeout(r, 40))
		assertEquals(w.value(["tick"]), tick)
		assertEquals(w.heard(), heard)
	} finally {
		clearInterval(ticking)
		w.done()
	}
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
	await until(() => w.status(p.process.id) instanceof Error)
	assertEquals((w.status(p.process.id) as Error).message, "boom")
	assertEquals(w.table.get("value", p.process.id)?.value, "running")
	await until(() => w.status(q.process.id) instanceof Error)
	assertEquals((w.status(q.process.id) as Error).message, "setup")
	w.done()
})

Deno.test("a value that won't clone: a plain Error, from the worker's write and in the worker's read", async () => {
	const w = world()
	w.node("live", { f: () => 1 })
	w.program(
		"cloner.js",
		`import { createEffect, ensureNode, patch, PENDING, read } from "@ermine/system"
		export default function () {
			const out = ensureNode("./out", "")
			try {
				patch(out, [{ path: [], value: { f: () => 1 } }])
			} catch (e) {
				patch("./out", [{ path: [], value: e.constructor.name + ": " + e.message }])
			}
			createEffect("live", () => {
				try { return read("./live") } catch (e) {
					if (e === PENDING) throw e
					return e.constructor.name + ": " + e.message
				}
			}, (v) => ensureNode("./read", v))
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
		ask.op === "edit" && ask.target.path?.join("/") === "work/secret" ? no("not yours") : yes
	const w = world({ may })
	w.node("secret", 1)
	w.program(
		"sneak.js",
		`import { createAction, createEffect, ensureNode, patch, peep, read } from "@ermine/system"
		export default function () {
			const seen = ensureNode("./seen", [])
			createEffect("watch", () => read("./secret"), (v) => {
				patch(seen, [{ path: [], value: [...peep(() => read(seen)), v] }])
			})
			createAction("on/sneak", () => patch("./secret", [{ path: [], value: 2 }]))
		}`,
	)
	const p = w.start("sneak.js", ["sneak"])
	await until(() => (w.value(["seen"]) as number[] | undefined)?.length === 1)
	await w.ermine.executeAction("/work/sneak/on/sneak")
	await until(() => w.status(p.process.id) instanceof Error)
	assert((w.status(p.process.id) as Error).message.includes("not yours"))
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
		`import { createAction, createEffect, ensureNode, patch, peep, read } from "@ermine/system"
		export default function () {
			const seen = ensureNode("./seen", [])
			createEffect("watch", () => read("./x"), (v) => {
				patch(seen, [{ path: [], value: [...peep(() => read(seen)), v] }])
			})
			createAction("on/race", () => patch("./x", [{ path: [], value: "worker" }]))
		}`,
	)
	w.start("racer.js", ["racer"])
	await until(() => (w.value(["seen"]) as unknown[] | undefined)?.length === 1)
	// the call crosses first, the page's write after it: the realm writes before it lands the page's
	const call = w.ermine.executeAction("/work/racer/on/race") as Promise<unknown>
	w.write(x, "page")
	await call
	await until(() => (w.value(["seen"]) as unknown[]).at(-1) === w.value(["x"]))
	assertEquals(w.value(["x"]), "worker")
	await new Promise((r) => setTimeout(r, 20))
	// the realm: its own write, the page's landing on it, then the page's entry whole (reset)
	assertEquals(w.value(["seen"]), ["start", "worker", "page", "worker"])
	w.done()
})

Deno.test("run takes source text or { url }: a function won't cross; nothing else is a program", () => {
	const ermine = createErmine()
	const realms = createRealms({
		ermine,
		worker: () => assert(false, "no worker") as never,
	})
	const scope = ermine.scheduler.createRootScope({ process: ["a"] })
	const start = {
		scope,
		box: { root: ermine.places.root, places: ermine.places },
		folder: [],
		at: ["a"],
		args: [],
		process: { id: "proc:a", at: ["a"], folder: [], scope },
	}
	assertThrows(() => realms.run.start(() => {}, start), Error, "won't cross to a realm")
	assertThrows(() => realms.run.start(42, start), Error, "not a program")
	ermine.close()
})
