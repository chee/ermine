import { assert, assertEquals, assertThrows } from "@std/assert"
import { createErmine, ErmineError } from "./ermine.ts"
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	explainAttributes,
	explainChildren,
	getArgs,
	getNode,
	getStatus,
	hasNode,
	list,
	patch,
	patchAttributes,
	patchChildren,
	peep,
	pipe,
	pulse,
	read,
	readAllChildren,
	readAttributes,
	readChildren,
} from "@ermine/system"
import { countOf } from "./system_fixture.ts"
import { manual } from "./manual_fixture.ts"

// the program a test wrote at a node (ensureNode), as start takes it: its function
const programAt = (e: { within: <T>(f: () => T) => T }, at: string) =>
	e.within(() => read(at)) as () => unknown

Deno.test("@ermine/system: getNode makes nothing, ensureNode makes once, hasNode says which", () => {
	const e = createErmine({ features: [manual] })
	const seen: unknown[] = []
	e.within(() =>
		ensureNode("/code/p", () => {
			const n = getNode("./nothing")
			seen.push(hasNode(n), hasNode("./nothing"))
			ensureNode("./made", { a: 1 })
			ensureNode("./made", { a: 2 })
			ensureNode("./empty")
			seen.push(hasNode("./made"), read("./made"), hasNode("./empty"), read("./empty"))
			seen.push(list("/code").sort())
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	assertEquals(seen, [false, false, true, { a: 1 }, true, undefined, ["empty", "made", "p"]])
	e.close()
})

Deno.test("@ermine/system: patch takes patches only; a node not there: nothing-there; attributes by their own pair", () => {
	const e = createErmine({ features: [manual] })
	const errors: unknown[] = []
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("./x", { n: 0 })
			patch("./x", [{ path: ["n"], value: 1 }])
			try {
				patch("./x", ((d: { n: number }) => void (d.n = 2)) as never)
			} catch (x) {
				errors.push((x as ErmineError).code)
			}
			try {
				patch("./missing", [{ path: [], value: 1 }])
			} catch (x) {
				errors.push((x as { code?: string }).code)
			}
			patchAttributes("./x", [{ path: ["kind"], value: "thing" }])
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	assertEquals(e.within(() => read("/code/x")), { n: 1 })
	assertEquals(errors, ["not-patches", "nothing-there"])
	let kind: unknown
	e.getProcessContext()!.within(() => kind = readAttributes("/code/x", ["kind"]))
	assertEquals(kind, "thing")
	e.close()
})

Deno.test("@ermine/system: createMemo and createEffect, early by an option; nothing open: nothing-open", () => {
	const e = createErmine({ features: [manual] })
	const acted: [string, unknown][] = []
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("./n", 2)
			const twice = createMemo("twice", () => (read("./n") as number) * 2)
			createEffect("show", () => read(twice), (v) => void acted.push(["late", v]))
			createEffect("first", () => read("./n"), (v) => void acted.push(["early", v]), {
				early: true,
			})
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	e.within(() => pulse())
	assert(acted.some(([k, v]) => k === "early" && v === 2))
	assert(acted.some(([k, v]) => k === "late" && v === 4))
	assertThrows(() => read("/code/n"), ErmineError, "read: nothing is open")
	e.close()
})

Deno.test("@ermine/system: the three parts alike: readChildren (handles), patchChildren (a name a patch), explainChildren, readAllChildren (no ids), explainAttributes", () => {
	const e = createErmine({ features: [manual] })
	const seen: Record<string, unknown> = {}
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("./box/a", 1)
			const b = ensureNode("./b", 2)
			const kids = readChildren("./box")
			seen.names = Object.keys(kids)
			seen.a = read(kids.a)
			patchChildren("./box", [{ path: ["also"], value: b }])
			seen.also = read("./box/also")
			patchChildren("./box", [{ path: ["a"] }])
			seen.after = list("./box").sort()
			try {
				patchChildren("./box", [{ path: [], value: {} }])
			} catch (x) {
				seen.whole = (x as ErmineError).code
			}
			seen.who = explainChildren("./box")?.writer?.kind
			patchAttributes("./b", [{ path: ["k"], value: 1 }])
			seen.attrs = explainAttributes("./b")?.writer?.kind
			seen.all = JSON.stringify(
				readAllChildren("./box").map((v) => Object.keys(v.value as object)),
			)
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	assertEquals(seen, {
		names: ["a"],
		a: 1,
		also: 2,
		after: ["also"],
		whole: "not-patches",
		who: "outside",
		attrs: "outside",
		all: '[["also"]]',
	})
	e.close()
})

Deno.test("@ermine/system: peep(f) reads untracked: a memo reading through peep isn't rerun by it", () => {
	const e = createErmine({ features: [manual] })
	let runs = 0
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("./n", 1)
			createMemo("m", () => (runs++, peep(() => read("./n"))))
			createAction("on/bump", () => patch("./n", [{ path: [], value: 2 }]))
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	e.within(() => pulse())
	const before = runs
	e.within(() => executeAction("/code/p/on/bump"))
	e.within(() => pulse())
	assertEquals(runs, before)
	e.close()
})

Deno.test("@ermine/system: with nothing open (a listener, a timer), a handle throws nothing-open as a path does; the host reaches the action", async () => {
	const e = createErmine({ features: [manual] })
	let count: ReturnType<typeof ensureNode> | undefined
	let bump: ReturnType<typeof createAction> | undefined
	e.within(() =>
		ensureNode("/code/p", () => {
			count = ensureNode("./count", 0)
			bump = createAction("on/bump", () => patch("./count", [{ path: [], value: 10 }]))
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	// a timer: nothing open, as a DOM listener's click
	const outcome = await new Promise<unknown[]>((done) =>
		setTimeout(() => {
			const out: unknown[] = []
			for (
				const f of [
					() => patch(count!, [{ path: [], value: 1 }]),
					() => executeAction(bump!),
					() => patch("/code/count", [{ path: [], value: 2 }]),
				]
			) {
				try {
					f()
				} catch (x) {
					out.push((x as ErmineError).code)
				}
			}
			done(out)
		}, 0)
	)
	assertEquals(outcome, ["nothing-open", "nothing-open", "nothing-open"])
	assertEquals(e.within(() => read("/code/count")), 0)
	e.within(() => executeAction(bump!))
	assertEquals(e.within(() => read("/code/count")), 10)
	e.close()
})

Deno.test("@ermine/system: a setup given nothing finds its process; a helper in another file too", () => {
	const e = createErmine({ features: [manual] })
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("./items", { a: 1, b: 2 })
			createAction("on/add", (k: string) => patch("./items", [{ path: [k], value: 0 }]))
			return countOf("./items")
		})
	)
	const p = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in p))
	e.within(() => pulse())
	assertEquals(e.within(() => read("/code/p/count")), 2)
	e.within(() => executeAction("/code/p/on/add", "c"))
	e.within(() => pulse())
	assertEquals(e.within(() => read("/code/items")), { a: 1, b: 2, c: 0 })
	assertEquals(e.within(() => read("/code/p/count")), 3)
	e.close()
})

Deno.test("@ermine/system: nothing open throws nothing-open, naming the function; after an await too", async () => {
	const e = createErmine({ features: [manual] })
	assertThrows(() => read("/x"), ErmineError, "read: nothing is open here")
	let caught: unknown
	let done!: () => void
	const after = new Promise<void>((r) => done = r)
	e.within(() =>
		ensureNode("/code/p", async () => {
			ensureNode("./before", 1)
			await 0
			try {
				ensureNode("./after", 2)
			} catch (x) {
				caught = x
			}
			done()
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	await after
	assertEquals(e.within(() => read("/code/before")), 1)
	assert(caught instanceof ErmineError && caught.code === "nothing-open")
	e.close()
})

Deno.test("@ermine/system: two ermines in one realm, each process its own ermine's", () => {
	const one = createErmine({ features: [manual] })
	const two = createErmine({ features: [manual] })
	one.within(() => ensureNode("/code/p", () => void ensureNode("./v", "one")))
	two.within(() => ensureNode("/code/p", () => void ensureNode("./v", "two")))
	one.start(programAt(one, "/code/p"), "/code/p")
	two.start(programAt(two, "/code/p"), "/code/p")
	assertEquals(one.within(() => read("/code/v")), "one")
	assertEquals(two.within(() => read("/code/v")), "two")
	one.close()
	two.close()
})

Deno.test("@ermine/system: one ermine's handler run inside another's action finds its own: the innermost entered", () => {
	const a = createErmine({ features: [manual] })
	const b = createErmine({ features: [manual] })
	b.start(() => void createAction("on/note", () => ensureNode("./b-note", "b's")), "/code/b")
	a.start(
		() => void createAction("go", () => b.within(() => executeAction("/code/b/on/note"))),
		"/code/a",
	)
	a.within(() => executeAction("/code/a/go"))
	assertEquals(a.within(() => list("/code")), ["a"])
	assertEquals(b.within(() => list("/code")), ["b", "b-note"])
	// and back: a's action, sent from inside b's, writes in a
	a.start(() => void createAction("on/mark", () => ensureNode("./a-mark", 1)), "/code/m")
	b.start(
		() => void createAction("go", () => a.within(() => executeAction("/code/m/on/mark"))),
		"/code/c",
	)
	a.getProcessContext()!.within(() => b.within(() => executeAction("/code/c/go")))
	assertEquals(a.within(() => read("/code/a-mark")), 1)
	assertEquals(b.within(() => hasNode("/code/a-mark")), false)
	a.close()
	b.close()
})

Deno.test("@ermine/system: nothing open here, but a second physical copy's ermine is: two-copies, naming both", () => {
	const copies = (globalThis as Record<symbol, { url: string; open: () => boolean }[]>)[
		Symbol.for("party.chee.ermine.system.copies")
	]
	const other = { url: "file:///vendored/ermine/system/typescript/registry.ts", open: () => true }
	copies.push(other)
	try {
		assertThrows(() => read("/x"), ErmineError, "two copies of @ermine/system are loaded")
		other.open = () => false
		assertThrows(() => read("/x"), ErmineError, "nothing-open")
	} finally {
		copies.splice(copies.indexOf(other), 1)
	}
})

Deno.test("@ermine/system: host code acting as a context opens it (within); args by getArgs", () => {
	const e = createErmine({ features: [manual] })
	e.getProcessContext()!.within(() => ensureNode("/h", 5))
	assertEquals(e.within(() => read("/h")), 5)
	let args: readonly string[] = []
	e.within(() => ensureNode("/code/p", () => void (args = getArgs())))
	e.start(programAt(e, "/code/p"), "/code/p", { args: ["a", "b"] })
	assertEquals(args, ["a", "b"])
	e.close()
})

Deno.test("@ermine/system: a closed ermine is let go: nothing of it found", () => {
	const e = createErmine({ features: [manual] })
	const host = e.getProcessContext()!
	e.close()
	assertThrows(() => host.within(() => read("/x")), ErmineError, "closed")
})

Deno.test("@ermine/system: a second copy of its module (another URL) finds the same processes: one registry", async () => {
	const url = new URL("./nodes.ts", import.meta.url).href
	const copy = await import(`${url}?copy=${Math.random()}`) as typeof import("./nodes.ts")
	assert(copy.ensureNode !== ensureNode)
	const e = createErmine({ features: [manual] })
	e.within(() => ensureNode("/code/p", () => void copy.ensureNode("./v", "from the copy")))
	e.start(programAt(e, "/code/p"), "/code/p")
	assertEquals(e.within(() => read("/code/v")), "from the copy")
	e.close()
})

Deno.test("@ermine/system: a pipe that stops its own process, then throws, is not the pulse's error", () => {
	const e = createErmine({ features: [manual] })
	e.within(() => ensureNode("/src", 1))
	const running = e.start(() => {
		pipe("/src", () => {
			;(running as { stop(): void }).stop()
			throw new Error("after stop")
		})
	}, "/work/p")
	e.within(() => patch("/src", [{ path: [], value: 2 }]))
	e.within(() => pulse())
	e.close()
})

Deno.test("@ermine/system: a pipe's function that rejects fails the pipe's status (observed)", async () => {
	const e = createErmine({ features: [manual] })
	e.within(() => ensureNode("/src", 1))
	let made: unknown
	e.start(() => {
		made = pipe("/src", () => Promise.reject(new Error("later no")), { timing: "write" })
	}, "/code/p")
	e.within(() => patch("/src", [{ path: [], value: 2 }]))
	await new Promise((r) => setTimeout(r))
	const status = e.within(() => getStatus(made as never)) as { state: string; error?: Error }
	assertEquals([status.state, status.error?.message], ["failed", "later no"])
	e.close()
})
