// eg-walker on random histories of one text: heads given in any order merge the same, and a merge
// started further back (from the root), or at a set of commits merged, is the merge started at the
// latest common ancestor
import { assertEquals } from "@std/assert"
import apply from "@ermine/op/apply"
import { type Commit, compare, decode, encode, name } from "@ermine/encoding/commit"
import { egwalker } from "./egwalker.ts"
import { createHistory, type History, type Kept } from "./history.ts"
import { type Merge, type Merges, plain, replay, type Tables } from "./replay.ts"
import { snapshot } from "./snapshot.ts"
import { createWalker } from "./walker.ts"

const merges: Merges = { "eg-walker": egwalker }

// a small seeded random
function random(seed: number) {
	let s = seed >>> 0 || 1
	return (n: number) => {
		s ^= s << 13, s ^= s >>> 17, s ^= s << 5
		return (s >>> 0) % n
	}
}

// back: a start only at a root; sets: a start at several commits too, merged as a device keeps them
const merge = (
	h: History,
	heads: readonly Kept[],
	how: "" | "back" | "sets" = "",
	by: Merge = egwalker,
): Tables => by(h, heads, get(h, how))
const get = (h: History, how: "" | "back" | "sets") => (ns: readonly Uint8Array[]) => {
	if (ns.length > 1) return how === "sets" ? merge(h, ns.map((n) => h.get(n)!)) : undefined
	return how === "back" && h.get(ns[0])!.parents.length > 0 ? undefined : plain(h, ns[0])
}

// rich: a map holding a string, a list of strings, a typed array and a number, edited every way
// (splices, puts, removals, moves, inside list elements), and now and then a second table
function grow(seed: number, rich = false) {
	const r = random(seed)
	const h = createHistory()
	let nonce = 0
	const text = (k: Kept) => (replay(h, k.name, undefined, merges)?.value?.value ?? "") as string
	const valueAt = (k: Kept) => replay(h, k.name, undefined, merges)?.value?.value
	const add = (
		parents: Kept[],
		patches: Commit["patches"],
		merged: boolean,
		table = "value",
	) => {
		const c: Commit = {
			table,
			actor: null,
			time: 0,
			signer: new Uint8Array(32).fill(1),
			nonce: nonce++,
			parents: parents.map((k) => k.name).sort(compare),
			lamport: 1 + Math.max(0, ...parents.map((k) => k.lamport)),
			patches,
		}
		if (merged) c.merge = "eg-walker"
		else if (parents.length > 1) c.base = c.parents[0]
		const bytes = encode(c)
		assertEquals(h.add(bytes), "taken")
		return h.get(name(bytes))!
	}
	const splice = (s: string): Commit["patches"] => {
		const n = [...s].length, a = r(n + 1), b = a + r(Math.min(3, n - a) + 1)
		const value = "abcdefgh".slice(r(8), r(8) + 1 + r(3))
		return [{ path: [], range: [a, b], value }]
	}
	// patches that apply where they are made: only those are taken in, by sync
	const fits = (t: Tables, table: string, patches: Commit["patches"]) => {
		try {
			apply(t[table]?.value, patches)
			return true
		} catch {
			return false
		}
	}
	type Rich = { t: string; l: string[]; a: Int32Array; n: number; k?: number }
	const edit = (v: Rich | undefined): Commit["patches"] => {
		if (v === undefined) return [{ path: [], value: { t: "", l: [], a: new Int32Array(), n: 0 } }]
		const n = v.l.length, at = r(n + 1)
		switch (r(9)) {
			case 0:
				return splice(v.t).map((p) => ({ ...p, path: ["t"] }))
			case 1: {
				const b = at + r(Math.min(2, n - at) + 1)
				return [{ path: ["l"], range: [at, b], value: r(2) ? ["x" + r(9)] : [] }]
			}
			case 2:
				return n ? [{ path: ["l", r(n)], value: "y" + r(9) }] : [{ path: ["n"], value: r(99) }]
			case 3: {
				const i = r(n + 1)
				return i < n ? splice(v.l[i]).map((p) => ({ ...p, path: ["l", i] })) : []
			}
			case 4:
				return r(2) ? [{ path: ["k"], value: r(99) }] : [{ path: ["k"] }]
			case 5: {
				if (n < 2) return [{ path: ["n"], value: r(99) }]
				const a = r(n)
				return [{ path: ["l"], range: [at, at], move: { path: ["l"], range: [a, a + 1] } }]
			}
			case 6: {
				const m = v.a.length, a = r(m + 1), b = a + r(Math.min(2, m - a) + 1)
				return [{ path: ["a"], range: [a, b], value: Int32Array.of(r(99), r(99)) }]
			}
			case 7:
				return [{ path: ["n"], value: r(99) }]
			default:
				return [{ path: [], value: { t: "new", l: ["z"], a: Int32Array.of(7), n: r(9) } }]
		}
	}
	add([], [{
		path: [],
		value: rich ? { t: "0123", l: ["p", "q"], a: Int32Array.of(1, 2), n: 0 } : "0123456789",
	}], false)
	for (let i = 0; i < 30; i++) {
		const heads = h.heads()
		// rich: now and then a second table, its own patches
		const table = rich && r(6) === 0 ? "attributes" : "value"
		const other = (t: Tables) =>
			t.attributes === undefined
				? [{ path: [], value: { a: r(5) } }]
				: r(4) === 0
				? [{ path: [] }]
				: [{ path: ["a"], value: r(5) }]
		if (heads.length > 1 && r(3) === 0) {
			// a merge of two or more heads, written on
			const on = heads.slice(0, 2 + r(heads.length - 1))
			const m = merge(h, on)
			const patches = table === "attributes"
				? other(m)
				: rich
				? edit(m.value?.value as Rich)
				: splice(m.value?.value as string)
			if (fits(m, table, patches)) add(on, patches, true, table)
		} else {
			// a commit on a head or on an older commit (a fork)
			const all = h.all()
			const on = r(2) ? heads[r(heads.length)] : all[r(all.length)]
			const patches = table === "attributes"
				? other(replay(h, on.name, undefined, merges) ?? {})
				: rich
				? edit(valueAt(on) as Rich)
				: splice(text(on))
			if (fits(replay(h, on.name, undefined, merges) ?? {}, table, patches)) {
				add([on], patches, false, table)
			}
		}
	}
	return h
}

Deno.test("egwalker: heads in any order, and a start further back, merge the same", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const h = grow(seed)
		const heads = h.heads()
		if (heads.length < 2) continue
		const want = merge(h, heads).value?.value
		assertEquals(merge(h, [...heads].reverse()).value?.value, want, `seed ${seed}`)
		assertEquals(merge(h, heads, "back").value?.value, want, `seed ${seed}, from the root`)
		assertEquals(merge(h, heads, "sets").value?.value, want, `seed ${seed}, from sets`)
	}
})

Deno.test("egwalker: one head is its own tables", () => {
	const h = grow(3)
	for (const k of h.all().slice(-5)) {
		assertEquals(merge(h, [k]), replay(h, k.name, undefined, merges))
	}
})

// a merge commit's tables: its patches on its parents' merge
Deno.test("egwalker: a merge commit's tables are its patches on its parents' merge", () => {
	for (const seed of [5, 7, 11]) {
		const h = grow(seed)
		for (const k of h.all()) {
			if (k.merge === undefined) continue
			const on = merge(h, k.parents.map((p) => h.get(p)!)).value?.value
			const want = apply(on, decode(k.bytes).patches)
			assertEquals(replay(h, k.name, undefined, merges)?.value?.value, want)
		}
	}
})

// the walker (walker.ts): a history taken in commit by commit, merged at every step as sync merges
// (its heads, and a merge commit's parents before it comes in, as its check does), and now and then
// at older heads: byte for byte what egwalker gives, from scratch
Deno.test("walker: kept between merges, it merges as egwalker does, byte for byte", () => {
	const bytes = (t: Tables) => snapshot(t)
	for (let seed = 1; seed <= 16; seed++) {
		for (const rich of [false, true]) {
			const h = grow(seed, rich)
			for (const how of ["", "sets"] as const) {
				for (const limit of [undefined, 6]) {
					const r = random(seed * 7 + 1)
					const walked = createHistory(), walker = createWalker(egwalker, limit)
					const at = `seed ${seed}${rich ? " rich" : ""} ${how} limit ${limit}`
					const same = (heads: readonly Kept[], what: string) =>
						assertEquals(
							bytes(merge(walked, heads, how, walker)),
							bytes(merge(walked, heads, how)),
							`${at}: ${what}`,
						)
					for (const k of h.all()) {
						if (k.merge !== undefined) same(k.parents.map((p) => walked.get(p)!), "parents")
						walked.add(k.bytes)
						const heads = walked.heads()
						if (heads.length > 1) same(heads, "heads")
						if (r(4) === 0) {
							const all = walked.all()
							same([all[r(all.length)], all[r(all.length)]], "older")
						}
					}
				}
			}
		}
	}
})
