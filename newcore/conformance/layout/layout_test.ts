// Runs the layout scenarios (files/conformance/layout/*.json, written by fixtures.ts) against a
// layout harness. LAYOUT_HARNESS: the command for another implementation (default: the
// reference). A scenario: {title, steps: [{request, expect}]}; every request stands alone, each
// answer compared whole (harness.ts has the protocol). Every scenario runs in one harness process.
import { assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("LAYOUT_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../files/conformance/layout/`

type Request = Record<string, unknown> & { op: string }
type Step = { request: Request; expect: unknown }
type Scenario = { title: string; steps: Step[] }

async function ask(command: string[], requests: Request[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(60_000),
	}).spawn()
	// answers read while requests are written: a full pipe either way never stops both
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(scenarios + f.name)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// every request in one run; a harness that dies fails each test with why
let answers: unknown[] = []
let died: unknown
try {
	answers = await ask(subject, files.flatMap(({ s }) => s.steps.map((t) => t.request)))
} catch (e) {
	died = e
}

let at = 0
for (const { name, s } of files) {
	const mine = answers.slice(at, at += s.steps.length)
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		s.steps.forEach((t, i) => assertEquals(mine[i], t.expect, `${name} #${i}: ${t.request.op}`))
	})
}
