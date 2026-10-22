import { assert, assertEquals, assertThrows } from "@std/assert"
import { type Commit, compare, encode, joinName, name } from "@ermine/formats/commit"
import { createHistory } from "./history.ts"
import { replay } from "./replay.ts"
import { snapshot, tablesOf } from "./snapshot.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
let nonce = 0
// a commit's bytes and name
function make(
	table: string,
	parents: Uint8Array[],
	lamport: number,
	patches: Commit["patches"],
	base?: Uint8Array,
) {
	const c: Commit = {
		table,
		actor: "t",
		time: 1_760_000_000 + lamport,
		signer: new Uint8Array(32).fill(1),
		nonce: ++nonce,
		parents: [...parents].sort(compare),
		lamport,
		patches,
	}
	if (parents.length > 1) c.base = base ?? c.parents[0]
	const bytes = encode(c)
	return { bytes, name: name(bytes) }
}

Deno.test("history: taken in order, a child before its parent waits, heads in the agreed order", () => {
	const h = createHistory()
	const a = make("value", [], 1, [{ path: [], value: { n: 0 } }])
	const b = make("value", [a.name], 2, [{ path: ["n"], value: 1 }])
	const c = make("children", [a.name], 2, [{
		path: [],
		value: { x: "ermine:0010" + "ab".repeat(16) },
	}])
	assertEquals(h.add(b.bytes), { waiting: [hex(a.name)] })
	assertEquals(h.add(a.bytes), "taken")
	assertEquals(h.add(a.bytes), "passed")
	assertEquals(h.all().map((k) => hex(k.name)), [hex(a.name), hex(b.name)])
	assertEquals(h.add(c.bytes), "taken")
	// two heads at lamport 2: the greater name first
	const heads = h.heads().map((k) => hex(k.name))
	assertEquals(heads, [hex(b.name), hex(c.name)].sort().reverse())
	assertEquals(h.waiting(), [])
})

Deno.test("history: refused, a lamport not above its parents', patches check says no, what waits on a refused one", () => {
	const h = createHistory((k) => k.table !== "nope")
	const a = make("value", [], 1, [{ path: [], value: 1 }])
	h.add(a.bytes)
	assertEquals(h.add(make("value", [a.name], 1, []).bytes), { refused: "lamport" })
	const bad = make("nope", [a.name], 2, [])
	const after = make("value", [bad.name], 3, [])
	assertEquals(h.add(after.bytes), { waiting: [hex(bad.name)] })
	assertEquals(h.add(bad.bytes), { refused: "patches" })
	assertEquals(h.refused().map((r) => r.refused).sort(), ["lamport", "parent", "patches"])
	assertEquals(h.add(new Uint8Array([1, 2, 3])), { refused: "shape" })
})

Deno.test("replay: back along the bases, then forward, each table its own; a merge keeps what its patches say", () => {
	const h = createHistory()
	const a = make("value", [], 1, [{ path: [], value: { n: 0, list: [] } }])
	const b = make("value", [a.name], 2, [{ path: ["n"], value: 1 }])
	const c = make("children", [b.name], 3, [{
		path: [],
		value: { k: "ermine:0010" + "cd".repeat(16) },
	}])
	const d = make("value", [a.name], 2, [{ path: ["list"], range: [0, 0], value: [1, 2] }])
	for (const x of [a, b, c, d]) h.add(x.bytes)
	assertEquals(replay(h, c.name)!.value.value, { n: 1, list: [] })
	assertEquals(replay(h, c.name)!.children.value, { k: "ermine:0010" + "cd".repeat(16) })
	assertEquals(replay(h, d.name)!.value.value, { n: 0, list: [1, 2] })
	assertEquals(replay(h, d.name)!.children, undefined)
	// a merge over c's line, saying what it takes from d's
	const m = make("value", [c.name, d.name], 4, [{ path: ["list"], value: [1, 2] }], c.name)
	h.add(m.bytes)
	assertEquals(h.heads().map((k) => hex(k.name)), [hex(m.name)])
	assertEquals(replay(h, m.name)!.value.value, { n: 1, list: [1, 2] })
	assertEquals(replay(h, m.name)!.value.change.time, 1_760_000_004)
	// each replay new: changing what one gave changes nothing kept
	const one = replay(h, m.name)!
	;(one.value.value as { n: number }).n = 99
	assertEquals((replay(h, m.name)!.value.value as { n: number }).n, 1)
})

Deno.test("snapshot: replay starts at one, its tables new each time", () => {
	const h = createHistory()
	const a = make("value", [], 1, [{ path: [], value: { n: 0 } }])
	const b = make("value", [a.name], 2, [{ path: ["n"], value: 1 }])
	const c = make("value", [b.name], 3, [{ path: ["n"], value: 2 }])
	for (const x of [a, b, c]) h.add(x.bytes)
	const packed = snapshot(replay(h, b.name)!)
	let used = 0
	const at = (n: Uint8Array) => compare(n, b.name) === 0 ? (used++, tablesOf(packed)) : undefined
	assertEquals(replay(h, c.name, at)!.value.value, { n: 2 })
	assertEquals(used, 1)
	assert(tablesOf(packed).value.value !== tablesOf(packed).value.value)
})

Deno.test("history: a head forgotten is gone as if never told of; its parent a head again once nothing goes on it", () => {
	const h = createHistory()
	const a = make("value", [], 1, [{ path: [], value: { n: 0 } }])
	const b = make("value", [a.name], 2, [{ path: ["n"], value: 1 }])
	const c = make("value", [a.name], 2, [{ path: ["n"], value: 2 }])
	h.add(a.bytes), h.add(b.bytes), h.add(c.bytes)
	// something goes on a: not forgotten
	assertEquals(h.forget(a.name), false)
	assertEquals(h.forget(b.name), true)
	assertEquals(h.forget(b.name), false)
	assertEquals(h.get(b.name), undefined)
	assertEquals(h.heads().map((k) => hex(k.name)), [hex(c.name)])
	assertEquals(h.forget(c.name), true)
	assertEquals(h.heads().map((k) => hex(k.name)), [hex(a.name)])
	assertEquals(h.all().map((k) => hex(k.name)), [hex(a.name)])
	// told again, it comes in again
	assertEquals(h.add(b.bytes), "taken")
	assertEquals(h.heads().map((k) => hex(k.name)), [hex(b.name)])
})

Deno.test("history: a throw in the check is no refusal: the commit waits on the check, the add throws once it is settled, and again judges it", () => {
	let broken = true
	const h = createHistory(() => {
		if (broken) throw new Error("the check broke")
		return true
	})
	const a = make("value", [], 1, [{ path: [], value: 0 }])
	const b = make("value", [a.name], 2, [{ path: [], value: 1 }])
	assertEquals(h.add(b.bytes), { waiting: [hex(a.name)] })
	assertThrows(() => h.add(a.bytes), Error, "the check broke")
	assertEquals(h.refused(), [])
	assertEquals(h.waiting(), [{ name: hex(b.name), waiting: [hex(a.name)] }, {
		name: hex(a.name),
		waiting: [],
	}])
	assertEquals(h.add(a.bytes), "passed")
	broken = false
	h.again()
	assertEquals(h.waiting(), [])
	assertEquals(h.heads().map((k) => hex(k.name)), [hex(b.name)])
})

Deno.test("history: past most, the oldest commit waiting on a parent is let go of and told, and the oldest refusal forgotten", () => {
	const dropped: string[] = []
	const h = createHistory(() => true, { most: 2, dropped: (n) => dropped.push(n) })
	const missing = joinName(0x1e, new Uint8Array(32).fill(7))
	const w = [1, 2, 3].map((i) => make("value", [missing], 2, [{ path: [], value: i }]))
	for (const x of w) assertEquals(h.add(x.bytes), { waiting: [hex(missing)] })
	assertEquals(dropped, [hex(w[0].name)])
	assertEquals(h.waiting().map((x) => x.name), [hex(w[1].name), hex(w[2].name)])
	// told again, it is judged again
	assertEquals(h.add(w[0].bytes), { waiting: [hex(missing)] })
	const bad = [5, 6, 7].map((i) => make("value", [], i, []))
	for (const x of bad) assertEquals(h.add(x.bytes), { refused: "lamport" })
	assertEquals(h.refused().map((x) => x.name), [hex(bad[1].name), hex(bad[2].name)])
})
