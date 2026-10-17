// node's streams: entries and nodes of random values (plain JSON, typed arrays, bytes, odd keys
// and strings) with random headers, their fields in the header's own order. each line stands
// alone; a header with no time is answered the time now (compared within the run's seconds).
// wild: a header's fields out of order, a time of -0, -0 in an integer typed array, 64-bit
// elements as "007" and "-0", metadata that is no pair, a node with no values
import { type Generator, picker, type Request, toJson } from "./kit.ts"

const NAMES = ["a", "b", "c", "d"]
const STRINGS = ["", "a", "é", 'a"b\\c', "line\nbreak", "\u0001", "🦊", "__proto__", "x\u0000y"]

// forms: typed arrays and bytes too (a value's; a header is plain JSON)
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
	const o: Record<string, unknown> = {}
	for (let i = pick(3); i > 0; i--) {
		Object.defineProperty(o, STRINGS[pick(STRINGS.length)], {
			value: json(pick, depth + 1, forms),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return o
}

function header(pick: (n: number) => number): Record<string, unknown> {
	const h: Record<string, unknown> = {}
	if (pick(5)) h.time = pick(2) ? pick(1 << 30) : -1 - pick(100)
	if (pick(2)) h.actor = pick(4) ? NAMES[pick(4)] : pick(2) ? null : { person: NAMES[pick(4)] }
	if (pick(4) === 0) h.reader = NAMES[pick(4)]
	if (pick(3) === 0) {
		h.external = Array.from({ length: pick(3) }, () => ({
			file: `f${pick(9)}.ts`,
			line: 1 + pick(500),
			...(pick(2) ? { column: pick(80) } : {}),
			...(pick(3) === 0 ? { function: NAMES[pick(4)] } : {}),
		}))
	}
	if (pick(3) === 0) {
		h.metadata = Array.from({ length: pick(4) }, () => [NAMES[pick(2)], json(pick, 2, false)])
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
		{ op: "entry", value: -0, header: { time: 1, metadata: [["a", -0]] } },
		{ op: "entry", value: 1, header: { time: 1, metadata: [["a"]] } },
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
				const values: Record<string, unknown> = {}
				for (let i = pick(4); i > 0; i--) {
					Object.defineProperty(values, STRINGS[pick(STRINGS.length)], {
						value: toJson(json(pick)),
						enumerable: true,
						writable: true,
						configurable: true,
					})
				}
				r.values = values
			}
			if (pick(4)) r.header = header(pick)
			out.push(r)
		}
		return [out]
	},
}
export default generator
