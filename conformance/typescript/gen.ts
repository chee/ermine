// What the fuzz tests share: seeded random values and patches, and a comparison that keeps lone surrogates.
import apply, { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"

export type Pick = (n: number) => number

// xorshift, because an LCG's low bits repeat.
export function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	const pick: Pick = (n) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	return { pick, one }
}

export const PARTS = ["a", "b", "xy", "é", "中", "😀", "\uD83D", "\uDE00", "\uD800", "\uDC00"]
export const KEYS = ["a", "b", "c", "__proto__"]
export const KINDS = [Int8Array, Int16Array, Float64Array, BigInt64Array]

export const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
export const view = (v: unknown): v is ArrayLike<unknown> & object =>
	ArrayBuffer.isView(v) && !(v instanceof DataView)
export const isSeq = (v: unknown) =>
	typeof v === "string" || Array.isArray(v) || view(v) && !(v instanceof Uint8Array)
export const len = (v: unknown) =>
	typeof v === "string" ? Array.from(v).length : (v as unknown[]).length

export function text(pick: Pick, most = 6) {
	return Array.from({ length: pick(most + 1) }, () => PARTS[pick(PARTS.length)]).join("")
}
export function elements(pick: Pick, kind: (typeof KINDS)[number], n: number) {
	const xs = Array.from({ length: n }, () => pick(200) - 100)
	const make = kind as unknown as new (xs: unknown[]) => ArrayLike<unknown>
	return new make(kind === BigInt64Array ? xs.map(BigInt) : xs)
}
export function made(pick: Pick, depth: number): unknown {
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
			return [null, true, false, -0][pick(4)]
		case 6:
		case 7:
			return Array.from({ length: pick(4) }, () => made(pick, depth - 1))
		default:
			return Object.fromEntries(
				Array.from({ length: pick(4) }, () => [KEYS[pick(KEYS.length)], made(pick, depth - 1)]),
			)
	}
}

export function places(v: unknown, path: Key[] = [], out: [Key[], unknown][] = []) {
	out.push([path, v])
	if (path.length >= 4) return out
	if (Array.isArray(v)) v.forEach((x, i) => places(x, [...path, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) places(v[k], [...path, k], out) }
	return out
}
export function span(pick: Pick, n: number): [number, number] {
	const a = pick(n + 1)
	return [a, a + pick(n - a + 1)]
}
function filling(pick: Pick, s: unknown): unknown {
	if (typeof s === "string") return text(pick, 3)
	if (Array.isArray(s)) return Array.from({ length: pick(3) }, () => made(pick, 1))
	return elements(pick, s!.constructor as (typeof KINDS)[number], pick(3))
}

export function patch(pick: Pick, v: unknown): Patch {
	const all = v === undefined ? [] : places(v)
	const any = () => all.length ? all[pick(all.length)] : [[], undefined] as [Key[], unknown]
	const seqs = all.filter(([, x]) => isSeq(x)), maps = all.filter(([, x]) => isMap(x))
	const seq = () => seqs.length ? seqs[pick(seqs.length)] : any()
	const key = () =>
		maps.length ? [...maps[pick(maps.length)][0], KEYS[pick(KEYS.length)]] : any()[0]
	const gap = (): Patch => {
		const [p, s] = seq()
		const g = pick((isSeq(s) ? len(s) : 0) + 1)
		return { path: p, range: [g, g + (pick(3) ? 0 : 1)] }
	}
	switch (pick(18)) {
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
			return { ...gap(), move: { path: any()[0] } }
		case 9:
		case 10: {
			const [f, s] = seq()
			const n = isSeq(s) ? len(s) : 0, r = span(pick, n)
			const g = pick(n - (r[1] - r[0]) + 1)
			return { path: f, range: [g, g + (pick(3) ? 0 : 1)], move: { path: f, range: r } }
		}
		case 11: {
			const [f, s] = seq()
			const r = span(pick, isSeq(s) ? len(s) : 0)
			return pick(2)
				? { ...gap(), move: { path: f, range: r } }
				: { path: key(), move: { path: f, range: r } }
		}
		case 12:
		case 13: {
			const [p, s] = seq()
			const fits = all.filter(([q, x]) =>
				q.length > 0 && (Array.isArray(s) ||
					(typeof s === "string"
						? typeof x === "string"
						: view(x) && x.constructor === s?.constructor))
			)
			if (!isSeq(s) || !fits.length) return { ...gap(), move: { path: any()[0] } }
			const g = pick(len(s) + 1)
			return {
				path: p,
				range: [g, g + (pick(3) ? 0 : 1)],
				move: { path: fits[pick(fits.length)][0] },
			}
		}
		case 14:
			return { path: [], value: made(pick, 2) }
		case 16:
		case 17: {
			const lists = all.filter(([, x]) => Array.isArray(x))
			if (!lists.length) return { path: any()[0], move: { path: any()[0] } }
			const [f, l] = lists[pick(lists.length)]
			const n = (l as unknown[]).length
			const take = pick(2) ? { path: f, range: span(pick, n) } : { path: [...f, pick(n + 1)] }
			const at = pick(n + 1)
			const to = pick(2)
				? { path: [...f, at, ...(pick(3) ? [] : [pick(2)])] }
				: { path: f, range: [at, at + pick(3)] as [number, number] }
			return { ...to, move: take }
		}
		default: {
			const [p] = any()
			return { path: [...p, [["x"], [0], [9], ["a", "b"]][pick(4)]].flat(), value: 1 }
		}
	}
}

export function start(pick: Pick): unknown {
	return pick(8)
		? { s: text(pick, 8), l: made(pick, 2), t: elements(pick, Int16Array, 3), m: made(pick, 2) }
		: made(pick, 3)
}

export function batch(pick: Pick, from: unknown, most = 24) {
	let v = from
	const good: Patch[] = [], bad: [number, Patch][] = []
	for (let tries = 0; good.length < most && tries < 4 * most; tries++) {
		const p = patch(pick, v)
		try {
			v = apply(from, [...good, p])
			good.push(p)
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
			if (bad.length < 3) bad.push([good.length, p])
		}
	}
	return { good, bad, end: v }
}

export function differ(a: unknown, b: unknown, order = false, at = "$"): string {
	if (typeof a === "string" || typeof b === "string") return a === b ? "" : `${at}: string`
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: list`
		for (let i = 0; i < a.length; i++) {
			const d = differ(a[i], b[i], order, `${at}[${i}]`)
			if (d) return d
		}
		return ""
	}
	if (view(a) || view(b)) {
		if (!view(a) || !view(b) || a.constructor !== b.constructor || a.length !== b.length) {
			return `${at}: typed`
		}
		for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${at}[${i}]`
		return ""
	}
	if (isMap(a) || isMap(b)) {
		if (!isMap(a) || !isMap(b)) return `${at}: map`
		const ka = Object.keys(a), kb = Object.keys(b)
		if (ka.length !== kb.length) return `${at}: keys`
		if (order && ka.some((k, i) => k !== kb[i])) return `${at}: key order`
		for (const k of ka) {
			if (!Object.hasOwn(b, k)) return `${at}.${k}: missing`
			const d = differ(a[k], b[k], order, `${at}.${k}`)
			if (d) return d
		}
		return ""
	}
	return Object.is(a, b) ? "" : `${at}: ${String(a)} ≠ ${String(b)}`
}

export function snap<T>(v: T): T {
	if (Array.isArray(v)) return v.map(snap) as T
	if (view(v)) return (v as unknown as Int8Array).slice() as T
	if (isMap(v)) {
		const out: Record<string, unknown> = {}
		for (const k of Object.keys(v)) {
			Object.defineProperty(out, k, {
				value: snap(v[k]),
				writable: true,
				enumerable: true,
				configurable: true,
			})
		}
		return out as T
	}
	return v
}

export const show = (x: unknown) =>
	JSON.stringify(
		x,
		(_, v) =>
			view(v)
				? `${v.constructor.name}(${Array.from(v as ArrayLike<unknown>).map(String)})`
				: typeof v === "bigint"
				? `${v}n`
				: v,
	)
