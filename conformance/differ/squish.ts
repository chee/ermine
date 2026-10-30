// squish's streams: patches typed into a string and a list, squished, encoded and decoded.
import type { Patch } from "@ermine/changeable/apply"
import { encode } from "@ermine/changeable/squish"
import { apply, at, type V } from "../../changeable/typescript/squish_model.ts"
import {
	type Answer,
	content,
	differs,
	firsts,
	formPatches,
	type Generator,
	picker,
	renamePatch,
	type Request,
	show,
	toJson,
	tricky,
	type Violation,
} from "./kit.ts"

const TEXT = ["a", "b", "é", "😀", "xy", "!", "\n", '"', "ü✓"]
const chars = (s: string) => Array.from(s).length

function start(pick: (n: number) => number): V {
	return {
		t: Array.from({ length: pick(8) }, () => TEXT[pick(TEXT.length)]).join(""),
		l: Array.from({ length: pick(8) }, () => pick(100)),
		m: { a: 1, b: [2], c: { d: "x" } },
		n: { x: { y: 1 } },
	}
}

function patches(pick: (n: number) => number, content: V, count: number): Patch[] {
	const out: Patch[] = []
	let caret = pick(4)
	const seq = (path: string[]) => {
		const s = at(content, path) as string | unknown[]
		return { path, len: typeof s === "string" ? chars(s) : s.length, text: typeof s === "string" }
	}
	let run = 0, runPath = ["t"]
	for (let i = 0; i < count; i++) {
		const k = pick(24)
		let p: Patch | null = null
		if (run > 0) {
			run--
			caret = Math.min(caret, seq(runPath).len)
			if (caret > 0) p = { path: runPath, range: [caret - 1, caret] }, caret--
		} else if (k < 11) {
			const s = seq(pick(3) === 0 ? ["l"] : ["t"])
			const where = pick(4) === 0 ? pick(s.len + 1) : Math.min(caret, s.len)
			const many = () => {
				const n = 1 + pick(3)
				return s.text
					? Array.from({ length: n }, () => TEXT[pick(TEXT.length)]).join("")
					: Array.from({ length: n }, () => pick(100))
			}
			const kind = pick(6)
			if (kind < 3) {
				const value = many()
				p = { path: s.path, range: [where, where], value }
				caret = where + (typeof value === "string" ? chars(value) : value.length)
				if (pick(4) === 0) run = 2 + pick(5), runPath = s.path, caret += 2 + pick(2)
			} else if (kind < 5 && s.len > 0) {
				const back = pick(2) === 0 && where > 0
				const a = back ? where - 1 : Math.min(where, s.len - 1)
				const b = Math.min(s.len, a + 1 + (pick(4) === 0 ? 1 : 0))
				p = { path: s.path, range: [a, b] }
				caret = a
			} else if (s.len > 0) {
				const a = Math.min(where, s.len - 1)
				const b = Math.min(s.len, a + 1 + pick(2))
				p = { path: s.path, range: [a, b], value: many() }
				caret = a
			}
		} else if (k < 13) {
			const s = seq(pick(2) === 0 ? ["l"] : ["t"])
			if (s.len > 1) {
				const a = pick(s.len), b = Math.min(s.len, a + 1 + pick(2))
				const g = pick(s.len - (b - a) + 1)
				p = { path: s.path, range: [g, g], move: { path: s.path, range: [a, b] } }
			}
		} else if (k < 15) {
			const m = at(content, ["m"]) as Record<string, V>
			const keys = Object.keys(m)
			if (keys.length) {
				const from = keys[pick(keys.length)]
				p = { path: ["m", "k" + pick(3)], move: { path: ["m", from] } }
			}
		} else if (k < 18) {
			const m = at(content, ["m"]) as Record<string, V>
			const key = ["a", "b", "c", "k0", "k1"][pick(5)]
			p = pick(3) === 0 && key in m
				? { path: ["m", key] }
				: { path: ["m", key], value: pick(100) }
		} else if (k < 19) {
			const n = at(content, ["n"]) as Record<string, V>
			const x = n.x as Record<string, V> | undefined
			const j = pick(5)
			if (j === 0) p = { path: ["n"], value: pick(2) ? { x: { y: pick(9) } } : {} }
			else if (j === 1 && x) p = { path: ["n", "x"], value: pick(2) ? {} : { y: pick(9) } }
			else if (j === 2 && x) p = { path: ["n", "x", "y"], value: pick(9) }
			else if (j === 3 && x) p = { path: ["n", "x"] }
			else if (j === 4 && x && typeof x === "object") {
				p = { path: ["n", "x", "z"], value: pick(9) }
			}
		} else if (k < 21) {
			if (pick(3) === 0) p = { path: [], value: start(pick) }
		} else {
			const l = at(content, ["l"]) as unknown[]
			if (l.length) {
				const i = pick(l.length)
				p = pick(2) === 0 ? { path: ["l", i] } : { path: ["l", i], value: pick(100) }
			}
		}
		if (!p) continue
		content = apply(content, p)
		out.push(p)
	}
	return out
}

function lone(v: unknown): boolean {
	if (typeof v === "string") return !v.isWellFormed()
	if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return false
	return (Array.isArray(v) ? v : Object.values(v)).some(lone)
}

function wild(pick: (n: number) => number): unknown[] {
	const out: unknown[] = []
	let at = 0
	const kinds = [
		() => new Int16Array([pick(9)]),
		() => new Float64Array([pick(9) / 2]),
		() => new Uint8Array([pick(255)]),
		() => ["\uD83D", "\uDE00", "a"][pick(3)],
	]
	const kind = kinds[pick(kinds.length)]
	for (let i = 0; i < 4 + pick(4); i++) {
		const v = kind()
		const n = typeof v === "string" ? 1 : (v as ArrayLike<unknown>).length
		out.push({ path: ["w"], range: [at, at], value: v })
		at += n
	}
	if (pick(2)) out.push({ path: ["w"], range: [-0, 1] })
	if (pick(2)) out.push({ value: "x", range: [0, 0], path: ["t"] })
	if (pick(2)) out.push({ path: ["t"], range: [0, 0], value: "y", extra: 1 })
	return formPatches(out)
}

const generator: Generator = {
	streams(seed, o) {
		const { pick } = picker(seed)
		const out: Request[] = []
		const names = tricky(seed, ["a", "b", "c", "d", "k0", "k1", "k2", "x", "y", "z"])
		for (let i = 0; i < 4; i++) {
			const first = start(pick)
			const ps = [{ path: [], value: first }, ...patches(pick, first, 20 + pick(40))].map((p) =>
				renamePatch(p, names) as Patch
			)
			out.push({ op: "squish", patches: formPatches(ps) })
			if (pick(2)) out.push({ op: "encode", patches: formPatches(ps) })
			if (pick(2)) {
				const c = encode(ps)
				out.push({ op: "decode", columns: { ...c, value: c.value.map(toJson) } })
			}
		}
		if (o.wild) {
			for (let i = 0; i < 3; i++) {
				const ps = wild(pick)
				out.push({ op: "squish", patches: ps }, { op: "encode", patches: ps })
			}
			out.push({ op: "squish" }, { op: "decode", columns: { paths: [] } }, { op: "nope" })
		}
		return [out]
	},
	async invariant(stream, answers, ask) {
		const out: Violation[] = []
		const no = (kind: string, at: number, why: string) => out.push({ kind, at, why })
		const cases: { at: number; ps: unknown[]; sq: unknown[] }[] = []
		stream.forEach((r, i) => {
			const sq = answers[i]?.patches
			if (r.op === "squish" && Array.isArray(r.patches) && Array.isArray(sq)) {
				cases.push({ at: i, ps: r.patches, sq })
			}
		})
		for (const c of cases) {
			if (c.sq.length > c.ps.length) {
				no("squish adds patches", c.at, `${c.ps.length} given, ${c.sq.length} back`)
			}
		}
		const applied = await ask(
			"apply",
			cases.flatMap((c) => [{ op: "apply", patches: c.ps }, { op: "apply", patches: c.sq }]),
		)
		cases.forEach((c, j) => {
			const want: Answer | undefined = applied[2 * j], got = applied[2 * j + 1]
			if (!want || want.error !== undefined) return
			if (content(got) !== content(want)) {
				no("squish changes meaning", c.at, `${show(got)}, not ${show(want)}`)
			}
		})
		const firstN = await ask(
			"squish",
			cases.flatMap((c) =>
				c.ps.map((_, n) => ({ op: "squish", patches: c.ps.slice(0, n + 1) }))
			),
		)
		let k = 0
		const sq = cases.map((c) => c.ps.map(() => firstN[k++]))
		const more = await ask(
			"squish",
			cases.flatMap((c, j) =>
				c.ps.slice(1).map((p, n) => ({
					op: "squish",
					patches: [...(sq[j][n]?.patches ?? []), p],
				}))
			),
		)
		k = 0
		cases.forEach((c, j) => {
			let told = false
			c.ps.slice(1).forEach((_, n) => {
				const got = more[k++], want = sq[j][n + 1]
				if (told || !Array.isArray(sq[j][n]?.patches)) return
				const d = differs(got, want)
				if (d) {
					told = true
					no(
						"one at a time differs",
						c.at,
						`patch ${n + 1} pushed on ${show(sq[j][n]!.patches)}: ${show(got)}, all at once ${
							show(want)
						}`,
					)
				}
			})
		})
		const twice = cases.filter((c) => !c.ps.some((p) => lone((p as Patch).value)))
		const again = await ask("squish", twice.map((c) => ({ op: "squish", patches: c.sq })))
		twice.forEach((c, j) => {
			if (differs(again[j], { patches: c.sq })) {
				no("squish twice differs", c.at, `${show(c.sq)} squished again: ${show(again[j])}`)
			}
		})
		return firsts(out)
	},
}
export default generator
