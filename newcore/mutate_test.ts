import { assertEquals, assertThrows } from "@std/assert"
import createChange, { type Change } from "./change.ts"
import createNode from "./node.ts"
import mutate, { MutateError } from "./mutate.ts"
import { squish } from "./squish.ts"
import { createNotify, type Patch } from "./notify.ts"

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

Deno.test("mutate: patched hears each patch once the change is in, with its own before", () => {
	const n = createNode<unknown, Change>("a", { value: at({ t: "ab", l: [1] }) })
	const notify = createNotify(() => n.value[0].content)
	const heard: [string, unknown][] = []
	const t = notify.read(["t"]), l = notify.read(["l", 0])
	t.on((kind) => heard.push([kind, t.value]))
	l.on((kind) => heard.push([kind, l.value]))
	const befores: unknown[] = []
	const c = mutate(n, "value", [
		{ path: ["t"], range: [2, 2], value: "c" },
		{ path: ["l", 0], value: 2 },
		{ path: ["t"], range: [0, 1] },
	], {
		...by,
		patched(p, before) {
			befores.push(structuredClone(before))
			notify.patched(p, before)
		},
	})
	assertEquals(befores, [{ t: "ab", l: [1] }, { t: "abc", l: [1] }, { t: "abc", l: [2] }])
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
	const patched = (_p: Patch, _b: unknown, node: string, which: unknown) => told.push([node, which])
	mutate(n, "value", [{ path: [], value: 2 }], { ...by, patched })
	mutate(n, ["info", "theme"], [{ path: [], value: "y" }], { ...by, patched })
	mutate(n, ["children", "kids"], [{ path: [], range: [1, 1], value: ["c"] }], { ...by, patched })
	assertEquals(told, [["a", "value"], ["a", ["info", "theme"]], ["a", ["children", "kids"]]])
})
