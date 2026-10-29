// where a change came from, from outside the graph (index.ts says the rule): a call given a build
// location keeps it, nothing captured; anything else made from outside, the stack there; made
// inside, nothing: the frames say, up to the process or call that began outside
import { assert, assertEquals, assertNotEquals, assertStrictEquals } from "@std/assert"
import { createErmine } from "./ermine.ts"
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	executeAction,
	patch,
	peep,
	pulse,
	read,
} from "@ermine/system"
import { at, site } from "@ermine/system/site"
import { locationsOf } from "@ermine/places/header"
import { frames } from "@ermine/changeable/stacktrace"
import { get } from "@ermine/places/lib"
import type { ChangeHeader } from "@ermine/graph/entry"
import { manual } from "./manual_fixture.ts"

type E = ReturnType<typeof createErmine>
const changeAt = (e: E, name: string): ChangeHeader => {
	const kids = e.table.get("children", e.places.root as string)?.value as Record<string, string>
	return e.table.get("value", kids[name])!.change as ChangeHeader
}
const here = new URL(import.meta.url).href
// this file's nearest line among the locations a change came from
const lineOf = (c: ChangeHeader) => locationsOf(c.frame)?.find((l) => l.file === here)?.line

Deno.test("site: a call from outside given a build location keeps it alone, nothing captured; a call in its arguments has the stack", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 12, 3)
	e.within(() => {
		at(S, ensureNode)("/x", (ensureNode("/y", 1), 1))
	})
	assertEquals(changeAt(e, "x").frame.info.locations, [
		{ file: "file:///program.ts", line: 12, column: 3, external: true },
	])
	// the call in the arguments has none given: the stack there, ermine's own lines too
	const y = locationsOf(changeAt(e, "y").frame)!
	assert(y.length > 1 && y.some((l) => l.file === here))
	assertEquals(y.every((l) => l.external), true)
	e.close()
})

Deno.test("site: a token not minted, or a function not @ermine/system's, gives nothing: the stack, as any call", () => {
	const e = createErmine({ features: [manual] })
	const mine = () => 1
	assert(at(site("file:///a.ts", 1, 1), mine) === mine)
	assert(at({} as never, patch) === patch)
	e.within(() => at({} as never, ensureNode)("/x", 1))
	assertEquals(lineOf(changeAt(e, "x")) !== undefined, true)
	e.close()
})

Deno.test("site: what the function runs never gets it (taken as it starts)", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 3, 1)
	e.within(() => at(S, peep)(() => ensureNode("/z", 1)))
	assertEquals(
		locationsOf(changeAt(e, "z").frame)!.some((l) => l.file === "file:///program.ts"),
		false,
	)
	assertEquals(lineOf(changeAt(e, "z")) !== undefined, true)
	e.close()
})

Deno.test("site: a computer made from outside through a call given a build location has it in its info; its run's writes too", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 8, 2)
	e.within(() => {
		ensureNode("/n", 1)
		ensureNode("/m", 0)
		at(S, createEffect)("copy", () => read("/n"), (n) => patch("/m", [{ path: [], value: n }]))
	})
	e.within(() => pulse())
	assertEquals(e.within(() => read("/m")), 1)
	// the write is by the run: its frame the run's own, under the computer's, which began outside
	// at the build location
	const m = changeAt(e, "m")
	assertEquals(m.frame.parent?.info.locations, [{
		file: "file:///program.ts",
		line: 8,
		column: 2,
		external: true,
	}])
	assertEquals(m.frame.info.run, 1)
	e.close()
})

// the line after the one calling this
const nextLine = () => frames(new Error().stack!)[1].line + 1

Deno.test("site: a write or make in a setup has the process's frame: where it was started, from outside, whichever line wrote it", () => {
	const e = createErmine({ features: [manual] })
	let started = 0
	started = nextLine()
	e.start(() => {
		ensureNode("/a", 0)
		ensureNode("/b", 1)
		patch("/a", [{ path: [], value: 1 }])
		createMemo("m", () => read("/a"))
		createEffect("fx", () => read("/a"), (n) => patch("/b", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	const header = (name: string) => changeAt(e, name)
	const memo = e.table.get("value", get(e.places, ["p", "m"])!)!.change as ChangeHeader
	const effect = e.table.get("value", get(e.places, ["p", "fx"])!)!.change as ChangeHeader
	// a setup's write: nothing captured at it; its frame has no locations, the process's does
	for (const c of [header("a"), header("b"), memo]) {
		assertEquals(c.frame.info.locations, undefined)
		assertEquals(lineOf(c), started)
	}
	// the effect's act wrote b: its frame the computer's, whose frame is under the process's
	assertEquals(lineOf(effect), started)
	assertEquals(lineOf(header("b")), started)
	e.close()
})

// the captures a process of n writes, n patches and n memos in its setup makes while it starts
// (the limit raised to Infinity is a capture's: header.ts, start.ts)
function captures(n: number): number {
	const was = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")!
	let count = 0
	let limit = Error.stackTraceLimit
	Object.defineProperty(Error, "stackTraceLimit", {
		configurable: true,
		get: () => limit,
		set: (v: number) => {
			if (v === Infinity) count++
			limit = v
		},
	})
	try {
		const e = createErmine({ features: [manual] })
		e.start(() => {
			for (let i = 0; i < n; i++) ensureNode(`/n${i}`, i)
			for (let i = 0; i < n; i++) patch(`/n${i}`, [{ path: [], value: -i }])
			for (let i = 0; i < n; i++) createMemo(`m${i}`, () => read(`/n${i}`))
		}, "/p")
		e.within(() => pulse())
		const started = count
		e.close()
		return started
	} finally {
		Object.defineProperty(Error, "stackTraceLimit", was)
	}
}

Deno.test("site: a process's setup captures nothing, however many writes and makes it does", () => {
	const none = captures(0)
	assertEquals(captures(1), none)
	assertEquals(captures(60), none)
})

Deno.test("site: two processes have a frame each; the host keeps each call's; an action's call, from outside its own, in a setup its starter's [chee 10-29: frames in the graph]", () => {
	const e = createErmine({ features: [manual] })
	e.start(() => void ensureNode("/a", 0), "/p")
	e.start(() => {
		ensureNode("/b", 0)
		createAction("on/put", () => void patch("/b", [{ path: [], value: 1 }]))
	}, "/q")
	const a = lineOf(changeAt(e, "a"))!
	const b = lineOf(changeAt(e, "b"))!
	assertNotEquals(a, b)
	// the host: each call its own
	e.within(() => {
		ensureNode("/h1", 0)
		ensureNode("/h2", 0)
	})
	assertNotEquals(lineOf(changeAt(e, "h1")), lineOf(changeAt(e, "h2")))
	// an action's call, called in a setup: inside, the frames go up through its handler's to q's
	e.start(() => executeAction("/q/on/put"), "/r")
	assertEquals(lineOf(changeAt(e, "b")), b)
	assertEquals(changeAt(e, "b").frame.info.call, 1)
	// a handler the host made, called from outside: the call began there, its line (the click)
	let made = 0
	e.within(() => {
		made = nextLine()
		createAction("/on/h", (v: unknown) => void patch("/h1", [{ path: [], value: v }]))
	})
	let called = 0
	e.within(() => {
		called = nextLine()
		executeAction("/on/h", 1)
	})
	assertEquals(lineOf(changeAt(e, "h1")), called)
	// called in a setup: not a click, and the handler's frames (the host's, none with locations)
	// are all the call is under, so its write is from outside too: the stack at the write, where
	// the handler's own line is nearest
	e.start(() => executeAction("/on/h", 2), "/s")
	assertEquals(lineOf(changeAt(e, "h1")), made)
	e.close()
})

Deno.test("site: a write inside a run is the run's frame, shared with the header, never copied", () => {
	const e = createErmine({ features: [manual] })
	e.start(() => {
		ensureNode("/n", 1)
		ensureNode("/m", 0)
		createEffect("copy", () => read("/n"), (n) => patch("/m", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	const m = changeAt(e, "m")
	assertEquals(m.frame.info.run, 1)
	assertStrictEquals(e.records.run(get(e.places, ["p", "copy"])!)?.frame, m.frame)
	e.close()
})
