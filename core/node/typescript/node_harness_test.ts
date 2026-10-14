// What the node suite asks of a harness besides its scenarios (conformance/run.ts): an unknown op
// is an error and the harness goes on; a fuzzer against a model. Against HARNESS, else the
// reference (node_harness.ts). The protocol: node_harness.ts.
import { assert, assertEquals } from "@std/assert"
import { ask, command } from "../../../conformance/typescript/ask.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

type Site = { file: string; line: number; column?: number; function?: string }
type Change = Record<string, unknown>
type Shown = { value?: unknown; change: Change }
type Request = Record<string, unknown> & { op: string }

const now = () => Math.floor(Date.now() / 1000)

// a time "now" in the expectation: within [from - 1, to + 1], then taken as the expectation's
function match(got: unknown, want: Shown, at: string, from: number, to: number) {
	const entry = got as Shown | undefined
	assert(entry !== undefined, `${at}: no entry`)
	if (want.change.time === "now") {
		const t = entry.change.time
		assert(
			Number.isInteger(t) && t as number >= from - 1 && t as number <= to + 1,
			`${at}: time ${t}`,
		)
		want = { ...want, change: { ...want.change, time: t } }
	}
	assertEquals(entry, want, at)
}

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const from = now()
	const [a, b] = await ask(command("node"), [{ op: "nope" }, { op: "entry" }])
	assert(a.error)
	match(b.entry, { change: { time: "now" } }, "entry", from, now())
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 25
const NAMES = ["a", "b", "c", "d"]
const STRINGS = ["", "a", "é", 'a"b\\c', "line\nbreak", "\u0001", "🦊"]

function json(pick: (n: number) => number, depth = 0): unknown {
	const k = pick(depth > 2 ? 4 : 6)
	if (k === 0) return null
	if (k === 1) return pick(2) === 0
	if (k === 2) return pick(2) === 0 ? pick(1000) : -pick(1000) / 4
	if (k === 3) return STRINGS[pick(STRINGS.length)]
	if (k === 4) return Array.from({ length: pick(3) }, () => json(pick, depth + 1))
	const o: Record<string, unknown> = {}
	for (let i = pick(3); i > 0; i--) o[STRINGS[pick(STRINGS.length)]] = json(pick, depth + 1)
	return o
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} requests against the model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const steps: { request: Request; expect: Shown }[] = []
		for (let k = 0; k < STEPS; k++) {
			const request: Request = { op: "entry" }
			const change: Change = {}
			const expect: Shown = { change }
			if (pick(4)) request.value = expect.value = json(pick)
			const header: Record<string, unknown> = {}
			if (pick(2)) header.time = pick(1 << 30)
			if (pick(2)) header.actor = NAMES[pick(4)]
			if (pick(3) === 0) {
				header.metadata = Array.from({ length: pick(4) }, () => [NAMES[pick(2)], json(pick, 2)])
			}
			const sites: Site[] = []
			for (let n = pick(3); n > 0; n--) {
				sites.push({
					file: `f${pick(9)}.ts`,
					line: 1 + pick(500),
					...(pick(2) ? { column: pick(80) } : {}),
				})
			}
			if (sites.length || pick(5) === 0) header.external = sites
			if (pick(2)) {
				request.header = header
				Object.assign(change, header)
			}
			if (change.time === undefined) change.time = "now"
			steps.push({ request, expect })
		}
		const from = now()
		const answers = await ask(command("node"), steps.map((s) => s.request))
		const to = now()
		steps.forEach((s, i) =>
			match(answers[i].entry, s.expect, `seed ${seed}, step ${i}`, from, to)
		)
	}
})
