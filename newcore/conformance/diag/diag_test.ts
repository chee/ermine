// Runs the scenarios against a diag harness. DIAG_HARNESS: the command for another implementation
// (default: the reference). Scenarios live in newcore/files/conformance/diag, written by
// fixtures.ts; values in their JSON form (../pack/form.ts):
//   {title, value, expect: {text}}: write(value) gives the text, and read(text) gives the value back
//   {title, text, expect: {value}}: read(text) gives the value
//   {title, text, expect: {at, line, column}}: read(text) refused (the offset in UTF-16 code
//     units, line and column from 1; the message is not compared)
// Not covered: cannot-carry, which needs a live stand-in. Requests are written with form.ts's line, which keeps -0.
import { assertEquals } from "@std/assert"
import { line } from "../pack/form.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("DIAG_HARNESS") ?? reference).split(" ")

type Expect = { text?: string; value?: unknown; at?: number; line?: number; column?: number }
type Scenario = { title: string; value?: unknown; text?: string; expect: Expect }
type Answer = Record<string, unknown>

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
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const dir = `${here}../../files/conformance/diag`
const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// every request of every scenario in one run; a harness that dies fails each test with why
const asks = (s: Scenario): Record<string, unknown>[] =>
	s.expect.text !== undefined
		? [{ op: "write", value: s.value }, { op: "read", text: s.expect.text }]
		: [{ op: "read", text: s.text }]
let answers: Answer[] = []
let died: unknown
try {
	answers = await ask(subject, files.flatMap(({ s }) => asks(s)))
} catch (e) {
	died = e
}

let at = 0
for (const { name, s } of files) {
	const mine = answers.slice(at, at += asks(s).length)
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		if (s.expect.text !== undefined) {
			const [written, back] = mine
			assertEquals(written.text, s.expect.text, "write")
			assertEquals(back.value, s.value, "read back")
			return
		}
		const [got] = mine
		if (s.expect.value !== undefined) {
			assertEquals(got.value, s.expect.value, "read")
			return
		}
		const { at, line, column } = s.expect
		assertEquals(got, { code: "not-diag", at, line, column })
	})
}
