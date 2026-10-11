// Runs session scenarios against a harness, for apply_test.ts and commit_test.ts.
// A scenario: {title, steps: [{request, expect}]}, the requests in order (session.ts has the
// protocol); each answer compared whole with what is expected. Every request of every scenario in
// one run, scenarios by file name; a harness that dies fails each test with why.
import { assertEquals } from "@std/assert"

type Step = { request: Record<string, unknown>; expect: unknown }
type Scenario = { title: string; steps: Step[] }

async function ask(command: string[], requests: Record<string, unknown>[]): Promise<unknown[]> {
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
	const answers = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l)
		.map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

// dir: the scenarios; subject: the harness command
export async function run(dir: string, subject: string[]) {
	const files: { name: string; s: Scenario }[] = []
	for await (const f of Deno.readDir(dir)) {
		if (!f.name.endsWith(".json")) continue
		files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
	}
	files.sort((a, b) => a.name.localeCompare(b.name))

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
			s.steps.forEach((step, i) =>
				assertEquals(mine[i], step.expect, `step ${i + 1}: ${JSON.stringify(step.request.op)}`)
			)
		})
	}
}
