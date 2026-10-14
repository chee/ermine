// what the places harness does besides its scenarios (conformance/run.ts runs those): a request not
// understood, and a seeded fuzzer. HARNESS: the command for another implementation (default: the
// TypeScript adapter). The protocol: places_harness.ts.
//
// the fuzzer makes random writes over a small graph, with places opened on random addresses, and
// checks that every opened place's items agree with get at its address; with HARNESS set, the
// TypeScript adapter gets the same requests and every answer must be the same (same aside: how two
// opened places share a step is each implementation's own)
import { assert, assertEquals } from "@std/assert"
import { ask as run, command, reference } from "../../../conformance/typescript/ask.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>
const ask = (cmd: string[], requests: Request[]) => run(cmd, requests) as Promise<Answer[]>

const given = Deno.env.get("HARNESS")
const cmd = command("places")
const without = (a: Answer, keys: string[]) => {
	const { ...copy } = a
	for (const k of keys) delete copy[k]
	return copy
}

Deno.test("a request not understood is an error, and the harness goes on", async () => {
	const answers = await ask(cmd, [
		{ op: "nope" },
		{ op: "get", address: ["a"], from: ["s"] },
		{ op: "items", open: "never" },
		{ op: "children", source: 5, id: "x" },
		{ op: "get", address: [] },
	])
	assertEquals(answers.length, 5)
	for (const i of [0, 1, 2, 3]) {
		assert(typeof answers[i].error === "string")
		assert(!["not-a-name", "nothing-there", "already-there", "range"].includes(answers[i].error))
	}
	assertEquals(answers[4].items.length, 1)
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 60
// how many items of an opened place get a fresh members to compare with its kept one
const WIDE = 8
const NAMES = ["a", "b", "c"]
const IDS = ["R", "A", "B", "C", "D"]
const SOURCES: unknown[] = ["s", "drag", { symbol: "x" }]
const SKIP = ["same"]

// the requests of a seed, and at which index each opened place's items and its get are asked
function sequence(
	seed: number,
): { requests: Request[]; pairs: number[]; kept: number[] } {
	const pick = rand(seed)
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const requests: Request[] = []
	const pairs: number[] = []
	// where each members of an opened place is asked, then WIDE fresh members of its items
	const kept: number[] = []
	requests.push({ op: "make", root: ["s", "R"] })
	for (const source of SOURCES) {
		for (const id of IDS) {
			// D of "s" has no children node: a parent that is not there
			if (id === "D" && source === "s") continue
			requests.push({
				op: "children",
				source,
				id,
				value: {},
				...(pick(5) ? {} : { inplace: true }),
			})
		}
	}
	const addresses = Array.from(
		{ length: 6 },
		() =>
			Array.from(
				{ length: 1 + pick(3) },
				() => pick(8) === 0 ? one(["..", ".", "/"]) : one(NAMES),
			),
	)
	addresses.forEach((address, i) => requests.push({ op: "open", address, as: `h${i}` }))
	const dropped = new Set<number>()
	// mostly the same few parents, so writes land and opened places have something to follow
	const parent = () => [
		one(["s", "s", "drag", "drag", SOURCES[2]]),
		pick(8) === 0 ? "D" : one(["R", "R", "A", "B", "C"]),
	]
	const entry = () => [one(["s", "s", "drag", SOURCES[2]]), IDS[1 + pick(4)]]
	for (let step = 0; step < STEPS; step++) {
		const time = step + 2
		const k = pick(24)
		if (k < 10) {
			requests.push({
				op: "place",
				parent: parent(),
				name: one(NAMES),
				entry: entry(),
				...(pick(2) ? {} : { index: pick(4) - 1 }),
				time,
			})
		} else if (k < 9) {
			requests.push({
				op: "unplace",
				parent: parent(),
				name: one(NAMES),
				index: pick(3) - 1,
				time,
			})
		} else if (k < 14) {
			requests.push({
				op: "order",
				parent: parent(),
				name: one(NAMES),
				from: pick(3),
				to: pick(3),
				time,
			})
		} else if (k < 16) {
			requests.push({
				op: "rename",
				parent: parent(),
				name: one(NAMES),
				to: pick(10) === 0 ? one([".", "..", "/"]) : one(NAMES),
				time,
			})
		} else if (k < 20) {
			requests.push({
				op: "move",
				parent: parent(),
				name: one(NAMES),
				index: pick(3),
				to: { parent: parent(), name: pick(10) === 0 ? "." : one(NAMES) },
				...(pick(2) ? {} : { toindex: pick(3) }),
				time,
			})
		} else if (k === 20 && pick(3) === 0) {
			requests.push({ op: "nothing", source: one(SOURCES), id: one(IDS) })
		} else if (k === 21 && pick(2) === 0) {
			// a node replaced: whatever it held, a map with a name or two, some of it malformed
			const value: Record<string, unknown> = {}
			for (const name of NAMES) {
				if (pick(2)) {
					value[name] = pick(6) === 0
						? 5
						: Array.from({ length: pick(3) }, () => pick(8) === 0 ? 7 : entry())
				}
			}
			requests.push({
				op: "children",
				source: one(SOURCES),
				id: one(IDS),
				value,
				...(pick(4) ? {} : { inplace: true }),
			})
		} else if (k === 22 && dropped.size < 2) {
			const h = pick(6)
			if (!dropped.has(h)) {
				dropped.add(h)
				requests.push({ op: "drop", open: `h${h}` })
			}
		} else {
			requests.push({ op: "get", address: one(addresses) })
		}
		for (let h = 0; h < 6; h++) {
			if (dropped.has(h)) continue
			pairs.push(requests.length)
			requests.push(
				{ op: "items", open: `h${h}`, save: `k${h}` },
				{ op: "get", address: addresses[h] },
			)
			kept.push(requests.length)
			requests.push({ op: "members", open: `h${h}` })
			for (let j = 0; j < WIDE; j++) {
				requests.push({ op: "members", from: { item: `k${h}`, at: j } })
			}
		}
	}
	return { requests, pairs, kept }
}

Deno.test(`fuzz: ${SEEDS} seeds x ${STEPS} writes: opened places agree with get`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { requests, pairs, kept } = sequence(seed)
		const answers = await ask(cmd, requests)
		assertEquals(answers.length, requests.length, `seed ${seed}`)
		for (const i of pairs) {
			assert(
				Array.isArray(answers[i].items),
				`seed ${seed}, request ${i}: ${JSON.stringify(answers[i])}`,
			)
			assertEquals(answers[i].items, answers[i + 1].items, `seed ${seed}, request ${i}`)
		}
		for (const i of kept) {
			const items = answers[i - 2].items as unknown[]
			assert(Array.isArray(answers[i].items), `seed ${seed}, request ${i}`)
			if (items.length > WIDE) continue
			const fresh = answers.slice(i + 1, i + 1 + items.length).flatMap((a) => a.items)
			assertEquals(answers[i].items, fresh, `seed ${seed}, request ${i}: kept members`)
		}
		for (const a of answers) {
			// a fresh members from an item past the end of the list: no such item
			if ("error" in a && !String(a.error).endsWith("no such saved item")) {
				assert(
					["not-a-name", "nothing-there", "already-there", "range"].includes(a.error),
					`seed ${seed}: ${JSON.stringify(a)}`,
				)
			}
		}
		if (given !== undefined) {
			const expected = await ask(reference("places"), requests)
			answers.forEach((a, i) => {
				// a request that is no good: the words are each implementation's own
				if ("error" in a && String(a.error).endsWith("no such saved item")) return
				assertEquals(
					without(a, SKIP),
					without(expected[i], SKIP),
					`seed ${seed}, request ${i}: ${JSON.stringify(requests[i])}`,
				)
			})
		}
	}
})
