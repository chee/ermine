// set aside: the old scheduler's suite, of processes; its scenarios in ../core/scheduler/conformance. for ermine.ts
// Runs the scenarios against a harness. SCHEDULER_HARNESS: the command for another
// implementation (default: the reference). SCHEDULER_SKIP: scenario files it does not speak yet,
// by commas. The protocol: harness.ts; programs as data: steps.ts; what is seen: normal.ts.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const command = (Deno.env.get("SCHEDULER_HARNESS") ?? reference).split(" ")
const skip = new Set((Deno.env.get("SCHEDULER_SKIP") ?? "").split(",").filter((x) => x))

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[]): Promise<Answer[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}

type Step = Request & { expect: Answer }

const files = [...Deno.readDirSync(`${here}../core/scheduler/conformance`)].map((f) => f.name).filter(
	(n) => n.endsWith(".json"),
).sort()
for (const name of files) {
	const { title, steps } = JSON.parse(
		Deno.readTextFileSync(`${here}../core/scheduler/conformance/${name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test({ name: `${name}: ${title}`, ignore: skip.has(name) }, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, ...r } = s
			assertEquals(answers[i], s.expect, `step ${i}: ${JSON.stringify(r)}`)
		})
	})
}

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask([{ op: "nope" }, { op: "new" }])
	assert(a.error)
	assertEquals(b, {})
})
