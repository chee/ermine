// pully's and patchy's module state: every ermine set up with them, held weakly. one closed is no
// longer asked (its functions throw closed), and one let go is collected
import { assert, assertEquals } from "@std/assert"
import {
	createAction,
	createErmine,
	ensureNode,
	executeAction,
	readAttributes,
} from "@ermine/system"
import pully, { provide, PROVIDER } from "@ermine/pully"
import patchy, { createPatch } from "@ermine/patchy/feature"
import { manual } from "../../../ermine/system/typescript/manual_fixture.ts"

const quiet = { features: [manual] }

// in a fresh ermine: provide and createPatch, as a program
function use() {
	const e = createErmine({ ...quiet, features: [pully, patchy] })
	e.start(() => {
		createAction("go", () => {
			const x = ensureNode("./x", 1)
			provide(x, createAction("./h", () => 0))
			createPatch("./p", x, [{ path: [], value: 2 }])
			return typeof (readAttributes(x) as Record<string, unknown>)[PROVIDER]
		})
	}, "/code/p")
	const got = e.within(() => executeAction("/code/p/go"))
	e.close()
	return got
}

Deno.test("an ermine closed leaves pully and patchy working in the next", () => {
	createErmine({ ...quiet, features: [pully, patchy] }).close()
	assertEquals(use(), "string")
	assertEquals(use(), "string")
})

Deno.test("an ermine closed and let go is collected: pully and patchy hold none", async () => {
	let died = 0
	const registry = new FinalizationRegistry(() => died++)
	;(() => {
		const e = createErmine({ ...quiet, features: [pully, patchy] })
		registry.register(e, 0)
		e.close()
	})()
	// collected as the engine chooses: garbage made till it is (gc() first, when exposed)
	const gc = (globalThis as { gc?: () => void }).gc
	for (let i = 0; i < 200 && died < 1; i++) {
		gc?.()
		const junk: unknown[] = []
		for (let j = 0; j < 1000; j++) junk.push(new Array(1000).fill(j))
		await new Promise((r) => setTimeout(r, 5))
	}
	assert(died === 1, "a closed ermine was held")
})
