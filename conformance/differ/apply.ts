// apply's streams: a start value and a batch of patches (core/fuzz/gen_harness.ts), asked as one call,
// then each patch alone on what the ones before it left, then each refused patch put in where it
// fell; some again with cow: false. every line stands alone (nothing lasts between lines). half
// the seeds have the generator's keys made tricky (kit.ts: "2", "01", "__proto__", "", NUL, ...).
// wild: patches of no patch's shape, odd numbers as indices, requests missing their patches
// the properties, each implementation on its own, of every apply or invert asked with a list of
// patches that its apply takes or refuses with a code: the undo undoes (applied to the value after,
// the value given back, maps by content) and the undo of the undo redoes (applied to the value
// given, the value after); invert refuses as apply does; the batch split in two calls at every
// place gives what it gives in one (the same value; refused: the same code, its
// index counted in the half it fell in)
// deno-lint-ignore-file no-explicit-any
import apply, { type Patch } from "@ermine/op/apply"
import { batch, KEYS, start } from "../../core/fuzz/gen_harness.ts"
import {
	type Answer,
	content,
	differs,
	firsts,
	formPatches,
	type Generator,
	picker,
	rename,
	type Request,
	show,
	toJson,
	tricky,
	type Violation,
} from "./kit.ts"

export function request(op: string, value: unknown, ps: readonly unknown[]): Request {
	return {
		op,
		...(value === undefined ? {} : { value: toJson(value) }),
		patches: formPatches(ps),
	}
}

// what no patch is, and numbers at their edges
export function wildPatches(pick: (n: number) => number): unknown[] {
	const p = [[], ["s"], ["l", 0], ["m"]][pick(4)]
	const bad: unknown[] = [
		{ path: [...p, -1] },
		{ path: [...p, 1.5], value: 1 },
		{ path: p, range: [0] },
		{ path: p, range: [-1, 0] },
		{ path: p, value: 1, move: { path: [] } },
		{ path: [true] },
		{ value: 1 },
		{ path: p, move: { path: "a" } },
		{ path: ["l", -0], value: 2 },
		{ path: ["s"], range: [-0, 1] },
		{ path: ["l", 2 ** 53], value: 1 },
		{ path: ["s"], range: [0, 1e300] },
		{ path: ["s"], range: [0, 1], extra: true },
		{ path: ["t"], range: [0, 1], value: { "/": { int16: [40000] } } },
		{ path: ["m"], value: { "/": { bytes: "a=" } } },
		null,
		"a patch",
	]
	return [bad[pick(bad.length)]]
}

export function streams(op: "apply" | "invert"): Generator["streams"] {
	return (seed, o) => {
		const { pick } = picker(seed)
		const first = start(pick)
		const { good, bad } = batch(pick, first)
		const out: Request[] = [request(op, first, good)]
		if (op === "apply") {
			let v = first
			for (const p of good) {
				out.push(request(op, v, [p]))
				v = apply(v, [p])
			}
		} else {
			for (let k = 1; k < good.length; k += 3) out.push(request(op, first, good.slice(0, k)))
		}
		for (const [k, p] of bad) {
			out.push(request(op, first, [...good.slice(0, k), p, ...good.slice(k)]))
		}
		// the same in place, some of them
		for (const r of out.slice()) if (pick(3) === 0) out.push({ ...r, cow: false })
		if (o.wild) {
			for (let i = 0; i < 6; i++) {
				const k = pick(good.length + 1)
				out.push(request(op, first, [...good.slice(0, k), ...wildPatches(pick)]))
			}
			out.push({ op }, { op, value: 1, patches: {} }, { op: "nope", patches: [] })
			out.push({ op, value: { "/": { number: "NaN" } }, patches: [] })
			out.push({ op, value: -0, patches: [] }, { op, value: { a: -0, b: [-0] }, patches: [] })
		}
		// half the seeds: the keys made tricky ("2", "01", "__proto__", ...: kit.ts)
		const names = tricky(seed, KEYS)
		return [out.map((r) => rename(r, names))]
	}
}

const isMap = (x: unknown): x is Record<string, any> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
// a refusal with a code: { code, patch }
const coded = (a: Answer | undefined) => isMap(a?.error) && typeof a.error.code === "string"

export async function invariant(
	stream: Request[],
	answers: (Answer | undefined)[],
	ask: (suite: string, requests: Request[]) => Promise<(Answer | undefined)[]>,
): Promise<Violation[]> {
	const out: Violation[] = []
	const no = (kind: string, at: number, why: string) => out.push({ kind, at, why })
	// a request of the case's: its value given (none: v undefined and not given) and cow
	type Case = { at: number; r: Request; ps: unknown[] }
	const asked = (c: Case, op: string, from: Answer | Request | undefined, ps: unknown) => ({
		op,
		...(from && "value" in from ? { value: from.value } : {}),
		patches: ps,
		...(c.r.cow === false ? { cow: false } : {}),
	})
	const cases: Case[] = []
	stream.forEach((r, i) => {
		if ((r.op === "apply" || r.op === "invert") && Array.isArray(r.patches) && answers[i]) {
			cases.push({ at: i, r, ps: r.patches })
		}
	})
	// the whole, its undo, each first part
	const one = cases.flatMap((c) => [
		asked(c, "apply", c.r, c.ps),
		asked(c, "invert", c.r, c.ps),
		...c.ps.slice(1).map((_, k) => asked(c, "apply", c.r, c.ps.slice(0, k + 1))),
	])
	const got1 = await ask("apply", one)
	let n = 0
	const whole: (Answer | undefined)[] = [], undo: (Answer | undefined)[] = []
	const firstOf: (Answer | undefined)[][] = []
	for (const c of cases) {
		whole.push(got1[n++]), undo.push(got1[n++])
		firstOf.push(c.ps.slice(1).map(() => got1[n++]))
	}
	// the undo applied after, its undo; each second part
	const two: Request[] = [], back: [number, string, number?][] = []
	cases.forEach((c, j) => {
		const w = whole[j], u = undo[j]
		if (!w || (w.error !== undefined && !coded(w))) return
		if (w.error !== undefined || u?.error !== undefined) {
			if (differs(u?.error, w.error)) {
				no("invert refuses unlike apply", c.at, `apply ${show(w)}, invert ${show(u)}`)
			}
		} else if (!Array.isArray(u?.undo)) no("not an undo", c.at, show(u))
		else {
			two.push(asked(c, "apply", w, u.undo), asked(c, "invert", w, u.undo))
			back.push([j, "undo"], [j, "undo of undo"])
		}
		firstOf[j].forEach((f, k) => {
			const at = k + 1
			if (!f) return
			if (coded(f)) {
				if (!coded(w) || differs(f.error, w.error)) {
					no("split differs", c.at, `at ${at}: first part ${show(f)}, whole ${show(w)}`)
				}
			} else if (f.error !== undefined) {
				no("split differs", c.at, `at ${at}: first part ${show(f)}, whole ${show(w)}`)
			} else {
				two.push(asked(c, "apply", f, c.ps.slice(at)))
				back.push([j, "second", at])
			}
		})
	})
	const got2 = await ask("apply", two)
	const three: Request[] = [], redo: number[] = []
	back.forEach(([j, what, at], k) => {
		const c = cases[j], w = whole[j]!, g = got2[k]
		if (what === "undo") {
			if (content(g) !== content(c.r)) {
				no("undo does not undo", c.at, `undo ${show(undo[j]!.undo)} gives ${show(g)}`)
			}
		} else if (what === "undo of undo") {
			if (!Array.isArray(g?.undo)) no("not an undo", c.at, `of the undo: ${show(g)}`)
			else three.push(asked(c, "apply", c.r, g.undo)), redo.push(j)
		} else {
			const f = got2[k]
			const want = coded(w) ? { error: { ...w.error, patch: w.error.patch - at! } } : w
			const d = coded(w) && w.error.patch < at!
				? { kind: "refused", path: "" }
				: differs(f, want)
			if (d) {
				no(
					"split differs",
					c.at,
					`at ${at}: ${d.kind} at ${d.path}: ${show(f)}, whole ${show(w)}`,
				)
			}
		}
	})
	const got3 = await ask("apply", three)
	redo.forEach((j, k) => {
		if (content(got3[k]) !== content(whole[j])) {
			no("undo of undo does not redo", cases[j].at, `${show(got3[k])}, not ${show(whole[j])}`)
		}
	})
	return firsts(out)
}

export default { streams: streams("apply"), invariant } satisfies Generator
export type { Patch }
