// what the sites suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on. the harness asked is HARNESS, else the TypeScript
// adapter (sites_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../../conformance/typescript/ask.ts"

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const answers = await ask(command("sites"), [
		{ op: "nope" },
		{ op: "root", name: "r" },
		{ op: "chain", name: "r" },
	])
	assertEquals(answers.length, 3)
	assert(typeof answers[0].error === "string")
	assertEquals(answers[1], {})
	assertEquals(answers[2], { length: 1 })
})
