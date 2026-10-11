// Runs the scenarios and the fuzzer against a node harness. NODE_HARNESS: the command for another
// implementation (default: the reference). A site of "*" in an expectation: any site the harness
// made, a file and a line.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("NODE_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(" ")

type Request = Record<string, unknown> & { op: string }
type Step = Request & { expect?: Shown }
type Version = { content: unknown; change: unknown; because?: unknown }
type Shown = {
	id: string
	value: Version[]
	info: [string, Version[]][]
	children: [string, Version[]][]
	header: Record<string, unknown>
}

async function ask(requests: Request[]): Promise<{ node?: Shown; error?: string }[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	return new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
}

// "*" sites: checked for shape, then taken as the expectation's
function match(got: Shown, want: Shown, at: string) {
	if (want.header.site === "*") {
		const site = got.header.site as { file?: unknown; line?: unknown } | undefined
		assert(typeof site?.file === "string" && typeof site.line === "number", `${at}: a site`)
		want = { ...want, header: { ...want.header, site } }
	}
	assertEquals(got, want, at)
}

for await (const f of Deno.readDir(`${here}../../nodes/conformance/node`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(
		await Deno.readTextFile(`${here}../../nodes/conformance/node/${f.name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			if (s.expect !== undefined) match(answers[i].node!, s.expect, `step ${i}`)
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const NAMES = ["a", "b", "c", "d"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// NODE.tex read plainly: entries as new Map takes them, without a Map
function entries(given: [string, Version[]][]): [string, Version[]][] {
	const out: [string, Version[]][] = []
	for (const [name, vs] of given) {
		const at = out.findIndex(([n]) => n === name)
		if (at === -1) out.push([name, vs])
		else out[at] = [name, vs]
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds against the model`, async () => {
	const requests: Request[] = []
	const expected: Shown[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const version = (list: boolean): Version => {
			const v: Version = {
				content: list
					? Array.from({ length: pick(4) }, () => pick(4) ? NAMES[pick(4)] : { symbol: "s" })
					: pick(3)
					? pick(100)
					: { k: [pick(9), "x"] },
				change: { time: pick(1000), actor: NAMES[pick(4)], node: "n" },
			}
			if (pick(3) === 0) v.because = ["b", pick(5)]
			return v
		}
		const versions = (list: boolean) => Array.from({ length: pick(3) }, () => version(list))
		const named = (list: boolean) =>
			Array.from(
				{ length: pick(6) },
				() => [NAMES[pick(4)], versions(list)] as [string, Version[]],
			)
		const value = versions(false), info = named(false), children = named(true)
		const header: Record<string, unknown> = {}
		if (pick(2)) header.time = pick(1 << 30)
		if (pick(2)) header.actor = NAMES[pick(4)]
		if (pick(4) === 0) header.cause = { why: pick(3) }
		const id = `n${seed}`
		requests.push({ op: "make", id, contents: { value, info, children }, header })
		expected.push({ id, value, info: entries(info), children: entries(children), header })
	}
	const answers = await ask(requests)
	expected.forEach((e, i) => match(answers[i].node!, e, `seed ${i + 1}`))
})
