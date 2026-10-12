import { assertEquals } from "@std/assert"
import { type Blop, encode, name } from "../../encoding/ts/blop.ts"
import { check, side } from "./apply.ts"
import { createHistories } from "./history.ts"

let count = 0
const make = (more: Partial<Blop> = {}): Blop => ({
	node: "n",
	object: "value",
	actor: "a",
	signer: new Uint8Array(32).fill(1),
	nonce: new Uint8Array(8).fill(++count),
	parents: [],
	lamport: 1,
	patches: [{ path: [], value: { a: 1 } }],
	...more,
})
const named = (b: Blop) => ({ b, n: name(encode(b)) })
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

Deno.test("history: a line is taken in, the last its one head", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	const a = named(make({ parents: [r.n], lamport: 2, patches: [{ path: ["a"], value: 2 }] }))
	assertEquals(histories.add(r.b, r.n), "taken")
	assertEquals(histories.add(a.b, a.n), "taken")
	assertEquals(histories.add(a.b, a.n), "passed")
	assertEquals(histories.heads("value").map((h) => hex(h.name)), [hex(a.n)])
	assertEquals(side(histories, a.n), { a: 2 })
})

Deno.test("history: waiting, woken by its parent", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	const a = named(make({ parents: [r.n], lamport: 2, patches: [] }))
	assertEquals(histories.add(a.b, a.n), { waiting: [hex(r.n)] })
	assertEquals(histories.heads("value"), [])
	histories.add(r.b, r.n)
	assertEquals(histories.waiting(), [])
	assertEquals(histories.get(a.n), a.b)
})

Deno.test("history: refused patches, and a child of it stuck", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	const bad = named(
		make({ parents: [r.n], lamport: 2, patches: [{ path: ["x", "y"], value: 1 }] }),
	)
	const kid = named(make({ parents: [bad.n], lamport: 3 }))
	histories.add(r.b, r.n)
	assertEquals(histories.add(bad.b, bad.n), { refused: "patches" })
	assertEquals(histories.add(kid.b, kid.n), { stuck: [hex(bad.n)] })
	assertEquals(histories.heads("value").map((h) => hex(h.name)), [hex(r.n)])
})

Deno.test("apply: no side when emptied", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	const gone = named(make({ parents: [r.n], lamport: 2, patches: [{ path: [] }] }))
	histories.add(r.b, r.n)
	assertEquals(histories.add(gone.b, gone.n), "taken")
	assertEquals(side(histories, gone.n), undefined)
})
