// build sites (site.ts): a call given one keeps it, captures nothing; anything else, the trace;
// in a process's setup, the process's site (index.ts says the rule)
import { assert, assertEquals, assertNotEquals } from "@std/assert"
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
import { traceOf } from "@ermine/core/places/header"
import { frames } from "@ermine/core/util/stacktrace"
import { get } from "@ermine/core/places/lib"
import type { ChangeHeader } from "@ermine/core/node/entry"
import { manual } from "./manual_fixture.ts"
import { trace, traceAlways } from "./trace.ts"

type E = ReturnType<typeof createErmine>
const changeAt = (e: E, name: string): ChangeHeader => {
	const kids = e.table.get("children", e.places.root as string)?.value as Record<string, string>
	return e.table.get("value", kids[name])!.change as ChangeHeader
}
const here = new URL(import.meta.url).href

Deno.test("site: a call given a build site keeps it, nothing captured; a call in its arguments, the process's", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 12, 3)
	e.start(() => {
		at(S, ensureNode)("/x", (ensureNode("/y", 1), 1))
	}, "/p")
	assertEquals(changeAt(e, "x").external, [{ file: "file:///program.ts", line: 12, column: 3 }])
	assertEquals(traceOf(changeAt(e, "x")), undefined)
	// the call in the arguments has none given: in setup, the process's
	assertEquals(changeAt(e, "y").external?.[0]?.file, here)
	assertEquals(changeAt(e, "y").external?.[0]?.function, "setup")
	e.close()
})

Deno.test("site: a token not minted, or a function not @ermine/system's, gives nothing", () => {
	const e = createErmine({ features: [manual] })
	const mine = () => 1
	assert(at(site("file:///a.ts", 1, 1), mine) === mine)
	assert(at({} as never, patch) === patch)
	e.start(() => {
		at({} as never, ensureNode)("/x", 1)
	}, "/p")
	assertEquals(changeAt(e, "x").external?.[0]?.file, here)
	assertEquals(changeAt(e, "x").external?.[0]?.function, "setup")
	e.close()
})

Deno.test("site: what the function runs never gets it (taken as it starts)", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 3, 1)
	e.start(() => {
		at(S, peep)(() => ensureNode("/z", 1))
	}, "/p")
	assertEquals(changeAt(e, "z").external?.[0]?.file, here)
	assertEquals(changeAt(e, "z").external?.[0]?.function, "setup")
	e.close()
})

Deno.test("site: trace always keeps the text beside a build site", () => {
	const e = createErmine({ features: [manual, traceAlways] })
	const S = site("file:///program.ts", 5, 1)
	e.start(() => void at(S, ensureNode)("/x", 1), "/p")
	assertEquals(changeAt(e, "x").external, [{ file: "file:///program.ts", line: 5, column: 1 }])
	assert(traceOf(changeAt(e, "x"))?.includes(here))
	e.close()
})

Deno.test("site: a computer made through a call given a build site has that site; its run's writes too", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 8, 2)
	e.start(() => {
		ensureNode("/n", 1)
		ensureNode("/m", 0)
		at(S, createEffect)("copy", () => read("/n"), (n) => patch("/m", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	assertEquals(e.within(() => read("/m")), 1)
	assertEquals(changeAt(e, "m").external, [{ file: "file:///program.ts", line: 8, column: 2 }])
	e.close()
})

// the line after the one calling this
const nextLine = () => frames(new Error().stack!)[1].line + 1
const siteOf = (e: E, name: string) => changeAt(e, name).external?.[0]

Deno.test("site: a write or make in a setup has the process's site: its first call's line, function setup, the same for all", () => {
	const e = createErmine({ features: [manual] })
	let first = 0
	e.start(() => {
		first = nextLine()
		ensureNode("/a", 0)
		ensureNode("/b", 1)
		patch("/a", [{ path: [], value: 1 }])
		createMemo("m", () => read("/a"))
		createEffect("fx", () => read("/a"), (n) => patch("/b", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	// the node a memo or effect wrote is its own; the site is the process's whichever wrote it
	const sites = [
		changeAt(e, "a"),
		changeAt(e, "b"),
		e.table.get("value", get(e.places, ["p", "m"])!)!.change as ChangeHeader,
		e.table.get("value", get(e.places, ["p", "fx"])!)!.change as ChangeHeader,
	].map((c) => c.external![0])
	for (const at of sites) {
		assertEquals([at.file, at.line, at.function], [here, first, "setup"])
		assertEquals(at, sites[0])
	}
	assert(sites[0].column! > 0)
	e.close()
})

// the captures a process of n writes, n patches and n memos in its setup makes while it starts
// (closing it removes each node, with a capture of its own: not counted)
function captures(n: number): number {
	const E = Error as unknown as { captureStackTrace: (...a: unknown[]) => unknown }
	const was = E.captureStackTrace
	let count = 0
	E.captureStackTrace = (...a) => (count++, was.apply(Error, a))
	const e = createErmine({ features: [manual] })
	try {
		e.start(() => {
			for (let i = 0; i < n; i++) ensureNode(`/n${i}`, i)
			for (let i = 0; i < n; i++) patch(`/n${i}`, [{ path: [], value: -i }])
			for (let i = 0; i < n; i++) createMemo(`m${i}`, () => read(`/n${i}`))
		}, "/p")
		e.within(() => pulse())
	} finally {
		E.captureStackTrace = was
	}
	e.close()
	return count
}

Deno.test("site: a process's setup captures once, however many writes and makes it does", () => {
	// what a process costs to start (its rows) and to end is the same for any n: the setup's own is
	// one more than none, whatever n
	const none = captures(0)
	assertEquals(captures(1), none + 1)
	assertEquals(captures(60), none + 1)
})

Deno.test("site: two processes have a site each; the host keeps each call's; an action's call, its handler's [chee 10-28: frames walked]", () => {
	const e = createErmine({ features: [manual] })
	e.start(() => void ensureNode("/a", 0), "/p")
	e.start(() => {
		ensureNode("/b", 0)
		createAction("on/put", () => void patch("/b", [{ path: [], value: 1 }]))
	}, "/q")
	const a = siteOf(e, "a")!
	const b = siteOf(e, "b")!
	assertEquals([a.function, b.function], ["setup", "setup"])
	assertNotEquals(a.line, b.line)
	// the host: each call its own
	e.within(() => {
		ensureNode("/h1", 0)
		ensureNode("/h2", 0)
	})
	assertEquals(siteOf(e, "h1")!.function, undefined)
	assertNotEquals(siteOf(e, "h1")!.line, siteOf(e, "h2")!.line)
	// an action's call, called in a setup or after: its handler's site, placed in q's setup: q's
	e.start(() => executeAction("/q/on/put"), "/r")
	assertEquals(siteOf(e, "b"), b)
	// a handler the host made: the line createAction was called at, whoever calls it
	let made = 0
	e.within(() => {
		made = nextLine()
		createAction("/on/h", () => void patch("/h1", [{ path: [], value: 1 }]))
	})
	e.start(() => executeAction("/on/h"), "/s")
	assertEquals([siteOf(e, "h1")!.line, siteOf(e, "h1")!.function], [made, undefined])
	e.close()
})

Deno.test("site: a write's own build site comes first, in a run too [chee 10-28]", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 4, 2)
	e.start(() => {
		ensureNode("/n", 1)
		ensureNode("/m", 0)
		createEffect("copy", () => read("/n"), (n) => at(S, patch)("/m", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	assertEquals(changeAt(e, "m").external, [{ file: "file:///program.ts", line: 4, column: 2 }])
	e.close()
})

Deno.test("site: the trace feature asks for the text, so each call in a setup is captured, at its own line", () => {
	const e = createErmine({ features: [manual, trace] })
	e.start(() => {
		ensureNode("/a", 0)
		ensureNode("/b", 0)
	}, "/p")
	assertEquals(siteOf(e, "a")!.function, undefined)
	assertNotEquals(siteOf(e, "a")!.line, siteOf(e, "b")!.line)
	assert(traceOf(changeAt(e, "a")) !== undefined)
	e.close()
})
