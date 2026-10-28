// software: a program is a node, a loader an action; run starts the program's process through it.
// on @ermine/system's createErmine, the host placing what it likes with within
import { assert, assertEquals, assertThrows } from "@std/assert"
import {
	createErmine,
	createMemo,
	ensureNode,
	getNode,
	getStatus,
	patch,
	pulse,
	read,
	unplace,
} from "@ermine/system"
import { get } from "@ermine/core/places/lib"
import { manual } from "../../../ermine/system/typescript/manual_fixture.ts"
import { createLoader, NEEDS, PROVIDES, run } from "./software.ts"

// a loader that takes the code as a number n and makes a setup writing it, doubled, to the process
const world = () => {
	const e = createErmine({ features: [manual] })
	const ran: unknown[] = []
	e.within(() => {
		createLoader("/loaders/double", (code) => () => {
			ran.push(code)
			return (code as number) * 2
		})
		ensureNode("/apps/five", 5)
	})
	return { e, ran, pulse: () => e.within(() => pulse()) }
}
const idOf = (e: ReturnType<typeof createErmine>, path: string[]) => get(e.places, path)!

Deno.test("run: the loader's action starts a process at `at` whose setup runs what the loader made of the program", () => {
	const { e, ran } = world()
	const r = e.within(() => run("/loaders/double", "/apps/five", "/work/five"))
	assert(!("refused" in r))
	assertEquals(r.process.at, ["work", "five"])
	assertEquals(ran, [5])
	assertEquals(e.within(() => read("/work/five")), 10)
	assertEquals(r.status(), { state: "done" })
	// the same place again: taken
	assertEquals(e.within(() => run("/loaders/double", "/apps/five", "/work/five")), {
		refused: "taken",
		at: ["work", "five"],
	})
	e.close()
})

Deno.test("the call record shows the loader, its end and the program among its reads", () => {
	const { e } = world()
	e.within(() => run("/loaders/double", "/apps/five", "/work/five"))
	const loader = idOf(e, ["loaders", "double"])
	const call = e.records.call(loader)!
	assertEquals(call.handler.id, loader)
	assertEquals(call.args.slice(0, 2), ["/apps/five", "/work/five"])
	assertEquals(call.end, "done")
	assertEquals(call.reads.map((r) => (r as { id: string }).id), [idOf(e, ["apps", "five"])])
	e.close()
})

Deno.test("code not there yet is pending, and placed it runs, once; new code is not rerun", () => {
	const { e, ran, pulse } = world()
	const r = e.within(() => run("/loaders/double", "/apps/later", "/work/later"))
	assert(!("refused" in r))
	pulse()
	assertEquals(ran, [])
	assertEquals(e.within(() => getStatus("/work/later/code" as never))?.state, "pending")
	e.within(() => ensureNode("/apps/later", 21))
	pulse()
	assertEquals(ran, [21])
	assertEquals(e.within(() => getStatus("/work/later/code" as never))?.state, "done")
	e.within(() => patch("/apps/later", [{ path: [], value: 22 }]))
	pulse()
	pulse()
	assertEquals(ran, [21])
	e.close()
})

Deno.test("a process places a loader (an interpreter); a program runs through it; stopping the interpreter stops what it ran", () => {
	const { e, ran } = world()
	const lisp = e.start(() => {
		createLoader("loaders/lisp", (code) => () => {
			ran.push(["lisp", code])
			createMemo("answer", () => String(code).length)
		})
	}, "/lisp")
	assert(!("refused" in lisp))
	e.within(() => ensureNode("/apps/prog", "(+ 1 2)"))
	const r = e.within(() => run("/lisp/loaders/lisp", "/apps/prog", "/work/prog"))
	assert(!("refused" in r))
	assertEquals(ran, [["lisp", "(+ 1 2)"]])
	assertEquals(e.within(() => get(e.places, ["work", "prog"])) !== undefined, true)
	lisp.stop()
	assertEquals(get(e.places, ["work", "prog"]), undefined)
	// and the interpreter's loader is gone with it
	assertEquals(get(e.places, ["lisp"]), undefined)
	e.close()
})

Deno.test("a loader that throws refuses: the caller sees the error, the record says failed", () => {
	const e = createErmine({ features: [manual] })
	e.within(() => {
		createLoader("/loaders/no", () => {
			throw new Error("no native code here")
		})
		ensureNode("/apps/p", 1)
	})
	assertThrows(() => e.within(() => run("/loaders/no", "/apps/p", "/work/p")), Error, "no native")
	const call = e.records.call(idOf(e, ["loaders", "no"]))!
	assertEquals(call.end, "failed")
	assertEquals((call.error as Error).message, "no native code here")
	assertEquals(get(e.places, ["work", "p"]), undefined)
	e.close()
})

Deno.test("a setup that throws fails its process; the call is done", () => {
	const e = createErmine({ features: [manual] })
	e.within(() => {
		createLoader("/loaders/bad", () => () => {
			throw new Error("setup broke")
		})
		ensureNode("/apps/p", 1)
	})
	const r = e.within(() => run("/loaders/bad", "/apps/p", "/work/p"))
	assert(!("refused" in r))
	assertEquals(r.status()?.state, "failed")
	assertEquals(e.records.call(idOf(e, ["loaders", "bad"]))!.end, "done")
	e.close()
})

Deno.test("the attribute names are exported; a loader and a program carry what whoever placed them wrote", () => {
	assertEquals([NEEDS, PROVIDES], ["love.ermine.software.needs", "love.ermine.software.provides"])
	const { e } = world()
	assertEquals(typeof e.within(() => getNode("/loaders/double")), "object")
	e.close()
})

Deno.test("the loader's node unplaced: what it ran stays (the placing scope owns it, not the node); the program too", () => {
	const { e } = world()
	e.within(() => run("/loaders/double", "/apps/five", "/work/five"))
	assertEquals(e.within(() => read("/work/five")), 10)
	e.within(() => unplace("/loaders/double"))
	assertEquals(e.within(() => read("/work/five")), 10)
	assertEquals(e.within(() => read("/apps/five")), 5)
	e.close()
})
