// Runs the scenarios against a names harness. NAMES_HARNESS: the command for another
// implementation (default: the reference). Scenarios live in newcore/files/conformance/names,
// written by fixtures.ts:
//   {title, requests: [{op, ...}], expect: [{result} | {error}]}
// an answer per request, in order (the protocol is in harness.ts). Results are compared as JSON
// values; an {error} scenario expects an error and no more of it than that.
import { assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("NAMES_HARNESS") ?? reference).split(" ")

type Answer = Record<string, unknown>
type Scenario = { title: string; requests: Record<string, unknown>[]; expect: Answer[] }

async function ask(command: string[], requests: Record<string, unknown>[]): Promise<Answer[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(30_000),
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const dir = `${here}../suites-aside/playground/files/conformance/names`
const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// every request of every scenario in one run; a harness that dies fails each test with why
let answers: Answer[] = []
let died: unknown
try {
	answers = await ask(subject, files.flatMap(({ s }) => s.requests))
} catch (e) {
	died = e
}

let at = 0
for (const { name, s } of files) {
	const mine = answers.slice(at, at += s.requests.length)
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		for (const [i, want] of s.expect.entries()) {
			const got = mine[i]
			const label = `${JSON.stringify(s.requests[i])}`
			if ("error" in want) assertEquals("error" in got, true, `${label}: an error`)
			else assertEquals(got, want, label)
		}
	})
}
