// what the crow suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on. the harness asked is HARNESS, else the TypeScript
// adapter (crow_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../conformance/typescript/ask.ts"
import { createHarness } from "./crow_harness.ts"
import { fuzz, SEEDS, STEPS } from "./fuzz_harness.ts"

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const answers = await ask(command("crow"), [
		{ op: "nope" },
		{ op: "start", value: { a: 1 } },
		{ op: "value" },
	])
	assertEquals(answers.length, 3)
	assert(typeof answers[0].error === "string")
	assertEquals(answers[1], {})
	assertEquals(answers[2], { value: { a: 1 } })
})

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps, as crow.ts`, () =>
	fuzz("crow", createHarness, false))
