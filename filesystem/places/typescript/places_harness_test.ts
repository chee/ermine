// what the places suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on, and the fuzzer. the harness asked is HARNESS, else
// the TypeScript adapter (places_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command, reference } from "../../../conformance/typescript/ask.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("places"), [
		{ op: "nope" },
		{ op: "watch", name: "w", scope: "nobody", f: 1 },
		{ op: "value", id: "a", value: 1 },
		{ op: "read", part: "value", id: "a" },
	])
	assertEquals(answers.length, 4)
	for (const i of [0, 1]) assert(typeof answers[i].error === "string")
	assertEquals(answers[2], {})
	assertEquals(answers[3], { value: 1 })
})

// the fuzzer: random worlds, programs and writes, a pulse and every compute's state after each
// step. an implementation is held to the reference, step by step (the same answers, errors too);
// the reference alone is only run, a check that it does not throw. a few dozen seeds
const SEEDS = 24
const STEPS = 50
const IDS = ["R", "A", "B", "C"]
// names: ASCII, an astral one, a lone high
const NAMES = ["a", "😀", "\uD83D"]
// string parts: ASCII, BMP, pairs, a pair and a modifier, lone halves (a high then a low: a pair), U+0000
const PARTS = ["a", "b", "xy", "é", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
const WATCHES = 6

const generator = (seed: number) => {
	const pick = rand(seed)
	return { pick, one: <T>(xs: readonly T[]): T => xs[pick(xs.length)] }
}

function sequence(seed: number): Request[] {
	const { pick, one } = generator(seed)
	const entry = () => one(IDS)
	const out: Request[] = [{ op: "root", name: "o", info: [["actor", "o"]] }]
	const kids = () => {
		const v: Record<string, unknown> = {}
		// now and then something that is no id: taken, no item
		for (const n of NAMES) if (pick(3)) v[n] = pick(8) === 0 ? [entry()] : entry()
		return v
	}
	const text = (most = 4) => Array.from({ length: pick(most + 1) }, () => one(PARTS)).join("")
	const value = () => pick(4) ? { t: pick(10), u: text(), l: [pick(9), pick(9)] } : text()
	// a span of u, in code points: mostly in it, now and then past its end
	const span = () => {
		const a = pick(6)
		return [a, a + pick(3)]
	}
	for (const id of IDS) {
		if (pick(4)) out.push({ op: "kids", id, value: kids() })
		if (pick(3)) out.push({ op: "value", id, value: value() })
	}
	const path = () => Array.from({ length: pick(4) }, () => one(NAMES))
	const program = (): unknown => {
		switch (pick(7)) {
			case 0:
				return { get: path() }
			case 1:
				return { names: path() }
			case 2:
				return { level: path() }
			case 3:
				return { values: path() }
			case 6:
				return { lookup: [path(), path()], ...(pick(2) ? {} : { all: true }) }
			case 4:
				return { read: ["value", one(IDS), one([[], ["t"], ["u"], ["l", 0]])] }
			default:
				return { change: ["value", one(IDS)] }
		}
	}
	for (let i = 0; i < WATCHES; i++) {
		out.push({ op: "watch", name: `w${i}`, scope: "o", f: program() })
	}
	const slot = () => ({ at: entry(), name: one(NAMES) })
	for (let i = 0; i < STEPS; i++) {
		const k = pick(14)
		if (k === 0) out.push({ op: "kids", id: one(IDS), value: kids() })
		else if (k === 1) out.push({ op: "value", id: one(IDS), value: value() })
		else if (k < 5) out.push({ op: "place", ...slot(), id: entry() })
		else if (k === 5) out.push({ op: "unplace", ...slot() })
		else if (k === 6) out.push({ op: "rename", ...slot(), to: one(NAMES) })
		else if (k === 7) out.push({ op: "place", ...slot(), id: entry() })
		else if (k === 8) {
			const to = slot()
			out.push({ op: "move", ...slot(), to })
		} else if (k < 11) {
			const patch = one([
				{ path: ["t"], value: pick(10) },
				{ path: ["t"] },
				{ path: ["u"], range: span(), value: text(2) },
				{ path: ["u"], range: span() },
				{ path: ["u"], range: [pick(5), pick(5)], value: text(2) },
				{ path: ["u"], range: [pick(5), pick(5)], move: { path: ["u"], range: span() } },
				{ path: ["t"], value: text() },
				{ path: [], value: { t: pick(10) } },
				{ path: ["l", pick(3)], value: pick(9) },
			])
			out.push({ op: "edit", part: "value", id: one(IDS), patches: [patch] })
		} else if (k === 11) {
			// one children entry under two keys: a write through either reaches both
			const keys = [["children", one(IDS)], ["children", one(IDS)]]
			out.push({ op: "share", value: kids(), keys })
		} else if (k === 12) {
			out.push({ op: "del", part: one(["value", "children"]), id: one(IDS) })
		} else out.push({ op: "get", path: path() })
		out.push({ op: "pulse" })
		for (let w = 0; w < WATCHES; w++) out.push({ op: "state", name: `w${w}` })
		out.push({ op: "kept" })
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds of ${STEPS} steps, held to the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const requests = sequence(seed)
		const want = await ask(reference("places"), requests)
		const got = Deno.env.get("HARNESS") ? await ask(command("places"), requests) : want
		assertEquals(got.length, requests.length, `seed ${seed}: an answer per request`)
		requests.forEach((r, i) => {
			assertEquals(got[i], want[i], `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
