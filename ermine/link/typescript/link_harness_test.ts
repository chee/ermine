// what the link suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on, and the fuzzer. the harness asked is HARNESS, else
// the TypeScript adapter (link_harness.ts)
import { assert, assertEquals } from "@std/assert"
import { ask, command, reference } from "../../../conformance/typescript/ask.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask(command("link"), [
		{ op: "nope" },
		{ op: "watch", name: "w", scope: "nobody", f: 1 },
		{ op: "value", source: "s", id: "a", value: 1 },
		{ op: "read", source: "s", part: "value", id: "a" },
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
const SOURCES = ["stored", "drag"]
const IDS = ["R", "A", "B", "C"]
const NAMES = ["a", "b", "c"]
const WATCHES = 6

const generator = (seed: number) => {
	const pick = rand(seed)
	return { pick, one: <T>(xs: readonly T[]): T => xs[pick(xs.length)] }
}

function sequence(seed: number): Request[] {
	const { pick, one } = generator(seed)
	const entry = () => [one(SOURCES), one(IDS)]
	const out: Request[] = [{ op: "root", name: "o" }]
	const kids = () => {
		const v: Record<string, unknown> = {}
		for (const n of NAMES) if (pick(3)) v[n] = Array.from({ length: pick(3) }, entry)
		return v
	}
	const value = () =>
		pick(4) ? { t: pick(10), u: "abc".slice(pick(4)), l: [pick(9), pick(9)] } : "plain"
	for (const source of SOURCES) {
		for (const id of IDS) {
			if (pick(4)) out.push({ op: "kids", source, id, value: kids() })
			if (pick(3)) out.push({ op: "value", source, id, value: value() })
		}
	}
	const address = () => Array.from({ length: 1 + pick(3) }, () => one(NAMES))
	const program = (): unknown => {
		switch (pick(6)) {
			case 0:
				return { get: address() }
			case 1:
				return { names: entry() }
			case 2:
				return { level: entry() }
			case 3:
				return { values: address() }
			case 4:
				return { read: [one(SOURCES), "value", one(IDS), one([[], ["t"], ["u"], ["l", 0]])] }
			default:
				return { change: [one(SOURCES), "value", one(IDS)] }
		}
	}
	for (let i = 0; i < WATCHES; i++) {
		out.push({ op: "watch", name: `w${i}`, scope: "o", f: program() })
	}
	const slot = () => ({ at: entry(), name: one(NAMES) })
	for (let i = 0; i < STEPS; i++) {
		const k = pick(14)
		if (k === 0) out.push({ op: "kids", source: one(SOURCES), id: one(IDS), value: kids() })
		else if (k === 1) {
			out.push({ op: "value", source: one(SOURCES), id: one(IDS), value: value() })
		} else if (k < 5) out.push({ op: "place", ...slot(), entry: entry(), index: pick(3) })
		else if (k === 5) out.push({ op: "unplace", ...slot(), index: pick(3) })
		else if (k === 6) out.push({ op: "rename", ...slot(), to: one(NAMES) })
		else if (k === 7) out.push({ op: "order", ...slot(), from: pick(3), to: pick(3) })
		else if (k === 8) {
			const to = slot()
			out.push({ op: "move", ...slot(), index: pick(3), to, toindex: pick(3) })
		} else if (k < 11) {
			const patch = one([
				{ path: ["t"], value: pick(10) },
				{ path: ["t"] },
				{ path: ["u"], range: [pick(3), pick(3)], value: "x" },
				{ path: [], value: { t: pick(10) } },
				{ path: ["l", pick(3)], value: pick(9) },
			])
			out.push({
				op: "edit",
				source: one(SOURCES),
				part: "value",
				id: one(IDS),
				patches: [patch],
			})
		} else if (k === 11) out.push({ op: "drop", source: "drag" })
		else if (k === 12) {
			out.push({
				op: "del",
				source: one(SOURCES),
				part: one(["value", "children"]),
				id: one(IDS),
			})
		} else out.push({ op: "get", address: address() })
		out.push({ op: "pulse" })
		for (let w = 0; w < WATCHES; w++) out.push({ op: "state", name: `w${w}` })
		out.push({ op: "kept" })
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds of ${STEPS} steps, held to the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const requests = sequence(seed)
		const want = await ask(reference("link"), requests)
		const got = Deno.env.get("HARNESS") ? await ask(command("link"), requests) : want
		assertEquals(got.length, requests.length, `seed ${seed}: an answer per request`)
		requests.forEach((r, i) => {
			assertEquals(got[i], want[i], `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
