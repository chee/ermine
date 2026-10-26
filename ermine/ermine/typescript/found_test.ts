import { assert, assertEquals, assertThrows } from "@std/assert"
import { createErmine, ErmineError } from "./ermine.ts"
import { countOf } from "./found_fixture.ts"
import { edit, getArgs, method, open, read } from "./found.ts"

Deno.test("a setup given nothing: its words, imported, find its process; a helper in another file too", () => {
	const e = createErmine({ schedule: () => {} })
	e.open("/code/p", () => {
		open("./items", { a: 1, b: 2 })
		method("on/add", (k: string) => edit("./items", [{ path: [k], value: 0 }]))
		return countOf("./items")
	})
	const p = e.start("/code/p")
	assert(!("refused" in p))
	e.pulse()
	assertEquals(e.read("/code/p/count"), 2)
	e.send("/code/p/on/add", "c")
	e.pulse()
	assertEquals(e.read("/code/items"), { a: 1, b: 2, c: 0 })
	assertEquals(e.read("/code/p/count"), 3)
	e.close()
})

Deno.test("with nothing open, an imported word throws nothing-open, naming itself", () => {
	const e = createErmine({ schedule: () => {} })
	assertThrows(() => read("/x"), ErmineError, "read: nothing is open here")
	e.close()
})

Deno.test("after an await, an imported word finds nothing open", async () => {
	const e = createErmine({ schedule: () => {} })
	let caught: unknown
	let done!: () => void
	const after = new Promise<void>((r) => done = r)
	e.open("/code/p", async () => {
		open("./before", 1)
		await 0
		try {
			open("./after", 2)
		} catch (x) {
			caught = x
		}
		done()
	})
	e.start("/code/p")
	await after
	assertEquals(e.read("/code/before"), 1)
	assert(caught instanceof ErmineError && caught.code === "nothing-open")
	e.close()
})

Deno.test("two ermines in one realm: each process's words are its own ermine's", () => {
	const one = createErmine({ schedule: () => {} })
	const two = createErmine({ schedule: () => {} })
	one.open("/code/p", () => void open("./v", "one"))
	two.open("/code/p", () => void open("./v", "two"))
	one.start("/code/p")
	two.start("/code/p")
	assertEquals(one.read("/code/v"), "one")
	assertEquals(two.read("/code/v"), "two")
	one.close()
	two.close()
})

Deno.test("host code finds the host's words inside its context's within; args by getArgs", () => {
	const e = createErmine({ schedule: () => {} })
	e.getProcessContext()!.within(() => open("/h", 5))
	assertEquals(e.read("/h"), 5)
	let args: readonly string[] = []
	e.open("/code/p", () => void (args = getArgs()))
	e.start("/code/p", { args: ["a", "b"] })
	assertEquals(args, ["a", "b"])
	e.close()
})

Deno.test("a closed ermine's scheduler is let go: its words no longer found", () => {
	const e = createErmine({ schedule: () => {} })
	const host = e.getProcessContext()!
	e.close()
	assertThrows(() => host.within(() => read("/x")), ErmineError, "closed")
})

Deno.test("a second copy of found.ts (another URL) finds the same processes: registry.ts is one module", async () => {
	const copy = await import(`./found.ts?copy=${Math.random()}`) as typeof import("./found.ts")
	assert(copy.open !== open)
	const e = createErmine({ schedule: () => {} })
	e.open("/code/p", () => void copy.open("./v", "from the copy"))
	e.start("/code/p")
	assertEquals(e.read("/code/v"), "from the copy")
	e.close()
})
