import { assertEquals } from "@std/assert"
import {
	createNotify,
	facts,
	type Kind,
	type Options,
	type Patch,
	type Path,
	type Place,
} from "./notify.ts"

// for the tests only: GRAPH.tex's patches on plain values (lists, maps, strings)
type V = unknown
function at(v: V, keys: readonly (string | number)[]): V {
	for (const k of keys) v = (v as Record<string | number, V>)[k]
	return v
}
function edit(v: V, keys: readonly (string | number)[], f: (v: V) => V): V {
	if (keys.length === 0) return f(v)
	const [k, ...more] = keys
	if (Array.isArray(v)) return v.with(k as number, edit(v[k as number], more, f))
	const o = v as Record<string | number, V>
	return { ...o, [k]: edit(o[k], more, f) }
}
function splice(seq: V, a: number, b: number, put: V): V {
	if (typeof seq === "string") {
		const cs = Array.from(seq)
		cs.splice(a, b - a, ...Array.from(put as string))
		return cs.join("")
	}
	return (seq as V[]).toSpliced(a, b - a, ...(put as V[]))
}
function remove(v: V, p: Place): V {
	if (p.range) return edit(v, p.path, (s) => splice(s, p.range![0], p.range![1], []))
	if (p.path.length === 0) return undefined
	const k = p.path[p.path.length - 1]
	return edit(v, p.path.slice(0, -1), (o) => {
		if (Array.isArray(o)) return o.toSpliced(k as number, 1)
		const { [k]: _, ...rest } = o as Record<string | number, V>
		return rest
	})
}
function place(v: V, p: Place, put: V, one: boolean): V {
	if (p.range) {
		return edit(
			v,
			p.path,
			(s) => splice(s, p.range![0], p.range![1], one && Array.isArray(s) ? [put] : put),
		)
	}
	return edit(v, p.path, () => put)
}
function apply(v: V, p: Patch): V {
	if (p.move) {
		const m = p.move
		const what = m.range
			? (() => {
				const s = at(v, m.path)
				return typeof s === "string"
					? Array.from(s).slice(...m.range!).join("")
					: (s as V[]).slice(...m.range!)
			})()
			: at(v, m.path)
		return place(remove(v, m), p, what, !m.range)
	}
	if ("value" in p) return place(v, p, p.value, false)
	return remove(v, p)
}

function setup(start: V) {
	let value = start
	const n = createNotify(() => value)
	const log: string[] = []
	return {
		read(path: Path, options?: Options) {
			const r = n.read(path, options)
			const name = JSON.stringify(path) + (options?.chase ? "~" : "")
			r.on((k: Kind) => log.push(`${name} ${k}`))
			return r
		},
		patch(p: Patch) {
			const before = value
			value = apply(value, p)
			n.patched(p, facts(p, before))
			return log.splice(0)
		},
	}
}

const items = () => ({ title: "a", items: ["x", "y", "z", "w", "v"] })

Deno.test("a same-length put over a span: only those indices", () => {
	const s = setup(items())
	s.read(["items", 1])
	s.read(["items", 3])
	s.read(["items"])
	assertEquals(s.patch({ path: ["items"], range: [1, 2], value: ["q"] }), [`["items",1] value`])
})

Deno.test("append: no element there, a length", () => {
	const s = setup(items())
	s.read(["items", 3])
	s.read(["items"])
	assertEquals(s.patch({ path: ["items"], range: [5, 5], value: ["u"] }), [`["items"] length`])
})

Deno.test("insert first: every later index by position, chased ones move", () => {
	const s = setup(items())
	s.read(["items", 3])
	const c = s.read(["items", 3], { chase: true })
	assertEquals(s.patch({ path: ["items"], range: [0, 0], value: ["t"] }), [
		`["items",3] value`,
		`["items",3]~ moved`,
	])
	assertEquals(c.path, ["items", 4])
	assertEquals(c.value, "w")
})

Deno.test("removing a key: its readers, and the map's keys", () => {
	const s = setup(items())
	s.read(["title"])
	s.read([])
	const c = s.read(["title"], { chase: true })
	assertEquals(s.patch({ path: ["title"] }), [`[] keys`, `["title"] value`, `["title"]~ gone`])
	assertEquals(s.patch({ path: ["title"], value: "b" }), [`[] keys`, `["title"] value`])
	assertEquals(c.path, ["title"])
})

Deno.test("deep hears under, plain does not", () => {
	const s = setup({ items: [{ name: "x" }] })
	s.read(["items"])
	s.read(["items"], { deep: true })
	assertEquals(s.patch({ path: ["items", 0, "name"], value: "y" }), [`["items"] value`])
})

Deno.test("a put over a chased item keeps it", () => {
	const s = setup(items())
	const c = s.read(["items", 3], { chase: true })
	assertEquals(s.patch({ path: ["items"], range: [3, 4], value: ["q"] }), [`["items",3]~ value`])
	assertEquals(c.value, "q")
	assertEquals(s.patch({ path: ["items", 3], value: "p" }), [`["items",3]~ value`])
	assertEquals(s.patch({ path: ["items", 3] }), [`["items",3]~ gone`])
})

Deno.test("a move carries a chased item", () => {
	const s = setup(items())
	const c = s.read(["items", 3], { chase: true })
	s.read(["items", 3])
	const out = s.patch({ path: ["items"], range: [0, 0], move: { path: ["items", 3] } })
	assertEquals(out.sort(), [`["items",3] value`, `["items",3]~ moved`])
	assertEquals(c.path, ["items", 0])
	assertEquals(c.value, "w")
})

Deno.test("a key moved: the chase follows it", () => {
	const s = setup({ a: { x: 1 }, b: 2 })
	const c = s.read(["a", "x"], { chase: true })
	s.patch({ path: ["c"], move: { path: ["a"] } })
	assertEquals(c.path, ["c", "x"])
	assertEquals(c.value, 1)
})

Deno.test("chased spans: move, grow, shrink", () => {
	const s = setup({ items: ["a", "b", "c", "d", "e", "f", "g"] })
	const c = s.read(["items", [3, 5]], { chase: true })
	s.patch({ path: ["items"], range: [0, 0], value: ["0", "1"] })
	assertEquals(c.path, ["items", [5, 7]])
	assertEquals(c.value, ["d", "e"])
	s.patch({ path: ["items"], range: [6, 6], value: ["i"] })
	assertEquals(c.path, ["items", [5, 8]])
	s.patch({ path: ["items"], range: [6, 7] })
	assertEquals(c.path, ["items", [5, 7]])
	assertEquals(c.value, ["d", "e"])
})

Deno.test("edges: in or out", () => {
	const s = setup({ text: "hello world" })
	const sel = s.read(["text", [0, 5]], { chase: true, edges: ["out", "in"] })
	const out = s.read(["text", [0, 5]], { chase: true, edges: ["out", "out"] })
	s.patch({ path: ["text"], range: [5, 5], value: "!" })
	assertEquals(sel.value, "hello!")
	assertEquals(out.value, "hello")
	s.patch({ path: ["text"], range: [0, 0], value: ">" })
	assertEquals(sel.value, "hello!")
	assertEquals(out.path, ["text", [1, 6]])
})

Deno.test("a caret: typing pushes it, or not", () => {
	const s = setup({ text: "ab" })
	const pushed = s.read(["text", [1, 1]], { chase: true, edges: ["out", "out"] })
	const stays = s.read(["text", [1, 1]], { chase: true, edges: ["in", "out"] })
	s.patch({ path: ["text"], range: [1, 1], value: "xy" })
	assertEquals(pushed.path, ["text", [3, 3]])
	assertEquals(stays.path, ["text", [1, 1]])
})

Deno.test("empty: keep or gone", () => {
	const s = setup({ items: ["a", "b", "c", "d"] })
	const keep = s.read(["items", [1, 3]], { chase: true, empty: "keep" })
	s.read(["items", [1, 3]], { chase: true, empty: "gone" })
	const out = s.patch({ path: ["items"], range: [0, 4] })
	assertEquals(out.includes(`["items",[1,3]]~ gone`), true)
	assertEquals(keep.path, ["items", [0, 0]])
})

Deno.test("a span by position: hears what reaches it", () => {
	const s = setup(items())
	s.read(["items", [3, 5]])
	assertEquals(s.patch({ path: ["items"], range: [0, 1], value: ["q"] }), [])
	assertEquals(s.patch({ path: ["items"], range: [0, 0], value: ["q"] }), [
		`["items",[3,5]] value`,
	])
})

Deno.test("strings count code points", () => {
	const s = setup({ text: "🦊ab" })
	const c = s.read(["text", [1, 2]], { chase: true })
	s.patch({ path: ["text"], range: [0, 0], value: "🐰" })
	assertEquals(c.path, ["text", [2, 3]])
	assertEquals(c.value, "a")
})

Deno.test("nothing listened, nothing walked", () => {
	const s = setup(items())
	assertEquals(s.patch({ path: ["items"], range: [0, 0], value: ["q"] }), [])
})

// laws, over random patches to a list of unique things (a few dozen seeds):
// a read whose value changed fired; a chased item that heard no value or gone holds the same thing
Deno.test("laws: nothing missed, chases hold their thing", () => {
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed
		const rand = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648) % n)
		let fresh = 0
		let value: V = { items: Array.from({ length: 6 }, () => `e${fresh++}`) }
		const n = createNotify(() => value)
		const list = () => (value as { items: string[] }).items
		type Watch = { r: ReturnType<typeof n.read>; last: V; heard: Kind[]; chase: boolean }
		const watches: Watch[] = []
		for (let i = 0; i < 8; i++) {
			const chase = rand(2) === 0
			const r = n.read(["items", rand(6)], { chase })
			const w: Watch = { r, last: r.value, heard: [], chase }
			r.on((k) => w.heard.push(k))
			watches.push(w)
		}
		for (let step = 0; step < 30; step++) {
			const len = list().length
			const a = rand(len + 1), b = a + rand(len - a + 1)
			const k = rand(len > 0 ? 5 : 2)
			const p: Patch = k === 0
				? {
					path: ["items"],
					range: [a, b],
					value: Array.from({ length: rand(3) }, () => `e${fresh++}`),
				}
				: k === 1
				? { path: ["items"], range: [a, b] }
				: k === 2
				? { path: ["items", rand(len)] }
				: k === 3
				? { path: ["items", rand(len)], value: `e${fresh++}` }
				: (() => {
					const g = rand(len)
					return { path: ["items"], range: [g, g], move: { path: ["items", rand(len)] } }
				})()
			const before = value
			value = apply(value, p)
			n.patched(p, facts(p, before))
			for (const w of [...watches]) {
				const now = w.r.value
				const said = `seed ${seed} step ${step} ${JSON.stringify(p)} ${
					JSON.stringify(w.r.path)
				}`
				if (w.heard.includes("gone")) {
					watches.splice(watches.indexOf(w), 1)
					continue
				}
				if (now !== w.last) assertEquals(w.heard.length > 0, true, `missed: ${said}`)
				if (w.chase && !w.heard.includes("value")) {
					assertEquals(now, w.last, `chase lost its thing: ${said}`)
				}
				w.last = now
				w.heard = []
			}
		}
	}
})

Deno.test("shifting: a chased and a plain read on one index part ways", () => {
	const s = setup({ items: [{ v: 0 }, { v: 1 }, { v: 2 }] })
	const c = s.read(["items", 1, "v"], { chase: true })
	const p = s.read(["items", 1, "v"])
	s.patch({ path: ["items"], range: [0, 0], value: [{ v: 9 }] })
	assertEquals([c.path, c.value], [["items", 2, "v"], 1])
	assertEquals([p.path, p.value], [["items", 1, "v"], 0])
	// both still hear their own places
	// named by where they started
	assertEquals(s.patch({ path: ["items", 2, "v"], value: 5 }), [`["items",1,"v"]~ value`])
	assertEquals(s.patch({ path: ["items", 1, "v"], value: 6 }), [`["items",1,"v"] value`])
})

Deno.test("shifting down: chased reads land on nodes already there", () => {
	const s = setup({ items: ["a", "b", "c", "d"] })
	const d = s.read(["items", 3], { chase: true })
	const one = s.read(["items", 1])
	s.patch({ path: ["items"], range: [0, 2] })
	assertEquals([d.path, d.value], [["items", 1], "d"])
	assertEquals([one.path, one.value], [["items", 1], "d"])
	assertEquals(s.patch({ path: ["items", 1], value: "x" }).sort(), [
		`["items",1] value`,
		`["items",3]~ value`,
	])
	s.patch({ path: ["items"], range: [0, 0], value: ["y"] })
	assertEquals(d.path, ["items", 2])
	// [y, c, x]: by position
	assertEquals(one.value, "c")
})

Deno.test("shifting: many chased reads, in order, then all of them back", () => {
	const items = Array.from({ length: 50 }, (_, i) => `e${i}`)
	const s = setup({ items })
	const rs = items.map((_, i) => s.read(["items", i], { chase: true }))
	s.patch({ path: ["items"], range: [0, 0], value: ["a", "b", "c"] })
	rs.forEach((r, i) => assertEquals(r.value, `e${i}`))
	s.patch({ path: ["items"], range: [0, 3] })
	rs.forEach((r, i) => assertEquals(r.path, ["items", i]))
	assertEquals(
		s.patch({ path: ["items"], range: [25, 25], move: { path: ["items", 0] } }).length,
		26,
	)
	assertEquals(rs[0].path, ["items", 25])
	assertEquals(rs[1].path, ["items", 0])
	assertEquals(rs[30].path, ["items", 30])
})

// found by the audit of 10-11

Deno.test("a read keeps no hold on the caller's path: a shift moves the read, not the array given", () => {
	const s = setup(items())
	const path = ["items", 1]
	const r = s.read(path, { chase: true })
	s.patch({ path: ["items"], range: [0, 0], value: ["q"] })
	assertEquals(r.path, ["items", 2])
	assertEquals(path, ["items", 1])
})

Deno.test("a lone high surrogate is one code point in a span's value, as in its places", () => {
	const s = setup({ text: "\ud83da" })
	assertEquals(s.read(["text", [1, 2]]).value, "a")
})
