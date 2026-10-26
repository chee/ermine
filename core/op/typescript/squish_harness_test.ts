// what squish's suite does besides its scenarios (conformance/run.ts), asked of the harness named by
// HARNESS (default: the TypeScript one, squish_harness.ts, which documents the protocol).
//
// The fuzzer applies patches (./squish_model.ts) to a content: what the squished patches make is
// what the originals make, they are never more, and squished again they are the same. With HARNESS
// set, the reference is run too and must give the same patches: how far squishing goes is part of
// the library.
import { assert, assertEquals } from "@std/assert"
import { apply, at, type V } from "./squish_model.ts"
import type { Key, Patch } from "@ermine/core/op/apply"
import { ask as send, command, reference } from "../../../conformance/typescript/ask.ts"
import { rand } from "../../../conformance/typescript/rand.ts"

const harness = command("squish")
// deno-lint-ignore no-explicit-any
type Answer = { error?: string; patches?: any[]; columns?: any }
const ask = (cmd: string[], requests: unknown[]) =>
	send(cmd, requests as never) as Promise<Answer[]>
// the reference to compare with, when another harness is asked
const other = Deno.env.get("HARNESS") ? reference("squish") : null

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask(harness, [{ op: "nope" }, { op: "squish", patches: [] }])
	assert(a.error)
	assertEquals(b, { patches: [] })
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 60

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

// patches that are valid one after the other, made against the content as it goes; they bunch
// up on a caret so that typing, backspacing and the like happen
function patches(pick: (n: number) => number, content: V, count: number): Patch[] {
	const out: Patch[] = []
	let caret = pick(4)
	const seq = (path: string[]) => {
		const s = at(content, path) as string | unknown[]
		return { path, len: typeof s === "string" ? chars(s) : s.length, text: typeof s === "string" }
	}
	// a backspace run going on: how many more, and where
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
				// a backspace run from past its end: merges reach back into this
				if (pick(4) === 0) run = 2 + pick(5), runPath = s.path, caret += 2 + pick(2)
			} else if (kind < 5 && s.len > 0) {
				// a backspace, or a forward delete
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
			// a move inside a sequence: found again in what is left
			const s = seq(pick(2) === 0 ? ["l"] : ["t"])
			if (s.len > 1) {
				const a = pick(s.len), b = Math.min(s.len, a + 1 + pick(2))
				const g = pick(s.len - (b - a) + 1)
				p = { path: s.path, range: [g, g], move: { path: s.path, range: [a, b] } }
			}
		} else if (k < 15) {
			// a key moved to another
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
			// the whole, same shape
			if (pick(3) === 0) p = { path: [], value: start(pick) }
		} else {
			// one element of the list, by its place: a removal moves the ones after it
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

function applyAll(content: V, ps: Patch[]): V {
	for (const p of ps) content = apply(content, p)
	return content
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, same end, never more, same as the reference`, async () => {
	const runs = Array.from({ length: SEEDS }, (_, i) => {
		const pick = rand(i + 1)
		const from = start(pick)
		return { from, ps: patches(pick, from, STEPS) }
	})
	const request = (op: string) => runs.map((r) => ({ op, patches: r.ps }))
	const squished = await ask(harness, request("squish"))
	const same = other ? await ask(other, request("squish")) : null
	runs.forEach((r, i) => {
		const out = squished[i].patches!
		assertEquals(squished[i].error, undefined)
		assertEquals(applyAll(r.from, out), applyAll(r.from, r.ps), `seed ${i + 1}: same end`)
		assert(out.length <= r.ps.length, `seed ${i + 1}: never more`)
		if (same) assertEquals(out, same[i].patches, `seed ${i + 1}: as the reference`)
	})
	// squished patches are valid patches: squishing them again changes nothing (no lone surrogates)
	const again = await ask(harness, squished.map((a) => ({ op: "squish", patches: a.patches })))
	runs.forEach((_, i) => {
		assertEquals(again[i].patches, squished[i].patches, `seed ${i + 1}: again`)
	})
})

Deno.test(`fuzz: ${SEEDS} seeds, columns and back`, async () => {
	const runs = Array.from({ length: SEEDS }, (_, i) => {
		const pick = rand(i + 101)
		return patches(pick, start(pick), STEPS)
	})
	const encoded = await ask(harness, runs.map((ps) => ({ op: "encode", patches: ps })))
	const decoded = await ask(harness, encoded.map((a) => ({ op: "decode", columns: a.columns })))
	const same = other ? await ask(other, runs.map((ps) => ({ op: "encode", patches: ps }))) : null
	runs.forEach((ps, i) => {
		const c = encoded[i].columns
		assertEquals(decoded[i].patches, ps, `seed ${i + 1}: back`)
		const total = (runs: number[]) =>
			runs.filter((_, j) => j % 2 === 1).reduce((a, b) => a + b, 0)
		assertEquals(total(c.path), ps.length, "a path per patch")
		assertEquals(total(c.shape), ps.length, "a shape per patch")
		const ranged = ps.filter((p) => p.range).length
		assertEquals([total(c.from), total(c.size)], [ranged, ranged], "a from and a size per range")
		assertEquals(c.value.length, ps.filter((p) => "value" in p).length)
		assertEquals(c.move.length, ps.filter((p) => p.move).length)
		const keys = c.paths.map((p: Key[]) => JSON.stringify(p))
		assertEquals(new Set(keys).size, keys.length, "each path once")
		if (same) assertEquals(c, same[i].columns, `seed ${i + 1}: as the reference`)
	})
})
