import { assertEquals, assertThrows } from "@std/assert"
import createChange, { type Change } from "../nodes/change.ts"
import createNode from "../nodes/node.ts"
import mutate, { MutateError } from "./mutate.ts"
import { squish } from "./squish.ts"
import { createNotify, type Facts, facts, type Patch } from "../notify.ts"

// a fuzz's numbers: xorshift (an LCG's low bits repeat, so % k of one is patterned)
const xs = (x: number) => {
	x = x || 1
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return x >>> 0
}

const by = { actor: "me", time: 5 }
const at = (
	content: unknown,
) => [{ content, change: createChange("a", { time: 0, actor: "host" }) }]
const code = (f: () => unknown) => (assertThrows(f, MutateError) as MutateError).code

Deno.test("mutate: puts, removes, and the change", () => {
	const n = createNode<unknown, Change>("a", { value: at({ t: "hi", l: [1, 2] }) })
	const c = mutate(n, "value", [
		{ path: ["x"], value: 1 },
		{ path: ["l", 0] },
		{ path: ["gone"] },
	], by)
	assertEquals(c, { time: 5, actor: "me", node: "a" })
	assertEquals(n.value[0], { content: { t: "hi", l: [2], x: 1 }, change: c })
})

Deno.test("mutate: the change carries the whole header given", () => {
	const n = createNode<unknown, Change>("a", { value: at(1) })
	const header = {
		time: 7,
		actor: { actor: "a1", person: "p1", trusted: false, code: ["c1", "c2"] },
		reader: "pid3",
		cause: "a new list",
		site: { file: "file:///x.ts", line: 9 },
	}
	const c = mutate(n, "value", [{ path: [], value: 2 }], header)
	assertEquals(c, { ...header, node: "a" })
})

Deno.test("mutate: spans of strings in code points, lists, typed arrays", () => {
	const n = createNode<unknown, Change>("a", {
		value: at({ s: "a😀b", l: [1, 2, 3], b: new Uint8Array([1, 2, 3]) }),
	})
	mutate(n, "value", [
		{ path: ["s"], range: [1, 2], value: "x" },
		{ path: ["l"], range: [0, 2], value: [9] },
		{ path: ["b"], range: [3, 3], value: new Uint8Array([4]) },
	], by)
	assertEquals(n.value[0].content, { s: "axb", l: [9, 3], b: new Uint8Array([1, 2, 3, 4]) })
})

Deno.test("mutate: what is not touched is shared, the old content unchanged", () => {
	const old = { a: { x: 1 }, b: { y: 2 } }
	const n = createNode<unknown, Change>("a", { value: at(old) })
	mutate(n, "value", [{ path: ["a", "x"], value: 3 }, { path: ["a", "z"], value: 4 }], by)
	const now = n.value[0].content as typeof old
	assertEquals(old, { a: { x: 1 }, b: { y: 2 } })
	assertEquals(now.a, { x: 3, z: 4 } as unknown)
	assertEquals(now.b === old.b, true)
})

Deno.test("mutate: squished typing gives what the typing gives", () => {
	const typing: Patch[] = [..."hello"].map((c, i) => ({ path: ["t"], range: [i, i], value: c }))
	const one = createNode<unknown, Change>("a", { value: at({ t: "" }) })
	const two = createNode<unknown, Change>("a", { value: at({ t: "" }) })
	mutate(one, "value", typing, by)
	mutate(two, "value", squish(typing), by)
	assertEquals(one.value[0].content, { t: "hello" })
	assertEquals(two.value[0].content, one.value[0].content)
})

Deno.test("mutate: moves leave first, then land in what is left", () => {
	const n = createNode<unknown, Change>("a", { value: at({ l: ["a", "b", "c"], m: {} }) })
	mutate(n, "value", [
		{ path: ["l"], range: [0, 0], move: { path: ["l", 2] } },
		{ path: ["m", "k"], move: { path: ["l", 1] } },
	], by)
	assertEquals(n.value[0].content, { l: ["c", "b"], m: { k: "a" } })
	assertEquals(
		code(() => mutate(n, "value", [{ path: ["m", "k", "x"], move: { path: ["m"] } }], by)),
		"into-itself",
	)
})

Deno.test("mutate: a first value, info and list; emptied, gone", () => {
	const n = createNode<unknown, Change>("a")
	mutate(n, "value", [{ path: [], value: { a: 1 } }], by)
	mutate(n, ["info", "title"], [{ path: [], value: "x" }], by)
	mutate(n, ["children", "kids"], [{ path: [], range: [0, 0], value: ["m2"] }], by)
	assertEquals([n.value[0].content, n.info.get("title")![0].content], [{ a: 1 }, "x"])
	assertEquals(n.children.get("kids")![0].content, ["m2"])
	mutate(n, ["children", "kids"], [{ path: [0] }], by)
	mutate(n, ["info", "title"], [{ path: [] }], by)
	assertEquals([n.children.has("kids"), n.info.has("title")], [false, false])
	assertEquals(code(() => mutate(n, ["info", "none"], [{ path: ["k"], value: 1 }], by)), "no-key")
})

Deno.test("mutate: the other versions and because are kept", () => {
	const ch = createChange("a", { time: 0, actor: "host" })
	const n = createNode<unknown, Change>("a", {
		value: [{ content: 1, change: ch, because: "front" }, { content: 2, change: ch }],
	})
	const c = mutate(n, "value", [{ path: [], value: 3 }], by)
	assertEquals(n.value, [{ content: 3, change: c, because: "front" }, { content: 2, change: ch }])
})

Deno.test("mutate: invalid, nothing changes", () => {
	const content = { s: "ab", l: [1], m: {} }
	const n = createNode<unknown, Change>("a", { value: at(content) })
	const was = n.value
	const cases: [Patch[], string][] = [
		[[{ path: ["s"], range: [1, 3] }], "range"],
		[[{ path: ["s"], range: [0, 0], value: [1] }], "wrong-kind"],
		[[{ path: ["l", "x"], value: 1 }], "wrong-kind"],
		[[{ path: ["l", 1], value: 1 }], "no-key"],
		[[{ path: ["m", "x", "y"], value: 1 }], "no-key"],
		[[{ path: ["s", 0], value: "x" }], "wrong-kind"],
		[[{ path: "s" } as unknown as Patch], "not-a-patch"],
		[[{ path: ["l", 0], value: 2 }, { path: ["q", 0] }], "no-key"],
	]
	for (const [ps, c] of cases) {
		assertEquals(code(() => mutate(n, "value", ps, by)), c, JSON.stringify(ps))
	}
	assertEquals(n.value === was, true)
	assertEquals(content, { s: "ab", l: [1], m: {} })
})

Deno.test("mutate: patched hears each patch once the change is in, with its facts", () => {
	const n = createNode<unknown, Change>("a", { value: at({ t: "ab", l: [1] }) })
	const notify = createNotify(() => n.value[0].content)
	const heard: [string, unknown][] = []
	const t = notify.read(["t"]), l = notify.read(["l", 0])
	t.on((kind) => heard.push([kind, t.value]))
	l.on((kind) => heard.push([kind, l.value]))
	const told: Facts[] = []
	const c = mutate(n, "value", [
		{ path: ["t"], range: [2, 2], value: "c" },
		{ path: ["l", 0], value: 2 },
		{ path: ["t"], range: [0, 1] },
	], {
		...by,
		patched(p, f) {
			told.push(f)
			notify.patched(p, f)
		},
	})
	assertEquals(told, [
		{ place: { list: false, length: 2, had: true } },
		{ place: { list: true, length: 1, had: true } },
		{ place: { list: false, length: 3, had: true } },
	])
	// handlers read the end: the change is in before any is told
	assertEquals(heard, [
		["value", "bc"],
		["length", "bc"],
		["value", 2],
		["value", "bc"],
		["length", "bc"],
	])
	assertEquals("patched" in c, false)
})

Deno.test("mutate: invalid, patched never hears", () => {
	const n = createNode<unknown, Change>("a", { value: at({ t: "ab" }) })
	let told = 0
	code(() =>
		mutate(n, "value", [{ path: ["t"], range: [0, 0], value: "x" }, { path: ["q", 0] }], {
			...by,
			patched: () => told++,
		})
	)
	assertEquals(told, 0)
})

Deno.test("mutate: patched is told the node and which object", () => {
	const n = createNode<unknown, Change>("a", {
		value: at(1),
		info: [["theme", at("x")]],
		children: [["kids", at(["b"]) as never]],
	})
	const told: unknown[] = []
	const patched = (_p: Patch, _b: unknown, node: string, which: unknown) =>
		told.push([node, which])
	mutate(n, "value", [{ path: [], value: 2 }], { ...by, patched })
	mutate(n, ["info", "theme"], [{ path: [], value: "y" }], { ...by, patched })
	mutate(n, ["children", "kids"], [{ path: [], range: [1, 1], value: ["c"] }], { ...by, patched })
	assertEquals(told, [["a", "value"], ["a", ["info", "theme"]], ["a", ["children", "kids"]]])
})

Deno.test("mutate: patched at [] says whether the object was there", () => {
	const n = createNode<unknown, Change>("a")
	const told: boolean[] = []
	const patched = (_p: Patch, f: Facts) => told.push(f.place.had)
	mutate(n, ["info", "x"], [{ path: [], value: 1 }, { path: [], value: 2 }], { ...by, patched })
	mutate(n, ["children", "k"], [{ path: [], value: ["m"] }], { ...by, patched })
	mutate(n, ["children", "k"], [{ path: [] }], { ...by, patched })
	assertEquals(told, [false, true, false, true])
})

// mutate's facts, against notify's facts() from the whole content before each patch
Deno.test("mutate: facts as notify makes them from the content", () => {
	let x = 0
	const rand = (n: number) => (x = xs(x)) % n
	const keys = ["a", "b", "c"]
	function patch(v: Record<string, unknown>): Patch {
		const l = v.l as unknown[], s = v.s as string
		const i = rand(l.length + 1), j = i + rand(l.length - i + 1)
		const c = rand(s.length + 1)
		switch (rand(10)) {
			case 0:
				return { path: ["l"], range: [i, j], value: [rand(9)] }
			case 1:
				return { path: ["l"], range: [i, j] }
			case 2:
				return { path: ["s"], range: [c, c], value: rand(2) ? "x" : "😀" }
			case 3:
				return { path: ["m", keys[rand(3)]], value: rand(9) }
			case 4:
				return { path: ["m", keys[rand(3)]] }
			case 5:
				return l.length
					? {
						path: ["l"],
						range: [i % l.length, i % l.length],
						move: { path: ["l", rand(l.length)] },
					}
					: { path: ["l"], range: [0, 0], value: [1, 2, 3] }
			case 6:
				return l.length > 1
					? {
						path: ["l"],
						range: [0, 0],
						move: { path: ["l"], range: [1, 1 + rand(l.length - 1)] },
					}
					: { path: ["l", 0], value: 0 } as Patch
			case 7:
				return l.length
					? { path: ["m", keys[rand(3)]], move: { path: ["l", rand(l.length)] } }
					: { path: ["s"], range: [0, 0], value: "y" }
			case 8:
				return l.length > 1
					? { path: ["l", rand(l.length - 1)], move: { path: ["l", rand(l.length)] } }
					: { path: ["l", rand(l.length + 1)], value: 7 }
			default:
				return { path: ["l", rand(l.length + 1)], value: 7 }
		}
	}
	// code points, then UTF-16 units (an emoji may be split there: allowed)
	for (const utf16 of [false, true]) {
		for (let seed = 1; seed <= 40; seed++) {
			x = seed
			const count = { ...by, utf16 }
			const n = createNode<unknown, Change>("a", {
				value: at({ l: [1, 2, 3], s: "ab", m: { a: 1 } }),
			})
			const ps: Patch[] = [], befores: unknown[] = []
			// one change each, to have each content before; patches that fail are left out
			for (let step = 0; step < 30; step++) {
				const v = n.value[0].content as Record<string, unknown>
				const p = patch(v)
				try {
					mutate(n, "value", [p], count)
					ps.push(p), befores.push(v)
				} catch (e) {
					if (!(e instanceof MutateError)) throw e
				}
			}
			const m = createNode<unknown, Change>("a", {
				value: at({ l: [1, 2, 3], s: "ab", m: { a: 1 } }),
			})
			const told: Facts[] = []
			mutate(m, "value", ps, { ...count, patched: (_p, f) => told.push(f) })
			assertEquals(m.value[0].content, n.value[0].content, `seed ${seed}`)
			ps.forEach((p, i) =>
				assertEquals(
					told[i],
					facts(p, befores[i], { utf16 }),
					`utf16 ${utf16} seed ${seed} ${JSON.stringify(p)}`,
				)
			)
		}
	}
})

Deno.test("mutate: utf16 counts UTF-16 units, and is not the change's", () => {
	const n = createNode<unknown, Change>("a", { value: at({ s: "a😀b" }) })
	const told: Facts[] = []
	const c = mutate(n, "value", [{ path: ["s"], range: [3, 4] }], {
		...by,
		utf16: true,
		patched: (_p, f) => told.push(f),
	})
	assertEquals(n.value[0].content, { s: "a😀" })
	assertEquals(told[0].place.length, 4)
	assertEquals("utf16" in c, false)
	assertEquals(
		code(() => mutate(n, "value", [{ path: ["s"], range: [0, 4] }], { ...by, utf16: true })),
		"range",
	)
})

// found by the audit of 10-11

Deno.test("mutate: a children content is a list; anything else at [] is wrong-kind", () => {
	const n = createNode<unknown, Change>("a")
	mutate(n, ["children", "k"], [{ path: [], value: ["m"] }], by)
	for (const value of ["", "abc", 5]) {
		assertEquals(
			code(() => mutate(n, ["children", "k"], [{ path: [], value }], by)),
			"wrong-kind",
		)
	}
	assertEquals(n.children.get("k")![0].content, ["m"])
})

Deno.test("mutate: the facts of moving the whole onto itself are notify's", () => {
	const n = createNode<unknown, Change>("a", { value: at({ x: 1 }) })
	const told: Facts[] = []
	const p: Patch = { path: [], move: { path: [] } }
	mutate(n, "value", [p], { ...by, patched: (_p, f) => told.push(f) })
	assertEquals(told, [facts(p, { x: 1 })])
})

Deno.test("mutate and notify, both utf16: spans read in UTF-16 units", () => {
	const n = createNode<unknown, Change>("a", { value: at({ s: "a😀bc" }) })
	const notify = createNotify(() => n.value[0].content, { utf16: true })
	const b = notify.read(["s", [3, 4]])
	assertEquals(b.value, "b")
	const heard: [string, unknown][] = []
	b.on((kind) => heard.push([kind, b.value]))
	mutate(n, "value", [{ path: ["s"], range: [3, 4], value: "B" }], {
		...by,
		utf16: true,
		patched: (p, f) => notify.patched(p, f),
	})
	assertEquals(n.value[0].content, { s: "a😀Bc" })
	assertEquals(heard, [["value", "B"]])
})

// many string patches in one change walk from what the last left (walk.ts near): the same end as
// one change each, which never does
Deno.test("mutate: fuzz, string edits in one change as one change each", () => {
	const parts = ["a", "é", "😀", "\uD83D", "\uDE00", "中", "xy"]
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const rand = (k: number) => (x = xs(x)) % k
		const start = Array.from({ length: rand(30) }, () => parts[rand(parts.length)]).join("")
		const one = createNode<unknown, Change>("a", { value: at({ s: start }) })
		const ps: Patch[] = []
		for (let step = 0; step < 60; step++) {
			const s = (one.value[0].content as { s: string }).s, n = Array.from(s).length
			// typing runs, backspaces, deletes, replaces, at random places and at the last caret
			const near = ps.length && rand(2) ? (ps[ps.length - 1].range![0] + 1) : rand(n + 2)
			const a = Math.min(near, n + 1), b = a + rand(3)
			const p: Patch = rand(3)
				? { path: ["s"], range: [a, b], value: parts[rand(parts.length)] }
				: { path: ["s"], range: [a, b] }
			try {
				mutate(one, "value", [p], by)
				ps.push(p)
			} catch (e) {
				if (!(e instanceof MutateError)) throw e
			}
		}
		const all = createNode<unknown, Change>("a", { value: at({ s: start }) })
		const told: Facts[] = []
		mutate(all, "value", ps, { ...by, patched: (_p, f) => told.push(f) })
		assertEquals(all.value[0].content, one.value[0].content, `seed ${seed}`)
		// each patch's length fact: the string's positions before it
		let s = start
		ps.forEach((p, i) => {
			assertEquals(told[i].place.length, Array.from(s).length, `seed ${seed} patch ${i}`)
			const cps = Array.from(s), [a, b] = p.range!
			s = cps.slice(0, a).join("") + ((p.value as string) ?? "") + cps.slice(b).join("")
		})
	}
})
