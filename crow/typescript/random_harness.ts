// Random values and patches for crow's fuzzers. Values are maps, lists, strings (including code
// points past one unit and lone halves that pair when they meet), typed arrays and bytes. Patches
// are mostly where something is, and sometimes somewhere made up. pick is rand's (conformance).
import type { Key, Patch } from "@ermine/changeable/apply"

const KEYS = ["a", "b", "c", "d"]
export const PARTS = ["x", "ab", "é", "中", "🦊", "👍🏽", "\uD83D", "\uDE00", "\u0000"]
export type Pick = (n: number) => number
export const text = (p: Pick, most = 4) =>
	Array.from({ length: p(most + 1) }, () => PARTS[p(PARTS.length)]).join("")
export const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

export function made(p: Pick, depth: number): unknown {
	switch (p(depth > 0 ? 9 : 5)) {
		case 0:
			return p(100)
		case 1:
			return text(p)
		case 2:
			return null
		case 3:
			return new Int16Array(Array.from({ length: p(4) }, () => p(50)))
		case 4:
			return new Uint8Array(Array.from({ length: p(3) }, () => p(255)))
		case 5:
		case 6: {
			const o: Record<string, unknown> = {}
			for (const k of KEYS) if (p(2)) o[k] = made(p, depth - 1)
			return o
		}
		default:
			return Array.from({ length: p(4) }, () => made(p, depth - 1))
	}
}
export function paths(v: unknown, at: Key[] = [], out: Key[][] = []): Key[][] {
	out.push(at)
	if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...at, i], out))
	else if (isMap(v)) { for (const k of Object.keys(v)) paths(v[k], [...at, k], out) }
	return out
}
export function at(v: unknown, path: readonly Key[]): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
export const size = (v: unknown) =>
	typeof v === "string" ? [...v].length : (v as ArrayLike<unknown>).length
export const sequence = (v: unknown) =>
	Array.isArray(v) || typeof v === "string" || ArrayBuffer.isView(v) && !(v instanceof Uint8Array)
export const above = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])

export function patch(p: Pick, v: unknown): Patch {
	const ps = paths(v)
	// A move out of a list into the item after it: the take shifts where it puts.
	if (!p(10)) {
		const spots = ps.flatMap((l) => {
			const list = at(v, l)
			if (!Array.isArray(list)) return []
			return list.flatMap((_, i) => Array.isArray(list[i + 1]) ? [[l, i] as const] : [])
		})
		if (spots.length) {
			const [l, i] = spots[p(spots.length)]
			return { path: [...l, i], range: [0, 0], move: { path: [...l, i] } }
		}
	}
	const path = p(20) ? ps[p(ps.length)] : [KEYS[p(4)], p(3)]
	const there = at(v, path)
	const k = p(12)
	if (k < 4) return { path, value: made(p, 2) }
	if (k < 5) return { path }
	if (k < 9 && sequence(there)) {
		const n = size(there), a = p(n + 1), b = a + p(n - a + 1)
		const value = Array.isArray(there)
			? Array.from({ length: p(3) }, () => made(p, 1))
			: typeof there === "string"
			? text(p, 2)
			: there instanceof Int16Array
			? new Int16Array([p(50)])
			: new Uint8Array([p(255)])
		return p(4) ? { path, range: [a, b], value } : { path, range: [a, b] }
	}
	const away = ps.filter((x) => x.length && !above(x, path))
	const from = away.length && p(8) ? away[p(away.length)] : ps[p(ps.length)]
	const source = at(v, from)
	if (k < 11 && Array.isArray(there) && Array.isArray(source)) {
		const n = source.length, a = p(n + 1), b = a + p(n - a + 1), i = p(there.length + 1)
		return { path, range: [i, i], move: { path: from, range: [a, b] } }
	}
	if (k < 11 && typeof there === "string") {
		const strings = ps.filter((x) => typeof at(v, x) === "string")
		const f = p(3) ? strings[p(strings.length)] : path
		const n = size(at(v, f)), a = p(n + 1), b = a + p(n - a + 1)
		const i = p(size(there) + 1)
		return { path, range: [i, i + p(2)], move: { path: f, range: [a, b] } }
	}
	return { path, move: { path: from } }
}
