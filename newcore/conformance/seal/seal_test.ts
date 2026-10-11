// Runs the seal scenarios (sync/conformance/seal/*.json, written by fixtures.ts) against a seal
// harness. SEAL_HARNESS: the command for another implementation (default: the reference).
// A scenario: {title, ask: [requests], expect: [answers]}, an answer per request,
// compared whole (harness.ts has the protocol).
import { assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("SEAL_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../sync/conformance/seal/`

type Request = Record<string, unknown> & { op: string }
type Scenario = { title: string; ask: Request[]; expect: unknown[] }

async function ask(command: string[], requests: Request[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(30_000),
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

for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(scenarios + f.name)) as Scenario
	Deno.test(`${f.name}: ${s.title}`, async () => {
		const answers = await ask(subject, s.ask)
		s.ask.forEach((r, i) => assertEquals(answers[i], s.expect[i], `${f.name} #${i}: ${r.op}`))
	})
}
