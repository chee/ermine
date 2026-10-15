import { assertEquals, assertThrows } from "@std/assert"
import { type Blop, encode, name } from "@ermine/encoding/blop"
import { Stand } from "@ermine/encoding/cbor"
import { check, side, versions } from "./apply.ts"
import { createHistories } from "./history.ts"
import { commit, CommitError } from "./commit.ts"

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
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const random = () => new Uint8Array(8).fill(9)
const change = (more = {}) => ({
	node: "n",
	object: "value" as const,
	patches: [{ path: ["a"], value: 2 }],
	header: { time: 5, actor: "me" },
	signer: new Uint8Array(32).fill(7),
	...more,
})

Deno.test("versions: the heads with a side, the caller's time, sync's because", () => {
	const histories = createHistories("n", check)
	const r = make()
	const n = name(encode(r))
	histories.add(r, n)
	assertEquals(versions(histories, "value", () => 12), [{
		content: { a: 1 },
		change: { time: 12, actor: "a" },
		because: {
			layer: "sync",
			place: { lamport: 1, name: hex(n) },
			why: { signer: hex(r.signer) },
		},
	}])
	assertEquals(versions(histories, ["info", "t"], () => 0), [])
})

Deno.test("commit: at version 0 along a line, parents its head", () => {
	const histories = createHistories("n", check)
	const r = make()
	histories.add(r, name(encode(r)))
	const b = commit(histories, change(), 0, [], random)
	assertEquals(b.parents, [name(encode(r))])
	assertEquals(b.lamport, 2)
	assertEquals(b.base, undefined)
	assertEquals(b.nonce, random())
})

Deno.test("commit: a span merges, a pop chooses, nothing is range", () => {
	const histories = createHistories("n", check)
	const r = make(), s = make({ patches: [{ path: [], value: { a: 5 } }] })
	histories.add(r, name(encode(r)))
	histories.add(s, name(encode(s)))
	const merged = commit(histories, change(), [0, 2], [], random)
	assertEquals([merged.combine, merged.parents.length, merged.lamport], [true, 2, 2])
	const popped = commit(histories, change(), { pop: 0 }, [], random)
	assertEquals([popped.combine, popped.patches, popped.parents.length], [undefined, [], 2])
	assertThrows(() => commit(histories, change(), [1, 1], [], random), CommitError)
	assertThrows(() => commit(histories, change(), { pop: [2, 2] }, [], random), CommitError)
	assertThrows(() => commit(histories, change(), 2, [], random), CommitError)
})

Deno.test("commit: a site made shareable", () => {
	const histories = createHistories("n", check)
	const at = (file: string, roots: string[]) =>
		commit(
			histories,
			change({ header: { time: 1, actor: "me", external: [{ file, line: 1 }] } }),
			0,
			roots,
			random,
		)
			.site?.file
	assertEquals(at("/w/proj/src/a.ts", ["/w", "/w/proj"]), "src/a.ts")
	assertEquals(at("/w/project/a.ts", ["/w/proj"]), "a.ts")
	assertEquals(at("C:\\w\\a.ts", ["C:\\w"]), "a.ts")
	assertEquals(at("https://x.org/a.ts", ["/w"]), "https://x.org/a.ts")
})

class Canvas {
	constructor(readonly url: string) {}
}

Deno.test("commit: live values in patches, actor and cause are stand-ins over the host's kind", () => {
	const histories = createHistories("n", check)
	const live = Symbol("s"), canvas = new Canvas("c")
	const kind = (x: unknown) => x instanceof Canvas ? x.url : typeof x
	const c = change({
		patches: [{ path: [], value: { c: canvas, f: () => 1, list: [live, new Map()], n: 1 } }],
		header: { time: 5, actor: canvas, metadata: [["cause", { by: live }]] },
	})
	const b = commit(histories, c, 0, [], random, kind)
	assertEquals(b.patches, [{
		path: [],
		value: {
			c: new Stand("c"),
			f: new Stand("function"),
			list: [new Stand("symbol"), new Stand("object")],
			n: 1,
		},
	}])
	assertEquals(b.actor, new Stand("c"))
	assertEquals(b.cause, { by: new Stand("symbol") })
	// no kind given: null; and a patch holding none is the same patch
	const bare = commit(histories, change({ patches: [{ path: [], value: canvas }] }), 0, [], random)
	assertEquals(bare.patches, [{ path: [], value: new Stand(null) }])
	const plain = change()
	assertEquals(commit(histories, plain, 0, [], random, kind).patches, plain.patches)
	// the blop encodes, so it can be taken in and sealed
	assertEquals(typeof name(encode(b)).length, "number")
})

Deno.test("apply: a stand-in in a side is data", () => {
	const histories = createHistories("n", check)
	const r = make({
		patches: [{ path: [], value: { c: new Stand("c"), d: new Stand("other"), n: 1 } }],
	})
	const n = name(encode(r))
	histories.add(r, n)
	assertEquals(side(histories, n), { c: new Stand("c"), d: new Stand("other"), n: 1 })
	assertEquals(versions(histories, "value", () => 0)[0].content, side(histories, n))
})
