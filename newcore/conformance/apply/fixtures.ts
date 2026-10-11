// Writes the apply scenarios to newcore/sync/conformance/apply/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/apply/fixtures.ts
// Each scenario one session (session.ts has the protocol). Sides, versions and add's answers are
// written by hand from APPLY.tex and CHAIN.tex; model.ts checks the versions against a small
// model built on mutate.ts. apply.ts is never imported.
import { Stand } from "../../encoding/ts/cbor.ts"
import {
	add,
	type B,
	create,
	desc,
	mk,
	none,
	put,
	removal,
	scenario,
	set,
	sideStep as side,
	versionsStep as versions,
	type Which,
	write,
} from "./model.ts"

const INFO: Which = ["info", "title"]
const LIST: Which = ["children", "kids"]

// ---- a root
{
	const A = mk({ patches: put({ a: 1 }) })
	scenario("root", "a root's side: its patches on an object with no versions", [
		create(),
		add(A),
		side(A, { a: 1 }),
		versions([A], "value", [[A, { a: 1 }]]),
	])
}

// ---- a root with no patches: nothing there, no side
{
	const A = mk()
	scenario("root-no-patches", "a root with no patches: no versions made, no side", [
		create(),
		add(A),
		side(A, none),
		versions([A], "value", []),
	])
}

// ---- along a line
{
	const A = mk({ patches: put({ n: 1 }) })
	const B = mk({ parents: [A], patches: set(["n"], 2) })
	const C = mk({ parents: [B], patches: [...set(["m"], 3), { path: ["n"] }] })
	scenario("line", "along a line: each side the one parent's side, patched; one version", [
		create(),
		add(A),
		add(B),
		add(C),
		side(A, { n: 1 }),
		side(B, { n: 2 }),
		side(C, { m: 3 }),
		versions([A, B, C], "value", [[C, { m: 3 }]]),
	])
}

// ---- a line, added out of order
{
	const A = mk({ patches: put("ab") })
	const B = mk({ parents: [A], patches: [{ path: [], range: [1, 1], value: "x" }] })
	scenario("line-woken", "a blop waiting for its parent: its side once both are taken in", [
		create(),
		add(B, { waiting: [A.name] }),
		side(B, none),
		add(A),
		side(B, "axb"),
		versions([A, B], "value", [[B, "axb"]]),
	])
}

// ---- a merge, choosing its base
{
	const A = mk({ patches: put({ x: 0 }) })
	const B = mk({ parents: [A], patches: set(["x"], 1) })
	const C = mk({ parents: [A], patches: set(["y"], 2) })
	for (const [base, content] of [[B, { x: 1, z: 3 }], [C, { x: 0, y: 2, z: 3 }]] as const) {
		const D = mk({ parents: [B, C], base, patches: set(["z"], 3) })
		const which = base === B ? "b" : "c"
		scenario(
			`merge-base-${which}`,
			`two parents, base ${which}: the patches on the base's side; the other parent unread`,
			[
				create(),
				add(A),
				add(B),
				add(C),
				versions(
					[A, B, C],
					"value",
					desc(B, C).map((h) => [h, h === B ? { x: 1 } : { x: 0, y: 2 }]),
				),
				add(D),
				side(D, content),
				versions([A, B, C, D], "value", [[D, content]]),
			],
		)
	}
}

// ---- combine
{
	const A = mk({ patches: put({ x: 0 }) })
	const B = mk({ parents: [A], patches: set(["x"], 1) })
	const C = mk({ parents: [A], patches: set(["y"], 2) })
	const D = mk({ parents: [B, C], base: B, combine: true, patches: set(["y"], 2) })
	scenario("combine", "combine: the side its patches on base's side make, as carried", [
		create(),
		add(A),
		add(B),
		add(C),
		add(D),
		side(D, { x: 1, y: 2 }),
		versions([A, B, C, D], "value", [[D, { x: 1, y: 2 }]]),
	])
}

// ---- combine of three
{
	const A = mk({ patches: put([]) })
	const B = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["b"] }] })
	const C = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["c"] }] })
	const D = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["d"] }] })
	const M = mk({
		parents: [B, C, D],
		base: C,
		combine: true,
		patches: [{ path: [], range: [0, 1], value: ["b", "c", "d"] }],
	})
	scenario("combine-three", "combine of three parents, base the middle: its patches on it", [
		create(),
		add(A),
		add(B),
		add(C),
		add(D),
		add(M),
		side(M, ["b", "c", "d"]),
		versions([A, B, C, D, M], "value", [[M, ["b", "c", "d"]]]),
	])
}

// ---- refused: a root not a put
{
	const A = mk({ patches: set(["a"], 1) })
	scenario("refused-no-key", "a root patching into nothing: mutate's no-key, refused patches", [
		create(),
		add(A, { refused: "patches" }),
		side(A, none),
		versions([], "value", []),
	])
}

// ---- refused along a line
{
	const A = mk({ patches: put(5) })
	const B = mk({ parents: [A], patches: set(["a"], 1) })
	const C = mk({ parents: [A], patches: [{ path: [], range: [2, 9], value: "x" }] })
	const D = mk({ parents: [A], patches: [{ path: [], move: { path: [] } }] })
	scenario(
		"refused-line",
		"patches that do not apply to the base's side: refused patches; the parent stays the head",
		[
			create(),
			add(A),
			add(B, { refused: "patches" }),
			add(C, { refused: "patches" }),
			add(D),
			side(B, none),
			side(C, none),
			versions([A, D], "value", [[D, 5]]),
		],
	)
}

// ---- refused range on a string
{
	const A = mk({ patches: put("abc") })
	const B = mk({ parents: [A], patches: [{ path: [], range: [2, 5] }] })
	scenario("refused-range", "a range past the string: refused patches", [
		create(),
		add(A),
		add(B, { refused: "patches" }),
		versions([A], "value", [[A, "abc"]]),
	])
}

// ---- refused: the second patch fails, so the whole blop does
{
	const A = mk({ patches: put({ a: 1 }) })
	const B = mk({ parents: [A], patches: [...set(["b"], 2), ...set(["a", "c"], 3)] })
	scenario("refused-second-patch", "the first patch applies, the second not: refused whole", [
		create(),
		add(A),
		add(B, { refused: "patches" }),
		side(A, { a: 1 }),
		versions([A], "value", [[A, { a: 1 }]]),
	])
}

// ---- waiters stuck behind refused patches
{
	const A = mk({ patches: put({}) })
	const B = mk({ parents: [A], patches: set(["a", "b"], 1) })
	const C = mk({ parents: [B], patches: set(["c"], 1) })
	scenario(
		"refused-waiters-stuck",
		"a blop waiting on one refused for its patches: stuck, no side, no version",
		[
			create(),
			add(A),
			add(C, { waiting: [B.name] }),
			add(B, { refused: "patches" }),
			add(C, { stuck: [B.name] }),
			side(C, none),
			versions([A], "value", [[A, {}]]),
		],
	)
}

// ---- emptied: the only head
{
	const A = mk({ patches: put({ v: 0 }) })
	const B = mk({ parents: [A], patches: removal })
	scenario("emptied", "a removal at []: no side; the only head gives no version", [
		create(),
		add(A),
		add(B),
		side(B, none),
		versions([A, B], "value", []),
	])
}

// ---- emptied, racing heads with sides
{
	const A = mk({ patches: put({ v: 0 }) })
	const B = mk({ parents: [A], patches: removal })
	const C = mk({ parents: [A], patches: set(["v"], 1) })
	const D = mk({ parents: [A], patches: set(["v"], 2) })
	const hand = desc(B, C, D).filter((h) => h !== B).map((h): [B, unknown] => [
		h,
		h === C ? { v: 1 } : { v: 2 },
	])
	scenario(
		"emptied-racing",
		"three heads of one lamport, one emptied: it gives no version, the others in agreed order",
		[create(), add(A), add(B), add(C), add(D), versions([A, B, C, D], "value", hand)],
	)
}

// ---- after an emptied blop, a put starts again
{
	const A = mk({ patches: put({ v: 0 }) })
	const B = mk({ parents: [A], patches: removal })
	const C = mk({ parents: [B], patches: put({ again: 1 }) })
	const D = mk({ parents: [B], patches: set(["v"], 1) })
	scenario(
		"emptied-again",
		"a base with no side: patches on an object with no versions; a put makes one, else refused",
		[
			create(),
			add(A),
			add(B),
			add(C),
			add(D, { refused: "patches" }),
			side(C, { again: 1 }),
			versions([A, B, C], "value", [[C, { again: 1 }]]),
		],
	)
}

// ---- a list emptied
{
	const A = mk({ object: LIST, patches: put(["x", "y"]) })
	const B = mk({ object: LIST, parents: [A], patches: [{ path: [], range: [0, 2] }] })
	const C = mk({ object: LIST, patches: [{ path: [], range: [0, 0], value: ["z"] }] })
	scenario("list", "children: a list starts as []; a list left with nothing has no side", [
		create(),
		add(A),
		add(C),
		side(A, ["x", "y"]),
		side(C, ["z"]),
		add(B),
		side(B, none),
		versions([A, B, C], LIST, [[C, ["z"]]]),
	])
}

// ---- objects apart
{
	const V = mk({ patches: put("v") })
	const I = mk({ object: INFO, patches: put("t") })
	const J = mk({ object: INFO, parents: [I], patches: put("u") })
	scenario("objects", "each object its own chain and versions; an object with none: []", [
		create(),
		add(V),
		add(I),
		add(J),
		versions([V, I, J], "value", [[V, "v"]]),
		versions([V, I, J], INFO, [[J, "u"]]),
		versions([V, I, J], ["info", "other"], []),
		versions([V, I, J], LIST, []),
	])
}

// ---- the agreed order
{
	const R1 = mk({ patches: put(1) })
	const R2 = mk({ patches: put(2) })
	const R3 = mk({ patches: put(3) })
	const S = mk({ parents: [R1], patches: put(4) })
	const T = mk({ parents: [S], patches: put(5) })
	const rest = desc(R2, R3).map((h): [B, unknown] => [h, h === R2 ? 2 : 3])
	scenario("order", "versions in the agreed order: higher lamport first; equal, greater name", [
		create(),
		add(R1),
		add(R2),
		add(R3),
		versions(
			[R1, R2, R3],
			"value",
			desc(R1, R2, R3).map((h) => [h, h === R1 ? 1 : h === R2 ? 2 : 3]),
		),
		add(S),
		versions([R1, R2, R3, S], "value", [[S, 4], ...rest]),
		add(T),
		versions([R1, R2, R3, S, T], "value", [[T, 5], ...rest]),
	])
}

// ---- the change and the because
{
	const site = { file: "src/a.ts", line: 3, column: 7, function: "f" }
	const A = mk({
		patches: put("hi"),
		actor: { who: "w", trust: 2 },
		reader: "r",
		site,
		cause: { why: "because" },
		signer: new Uint8Array(32).fill(0xab),
	})
	const B = mk({ patches: put("bare"), actor: null })
	scenario(
		"header",
		"a version's change: the head's actor, reader, site, cause, and the caller's time; because sync's, {lamport, name}, {signer}",
		[
			create(),
			add(A),
			add(B),
			versions([A, B], "value", desc(A, B).map((h) => [h, h === A ? "hi" : "bare"])),
		],
	)
}

// ---- because names the head and its lamport
{
	const A = mk({ patches: put(0), signer: new Uint8Array(32).fill(2) })
	const B = mk({ parents: [A], patches: put(1), signer: new Uint8Array(32).fill(3) })
	scenario("because", "because: the head's lamport, name and signer, not its parent's", [
		create(),
		add(A),
		add(B),
		versions([A, B], "value", [[B, 1]]),
	])
}

// ---- side of a name not taken in
{
	const A = mk({ patches: put(0) })
	const W = mk({ parents: [A], patches: put(1) })
	scenario("side-unknown", "side of a name never added, or waiting: none", [
		create(),
		side(A, none),
		add(W, { waiting: [A.name] }),
		side(W, none),
	])
}

// ---- a stand-in in a side is kept as data (no live given)
{
	const kept = { canvas: new Stand("canvas"), shape: new Stand({ url: "x", w: 2 }), n: 1 }
	const A = mk({ patches: put(kept), actor: new Stand("device") })
	const B = mk({ parents: [A], patches: set(["n"], new Stand(null)) })
	const content = { ...kept, n: new Stand(null) }
	scenario(
		"stand-in-data",
		"a stand-in in an incoming blop's patches (or its actor) is held as data in the side: it comes back as it was, and patches go on past it",
		[
			create(),
			add(A),
			side(A, kept),
			add(B),
			side(B, content),
			versions([A, B], "value", [[B, content]]),
		],
	)
}

await write(new URL("../../sync/conformance/apply/", import.meta.url))
