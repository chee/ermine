// pipes as a program uses them (pipe.ts), beside the scenarios (conformance/pipe)
import { assert, assertEquals, assertThrows } from "@std/assert"
import {
	createEffect,
	createErmine,
	ensureNode,
	type Ermine,
	explain,
	getNode,
	getStatus,
	patch,
	pulse,
	read,
} from "@ermine/system"
import pipes, { pipe, type Told } from "./pipe.ts"
import { manual } from "../../../ermine/system/typescript/manual_fixture.ts"

// an ermine with pipes, pulses run by hand; setup run as a process at /code/p
function world(setup: () => void): Ermine {
	const e = createErmine({ features: [pipes, manual] })
	e.within(() => {
		ensureNode("/a", 0)
		ensureNode("/b", 0)
	})
	e.start(setup, "/code/p")
	e.within(() => pulse())
	return e
}

Deno.test("a reader of both ends, in the pulse a pulse pipe carries a write: it acts on both new", () => {
	const seen: unknown[] = []
	const e = world(() => {
		pipe("/a", "/b")
		createEffect("both", () => [read("/a"), read("/b")], (v) => void seen.push(v))
	})
	e.within(() => patch("/a", [{ path: [], value: 1 }]))
	e.within(() => pulse())
	assertEquals(seen, [[0, 0], [1, 1]])
	e.close()
})

Deno.test("what a function is told: the patches, the change's view, from as given, the value now", () => {
	const told: Told[] = []
	const e = world(() => void pipe("/a", (w: Told) => void told.push(w), { timing: "write" }))
	e.within(() => patch("/a", [{ path: [], value: { x: 1 } }]))
	e.within(() => patch("/a", [{ path: ["x"], value: 2 }]))
	assertEquals(told.map((w) => [w.from, w.patches, w.value]), [
		["/a", [{ path: [], value: { x: 1 } }], { x: 2 }],
		["/a", [{ path: ["x"], value: 2 }], { x: 2 }],
	])
	// the view explain takes back: the host wrote it
	assertEquals(e.within(() => explain(told[1].change))?.writer?.kind, "outside")
	e.close()
})

Deno.test("a path as a list of names, given as a handle; a list is fan-in", () => {
	const from: unknown[] = []
	const e = world(() => {
		ensureNode("/d/e", 0)
		pipe([getNode(["/", "d", "e"]), "/a"], (w: Told) => void from.push(w.from), {
			timing: "write",
		})
	})
	e.within(() => patch("/d/e", [{ path: [], value: 1 }]))
	e.within(() => patch("/a", [{ path: [], value: 1 }]))
	assertEquals(from[1], "/a")
	assert(from[0] !== undefined && typeof from[0] !== "string")
	e.close()
})

Deno.test("options are a plain object last; a function second is a watch", () => {
	let watched = 0
	const e = world(() => {
		pipe("/a", () => void watched++, { name: "w" })
		pipe("/a", "/b", { name: "m", timing: "write" })
	})
	e.within(() => patch("/a", [{ path: [], value: 3 }]))
	assertEquals(e.within(() => read("/b")), 3)
	e.within(() => pulse())
	assertEquals(watched, 1)
	assertEquals(e.within(() => getStatus("/code/p/w"))?.state, "done")
	assertEquals(e.within(() => getStatus("/code/p/m"))?.state, "done")
	e.close()
})

Deno.test("no pipe feature in the ermine: pipe says so", () => {
	const e = createErmine({ features: [manual] })
	assertThrows(() => e.within(() => pipe("/x", "/y")), Error, "no ermine with the pipe feature")
	e.close()
})

Deno.test("an ermine closed leaves pipes working in the next, and is collected: pipe holds none", async () => {
	const once = () => {
		const e = world(() => void pipe("/a", "/b", { timing: "write" }))
		e.within(() => patch("/a", [{ path: [], value: 5 }]))
		const b = e.within(() => read("/b"))
		e.close()
		return b
	}
	assertEquals(once(), 5)
	assertEquals(once(), 5)
	let died = 0
	const registry = new FinalizationRegistry(() => died++)
	;(() => {
		const e = world(() => void pipe("/a", "/b"))
		registry.register(e, 0)
		e.close()
	})()
	const gc = (globalThis as { gc?: () => void }).gc
	for (let i = 0; i < 200 && died < 1; i++) {
		gc?.()
		const junk: unknown[] = []
		for (let j = 0; j < 1000; j++) junk.push(new Array(1000).fill(j))
		await new Promise((r) => setTimeout(r, 5))
	}
	assert(died === 1, "a closed ermine was held")
})

Deno.test("an ermine kept: pipe finds its feature after garbage is collected", async () => {
	const e = world(() => {})
	const gc = (globalThis as { gc?: () => void }).gc
	for (let i = 0; i < 20; i++) {
		gc?.()
		const junk: unknown[] = []
		for (let j = 0; j < 1000; j++) junk.push(new Array(1000).fill(j))
		await new Promise((r) => setTimeout(r, 5))
	}
	e.within(() => pipe("/a", "/b", { timing: "write" }))
	e.within(() => patch("/a", [{ path: [], value: 2 }]))
	assertEquals(e.within(() => read("/b")), 2)
	e.close()
})
