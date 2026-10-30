// Tests update on the harness named by HARNESS (default update_harness.ts), with a fuzzer.
import { assert, assertEquals } from "@std/assert"
import type { Changeable, ChangeHeader } from "@ermine/changeable"
import update from "@ermine/changeable/update"
import apply, { ApplyError, type Patch } from "@ermine/changeable/apply"
import { ask, command, reference, suite } from "../../conformance/typescript/ask.ts"
import { line, revive, toJson } from "../../conformance/typescript/form.ts"
import { rand } from "../../conformance/typescript/rand.ts"

const createChangeable = <V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Changeable<V> => {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const c: Changeable<V> = { change }
	if (value !== undefined) c.value = value
	return c
}

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

const canon = (v: unknown): unknown =>
	Array.isArray(v)
		? v.map(canon)
		: v !== null && typeof v === "object"
		? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Answer)[k])]))
		: v

function around(
	steps: Request[],
): { asked: Request[]; at: number[]; check: (a: Answer[]) => void } {
	const asked: Request[] = [], at: number[] = []
	for (const s of steps) {
		if (s.op === "update") asked.push({ op: "entry" })
		at.push(asked.length)
		asked.push(s)
		if (s.op === "update") asked.push({ op: "entry" })
	}
	const check = (a: Answer[]) => {
		steps.forEach((s, k) => {
			if (s.op !== "update") return
			const i = at[k]
			const before = a[i - 1].entry, after = a[i + 1].entry
			if (a[i].error) {
				assertEquals(after, before, `step ${k}: a failed update changes nothing`)
				return
			}
			const undo = (after.change.op.undo as Patch[]).map((p) => revive(p) as Patch)
			const back = apply(revive(after.value), undo)
			assertEquals(
				canon(toJson(back)),
				canon(before.value),
				`step ${k}: the undo takes the value back`,
			)
		})
	}
	return { asked, at, check }
}

Deno.test("around every update: the undo takes the value back, a failed one changes nothing", async () => {
	const dir = suite("update").fixtures
	for (
		const f of [...Deno.readDirSync(dir)].map((f) => f.name).filter((n) => /^\d.*\.json$/.test(n))
			.sort()
	) {
		const { steps } = JSON.parse(Deno.readTextFileSync(dir + f)) as { steps: Request[] }
		const requests = steps.map(({ expect: _, fails: __, skip: ___, ...r }) => r)
		const { asked, check } = around(requests)
		const answers = await ask(command("update"), asked)
		assertEquals(answers.length, asked.length, `${f}: one answer per request`)
		check(answers)
	}
})

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask(command("update"), [{ op: "nope" }, { op: "start" }])
	assert(a.error)
	assertEquals(b, {})
})

const SEEDS = 40
const STEPS = 30

const KEYS = ["a", "b", "c"]
const content = () => ({ l: [1, 2, 3], s: "a\uD83D中👍🏽\u0000\uDE00b", m: { a: 1 } })
const PIECES = ["x", "é", "😀", "👍🏽", "\uD83D", "\uDE00", "\uD800\uDC00", "\u0000"]
const start = { op: "start", value: content(), header: { time: 0, actor: "host" } }

function patch(pick: (n: number) => number, v: Record<string, unknown>): Patch {
	const l = v.l as unknown[], s = [...(v.s as string)]
	const i = pick(l.length + 1), j = i + pick(l.length - i + 1)
	const c = pick(s.length + 1), d = c + pick(s.length - c + 1)
	switch (pick(16)) {
		case 0:
			return { path: ["l"], range: [i, j], value: [pick(9)] }
		case 1:
			return { path: ["l"], range: [i, j] }
		case 2:
			return { path: ["s"], range: [c, c], value: PIECES[pick(PIECES.length)] }
		case 3:
			return { path: ["s"], range: [c, d], value: pick(3) ? PIECES[pick(PIECES.length)] : "" }
		case 4:
			return { path: ["m", KEYS[pick(3)]], value: pick(2) ? pick(9) : { n: [pick(9)] } }
		case 5:
			return { path: ["m", KEYS[pick(3)]] }
		case 6:
			return l.length
				? {
					path: ["l"],
					range: [i % l.length, i % l.length],
					move: { path: ["l", pick(l.length)] },
				}
				: { path: ["l"], range: [0, 0], value: [1, 2, 3] }
		case 7:
			return l.length > 1
				? {
					path: ["l"],
					range: [0, 0],
					move: { path: ["l"], range: [1, 1 + pick(l.length - 1)] },
				}
				: { path: ["l", 0], value: 0 }
		case 8:
			return l.length
				? { path: ["m", KEYS[pick(3)]], move: { path: ["l", pick(l.length)] } }
				: { path: ["s"], range: [0, 0], value: "y" }
		case 9:
			return l.length > 1
				? { path: ["l", pick(l.length - 1)], move: { path: ["l", pick(l.length)] } }
				: { path: ["l", pick(l.length + 1)], value: 7 }
		case 10:
			return { path: ["s"], range: [pick(2), 0 + pick(2)], move: { path: ["m", KEYS[pick(3)]] } }
		case 11:
			return pick(2)
				? { path: ["l", 9], value: 1 }
				: { path: ["s"], range: [c, c + 1 + pick(5)] }
		case 12:
			return pick(2)
				? { path: ["l"], range: [0, 0], value: "x" as unknown }
				: { path: ["m", "a", "z"], move: { path: ["m"] } } as Patch
		case 13:
			return { path: ["s"], range: [c, c], move: { path: ["s"], range: [c, d] } }
		default:
			return { path: ["l", pick(l.length + 1)], value: 7 }
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, as the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const n = createChangeable<Record<string, unknown>>(content())
		const patches: Patch[] = [], good: Patch[] = []
		for (let k = 0; k < STEPS; k++) {
			const p = patch(pick, structuredClone(n.value!))
			patches.push(p)
			try {
				update(n, [p], { time: 1, actor: "me", frame: { info: {}, parent: undefined } })
				good.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		const steps: Request[] = [start]
		for (const p of patches) steps.push({ op: "update", patches: [p] })
		steps.push(start, { op: "update", patches: good }, { op: "entry" })
		const { asked, check } = around(steps)
		const mine: Answer[] = await ask(command("update"), asked)
		if (Deno.env.get("HARNESS")) {
			assertEquals(
				line(canon(mine)),
				line(canon(await ask(reference("update"), asked))),
				`seed ${seed}`,
			)
		}
		check(mine)
		assertEquals(
			canon(mine[mine.length - 1].entry.value),
			canon(toJson(n.value)),
			`seed ${seed}: the end`,
		)
	}
})
