// Runs the scenarios, and a seeded fuzzer, against a harness. PLACES_HARNESS: the command for
// another implementation (default: the reference). The protocol: harness.ts.
//
// scenarios (core/places/conformance/places/*.json): { title, steps }, a step a request and its
// expect; a step's skip lists answer fields not compared (same, where a list's identity is not
// the rule). the fuzzer makes random writes over a small graph, with places opened on random
// addresses, and checks that every opened place's items agree with get at its address; with
// PLACES_HARNESS set, the reference gets the same requests and every answer must be the same
// (same aside: how two opened places share a step is each implementation's own)
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const given = Deno.env.get("PLACES_HARNESS")
const command = (given ?? reference).split(" ")
const scenarios = `${here}../../core/places/conformance/places`

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[], cmd = command): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
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

type Step = Request & { expect: Answer; skip?: string[] }

const without = (a: Answer, keys: string[]) => {
	const { ...copy } = a
	for (const k of keys) delete copy[k]
	return copy
}

const files: string[] = []
for await (const f of Deno.readDir(scenarios)) if (f.name.endsWith(".json")) files.push(f.name)
files.sort()
for (const name of files) {
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${scenarios}/${name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, skip: __, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, skip, ...r } = s
			assertEquals(
				without(answers[i], skip ?? []),
				without(s.expect, skip ?? []),
				`step ${i}: ${JSON.stringify(r)}`,
			)
		})
	})
}

Deno.test("a request not understood is an error, and the harness goes on", async () => {
	const answers = await ask([
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
const NAMES = ["a", "b", "c"]
const IDS = ["R", "A", "B", "C", "D"]
const SOURCES: unknown[] = ["s", "drag", { symbol: "x" }]
const SKIP = ["same"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// the requests of a seed, and at which index each opened place's items and its get are asked
function sequence(seed: number): { requests: Request[]; pairs: number[] } {
	const pick = rand(seed)
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const requests: Request[] = []
	const pairs: number[] = []
	requests.push({ op: "make", root: ["s", "R"] })
	for (const source of SOURCES) {
		for (const id of IDS) {
			// D of "s" has no children node: a parent that is not there
			if (id === "D" && source === "s") continue
			requests.push({ op: "children", source, id, value: {} })
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
			requests.push({ op: "children", source: one(SOURCES), id: one(IDS), value })
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
			requests.push({ op: "items", open: `h${h}` }, { op: "get", address: addresses[h] })
		}
	}
	return { requests, pairs }
}

Deno.test(`fuzz: ${SEEDS} seeds x ${STEPS} writes: opened places agree with get`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { requests, pairs } = sequence(seed)
		const answers = await ask(requests)
		assertEquals(answers.length, requests.length, `seed ${seed}`)
		for (const i of pairs) {
			assert(
				Array.isArray(answers[i].items),
				`seed ${seed}, request ${i}: ${JSON.stringify(answers[i])}`,
			)
			assertEquals(answers[i].items, answers[i + 1].items, `seed ${seed}, request ${i}`)
		}
		for (const a of answers) {
			if ("error" in a) {
				assert(
					["not-a-name", "nothing-there", "already-there", "range"].includes(a.error),
					`seed ${seed}: ${JSON.stringify(a)}`,
				)
			}
		}
		if (given !== undefined) {
			const expected = await ask(requests, reference.split(" "))
			answers.forEach((a, i) => {
				assertEquals(
					without(a, SKIP),
					without(expected[i], SKIP),
					`seed ${seed}, request ${i}: ${JSON.stringify(requests[i])}`,
				)
			})
		}
	}
})
