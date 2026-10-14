// what the guard suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on. the harness asked is HARNESS, else the TypeScript
// adapter (guard_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../../conformance/typescript/ask.ts"

Deno.test("guard: an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("guard"), [
		{ op: "nope" },
		{ op: "value", id: "a", value: 1 },
		{ op: "guard", name: "g" },
		{ op: "eval", guard: "g", e: { read: ["a", "value"] } },
		{ op: "eval", guard: "g", e: { nonsense: 1 } },
	])
	assertEquals(answers.length, 5)
	for (const i of [0, 4]) assert(typeof answers[i].error === "string")
	assertEquals(answers.slice(1, 4), [{}, {}, { value: 1 }])
})
