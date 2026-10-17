// the only head's side changes in place: never a blop's patches, never another side
import { assertEquals } from "@std/assert"
import { type Blop, encode, name } from "@ermine/encoding/blop"
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
	patches: [{ path: [], value: { children: {} } }],
	...more,
})
const named = (b: Blop) => ({ b, n: name(encode(b)), bytes: encode(b) })
type Named = ReturnType<typeof named>
const after = (p: Named, patches: Blop["patches"]) =>
	named(make({ parents: [p.n], lamport: p.b.lamport + 1, patches }))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

Deno.test("apply: a line of places changes the side in place, the blops as they were", () => {
	const histories = createHistories("n", check)
	const line = [named(make())]
	histories.add(line[0].b, line[0].n)
	for (let i = 0; i < 20; i++) {
		const last = line.at(-1)!
		// a place, and an edit inside the one placed before
		const next = after(
			last,
			[
				{ path: ["children", `e${i}`], value: { id: i, tags: [] } },
				...(i ? [{ path: ["children", `e${i - 1}`, "seen"], value: true }] : []),
			] as Blop["patches"],
		)
		assertEquals(histories.add(next.b, next.n), "taken")
		line.push(next)
	}
	const value = side(histories, line.at(-1)!.n) as { children: Record<string, unknown> }
	assertEquals(Object.keys(value.children).length, 20)
	assertEquals(value.children.e3, { id: 3, tags: [], seen: true })
	// every blop encodes as it did: the history never changed
	for (const l of line) assertEquals(hex(encode(l.b)), hex(l.bytes))
})

Deno.test("apply: a fork after changes in place: each head's side its own", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	histories.add(r.b, r.n)
	const a = after(r, [{ path: ["children", "a"], value: 1 }])
	const b = after(a, [{ path: ["children", "b"], value: 2 }])
	histories.add(a.b, a.n), histories.add(b.b, b.n)
	// two children of b: the second's base is no longer the only head
	const x = after(b, [{ path: ["children", "x"], value: 3 }])
	const y = after(b, [{ path: ["children", "y"], value: 4 }])
	assertEquals(histories.add(x.b, x.n), "taken")
	assertEquals(histories.add(y.b, y.n), "taken")
	assertEquals(side(histories, x.n), { children: { a: 1, b: 2, x: 3 } })
	assertEquals(side(histories, y.n), { children: { a: 1, b: 2, y: 4 } })
	// one more on x: two heads, so copied, and y's side is untouched
	const z = after(x, [{ path: ["children", "a"], value: 9 }])
	assertEquals(histories.add(z.b, z.n), "taken")
	assertEquals(side(histories, z.n), { children: { a: 9, b: 2, x: 3 } })
	assertEquals(side(histories, y.n), { children: { a: 1, b: 2, y: 4 } })
})

Deno.test("apply: a patch that does not apply leaves the side as it was", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	histories.add(r.b, r.n)
	const a = after(r, [{ path: ["children", "a"], value: 1 }])
	histories.add(a.b, a.n)
	const bad = after(
		a,
		[
			{ path: ["children", "b"], value: 2 },
			{ path: ["children", "nope", "deeper"], value: 3 },
		] as Blop["patches"],
	)
	assertEquals(histories.add(bad.b, bad.n), { refused: "patches" })
	assertEquals(side(histories, a.n), { children: { a: 1 } })
	const good = after(a, [{ path: ["children", "c"], value: 3 }])
	assertEquals(histories.add(good.b, good.n), "taken")
	assertEquals(side(histories, good.n), { children: { a: 1, c: 3 } })
})

Deno.test("apply: a side handed out before going in place is the copy it was", () => {
	const histories = createHistories("n", check)
	const r = named(make())
	histories.add(r.b, r.n)
	// the root's side is its blop's own value until the first change in place copies it
	const first = side(histories, r.n)
	const a = after(r, [{ path: ["children", "a"], value: 1 }])
	histories.add(a.b, a.n)
	assertEquals(first, { children: {} })
	assertEquals(hex(encode(r.b)), hex(r.bytes))
})
