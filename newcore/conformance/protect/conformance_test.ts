// Runs the scenarios and the fuzzer against a harness. PROTECT_HARNESS: the command for another
// implementation (default: the reference). The protocol: harness.ts. The fuzzer's expectations
// are the reference's own answers.
import { assertEquals } from "@std/assert"
import { answer, type Policy, type Request } from "./harness.ts"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("PROTECT_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(
	" ",
)

type Step = Request & { expect?: unknown }

async function ask(requests: Request[]): Promise<Record<string, unknown>[]> {
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

for await (const f of Deno.readDir(`${here}../../protect/conformance`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${here}../../protect/conformance/${f.name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			if (s.expect !== undefined) assertEquals(answers[i], s.expect, `step ${i}`)
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 60

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// small pools, so rules and asks often meet
function fuzz(pick: (n: number) => number) {
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	const ids = ["a", "b", "c", "n", "home", "ü"]
	const names = ["theme", "notes", "x"]
	const ops = ["read", "write", "push", "pass", "list", "place", "unplace", "pop"]
	const objects = ["value", "order", ["info", "type"], ["info", "tags"], ["children", "x"]]
	const scalars = [null, true, false, 0, 1, 1.5, -2, "", "bob", "k1"]

	function value(depth = 0): unknown {
		const k = pick(depth > 1 ? 3 : 5)
		if (k < 3) return one(scalars)
		if (k === 3) return Array.from({ length: pick(3) }, () => value(depth + 1))
		return Object.fromEntries(
			Array.from({ length: pick(3) }, () => [one(["peer", "x", "actor"]), value(depth + 1)]),
		)
	}

	function actor(): unknown {
		if (pick(3) === 0) return pick(2) ? one(["bob", "carol"]) : value()
		const a: Record<string, unknown> = {}
		if (pick(4)) a.actor = one(["bob", "carol", null])
		if (pick(2)) a.peer = one(["k1", "k2"])
		if (pick(3) === 0) a.person = one(["bob", "p"])
		if (pick(3) === 0) a.trusted = pick(2) === 0
		if (pick(2)) {
			a.code = Array.from({ length: pick(3) }, () => {
				if (pick(5) === 0) return value()
				const s: Record<string, unknown> = { process: one(["p1", "p2", 3]) }
				const k = pick(4)
				if (k === 1) s.program = one(["prog", "other"])
				if (k === 2) s.program = { node: one(["prog", "other", 7]), time: pick(4) }
				return s
			})
		}
		return a
	}

	function args(): Record<string, unknown> {
		const a: Record<string, unknown> = { node: one(ids) }
		if (pick(2)) a.object = one(objects)
		if (pick(3) === 0) a.name = one(names)
		if (pick(4) === 0) a.id = one(ids)
		if (pick(3) === 0) a.at = pick(2) ? pick(3) : [pick(2), pick(3)]
		return a
	}

	const ask = () => ({ op: one(ops), args: args() })

	function rule(): unknown {
		if (pick(30) === 0) return value()
		const r: Record<string, unknown> = {}
		if (pick(3) === 0) r.actor = pick(4) ? one(["bob", "carol", null]) : value()
		if (pick(4) === 0) r.peer = one(["k1", "k2"])
		if (pick(6) === 0) r.person = one(["bob", "p"])
		if (pick(6) === 0) r.trusted = pick(2) === 0
		if (pick(5) === 0) r.process = one(["p1", "p2"])
		if (pick(5) === 0) r.program = one(["prog", "other"])
		if (pick(2)) r.op = one(ops)
		if (pick(3) === 0) r.node = one(ids)
		if (pick(5) === 0) r.id = one(ids)
		if (pick(4) === 0) r.name = one(names)
		if (pick(4) === 0) r.object = one(objects)
		if (pick(40) === 0) r.who = 1
		r.allow = pick(40) === 0 ? "yes" : pick(2) === 0
		return r
	}

	function nodes(): Record<string, unknown> {
		const n: Record<string, unknown> = {}
		for (const id of ["r", "s"]) {
			const k = pick(12)
			if (k === 0) continue // not loaded
			if (k === 1) n[id] = {}
			else if (k === 2) n[id] = { value: value() }
			else n[id] = { value: Array.from({ length: pick(5) }, rule) }
		}
		return n
	}

	function policy(depth = 0): Policy {
		const k = pick(depth > 1 ? 3 : 5)
		if (k === 0) return "anyone"
		if (k === 1) return { rules: one(["r", "s"]) }
		if (k === 2) {
			return { answer: one([{ yes: true }, { pending: true }, { no: { code: "lock" } }]) }
		}
		return { first: Array.from({ length: pick(4) }, () => policy(depth + 1)) }
	}

	const list = () => Array.from({ length: pick(6) }, () => pick(6) ? one(ids) : one(scalars))

	return (): Request => {
		switch (pick(8)) {
			case 0:
			case 1:
				return { op: "may", policy: policy(), actor: actor(), ask: ask(), nodes: nodes() }
			case 2:
				return {
					op: "check",
					policy: policy(),
					actor: actor(),
					asks: Array.from({ length: pick(5) }, ask),
					nodes: nodes(),
				}
			case 3:
				return {
					op: "placing",
					node: one(ids),
					name: one(names),
					before: list(),
					after: list(),
				}
			case 4: {
				const names3 = () => [...new Set(Array.from({ length: pick(3) }, () => one(names)))]
				return {
					op: "read",
					node: {
						id: one(ids),
						value: Array.from({ length: pick(3) }, () => ({})),
						info: names3().map((n) => [n, value()]),
						children: names3().map((n) => [n, []]),
					},
				}
			}
			case 5: {
				const r: Request = { op: "edit", edit: one(ops), node: one(ids), object: one(objects) }
				if (pick(2)) r.at = pick(2) ? pick(4) : [pick(2), pick(4)]
				return r
			}
			case 6:
				return pick(2)
					? {
						op: "pass",
						route: Array.from({ length: pick(4) }, () => ({
							node: one(ids),
							name: one(names),
							id: one(ids),
							at: 0,
						})),
					}
					: { op: "list", node: one(ids) }
			default: {
				const a = ask()
				const facts = answer({ op: "facts", actor: actor(), ask: a }) as { facts: unknown }
				return pick(2)
					? { op: "facts", actor: actor(), ask: a }
					: { op: "matches", rule: rule(), facts: facts.facts }
			}
		}
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} requests, answered as the reference does`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const next = fuzz(rand(seed))
		const requests = Array.from({ length: STEPS }, next)
		const answers = await ask(requests)
		assertEquals(answers.length, requests.length, `seed ${seed}: one answer per request`)
		requests.forEach((r, i) => {
			assertEquals(answers[i], answer(r), `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
