// node's streams: entries and nodes of random values with random headers, checked against a model.
import { ordered } from "../typescript/json.ts"
import { revive } from "../typescript/form.ts"
import {
	type Answer,
	differs,
	firsts,
	type Generator,
	picker,
	type Request,
	show,
	toJson,
	TRICKY,
	type Violation,
} from "./kit.ts"

const NAMES = ["a", "b", "c", "d"]
const STRINGS = [
	"",
	"a",
	"é",
	'a"b\\c',
	"line\nbreak",
	"\u0001",
	"🦊",
	"__proto__",
	"x\u0000y",
	"中",
	"👍🏽",
	"\uD83D",
	"\uDE00",
	"a\uD800",
	"\uDC00b",
	"\uD83D\uDE00",
]
const KEYS = [...STRINGS, ...TRICKY]

function json(pick: (n: number) => number, depth = 0, forms = true): unknown {
	const k = pick(depth > 2 ? 4 : 8)
	if (k === 0) return null
	if (k === 1) return pick(2) === 0
	if (k === 2) return pick(2) === 0 ? pick(1000) : -pick(1000) / 4
	if (k === 3) return STRINGS[pick(STRINGS.length)]
	if (k === 4) return Array.from({ length: pick(3) }, () => json(pick, depth + 1, forms))
	if (k === 5 && forms) {
		return [
			new Int16Array([pick(9), -pick(9)]),
			new Float32Array([pick(9) / 3]),
			new BigInt64Array([BigInt(pick(99)) - 50n]),
			new Uint8Array([pick(255), pick(255)]),
		][pick(4)]
	}
	const o: [string, unknown][] = []
	for (let i = pick(3); i > 0; i--) o.push([KEYS[pick(KEYS.length)], json(pick, depth + 1, forms)])
	return ordered(o)
}

function header(pick: (n: number) => number): Record<string, unknown> {
	const h: Record<string, unknown> = {}
	if (pick(5)) h.time = pick(2) ? pick(1 << 30) : -1 - pick(100)
	if (pick(2)) h.actor = pick(4) ? NAMES[pick(4)] : pick(2) ? null : { person: NAMES[pick(4)] }
	if (pick(4) === 0) h.reader = NAMES[pick(4)]
	if (pick(3) === 0) {
		h.frame = Array.from({ length: 1 + pick(2) }, () => {
			const info: Record<string, unknown> = Object.fromEntries(
				Array.from({ length: pick(4) }, () => [NAMES[pick(2)], json(pick, 2, false)]),
			)
			if (pick(3) === 0) {
				info.locations = Array.from({ length: pick(3) }, () => ({
					file: `f${pick(9)}.ts`,
					line: 1 + pick(500),
					...(pick(2) ? { column: pick(80) } : {}),
					...(pick(3) === 0 ? { function: NAMES[pick(4)] } : {}),
					external: true,
				}))
			}
			return info
		})
	}
	return h
}

function wild(pick: (n: number) => number): Request {
	const shuffled = () => {
		const h = header(pick)
		const keys = Object.keys(h).reverse()
		return Object.fromEntries(keys.map((k) => [k, h[k]]))
	}
	const all: Request[] = [
		{ op: "entry", value: 1, header: shuffled() },
		{ op: "entry", header: { time: -0 } },
		{ op: "entry", value: { "/": { int16: [-0, 1] } }, header: { time: 1 } },
		{ op: "entry", value: { "/": { int64: ["007", "-0"] } }, header: { time: 1 } },
		{ op: "entry", value: { "/": { float64: ["NaN", -0] } }, header: { time: 1 } },
		{ op: "entry", value: -0, header: { time: 1, frame: [{ a: -0 }] } },
		{ op: "entry", value: 1, header: { time: 1, frame: [[["a", 1]]] } },
		{ op: "entry", value: 1, header: { time: 1, other: 2, actor: "a" } },
		{ op: "node", header: { time: 1 } },
		{ op: "node", values: { a: { "/": { bytes: "a=" } } }, header: { time: 1 } },
		{ op: "Entry" },
	]
	return all[pick(all.length)]
}

const generator: Generator = {
	streams(seed, o) {
		const { pick } = picker(seed)
		const out: Request[] = []
		for (let k = 0; k < 30; k++) {
			if (o.wild && pick(4) === 0) {
				out.push(wild(pick))
				continue
			}
			const r: Request = pick(3) ? { op: "entry" } : { op: "node" }
			if (r.op === "entry") {
				if (pick(4)) r.value = toJson(json(pick))
			} else {
				const values: [string, unknown][] = []
				for (let i = pick(4); i > 0; i--) {
					values.push([KEYS[pick(KEYS.length)], toJson(json(pick))])
				}
				r.values = ordered(values)
			}
			if (pick(4)) r.header = header(pick)
			out.push(r)
		}
		return [out]
	},
}
generator.invariant = invariant
export default generator

const FIELDS = ["time", "actor", "reader", "frame", "op"]
class Refused {}
function expected(r: Request, time: number): Answer | undefined {
	const entry = (value: unknown, h: unknown) => {
		const header = (h ?? {}) as Record<string, unknown>
		const change: Record<string, unknown> = {}
		for (const k of FIELDS) if (Object.hasOwn(header, k)) change[k] = header[k]
		change.time = change.time === undefined ? time : Object.is(change.time, -0) ? 0 : change.time
		const f = change.frame
		if (Object.hasOwn(header, "frame")) {
			const map = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x)
			if (!Array.isArray(f) || f.length === 0 || !f.every(map)) throw new Refused()
		}
		let v: unknown
		try {
			v = value === undefined ? undefined : toJson(revive(value))
		} catch {
			throw new Refused()
		}
		return v === undefined ? { change } : { value: v, change }
	}
	try {
		if (r.op === "entry") return { entry: entry(r.value, r.header) }
		if (r.op !== "node" || r.values === null || typeof r.values !== "object") return
		if (Array.isArray(r.values)) return
		const node: [string, unknown][] = []
		for (const k of Object.keys(r.values)) node.push([k, entry(r.values[k], r.header)])
		return { node: ordered(node) }
	} catch (e) {
		if (e instanceof Refused) return
		throw e
	}
}

function invariant(stream: Request[], answers: (Answer | undefined)[]): Promise<Violation[]> {
	const out: Violation[] = []
	const end = Math.floor(Date.now() / 1000) + 1, start = end - 120
	stream.forEach((r, at) => {
		const a = answers[at]
		if (a === undefined) return
		const times = [a.entry, ...Object.values(a.node ?? {})].map((e) => e?.change?.time)
		const now = times.find((t) => Number.isInteger(t) && t >= start && t <= end) ?? start - 1
		const want = expected(r, now)
		if (want === undefined) {
			if (typeof a.error !== "string") {
				out.push({ kind: "refused", at, why: `${show(r)}: ${show(a)}, not refused` })
			}
		} else if (differs(a, want)) {
			const field = typeof a.error === "string" ? "refused" : differs(a, want)!.path
			out.push({
				kind: `${r.op} ${field.replace(/\[\d+\]/g, "[]")}`,
				at,
				why: `${show(r)}: ${show(a)}, not ${show(want)}`,
			})
		}
	})
	return Promise.resolve(firsts(out))
}
