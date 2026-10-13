// Runs invert's scenarios (core/op/conformance/invert/) and a fuzzer against a harness that speaks
// op-apply's protocol (conformance/op-apply/harness.ts: { op: "invert", value?, patches, list? }).
// OP_APPLY_HARNESS: the command for another implementation (default: the reference).
//
// Every undo answered is also walked back with apply.ts: apply(apply(value, patches), undo) is
// value; lists, strings and typed arrays element for element, maps by content (a key put back
// goes last). The fuzzer makes values and patches and asks the harness: its answers must be what
// calling invert.ts gives.
import { assert, assertEquals } from "@std/assert"
import apply, { ApplyError, type Key, type Patch } from "@ermine/op/apply"
import invert from "@ermine/op/invert"
import { Stand } from "@ermine/encoding/cbor"
import { fromJson, line, toJson } from "../pack/form.ts"

const here = new URL(".", import.meta.url).pathname
const scenarios = `${here}../../core/op/conformance/invert/`
const reference = `deno run --quiet ${here}../op-apply/harness.ts`
const command = (Deno.env.get("OP_APPLY_HARNESS") ?? reference).split(" ")

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[]): Promise<Answer[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const done = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await done
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const isSlash = (x: unknown): x is { "/": unknown } =>
	isMap(x) && Object.keys(x).length === 1 && Object.hasOwn(x, "/")

// a value from its JSON form, lone surrogates and all (as the harness revives it)
function revive(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(revive)
	if (!isMap(x)) return x
	if (isSlash(x)) {
		const form = x["/"]
		if (isMap(form) && Object.keys(form).length === 1) {
			if (Object.hasOwn(form, "map") && isSlash(form.map)) return { "/": revive(form.map["/"]) }
			if (Object.hasOwn(form, "live")) return new Stand(revive(form.live) as never)
		}
		return fromJson(x)
	}
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(x)) {
		Object.defineProperty(out, k, {
			value: revive(x[k]),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return out
}
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
	const o = { list: r.list === true }
	const out = apply(value, patchesOf(r.patches), o)
	const back = apply(out, patchesOf(undo), o)
	assertEquals(content(back), content(apply(value, [], o)), `${why}: the way back`)
}

type Step = Request & { expect: Answer }

const files = [...Deno.readDirSync(scenarios)].map((f) => f.name).filter((n) => n.endsWith(".json"))
	.sort()
for (const name of files) {
	const { title, steps } = JSON.parse(await Deno.readTextFile(scenarios + name)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, ...r } = s
			assertEquals(answers[i], s.expect, `step ${i}: ${line(r)}`)
			if (answers[i].undo) walksBack(r, answers[i].undo, `step ${i}: ${line(r)}`)
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const PATCHES = 24

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}
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
function patch(pick: Pick, v: unknown, list: boolean): Patch {
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
	if (list && pick(6) === 0) return { path: [], value: pick(4) ? [made(pick, 1)] : made(pick, 0) }
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

const request = (value: unknown, ps: Patch[], list: boolean): Request => ({
	op: "invert",
	...(value === undefined ? {} : { value: toJson(value) }),
	patches: ps.map((p) =>
		isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: toJson(p.value) } : p
	),
	...(list ? { list } : {}),
})
// invert.ts called directly, answered as the harness answers
function direct(value: unknown, ps: Patch[], list: boolean): Answer {
	try {
		const undo = invert(value, ps, { list })
		return JSON.parse(
			line({ undo: undo.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p) }),
		)
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		return { error: { code: e.code, patch: e.patch } }
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${PATCHES} patches, as invert.ts; each undo walks back`, async () => {
	const requests: Request[] = [], expected: Answer[] = [], where: string[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const list = seed % 5 === 0
		const start = list
			? (pick(3) ? Array.from({ length: pick(5) }, () => made(pick, 1)) : undefined)
			: pick(8)
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
			const p = patch(pick, v, list)
			try {
				v = apply(start, [...good, p], { list })
				good.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				if (bad.length < 3) bad.push([good.length, p])
			}
		}
		const add = (what: string, ps: Patch[]) => {
			requests.push(request(start, ps, list))
			expected.push(direct(start, ps, list))
			where.push(`seed ${seed}: ${what}`)
		}
		add("all", good)
		for (let k = 1; k < good.length; k += 4) add(`the first ${k}`, good.slice(0, k))
		for (const [k, p] of bad) add(`invalid at ${k}`, [...good.slice(0, k), p, ...good.slice(k)])
	}
	const answers = await ask(requests)
	assertEquals(answers.length, requests.length, "one answer per request")
	answers.forEach((a, i) => {
		assertEquals(a, expected[i], `${where[i]}: ${line(requests[i])}`)
		if (a.undo) walksBack(requests[i], a.undo, where[i])
	})
	assert(answers.some((a) => a.undo?.some((p: Patch) => p.move)), "some undo moves back")
})
