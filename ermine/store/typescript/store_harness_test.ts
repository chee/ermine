// the store's harness (store_harness.ts) asked what its scenarios (conformance/run.ts) do not.
// HARNESS: the command for another implementation (default: the reference)
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../../conformance/typescript/ask.ts"

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("store"), [
		{ op: "nope" },
		{ op: "add", source: "s", part: 1, id: "a", node: "n" },
		{ op: "add", source: 1, part: "value", id: "a", node: "n" },
		{ op: "add", source: "s", part: "value", id: "a", node: "n" },
		{ op: "get", source: "s", part: "value", id: "a" },
	])
	assertEquals(answers.length, 5)
	for (const i of [0, 1, 2]) {
		assert(typeof answers[i].error === "string")
		assert(answers[i].error !== "already-there" && answers[i].error !== "nothing-there")
	}
	assertEquals(answers[3], {})
	assertEquals(answers[4], { node: "n" })
})
