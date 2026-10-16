// what the patch suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on. the harness asked is HARNESS, else the TypeScript
// adapter (patch_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../../conformance/typescript/ask.ts"

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("patch"), [
		{ op: "nope" },
		{ op: "watch", name: "w", scope: "nobody", f: 1 },
		{ op: "value", id: "a", value: 1 },
		{ op: "read", id: "a" },
	])
	assertEquals(answers.length, 4)
	for (const i of [0, 1]) assert(typeof answers[i].error === "string")
	assertEquals(answers[2], {})
	assertEquals(answers[3], { value: 1 })
})
