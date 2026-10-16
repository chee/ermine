// what the unread suite checks besides its scenarios (conformance/run.ts runs those): the harness
// answers an unknown op as an error and goes on. the harness asked is HARNESS, else the TypeScript
// adapter (unread_harness.ts)
import { assert, assertEquals } from "@std/assert"
import type { Patch } from "@ermine/op/apply"
import { ask, command } from "../../../conformance/typescript/ask.ts"
import { fromJson, line, toJson } from "../../../conformance/typescript/form.ts"
import { rand } from "../../../conformance/typescript/rand.ts"
import { createHarness } from "./unread_harness.ts"
import { at, made, patch, paths } from "./random.ts"

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const answers = await ask(command("unread"), [
		{ op: "nope" },
		{ op: "start", value: { a: 1 } },
		{ op: "value" },
	])
	assertEquals(answers.length, 3)
	assert(typeof answers[0].error === "string")
	assertEquals(answers[1], {})
	assertEquals(answers[2], { value: { a: 1 } })
})

// the harness asked against the TypeScript one run here, request by request: random values
// (maps, lists, strings, typed arrays, bytes), random patches mostly where something is (sets,
// takings out, ranges, moves, ranged moves), reads, keeps (alone, wrapped, through a scheduler's
// compute, effect, or failing set), marks and sames, helds, unwrites. a few dozen seeds
const SEEDS = 30, STEPS = 50
const form = (ps: Patch[]) => ps.map((x) => "value" in x ? { ...x, value: toJson(x.value) } : x)

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps, as unread.ts`, async () => {
	const requests: Record<string, unknown>[] = [], expected: unknown[] = [], where: string[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const p = rand(seed)
		const reference = createHarness()
		// answers as they come over the line (JSON: a list's undefined is null)
		const send = (step: number, r: Record<string, unknown>) => {
			const a = JSON.parse(line(reference(r)))
			requests.push(r)
			expected.push(a)
			where.push(`seed ${seed}, step ${step}`)
			return a
		}
		const now = () => fromJson(reference({ op: "value" }).value)
		// what each hold held, as it was then: a held answer must say it still
		let marks: string[] = [], holds = new Map<string, unknown>()
		// the latest write's undo (unwrite writes it)
		let undo: Record<string, unknown>[] | undefined
		// every hold asked: what a write changed in place under one stays changed
		const all = (step: number) => {
			for (const [held, was] of holds) {
				const a = send(step, { op: "held", name: held })
				assertEquals(a.value, was, `seed ${seed}, step ${step}: ${held} as held`)
			}
		}
		const start = (step: number) => {
			all(step)
			send(step, { op: "start", value: toJson(made(p, 3)) })
			marks = [], holds = new Map(), undo = undefined
		}
		const name = (step: number) => p(3) ? undefined : `h${step}`
		const values = (ps: Record<string, unknown>[]) =>
			ps.filter((x) => "value" in x).map((x) => x.value)
		// a write's answer: its undo the latest, when it landed
		const wrote = (a: Record<string, unknown>) => {
			if (Array.isArray(a.undo)) undo = a.undo
		}
		start(0)
		for (let step = 1; step <= STEPS; step++) {
			const k = p(100), v = now(), ps = paths(v)
			if (k < 45) {
				const patches = form(Array.from({ length: 1 + p(3) }, () => patch(p, v)))
				const hold = name(step)
				if (hold) holds.set(hold, values(patches))
				wrote(send(step, { op: "write", patches, ...(hold ? { hold } : {}) }))
			} else if (k < 52) {
				const hold = name(step)
				const a = send(step, { op: "read", ...(hold ? { hold } : {}) })
				if (hold) holds.set(hold, a.value)
			} else if (k < 62) {
				const scheduler = [undefined, true, "effect", "fails"][p(4)]
				const path = ps[p(ps.length)], wrap = !p(2), hold = name(step)
				const x = at(v, path)
				if (hold) {
					holds.set(
						hold,
						x === undefined && !wrap ? undefined : JSON.parse(line(toJson(wrap ? [x] : x))),
					)
				}
				send(step, {
					op: "keep",
					path,
					...(wrap ? { wrap: true } : {}),
					...(p(2) ? {} : { handed: true }),
					...(scheduler === undefined ? {} : { scheduler }),
					...(hold ? { hold } : {}),
				})
			} else if (k < 72) {
				const name = `m${p(4)}`
				if (!marks.includes(name)) marks.push(name)
				send(step, { op: "mark", name, path: ps[p(ps.length)] })
			} else if (k < 82 && marks.length) {
				send(step, { op: "same", name: marks[p(marks.length)], path: ps[p(ps.length)] })
			} else if (k < 88 && holds.size) {
				const names = [...holds.keys()], held = names[p(names.length)]
				const a = send(step, { op: "held", name: held })
				// the reference too says what was held, as it was
				assertEquals(a.value, holds.get(held), `seed ${seed}, step ${step}: ${held} as held`)
			} else if (k < 94) send(step, { op: "value" })
			else if (k < 98) {
				const hold = name(step)
				if (hold) holds.set(hold, undo === undefined ? undefined : values(undo))
				wrote(send(step, { op: "unwrite", ...(hold ? { hold } : {}) }))
			} else start(step)
		}
		all(STEPS)
	}
	const answers = await ask(command("unread"), requests as never)
	assertEquals(answers.length, requests.length, "one answer per request")
	answers.forEach((a, i) => assertEquals(a, expected[i], `${where[i]}: ${line(requests[i])}`))
})
