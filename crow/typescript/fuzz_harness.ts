// Besides their scenarios, the harness suites run the harness asked against the TypeScript one
// request by request, on random values and patches, reads, keeps, marks, sames, helds and
// unwrites, for a few dozen seeds.
import { assertEquals } from "@std/assert"
import type { Patch } from "@ermine/changeable/apply"
import { ask, command } from "../../conformance/typescript/ask.ts"
import type { Request } from "../../conformance/typescript/harness.ts"
import { line, revive, toJson } from "../../conformance/typescript/form.ts"
import { rand } from "../../conformance/typescript/rand.ts"
import { at, made, patch, paths } from "./random_harness.ts"

export const SEEDS = 30, STEPS = 50
const form = (ps: Patch[]) => ps.map((x) => "value" in x ? { ...x, value: toJson(x.value) } : x)
const sorted = (v: unknown) =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
		: v

export async function fuzz(
	suite: string,
	createHarness: () => (r: Request) => Record<string, unknown>,
	withScheduler: boolean,
) {
	const requests: Record<string, unknown>[] = [], expected: unknown[] = [], where: string[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const p = rand(seed)
		const reference = createHarness()
		const send = (step: number, r: Record<string, unknown>) => {
			const a = JSON.parse(line(reference(r)))
			requests.push(r)
			expected.push(a)
			where.push(`seed ${seed}, step ${step}`)
			return a
		}
		const now = () => revive(reference({ op: "value" }).value)
		let marks: string[] = [], holds = new Map<string, unknown>()
		let undo: Record<string, unknown>[] | undefined
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
				const scheduler = withScheduler ? [undefined, true, "effect", "fails"][p(4)] : undefined
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
	const answers = await ask(command(suite), requests as never)
	assertEquals(answers.length, requests.length, "one answer per request")
	answers.forEach((a, i) =>
		assertEquals(line(a, sorted), line(expected[i], sorted), `${where[i]}: ${line(requests[i])}`)
	)
}
