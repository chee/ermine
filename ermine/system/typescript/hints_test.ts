import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import { PlacesError } from "@ermine/core/places"
import { Refusal } from "@ermine/core/places/guard"
import { no, yes } from "@ermine/core/protect"
import { PENDING, SchedulerError } from "@ermine/core/scheduler"
import { createErmine, ErmineError, FeatureError, type Status } from "./ermine.ts"
import { bare, hint, hintStatus } from "./hints.ts"
import {
	createAction,
	createMemo,
	ensureNode,
	executeAction,
	getNode,
	getStatus,
	patch,
	patchChildren,
	place,
	pulse,
	read,
} from "@ermine/system"
import { manual } from "./manual_fixture.ts"
import { hints } from "./hints.ts"

// what f threw
function thrown(f: () => unknown): unknown {
	try {
		f()
	} catch (e) {
		return e
	}
	throw new Error("it didn't throw")
}
// e hinted: the code's text first, as the base gives it, then the hint; the hint has every one of
// says in it
function hinted(e: unknown, text: string, ...says: string[]): string {
	assert(e instanceof Error)
	const h = (e as { hint?: string }).hint
	assert(typeof h === "string", `no hint on ${e.message}`)
	assertEquals(bare(e), text)
	assertEquals(e.message, `${text}\nhint: ${h}`)
	// not enumerable: a print shows it once, in the message
	assertEquals(Object.keys(e).includes("hint"), false)
	for (const s of says) assert(h.includes(s), `"${h}" doesn't say ${s}`)
	return h
}
// the error a process's setup threw, as its status shows it
function setupError(f: () => void, options: Parameters<typeof createErmine>[0] = {}) {
	const e = createErmine({ features: [manual, hints], ...options })
	const s = e.start(f, "/work/p")
	assert("status" in s)
	const st = s.status()
	e.close()
	return st
}

Deno.test("hints: nothing-there for a write names the path as the program sees it, and ensureNode", () => {
	let caught: unknown
	setupError(() => {
		caught = thrown(() => patch("count", [{ path: [], value: 1 }]))
	})
	assert(caught instanceof PlacesError)
	assertEquals(caught.code, "nothing-there")
	hinted(caught, "nothing-there (work/p/count)", "/work/p/count", "ensureNode", "patch")
})

Deno.test("hints: nothing-there for a memo in a folder not there names the folder", () => {
	let caught: unknown
	setupError(() => {
		caught = thrown(() => createMemo("nofolder/x", () => 1))
	})
	hinted(caught, "nothing-there (work/p/nofolder/x)", "/work/p/nofolder", "createMemo")
})

Deno.test("hints: nothing-there for a path above the root", () => {
	const e = createErmine({ features: [manual, hints] })
	const caught = thrown(() => e.within(() => getNode("../..")))
	e.close()
	hinted(caught, "nothing-there (..)", `too many ".."`)
})

Deno.test("hints: already-there for two memos of one name in one setup", () => {
	let caught: unknown
	setupError(() => {
		createMemo("total", () => 1)
		caught = thrown(() => createMemo("total", () => 2))
	})
	assert(caught instanceof PlacesError)
	hinted(caught, "already-there (work/p/total)", "/work/p/total", "its own name")
})

Deno.test("hints: already-there for a place onto a name taken", () => {
	const e = createErmine({ features: [manual, hints] })
	e.within(() => ensureNode("/a", 1))
	e.within(() => ensureNode("/b", 2))
	const caught = thrown(() => e.within(() => place("/a", "/b")))
	e.close()
	hinted(caught, "already-there (a)", `"a" is taken`, "unplace")
})

Deno.test("hints: not-a-name", () => {
	const e = createErmine({ features: [manual, hints] })
	const caught = thrown(() => e.within(() => ensureNode(["x", ""], 1)))
	e.close()
	assert(caught instanceof PlacesError)
	assertEquals(caught.code, "not-a-name")
	hinted(caught, bare(caught), "never empty")
})

Deno.test("hints: not-a-method", () => {
	const e = createErmine({ features: [manual, hints] })
	e.within(() => ensureNode("/v", 1))
	const caught = thrown(() => e.within(() => executeAction("/v")))
	e.close()
	hinted(caught, "not-a-method (v)", "/v", "createAction")
})

Deno.test("hints: nothing-open, a function called with nothing open", () => {
	const e = createErmine({ features: [manual, hints] })
	const caught = thrown(() => read("/x"))
	e.close()
	assert(caught instanceof ErmineError)
	assertEquals(caught.code, "nothing-open")
	hinted(caught, bare(caught), "read", "before the await", "createMemo")
})

Deno.test("hints: not-a-handle, not-a-value, not-patches", () => {
	const e = createErmine({ features: [manual, hints] })
	e.within(() => ensureNode("/a", 1))
	const handle = thrown(() => e.within(() => read({} as never)))
	const value = thrown(() => JSON.stringify(e.within(() => getNode("/a"))))
	const patches = thrown(() => e.within(() => patch("/a", { value: 2 } as never)))
	const kids = thrown(() => e.within(() => patchChildren("/", [{ path: ["a", "b"], value: 1 }])))
	e.close()
	hinted(handle, bare(handle), "pass a path")
	hinted(value, bare(value), "read(node)")
	hinted(patches, bare(patches), "patch takes a list of patches")
	hinted(kids, bare(kids), "one name a patch")
})

Deno.test("hints: start's not-a-function", () => {
	const e = createErmine({ features: [manual, hints] })
	const fn = thrown(() => e.start("/code/p" as never, "/p"))
	e.close()
	hinted(fn, bare(fn), "start(program")
})

Deno.test("hints: closed", () => {
	const e = createErmine({ features: [manual, hints] })
	e.close()
	const caught = thrown(() => e.within(() => read("/x")))
	assert(caught instanceof ErmineError)
	hinted(caught, "closed: ermine is closed", "addTeardown")
})

Deno.test("hints: a refusal says what and whose, by the program's path", () => {
	let caught: unknown
	setupError(() => {
		ensureNode("/shared", 1)
		caught = thrown(() => patch("/shared", [{ path: [], value: 2 }]))
	}, { may: (ask) => ask.op === "edit" ? no("not yours") : yes })
	assert(caught instanceof Refusal)
	hinted(caught, "edit refused: not yours", "host's policy", "/shared", "a node of its own")
})

Deno.test("hints: a failed status's error is the thrown one, hinted", () => {
	const e = createErmine({ features: [manual, hints] })
	e.start(() => {
		createMemo("m", () => patch("missing", [{ path: [], value: 1 }]))
	}, "/work/p")
	e.within(() => pulse())
	const st = e.within(() => getStatus("/work/p/m"))
	e.close()
	assertEquals(st?.state, "failed")
	hinted(st?.error, "nothing-there (work/p/missing)", "/work/p/missing")
})

Deno.test("hints: a setup pending on a read or a send says setup runs once, and what it waits on", () => {
	const read1 = setupError(() => void read("missing"))
	assertEquals(read1?.state, "pending")
	assert(read1?.hint?.includes("/work/p/missing"), read1?.hint)
	assert(read1?.hint?.includes("runs once and never again"), read1?.hint)
	assert(read1?.hint?.includes("createEffect"), read1?.hint)
	const sent = setupError(() => void executeAction("/on/go"))
	assert(sent?.hint?.includes(`executeAction("/on/go") has no action there yet`), sent?.hint)
	assert(sent?.hint?.includes("runs once"), sent?.hint)
	// a memo waiting is no stuck setup: no hint
	const e = createErmine({ features: [manual, hints] })
	e.start(() => void createMemo("m", () => read("missing")), "/work/p")
	e.within(() => pulse())
	const memo = e.within(() => getStatus("/work/p/m"))
	e.close()
	assertEquals(memo?.state, "pending")
	assertEquals(memo?.hint, undefined)
	// a setup's promise: none either
	const later = setupError(() => new Promise(() => {}))
	assertEquals(later?.state, "pending")
	assertEquals(later?.hint, undefined)
})

Deno.test("hints: PENDING itself is never touched; hint(PENDING) says how to show loading", () => {
	const e = createErmine({ features: [manual, hints] })
	const caught = thrown(() => e.within(() => read("/counter/count")))
	e.close()
	assertStrictEquals(caught, PENDING)
	const h = hint(PENDING, { fn: "read" })!
	for (const s of ["not undefined", "hasNode", `getStatus(x)?.state === "pending"`, "peep"]) {
		assert(h.includes(s), h)
	}
	const st: Status = { state: "pending", waiting: [{ node: ["counter", "count"] }] }
	assert(hint(PENDING, { fn: "read", status: st })!.includes("/counter/count"))
})

Deno.test("hints: the rest by hint(): scheduler errors, a feature's, looping", () => {
	assert(hint(new SchedulerError("disposed", "the scope is disposed"))!.includes("addTeardown"))
	assert(hint(new SchedulerError("unscoped", "no scope is open"))!.includes("a setup"))
	assert(hint(new FeatureError("pully", "onWrite", new Error("x")))!.includes(`"pully"`))
	const looping = hintStatus({ state: "looping", error: new Error("looping") }, true)
	assert(looping.hint?.includes("it loops"))
	assertEquals(hint(new Error("a program's own")), undefined)
	// a program's own throw passes as it is: its status's error unhinted
	const own = setupError(() => {
		throw new Error("mine")
	})?.error
	assert(own instanceof Error)
	assertEquals(own.message, "mine")
	assertEquals("hint" in own, false)
})

Deno.test("hints: without the hints feature, the bare error and status", () => {
	let caught: unknown
	const st = setupError(() => {
		caught = thrown(() => patch("count", [{ path: [], value: 1 }]))
		read("missing")
	}, { features: [manual] })
	assert(caught instanceof PlacesError)
	assertEquals(caught.message, "nothing-there (work/p/count)")
	assertEquals("hint" in caught, false)
	assertEquals(st?.state, "pending")
	assertEquals(st?.hint, undefined)
	const e = createErmine({ features: [manual] })
	const fn = thrown(() => e.start("/x" as never, "/p"))
	e.close()
	assertEquals((fn as Error).message, "not-a-function: start takes the program: its function")
	assertEquals("hint" in (fn as Error), false)
})

Deno.test("hints: an action's error, thrown on through executeAction, carries the action's hint once", () => {
	const e = createErmine({ features: [manual, hints] })
	e.start(() => {
		createAction("on/go", () => patch("missing", [{ path: [], value: 1 }]))
	}, "/work/p")
	const caught = thrown(() => e.within(() => executeAction("/work/p/on/go")))
	e.close()
	hinted(caught, "nothing-there (work/p/missing)", "/work/p/missing")
	assertEquals((caught as Error).message.split("\nhint: ").length, 2)
})
