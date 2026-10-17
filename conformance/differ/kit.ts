// what the differ's generators share: the shape of a generator, seeded picks, and values made into
// the JSON form a request carries (conformance/typescript/form.ts)
// deno-lint-ignore-file no-explicit-any
import { line, toJson } from "../typescript/form.ts"
import { rand } from "../typescript/rand.ts"

export type Request = Record<string, any>
export type Answer = Record<string, any>
export type Options = { wild: boolean }
// something an implementation did that it must not, whatever the others did: kind names it (a
// finding's signature), at the line it shows at, why says what
export type Violation = { kind: string; at: number; why: string }

export type Generator = {
	// the streams a seed makes: each a list of requests sent to one fresh harness process
	streams(seed: number, o: Options): Request[][]
	// checks of one implementation's answers on its own: ask runs another suite of that same
	// implementation (apply, to replay patches)
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

// a patch with its value (and nothing else: paths and ranges are plain) in the JSON form
export const formPatch = (p: unknown) =>
	isMap(p) && Object.hasOwn(p, "value") ? { ...p, value: toJson(p.value) } : p
export const formPatches = (ps: readonly unknown[]) => ps.map(formPatch)
export { toJson }

// where two answers differ, as the conformance runner compares (conformance/run.ts, ordered): a
// map's keys in order, numbers as Object.is has them (0 and -0 differ). now: a window of whole
// seconds; two whole numbers both in it are the same (a time "now"). undefined: the same
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
		if (ka.some((k, i) => k !== kb[i])) return { path, kind: "key order" }
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

// an answer's value as compared by content: a map's keys in any order (a key put back goes last),
// -0 not 0; nothing there ({}) is nothing there
const sorted = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
export const content = (a: Answer | undefined) =>
	a === undefined ? "no answer" : line("value" in a ? { value: a.value } : {}, sorted)

// the first violation of each kind, in stream order
export function firsts(vs: Violation[]): Violation[] {
	const seen = new Set<string>()
	return vs.sort((a, b) => a.at - b.at).filter((v) => !seen.has(v.kind) && !!seen.add(v.kind))
}
export const show = (x: unknown) => line(x)
