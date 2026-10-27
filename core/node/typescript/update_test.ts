import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "@ermine/core/changeable/apply"
import createEntry, { type ChangeHeader, type Entry } from "./entry.ts"
import update from "./update.ts"

const host: ChangeHeader = { time: 0, actor: "host" }
const by: ChangeHeader = { time: 5, actor: "me" }
const make = (value?: unknown): Entry<unknown> => createEntry(value, host)
const code = (f: () => unknown) => (assertThrows(f, ApplyError) as ApplyError).code

Deno.test("update: the value the patches make; the change, the header with its op", () => {
	const n = make({ t: "hi", l: [1, 2] })
	const patches: Patch[] = [{ path: ["x"], value: 1 }, { path: ["l", 0] }, { path: ["gone"] }]
	update(n, patches, by)
	assertEquals(n.value, { t: "hi", l: [2], x: 1 })
	assertEquals([n.change.time, n.change.actor], [5, "me"])
	assertStrictEquals(n.change.op!.patches, patches)
	// the header given is unchanged
	assertEquals(by, { time: 5, actor: "me" })
})

Deno.test("update: the undo takes the value back", () => {
	const before = { t: "hi🦊", l: [1, 2, 3], m: { a: 1 } }
	const n = make(before)
	update(n, [
		{ path: ["t"], range: [2, 3], value: "!" },
		{ path: ["l"], range: [0, 1] },
		{ path: ["m", "b"], move: { path: ["m", "a"] } },
	], by)
	assertEquals(apply(n.value, n.change.op!.undo), before)
})

Deno.test("update: a whole header kept, its fields as given", () => {
	const n = make(1)
	const header: ChangeHeader = {
		time: 7,
		actor: { actor: "a1", person: "p1", trusted: false, code: ["c1", "c2"] },
		reader: "pid3",
		external: [{ file: "file:///x.ts", line: 9 }],
		metadata: { why: "a new list" },
	}
	update(n, [{ path: [], value: 2 }], header)
	const { op: _, ...rest } = n.change
	assertEquals(rest, header)
})

Deno.test("update: a first value made, and removed", () => {
	const n = make()
	update(n, [{ path: [], value: { a: 1 } }], by)
	assertEquals(n.value, { a: 1 })
	assertEquals(n.change.op!.undo, [{ path: [] }])
	update(n, [{ path: [] }], by)
	assertEquals("value" in n, false)
	assertEquals(n.change.op!.undo, [{ path: [], value: { a: 1 } }])
	assertEquals(code(() => update(n, [{ path: ["k"], value: 1 }], by)), "no-key")
})

Deno.test("update: invalid, nothing changes", () => {
	const value = { s: "ab", l: [1], m: {} }
	const n = make(value)
	const change = n.change
	const cases: [Patch[], string][] = [
		[[{ path: ["s"], range: [1, 3] }], "range"],
		[[{ path: ["l", 1], value: 1 }], "no-key"],
		[[{ path: ["l", 0], value: 2 }, { path: ["q", 0] }], "no-key"],
		[[{ path: ["s"], range: [0, 0], value: "y" }, { path: ["s", 0] }], "wrong-kind"],
		[[{ path: ["l", -1] } as Patch], "not-a-patch"],
	]
	for (const [ps, c] of cases) assertEquals(code(() => update(n, ps, by)), c, JSON.stringify(ps))
	assertStrictEquals(n.value, value)
	assertStrictEquals(n.change, change)
	assertEquals(value, { s: "ab", l: [1], m: {} })
})

Deno.test("update: patches given as any iterable", () => {
	const n = make({ a: 1 })
	function* ps(): Generator<Patch> {
		yield { path: ["b"], value: 2 }
	}
	update(n, ps(), by)
	assertEquals(n.value, { a: 1, b: 2 })
	assertEquals(n.change.op!.patches, [{ path: ["b"], value: 2 }])
})
