// Runs the scenarios and the fuzzer against a harness. CHANGE_HARNESS: the command for another
// implementation (default: the reference). Changes compare as JSON, key order aside.
// site "captured": the harness's own site, so only its shape is checked.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("CHANGE_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(" ")

type Site = { file: string; line: number; column?: number; function?: string }
type Header = {
	time: number
	actor?: unknown
	reader?: string
	site?: Site
	cause?: unknown
}
type Request = { op: string; node: string; header: Header; outside?: boolean }
type Change = Header & { node: string }
type Step = Request & { expect: Omit<Change, "site"> & { site?: Site | "captured" } }

async function ask(requests: Request[]): Promise<{ change?: Change; error?: string }[]> {
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

function isSite(s: unknown): boolean {
	if (typeof s !== "object" || s === null) return false
	const { file, line, column, function: fn, ...rest } = s as Record<string, unknown>
	return typeof file === "string" && file !== "" && Number.isInteger(line) &&
		(line as number) > 0 && (column === undefined || Number.isInteger(column)) &&
		(fn === undefined || typeof fn === "string") && Object.keys(rest).length === 0
}

function check(got: Change | undefined, expect: Step["expect"], at: string) {
	assert(got !== undefined, `${at}: no change`)
	if (expect.site === "captured") {
		const { site, ...rest } = got
		const { site: _, ...want } = expect
		assert(isSite(site), `${at}: site ${JSON.stringify(site)}`)
		assertEquals(rest, want, at)
	} else assertEquals(got, expect, at)
}

for await (const f of Deno.readDir(`${here}../../nodes/conformance/change`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${here}../../nodes/conformance/change/${f.name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			check(answers[i].change, s.expect, `step ${i}: ${JSON.stringify(s)}`)
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 100

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const STRINGS = ["", "a", "chee", "é", 'a"b\\c', "line\nbreak", "\u0001", "🦊"]

function value(pick: (n: number) => number, depth = 0): unknown {
	const k = pick(depth > 2 ? 4 : 6)
	if (k === 0) return null
	if (k === 1) return pick(2) === 0
	if (k === 2) return pick(2) === 0 ? pick(1000) : -pick(1000)
	if (k === 3) return STRINGS[pick(STRINGS.length)]
	if (k === 4) return Array.from({ length: pick(3) }, () => value(pick, depth + 1))
	const o: Record<string, unknown> = {}
	for (let i = pick(3); i > 0; i--) o[STRINGS[pick(STRINGS.length)]] = value(pick, depth + 1)
	return o
}

const TIMES = [0, 1, 2, 1000, 2 ** 31, 2 ** 32 + 1, 2 ** 53 - 1]

// a request, and the change it must give: the header's fields as given, node added
function step(pick: (n: number) => number): Step {
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const header: Header = { time: one(TIMES) }
	if (pick(5) > 0) header.actor = value(pick)
	if (pick(2) === 0) header.reader = one(STRINGS)
	let site: Site | undefined
	if (pick(2) === 0) {
		site = { file: one(["x.c", "file:///a/b.ts", "é/🦊.js"]), line: 1 + pick(5000) }
		if (pick(2) === 0) site.column = 1 + pick(200)
		if (pick(2) === 0) site.function = one(["f", "async Foo.bar", "main"])
		header.site = site
	}
	if (pick(2) === 0) header.cause = value(pick)
	const outside = pick(3) === 0
	const node = one(STRINGS)
	const expect: Step["expect"] = { ...header, node }
	if (outside && site === undefined) expect.site = "captured"
	return { op: "make", node, header, ...(outside ? { outside } : {}), expect }
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} requests against the model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const steps = Array.from({ length: STEPS }, () => step(pick))
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `seed ${seed}, step ${i}`)
			check(answers[i].change, s.expect, `seed ${seed}, step ${i}: ${JSON.stringify(s)}`)
		})
	}
})
