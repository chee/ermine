// what the patch suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on, and the fuzzer. the harness asked is HARNESS, else the TypeScript
// adapter (patch_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command, reference } from "../../../conformance/typescript/ask.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("patch"), [
		{ op: "nope" },
		{ op: "watch", name: "w", scope: "nobody", f: 1 },
		{ op: "value", id: "a", value: 1 },
		{ op: "read", id: "a" },
	])
	assertEquals(answers.length, 4)
	for (const i of [0, 1]) assert(typeof answers[i].error === "string")
	assertEquals(answers[2], {})
	assertEquals(answers[3], { value: 1 })
})

// the fuzzer: random values, patch nodes over them, edits, lands and takings out, a pulse and
// every compute's state after each step; strings of every kind, cut by code points. an
// implementation is held to the reference, step by step (the same answers, errors too); the
// reference alone is only run. a few dozen seeds
const SEEDS = 24
const STEPS = 40
const WATCHES = 4
// string parts: ASCII, BMP, pairs, a pair and a modifier, lone halves (a high then a low: a pair), U+0000
const PARTS = ["a", "b", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
const KEYS = ["s", "t", "😀", "\uD83D"]

function sequence(seed: number): Request[] {
	const pick = rand(seed)
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	const text = (most = 4) => Array.from({ length: pick(most + 1) }, () => one(PARTS)).join("")
	const value = () => {
		const v: Record<string, unknown> = {}
		for (const k of KEYS) if (pick(3)) v[k] = pick(4) ? text() : pick(9)
		return v
	}
	// a span, in code points: mostly in the string, now and then past its end
	const span = () => {
		const a = pick(6)
		return [a, a + pick(3)]
	}
	const patch = () => {
		const path = [one(KEYS)]
		switch (pick(6)) {
			case 0:
				return { path, value: text() }
			case 1:
				return { path }
			case 2:
				return { path, range: span() }
			case 3: {
				const g = pick(5)
				return { path, range: [g, g], move: { path: [one(KEYS)], range: span() } }
			}
			default:
				return { path, range: span(), value: text(2) }
		}
	}
	const patches = () => Array.from({ length: 1 + pick(2) }, patch)
	let time = 100
	const out: Request[] = [
		{ op: "root", name: "o", info: { actor: "o" } },
		{ op: "value", id: "N", value: value(), time },
	]
	for (let i = 0; i < WATCHES; i++) {
		const f = pick(2) ? { read: ["N", pick(2) ? [] : [one(KEYS)]] } : { entries: ["N"] }
		out.push({ op: "watch", name: `w${i}`, scope: "o", f })
	}
	const ps = ["P", "Q", "R"]
	for (let i = 0; i < STEPS; i++) {
		time += pick(2)
		const k = pick(10)
		if (k < 3) out.push({ op: "patch", id: one(ps), on: "N", at: time, patches: patches(), time })
		else if (k < 6) out.push({ op: "edit", part: "value", id: "N", patches: patches(), time })
		else if (k === 6) {
			out.push({
				op: "edit",
				part: "patch",
				id: one(ps),
				patches: [{ path: ["patches"], value: patches() }],
				time,
			})
		} else if (k === 7) out.push({ op: "land", id: one(ps), time })
		else if (k === 8) out.push({ op: "del", part: "patch", id: one(ps) })
		else out.push({ op: "value", id: "N", value: value(), time })
		out.push({ op: "pulse" })
		out.push({ op: "read", id: "N" }, { op: "entries", id: "N" })
		for (let w = 0; w < WATCHES; w++) out.push({ op: "state", name: `w${w}` })
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds of ${STEPS} steps, held to the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const requests = sequence(seed)
		const want = await ask(reference("patch"), requests)
		const got = Deno.env.get("HARNESS") ? await ask(command("patch"), requests) : want
		assertEquals(got.length, requests.length, `seed ${seed}: an answer per request`)
		requests.forEach((r, i) => {
			assertEquals(got[i], want[i], `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
