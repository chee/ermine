// What the differ's generators share: seeded picks and values in request JSON form.
// deno-lint-ignore-file no-explicit-any
import { line, toJson } from "../typescript/form.ts"
import { ordered } from "../typescript/json.ts"
import { rand } from "../typescript/rand.ts"

export type Request = Record<string, any>
export type Answer = Record<string, any>
export type Options = { wild: boolean }
export type Violation = { kind: string; at: number; why: string }

export type Generator = {
	streams(seed: number, o: Options): Request[][]
	invariant?(
		stream: Request[],
		answers: (Answer | undefined)[],
		ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
	): Promise<Violation[]>
}

export type Pick = (n: number) => number
export function picker(seed: number) {
	const pick: Pick = rand(seed)
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	return { pick, one }
}

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x)

export const formPatch = (p: unknown) =>
	isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: toJson(p.value) } : p
export const formPatches = (ps: readonly unknown[]) => ps.map(formPatch)
export { toJson }

export type Difference = { path: string; kind: string }
export function differs(
	a: unknown,
	b: unknown,
	now?: [number, number],
	path = "",
): Difference | undefined {
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return { path, kind: "type" }
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			const d = differs(a[i], b[i], now, `${path}[${i}]`)
			if (d) return d
		}
		return a.length === b.length ? undefined : { path, kind: "length" }
	}
	if (isMap(a) || isMap(b)) {
		if (!isMap(a) || !isMap(b)) return { path, kind: "type" }
		const ka = Object.keys(a), kb = Object.keys(b)
		const sa = [...ka].sort().join("\u0000"), sb = [...kb].sort().join("\u0000")
		if (sa !== sb) {
			const k = ka.find((k) => !Object.hasOwn(b, k)) ?? kb.find((k) => !Object.hasOwn(a, k))!
			return { path: `${path}.${k}`, kind: "keys" }
		}
		for (const k of ka) {
			const d = differs(a[k], b[k], now, `${path}.${k}`)
			if (d) return d
		}
		return
	}
	if (Object.is(a, b)) return
	if (typeof a === "number" && typeof b === "number") {
		if (a === b) return { path, kind: "-0" }
		if (now && [a, b].every((x) => Number.isInteger(x) && x >= now[0] - 1 && x <= now[1] + 1)) {
			return
		}
	}
	return { path, kind: typeof a === typeof b ? "value" : "type" }
}

const sorted = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
export const content = (a: Answer | undefined) =>
	a === undefined ? "no answer" : line("value" in a ? { value: a.value } : {}, sorted)

export function firsts(vs: Violation[]): Violation[] {
	const seen = new Set<string>()
	return vs.sort((a, b) => a.at - b.at).filter((v) => !seen.has(v.kind) && !!seen.add(v.kind))
}
export const show = (x: unknown) => line(x)

export const TRICKY = [
	"0",
	"1",
	"2",
	"10",
	"4294967294",
	"01",
	"-1",
	"1.0",
	"1e3",
	" 1",
	"4294967295",
	"9007199254740993",
	"__proto__",
	"constructor",
	"toString",
	"",
	"é😀",
	"\uD800",
	"\u0000",
]
export function tricky(seed: number, keys: readonly string[]): Map<string, string> {
	const pick = rand(seed * 7919 + 13)
	if (pick(2) === 0) return new Map()
	const pool = TRICKY.filter((k) => !keys.includes(k))
	return new Map(keys.map((k) => [k, pool.splice(pick(pool.length), 1)[0]]))
}
const to = (names: Map<string, string>, k: string) => names.get(k) ?? k
export function renameKeys(x: unknown, names: Map<string, string>): unknown {
	if (names.size === 0) return x
	if (Array.isArray(x)) return x.map((v) => renameKeys(v, names))
	if (!isMap(x)) return x
	return ordered(Object.keys(x).map((k) => [to(names, k), renameKeys(x[k], names)]))
}
export const renamePath = (p: unknown, names: Map<string, string>) =>
	Array.isArray(p) ? p.map((k) => typeof k === "string" ? to(names, k) : k) : p
export function renamePatch(p: unknown, names: Map<string, string>): unknown {
	if (names.size === 0 || !isMap(p)) return p
	return ordered(
		Object.keys(p).map((k) => {
			const v = p[k]
			if (k === "path") return [k, renamePath(v, names)]
			if (k === "value") return [k, renameKeys(v, names)]
			if (k === "move" && isMap(v)) return [k, renamePatch(v, names)]
			return [k, v]
		}),
	)
}
export function rename(r: Request, names: Map<string, string>): Request {
	if (names.size === 0) return r
	const each = (k: string, v: unknown) =>
		k === "value" || k === "values"
			? renameKeys(v, names)
			: k === "patch"
			? renamePatch(v, names)
			: k === "path"
			? renamePath(v, names)
			: (k === "patches" || k === "paths") && Array.isArray(v)
			? v.map((x) => k === "patches" ? renamePatch(x, names) : renamePath(x, names))
			: v
	return ordered(Object.keys(r).map((k) => [k, each(k, r[k])])) as Request
}
