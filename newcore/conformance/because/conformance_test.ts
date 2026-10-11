// Runs the scenarios and the fuzzer against a harness. BECAUSE_HARNESS: the command for another
// implementation (default: the reference). The protocol: harness.ts.
//
// A site is the harness's own, so it is checked by shape only: expect's site true means a site
// is there, with a file and a line, and its file is not the library's.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("BECAUSE_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(
	" ",
)

type Request = { op: string; layer?: string; place?: unknown; why?: unknown; outside?: boolean }
type Because = { layer: string; place: unknown; why?: unknown; site?: Record<string, unknown> }
type Step = Request & { expect?: Omit<Because, "site"> & { site?: true } }

async function ask(requests: Request[]): Promise<{ because?: Because; error?: string }[]> {
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

function check(got: Because, expect: Step["expect"] & object, at: string) {
	const { site, ...rest } = got
	const { site: wanted, ...want } = expect
	assertEquals(rest, want, at)
	if (!wanted) return assertEquals(site, undefined, `${at}: no site`)
	assert(site !== undefined, `${at}: a site`)
	assertEquals(typeof site.file, "string", `${at}: site's file`)
	assert(Number.isInteger(site.line) && (site.line as number) > 0, `${at}: site's line`)
	assert(!/(^|\/)(because|stacktrace)\.\w+$/.test(site.file as string), `${at}: not ours`)
}

for await (const f of Deno.readDir(`${here}../../nodes/conformance/because`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${here}../../nodes/conformance/because/${f.name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			if (s.expect !== undefined) check(answers[i].because!, s.expect, `step ${i}`)
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 50

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// any JSON value, a few levels deep
function value(pick: (n: number) => number, depth = 0): unknown {
	const k = pick(depth > 2 ? 5 : 7)
	if (k === 0) return null
	if (k === 1) return pick(2) === 0
	if (k === 2) return pick(1000) - 500
	if (k === 3) return ["", "a", "side", "ü ✓", "\n"][pick(5)]
	if (k === 4) return pick(1000) / 8
	if (k === 5) return Array.from({ length: pick(4) }, () => value(pick, depth + 1))
	return Object.fromEntries(
		Array.from({ length: pick(4) }, (_, i) => [`k${i}`, value(pick, depth + 1)]),
	)
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} creates, given back as given`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const steps: Step[] = Array.from({ length: STEPS }, () => {
			const r: Request = { op: "create", layer: ["sync", "overlay", "", "ü"][pick(4)] }
			r.place = value(pick)
			if (pick(3) > 0) r.why = value(pick)
			if (pick(4) === 0) r.outside = true
			const expect: Step["expect"] = { layer: r.layer!, place: r.place }
			if ("why" in r) expect.why = r.why
			if (r.outside) expect.site = true
			return { ...r, expect }
		})
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		steps.forEach((s, i) => {
			const at = `seed ${seed}, step ${i}: ${JSON.stringify(s)}`
			assertEquals(answers[i].error, undefined, at)
			check(answers[i].because!, s.expect!, at)
		})
	}
})
