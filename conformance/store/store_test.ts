// Runs the store scenarios (files/conformance/store/*.json, written by fixtures.ts) against a
// store harness. STORE_HARNESS: the command for another implementation (default: the reference,
// harness.ts, over files/ts/store.ts). harness.ts has the protocol, run.ts the scenarios' shape,
// the edits and the snapshot; each answer and snapshot compared whole with what is expected.
// The store works on a real folder, with extended attributes: macOS only, and a run that may
// write and call the system (deno test --allow-all), as files/ts/store_test.ts.
import { assertEquals } from "@std/assert"
import { run, type Scenario } from "./run.ts"

const here = new URL(".", import.meta.url).pathname
const dir = `${here}../../playground/files/conformance/store`
const reference = `deno run --quiet --allow-all ${here}harness.ts`
const subject = (Deno.env.get("STORE_HARNESS") ?? reference).split(" ")
const granted = (["write", "ffi", "run"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)
const mac = Deno.build.os === "darwin" && granted

const files: { name: string; s: Scenario }[] = []
if (mac) {
	for await (const f of Deno.readDir(dir)) {
		if (!f.name.endsWith(".json")) continue
		files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
	}
	files.sort((a, b) => a.name.localeCompare(b.name))
}

for (const { name, s } of files) {
	Deno.test(`${name}: ${s.title}`, async () => {
		const got = await run(s, subject)
		s.steps.forEach((step, i) => {
			if (!("expect" in step)) return
			const what = step.request ? JSON.stringify(step.request.op) : "observe"
			assertEquals(got[i], step.expect, `step ${i + 1}: ${what}`)
		})
	})
}
