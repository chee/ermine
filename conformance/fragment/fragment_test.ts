// Runs the scenarios against a fragment harness. FRAGMENT_HARNESS: the command for another
// implementation (default: the reference). Scenarios live in newcore/sync/conformance/fragment,
// written by fixtures.ts from Subduction's own code (oracle/):
//   {title, names, request, expect}: the harness answers request (harness.ts) with expect.
//   names: each id's letter in fixtures.ts, for reading only.
// Then a fuzz: random DAGs (oracle.ts, dag), the harness against the oracle, a few dozen seeds.
// It needs the oracle built (cargo, in oracle/); without it the fuzz is ignored, saying so.
import { assertEquals } from "@std/assert"
import { type Answer, ask as oracle, built, dag, type Request } from "./oracle.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const subject = (Deno.env.get("FRAGMENT_HARNESS") ?? reference).split(" ")
const SEEDS = 40

type Scenario = { title: string; names: Record<string, string>; request: Request; expect: Answer }

async function ask(command: string[], requests: unknown[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(60_000),
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
		.map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

const dir = `${here}../suites-aside/sync/subduction/conformance/fragment`
const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(dir)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(`${dir}/${f.name}`)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// the fuzz's requests and the oracle's answers, when the oracle is built
const fuzz: { seed: number; requests: Request[]; want: Answer[] }[] = []
const haveOracle = await built()
if (haveOracle) {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { build, walks } = await dag(seed)
		const requests = [build, ...walks]
		fuzz.push({ seed, requests, want: await oracle(requests) })
	}
}

// every request in one run; a harness that dies fails each test with why
let answers: unknown[] = []
let died: unknown
try {
	answers = await ask(subject, [
		...files.map(({ s }) => s.request),
		...fuzz.flatMap((f) => f.requests),
	])
} catch (e) {
	died = e
}

let at = 0
for (const { name, s } of files) {
	const mine = answers[at++]
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		assertEquals(mine, s.expect)
	})
}
Deno.test({
	name: `fuzz: ${SEEDS} random DAGs against Subduction's own code`,
	ignore: !haveOracle,
	fn() {
		if (died) throw died
		for (const f of fuzz) {
			const mine = answers.slice(at, at += f.requests.length)
			f.requests.forEach((r, i) =>
				assertEquals(mine[i], f.want[i], `seed ${f.seed}, request ${i} (${r.op})`)
			)
		}
	},
})
if (!haveOracle) console.error("fragment fuzz ignored: the oracle is not built (cargo, in oracle/)")
