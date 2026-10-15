// Runs the scenarios against a blop harness. BLOP_HARNESS: the command for another implementation
// (default: the reference). Scenarios live in newcore/encoding/conformance/blop, written by
// fixtures.ts:
//   {title, blop, expect: {bytes, name}}: encode(blop) gives the bytes, decode(bytes) gives the
//     blop back, name(bytes) gives the name (all hex; the blop in its JSON form, form.ts)
//   {title, blop, expect: {code, field?}}: encoding refused
//   {title, bytes, expect: {code, field?}}: decoding refused
// Not covered: cannot-carry. It needs a live value, which the JSON form cannot write
// (BLOP.tex, errors, step 4), so it is left to the implementation's own tests.
import { assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("BLOP_HARNESS") ?? reference).split(" ")

type Expect = { bytes?: string; name?: string; code?: string; field?: string }
type Scenario = { title: string; blop?: unknown; bytes?: string; expect: Expect }
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
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const dir = `${here}../suites-aside/ermine/encoding/conformance/blop`
const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// every request of every scenario in one run; a harness that dies fails each test with why
const asks = (s: Scenario): Record<string, unknown>[] =>
	s.expect.bytes !== undefined
		? [{ op: "encode", blop: s.blop }, { op: "decode", bytes: s.expect.bytes }, {
			op: "name",
			bytes: s.expect.bytes,
		}]
		: s.bytes !== undefined
		? [{ op: "decode", bytes: s.bytes }]
		: [{ op: "encode", blop: s.blop }]
let answers: Answer[] = []
let died: unknown
try {
	answers = await ask(subject, files.flatMap(({ s }) => asks(s)))
} catch (e) {
	died = e
}

const failed = (a: Answer) =>
	a.field === undefined ? { code: a.code } : { code: a.code, field: a.field }
let at = 0
for (const { name, s } of files) {
	const mine = answers.slice(at, at += asks(s).length)
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		if (s.expect.bytes !== undefined) {
			const [encoded, decoded, named] = mine
			assertEquals(encoded.bytes, s.expect.bytes, "encode")
			assertEquals(decoded.blop, s.blop, "decode")
			assertEquals(named.name, s.expect.name, "name")
			return
		}
		const want = s.expect.field === undefined
			? { code: s.expect.code }
			: { code: s.expect.code, field: s.expect.field }
		assertEquals(failed(mine[0]), want)
	})
}
