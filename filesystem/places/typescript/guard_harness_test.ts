// what the guard suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on, and the fuzzer. the harness asked is HARNESS, else the TypeScript
// adapter (guard_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command, reference } from "../../../conformance/typescript/ask.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

Deno.test("guard: an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("guard"), [
		{ op: "nope" },
		{ op: "value", id: "a", value: 1 },
		{ op: "guard", name: "g" },
		{ op: "eval", guard: "g", e: { read: ["a", "value"] } },
		{ op: "eval", guard: "g", e: { nonsense: 1 } },
	])
	assertEquals(answers.length, 5)
	for (const i of [0, 4]) assert(typeof answers[i].error === "string")
	assertEquals(answers.slice(1, 4), [{}, {}, { value: 1 }])
})

// the fuzzer: a value with keys and strings of every kind, grants by actor, op and field (those
// strings too), and edits and reads tried through the guard, ranged string edits cut by code
// points. an implementation is held to the reference, step by step (the same answers, errors too);
// the reference alone is only run. a few dozen seeds
const SEEDS = 24
const STEPS = 40
// string parts: ASCII, BMP, pairs, a pair and a modifier, lone halves (a high then a low: a pair), U+0000
const PARTS = ["a", "b", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
const KEYS = ["s", "😀", "\uD83D", "\uDE00", "\u0000"]
const ACTORS = ["chee", "😀\uD83D", "\uDE00"]

function sequence(seed: number): Request[] {
	const pick = rand(seed)
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	const text = (most = 4) => Array.from({ length: pick(most + 1) }, () => one(PARTS)).join("")
	const value = () => {
		const v: Record<string, unknown> = {}
		for (const k of KEYS) if (pick(3)) v[k] = pick(5) ? text() : pick(9)
		return v
	}
	const rules = () =>
		Array.from({ length: 1 + pick(6) }, () => {
			const g: Record<string, unknown> = { id: "A" }
			if (pick(2)) g.actor = one(ACTORS)
			if (pick(3) === 0) g.op = one(["edit", "read"])
			if (pick(2)) g.field = [one(KEYS)]
			if (pick(8) === 0) g.deny = true
			return g
		})
	// a span, in code points: mostly in the string, now and then past its end
	const span = () => {
		const a = pick(6)
		return [a, a + pick(3)]
	}
	const patch = () => {
		const path = [one(KEYS)]
		switch (pick(5)) {
			case 0:
				return { path, value: text() }
			case 1:
				return { path, range: span() }
			case 2: {
				const g = pick(5)
				return { path, range: [g, g], move: { path: [one(KEYS)], range: span() } }
			}
			default:
				return { path, range: span(), value: text(2) }
		}
	}
	const out: Request[] = [
		{ op: "value", id: "A", value: value() },
		{ op: "value", id: "rules", value: rules() },
		{ op: "guard", name: "g", may: { grants: ["value", "rules"] } },
	]
	ACTORS.forEach((a, i) => out.push({ op: "root", name: `o${i}`, info: [["actor", a]] }))
	for (let i = 0; i < STEPS; i++) {
		const scope = `o${pick(ACTORS.length)}`
		const k = pick(8)
		if (k === 0) out.push({ op: "value", id: "rules", value: rules() })
		else if (k === 1) out.push({ op: "value", id: "A", value: value() })
		else if (k < 5) {
			const patches = Array.from({ length: 1 + pick(2) }, patch)
			out.push({ op: "eval", guard: "g", scope, e: { try: { edit: ["A", "value", patches] } } })
		} else {
			const path = pick(3) ? [one(KEYS)] : []
			out.push({ op: "eval", guard: "g", scope, e: { try: { read: ["A", "value", path] } } })
		}
		out.push({ op: "node", part: "value", id: "A" })
	}
	out.push({ op: "asks" })
	return out
}

Deno.test(`guard fuzz: ${SEEDS} seeds of ${STEPS} steps, held to the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const requests = sequence(seed)
		const want = await ask(reference("guard"), requests)
		const got = Deno.env.get("HARNESS") ? await ask(command("guard"), requests) : want
		assertEquals(got.length, requests.length, `seed ${seed}: an answer per request`)
		requests.forEach((r, i) => {
			assertEquals(got[i], want[i], `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
