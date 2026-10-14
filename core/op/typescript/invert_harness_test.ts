// what invert's suite does besides its scenarios (conformance/run.ts), asked of the harness named
// by HARNESS (default: the TypeScript one, apply_harness.ts, which speaks both suites: { op:
// "invert", value?, patches, cow? }).
//
// Every undo answered is also walked back with apply.ts: apply(apply(value, patches), undo) is
// value; lists, strings and typed arrays element for element, maps by content (a key put back
// goes last). That is done for the scenarios' answers too, at the start of the one test. The
// fuzzer makes values and patches and asks the harness: its answers must be what calling
// invert.ts gives.
import { assert, assertEquals } from "@std/assert"
import apply, { ApplyError, type Key, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import { ask, command, suite } from "../../../conformance/typescript/ask.ts"
import { line, revive, toJson } from "../../../conformance/typescript/form.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

const harness = command("invert")
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

const patchesOf = (ps: unknown[]) =>
	ps.map((p) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: revive(p.value) } : p
	) as Patch[]

// a value's JSON form with every map's keys sorted: the same for the same content
const sorted = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
const content = (v: unknown) => v === undefined ? "(nothing)" : line(toJson(v), sorted)

// the undo, walked back with apply.ts: the value as apply has it
function walksBack(r: Request, undo: unknown[], why: string) {
	const value = Object.hasOwn(r, "value") ? revive(r.value) : undefined
	const out = apply(value, patchesOf(r.patches))
	const back = apply(out, patchesOf(undo))
	assertEquals(content(back), content(apply(value, [])), `${why}: the way back`)
}

// the scenarios' undos walk back too
async function scenarios() {
	for (const f of [...Deno.readDirSync(suite("invert").fixtures)].map((f) => f.name).sort()) {
		if (!/^\d.*\.json$/.test(f)) continue
		const { steps } = JSON.parse(Deno.readTextFileSync(suite("invert").fixtures + f)) as {
			steps: Request[]
		}
		const requests = steps.map(({ expect: _, fails: __, skip: ___, ...r }) => r)
		const answers = await ask(harness, requests)
		answers.forEach((a, i) => {
			if (a.undo) {
				walksBack(requests[i], a.undo as unknown[], `${f} step ${i}: ${line(requests[i])}`)
			}
		})
	}
}

// a few dozen seeds (fuzz runs stay small)
const SEEDS = 40
const PATCHES = 24

type Pick = ReturnType<typeof rand>

const PARTS = ["a", "b", "xy", "é", "中", "😀", "\uD83D", "\uDE00", "\uD800", "\uDC00", "\u0000"]
const KEYS = ["a", "b", "c", "k"]
const KINDS = [Int8Array, Int16Array, Uint32Array, Float64Array, BigInt64Array]
const view = (v: unknown): v is ArrayLike<unknown> & object =>
	ArrayBuffer.isView(v) && !(v instanceof DataView)
const isSeq = (v: unknown) =>
	typeof v === "string" || Array.isArray(v) || view(v) && !(v instanceof Uint8Array)
const len = (v: unknown) => typeof v === "string" ? Array.from(v).length : (v as unknown[]).length

function text(pick: Pick, most = 6) {
	return Array.from({ length: pick(most + 1) }, () => PARTS[pick(PARTS.length)]).join("")
}
function elements(pick: Pick, kind: (typeof KINDS)[number], n: number) {
	const xs = Array.from({ length: n }, () => pick(200) - (kind === Uint32Array ? 0 : 100))
	const make = kind as unknown as new (xs: unknown[]) => ArrayLike<unknown>
	return new make(kind === BigInt64Array ? xs.map(BigInt) : xs)
}
function made(pick: Pick, depth: number): unknown {
	switch (pick(depth > 0 ? 9 : 6)) {
		case 0:
			return pick(100)
		case 1:
		case 2:
			return text(pick)
		case 3:
			return elements(pick, KINDS[pick(KINDS.length)], pick(4))
		case 4:
			return new Uint8Array(Array.from({ length: pick(3) }, () => pick(256)))
		case 5:
			return [null, true, false, 0.5][pick(4)]
		case 6:
		case 7:
			return Array.from({ length: pick(4) }, () => made(pick, depth - 1))
		default:
			return Object.fromEntries(
				Array.from({ length: pick(4) }, () => [KEYS[pick(KEYS.length)], made(pick, depth - 1)]),
			)
	}
}
function places(v: unknown, path: Key[] = [], out: [Key[], unknown][] = []) {
	out.push([path, v])
	if (path.length >= 4) return out
	if (Array.isArray(v)) v.forEach((x, i) => places(x, [...path, i], out))
	else if (isMap(v) && !view(v)) {
		for (const k of Object.keys(v)) {
			places(v[k], [...path, k], out)
		}
	}
	return out
}
function span(pick: Pick, n: number): [number, number] {
	const a = pick(n + 1)
	return [a, a + pick(n - a + 1)]
}
function filling(pick: Pick, s: unknown): unknown {
	if (typeof s === "string") return text(pick, 3)
	if (Array.isArray(s)) return Array.from({ length: pick(3) }, () => made(pick, 1))
	return elements(pick, s!.constructor as (typeof KINDS)[number], pick(3))
}
// a patch against v: many valid, some not
function patch(pick: Pick, v: unknown): Patch {
	const all = v === undefined ? [] : places(v)
	const any = () => all.length ? all[pick(all.length)] : [[], undefined] as [Key[], unknown]
	const seqs = all.filter(([, x]) => isSeq(x))
	const maps = all.filter(([, x]) => isMap(x) && !view(x))
	const seq = () => seqs.length ? seqs[pick(seqs.length)] : any()
	const key = () =>
		maps.length ? [...maps[pick(maps.length)][0], KEYS[pick(KEYS.length)]] : any()[0]
	const gap = (s: unknown) => {
		const g = pick((isSeq(s) ? len(s) : 0) + 1)
		return [g, g + (pick(3) ? 0 : 1)] as [number, number]
	}
	switch (pick(15)) {
		case 0:
			return { path: any()[0], value: made(pick, 2) }
		case 1:
			return { path: key(), value: made(pick, 1) }
		case 2:
			return pick(5) ? { path: any()[0] } : { path: key() }
		case 3:
		case 4:
		case 5: {
			const [p, s] = seq()
			if (!isSeq(s)) return { path: p, range: [0, 0], value: "x" }
			const r = span(pick, len(s))
			return pick(3) ? { path: p, range: r, value: filling(pick, s) } : { path: p, range: r }
		}
		case 6:
			return { path: key(), move: { path: any()[0] } }
		case 7:
			return { path: any()[0], move: { path: any()[0] } }
		case 8:
		case 9: {
			// a value into a sequence of its kind
			const [p, s] = seq()
			const fits = all.filter(([q, x]) =>
				q.length > 0 && (Array.isArray(s) ||
					(typeof s === "string"
						? typeof x === "string"
						: view(x) && x.constructor === s?.constructor))
			)
			const from = fits.length ? fits[pick(fits.length)][0] : any()[0]
			return { path: p, range: gap(s), move: { path: from } }
		}
		case 10:
		case 11: {
			const [f, s] = seq()
			const n = isSeq(s) ? len(s) : 0, r = span(pick, n)
			const g = pick(n - (r[1] - r[0]) + 1)
			return { path: f, range: [g, g + (pick(3) ? 0 : 1)], move: { path: f, range: r } }
		}
		case 12: {
			const [f, s] = seq()
			const r = span(pick, isSeq(s) ? len(s) : 0)
			const [p, t] = seq()
			return pick(2)
				? { path: p, range: gap(t), move: { path: f, range: r } }
				: { path: key(), move: { path: f, range: r } }
		}
		case 13:
			return { path: [], value: made(pick, 2) }
		default: {
			const [p] = any()
			return { path: [...p, [["x"], [0], [9], ["a", "b"]][pick(4)]].flat(), value: 1 }
		}
	}
}

const request = (value: unknown, ps: Patch[]): Request => ({
	op: "invert",
	...(value === undefined ? {} : { value: toJson(value) }),
	patches: ps.map((p) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: toJson(p.value) } : p
	),
})
// invert.ts called directly, answered as the harness answers
function direct(value: unknown, ps: Patch[]): Answer {
	try {
		const undo = invert(value, ps)
		return JSON.parse(
			line({ undo: undo.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p) }),
		)
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		return { error: { code: e.code, patch: e.patch } }
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${PATCHES} patches, as invert.ts; each undo walks back`, async () => {
	await scenarios()
	const requests: Request[] = [], expected: Answer[] = [], where: string[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const start = pick(8)
			? {
				s: text(pick, 8),
				l: made(pick, 2),
				t: elements(pick, Int16Array, 3),
				m: made(pick, 2),
			}
			: made(pick, 3)
		let v: unknown = start
		const good: Patch[] = [], bad: [number, Patch][] = []
		for (let tries = 0; good.length < PATCHES && tries < PATCHES * 4; tries++) {
			const p = patch(pick, v)
			try {
				v = apply(start, [...good, p])
				good.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				if (bad.length < 3) bad.push([good.length, p])
			}
		}
		const add = (what: string, ps: Patch[]) => {
			requests.push(request(start, ps))
			expected.push(direct(start, ps))
			where.push(`seed ${seed}: ${what}`)
		}
		add("all", good)
		for (let k = 1; k < good.length; k += 4) add(`the first ${k}`, good.slice(0, k))
		for (const [k, p] of bad) add(`invalid at ${k}`, [...good.slice(0, k), p, ...good.slice(k)])
	}
	const answers = (await ask(harness, requests)) as Answer[]
	assertEquals(answers.length, requests.length, "one answer per request")
	answers.forEach((a, i) => {
		assertEquals(a, expected[i], `${where[i]}: ${line(requests[i])}`)
		if (a.undo) walksBack(requests[i], a.undo, where[i])
	})
	// the same in place
	const inPlace = await ask(harness, requests.map((r) => ({ ...r, cow: false })))
	inPlace.forEach((a, i) =>
		assertEquals(a, expected[i], `${where[i]} (cow: false): ${line(requests[i])}`)
	)
	assert(answers.some((a) => a.undo?.some((p: Patch) => p.move)), "some undo moves back")
})
