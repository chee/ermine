// Writes the chain scenarios to newcore/sync/conformance/chain/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/chain/fixtures.ts
// A scenario: {title, steps: [{request, expect}]}, one session, the requests in order
// (harness.ts has the protocol). Every expected answer is worked out by hand from CHAIN.tex and
// written here by label; the only thing computed is each blop's name (blop.ts, BLOP.tex), and,
// where the agreed order falls to names, which of two is the greater (desc). chain.ts is never
// imported.
import { encode, name } from "../../encoding/ts/blop.ts"
import { toJson } from "../pack/form.ts"

const out = new URL("../../sync/conformance/chain/", import.meta.url)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

type Object = "value" | ["info", string] | ["children", string]
type B = { blop: Record<string, unknown>; name: string; bytes: Uint8Array; lamport: number }
type Make = {
	object?: Object
	parents?: B[]
	base?: B
	combine?: true
	lamport?: number
	patches?: unknown[]
	node?: string
}

let count = 0
// a blop: node "n", the object "value", lamport one more than its parents' highest (1 with
// none), base the first parent when there are two or more, unless given; each its own nonce
function mk(m: Make = {}): B {
	count++
	const parents = [...(m.parents ?? [])].sort((a, b) => a.name < b.name ? -1 : 1)
	const lamport = m.lamport ??
		(parents.length ? Math.max(...parents.map((p) => p.lamport)) + 1 : 1)
	const blop: Record<string, unknown> = {
		node: m.node ?? "n",
		object: m.object ?? "value",
		actor: "a",
		signer: new Uint8Array(32).fill(1),
		nonce: Uint8Array.from({ length: 8 }, (_, i) => (count >> (8 * i)) & 0xff),
		parents: parents.map((p) => p.bytes),
		lamport,
		patches: m.patches ?? [],
	}
	if (parents.length >= 2) blop.base = (m.base ?? parents[0]).bytes
	if (m.combine) blop.combine = true
	const bytes = name(encode(blop as never))
	return { blop, name: hex(bytes), bytes, lamport }
}

// the JSON form: byte fields as ArrayBuffers (form.ts)
const buf = (u: Uint8Array) => u.slice().buffer
function form(b: B): unknown {
	const o: Record<string, unknown> = { ...b.blop }
	o.signer = buf(o.signer as Uint8Array)
	o.nonce = buf(o.nonce as Uint8Array)
	o.parents = (o.parents as Uint8Array[]).map(buf)
	if (o.base) o.base = buf(o.base as Uint8Array)
	return toJson(o)
}

const byName = (bs: B[]) => [...bs].sort((a, b) => a.name < b.name ? -1 : 1)
const names = (bs: B[]) => byName(bs).map((b) => b.name)
// of blops equal in lamport, the agreed order: the greater name first
const desc = (...bs: B[]) => byName(bs).reverse()

type Step = { request: Record<string, unknown>; expect: unknown }
const create = (): Step => ({ request: { op: "create", node: "n" }, expect: {} })
const add = (b: B, expect: unknown): Step => ({
	request: { op: "add", blop: form(b), name: b.name },
	expect,
})
const taken = (b: B) => add(b, "taken")
const passed = (b: B) => add(b, "passed")
const waits = (b: B, ...on: B[]) => add(b, { waiting: names(on) })
const stuck = (b: B, ...on: B[]) => add(b, { stuck: names(on) })
const refuses = (b: B, code: string) => add(b, { refused: code })
const heads = (object: Object, ...bs: B[]): Step => ({
	request: { op: "heads", object },
	expect: bs.map((b) => ({ name: b.name, blop: form(b) })),
})
const has = (b: B): Step => ({ request: { op: "get", name: b.name }, expect: { blop: form(b) } })
const hasnt = (b: B): Step => ({ request: { op: "get", name: b.name }, expect: {} })
const waiting = (...ws: [B, B[]][]): Step => ({
	request: { op: "waiting" },
	expect: ws.sort((a, b) => a[0].name < b[0].name ? -1 : 1).map(([b, on]) => ({
		name: b.name,
		waiting: names(on),
	})),
})
type Out = [B, string] | [B, B[]]
const refused = (...rs: Out[]): Step => ({
	request: { op: "refused" },
	expect: rs.sort((a, b) => a[0].name < b[0].name ? -1 : 1).map(([b, why]) =>
		typeof why === "string" ? { name: b.name, refused: why } : { name: b.name, stuck: names(why) }
	),
})
const checked = (...bs: B[]): Step => ({
	request: { op: "checked" },
	expect: bs.map((b) => b.name),
})

const all: { name: string; scenario: unknown }[] = []
const scenario = (name: string, title: string, steps: Step[]) =>
	all.push({ name, scenario: { title, steps: [create(), ...steps] } })

const INFO: Object = ["info", "t"]
const put = (value: unknown) => [{ path: [], value }]

// ---- empty
{
	const P = mk()
	scenario("empty", "empty: no heads, nothing to get, nothing waiting or refused", [
		heads("value"),
		heads(INFO),
		hasnt(P),
		waiting(),
		refused(),
	])
}

// ---- one root
{
	const R = mk({ patches: put({ a: 1 }) })
	scenario("one-root", "one root: taken in, the only head", [
		taken(R),
		heads("value", R),
		has(R),
		waiting(),
		refused(),
	])
}

// ---- a line
{
	const R = mk()
	const A = mk({ parents: [R] })
	const B = mk({ parents: [A] })
	scenario("line", "a line: each taken in, the last the one head", [
		taken(R),
		heads("value", R),
		taken(A),
		taken(B),
		heads("value", B),
		has(R),
		has(A),
		has(B),
	])
}

// ---- concurrent heads, the agreed order
{
	const R = mk()
	const X = mk({ parents: [R] })
	const Y = mk({ parents: [R] })
	const Z = mk({ parents: [Y] })
	const M = mk({ parents: [X, Z], base: Z })
	scenario(
		"concurrent-heads",
		"two heads: higher lamport first; equal lamport, the greater name first; a merge one head",
		[
			taken(R),
			taken(X),
			taken(Y),
			heads("value", ...desc(X, Y)),
			taken(Z),
			heads("value", Z, X),
			taken(M),
			heads("value", M),
		],
	)
}

// ---- passed over
{
	const R = mk()
	const A = mk({ parents: [R] })
	scenario("passed-over", "a name taken in, added again: passed", [
		taken(R),
		passed(R),
		taken(A),
		passed(A),
		passed(R),
		heads("value", A),
		waiting(),
		refused(),
	])
}

// ---- wrong node
{
	const R = mk({ node: "other" })
	const P = mk()
	const W = mk({ node: "other", parents: [P] })
	const G = mk()
	const C = mk({ node: "other", parents: [G] })
	const K = mk({ parents: [R] })
	scenario(
		"wrong-node",
		"node not this one: refused node, before waiting (step 2 before 4); its child stuck",
		[
			refuses(R, "node"),
			refuses(W, "node"),
			taken(G),
			refuses(C, "node"),
			stuck(K, R),
			heads("value", G),
			hasnt(R),
			hasnt(C),
			waiting(),
			refused([R, "node"], [W, "node"], [C, "node"], [K, [R]]),
		],
	)
}

// ---- waiting, then woken
{
	const R = mk()
	const A = mk({ parents: [R] })
	const B = mk({ parents: [A] })
	scenario(
		"waiting-woken",
		"a parent not added: waiting, also on a parent itself waiting; woken when it is taken in",
		[
			waits(B, A),
			waits(A, R),
			waiting([A, [R]], [B, [A]]),
			hasnt(A),
			hasnt(B),
			heads("value"),
			taken(R),
			waiting(),
			heads("value", B),
			has(A),
			has(B),
			refused(),
		],
	)
}

// ---- woken in the agreed order, with cascades
{
	const R = mk()
	const Y1 = mk({ parents: [R] })
	const Y = mk({ parents: [Y1] }) // 3
	const X = mk({ parents: [R] }) // 2
	const W4 = mk({ parents: [X, Y], base: Y }) // 4
	const [Whi, Wlo] = desc(mk({ parents: [X] }), mk({ parents: [X] })) // 3, 3
	const W3 = mk({ parents: [Wlo] }) // 4
	scenario(
		"woken-agreed-order",
		"blops waiting on one taken in: added again in the agreed order (lamport, then the greater " +
			"name), and what that takes in wakes its own (check's calls show the order)",
		[
			taken(R),
			taken(Y1),
			taken(Y),
			checked(R, Y1, Y),
			waits(W3, Wlo),
			waits(Wlo, X),
			waits(Whi, X),
			waits(W4, X),
			waiting([W3, [Wlo]], [Wlo, [X]], [Whi, [X]], [W4, [X]]),
			checked(),
			taken(X),
			checked(X, W4, Whi, Wlo, W3),
			waiting(),
			heads("value", ...desc(W4, W3), Whi),
		],
	)
}

// ---- a parent in another chain
{
	const R = mk()
	const I = mk({ object: INFO })
	const C = mk({ object: INFO, parents: [R] })
	const D = mk({ parents: [I] })
	const P = mk({ parents: [R] })
	const E = mk({ object: ["children", "k"], parents: [P] })
	scenario(
		"other-chain",
		"a parent taken in to another chain of this node: refused chain; also after waiting on it",
		[
			taken(R),
			taken(I),
			refuses(C, "chain"),
			refuses(D, "chain"),
			waits(E, P),
			taken(P),
			waiting(),
			refused([C, "chain"], [D, "chain"], [E, "chain"]),
			heads("value", P),
			heads(INFO, I),
			heads(["children", "k"]),
			hasnt(E),
		],
	)
}

// ---- bad lamport
{
	const R = mk({ lamport: 2 })
	const R1 = mk()
	const A = mk({ parents: [R1], lamport: 3 })
	const A2 = mk({ parents: [R1], lamport: 1 })
	const B = mk({ parents: [R1] })
	const M = mk({ parents: [R1, B], base: B, lamport: 2 })
	const M2 = mk({ parents: [R1, B], base: B }) // 3
	const P = mk()
	const L = mk({ parents: [P], lamport: 7 })
	const Q = mk({ object: INFO, parents: [R1], lamport: 9 })
	scenario(
		"lamport",
		"lamport not one more than its parents' highest, or 1 with none: refused lamport; " +
			"waiting and chain come first",
		[
			refuses(R, "lamport"),
			taken(R1),
			refuses(A, "lamport"),
			refuses(A2, "lamport"),
			taken(B),
			refuses(M, "lamport"),
			taken(M2),
			waits(L, P),
			refuses(Q, "chain"),
			heads("value", M2),
			heads(INFO),
			waiting([L, [P]]),
			refused([R, "lamport"], [A, "lamport"], [A2, "lamport"], [M, "lamport"], [Q, "chain"]),
		],
	)
}

// ---- patches
{
	const R = mk({ patches: put({ a: 1 }) })
	const A = mk({ parents: [R], patches: [{ path: ["a"], value: 2 }] })
	const Bad = mk({ parents: [R], patches: [{ path: ["b", "c"], value: 1 }] })
	const Root0 = mk({ patches: [{ path: ["a"], value: 1 }] })
	const S = mk({ parents: [R], patches: put("x") })
	const J = mk({ parents: [A, S], base: A, patches: [{ path: ["a"], value: 3 }] })
	const J2 = mk({ parents: [A, S], base: S, patches: [{ path: ["a"], value: 3 }] })
	const Jc = mk({ parents: [A, S], base: A, combine: true, patches: [{ path: ["a"], value: 4 }] })
	const Bad2 = mk({ parents: [R], lamport: 5, patches: [{ path: ["b", "c"], value: 1 }] })
	scenario(
		"patches",
		"patches applied to the base's side: refused patches when they do not apply; " +
			"lamport comes first",
		[
			taken(R),
			taken(A),
			refuses(Bad, "patches"),
			refuses(Root0, "patches"),
			taken(S),
			taken(J),
			refuses(J2, "patches"),
			taken(Jc),
			refuses(Bad2, "lamport"),
			heads("value", ...desc(J, Jc)),
			hasnt(J2),
			refused([Bad, "patches"], [Root0, "patches"], [J2, "patches"], [Bad2, "lamport"]),
		],
	)
}

// ---- refused parent: stuck
{
	const R = mk({ lamport: 2 }) // refused
	const C = mk({ parents: [R] }) // 3
	const D = mk({ parents: [C] })
	const P = mk()
	const E = mk({ parents: [R, P] })
	const F = mk({ node: "other", parents: [R] })
	scenario(
		"stuck",
		"a parent refused or stuck: stuck, before waiting (step 3 before 4); node comes first",
		[
			refuses(R, "lamport"),
			stuck(C, R),
			stuck(D, C),
			stuck(E, R),
			refuses(F, "node"),
			heads("value"),
			hasnt(C),
			waiting(),
			refused([R, "lamport"], [C, [R]], [D, [C]], [E, [R]], [F, "node"]),
		],
	)
}

// ---- a waiter whose parent arrives refused
{
	const R = mk()
	const A = mk({ parents: [R], patches: [{ path: ["z", "q"], value: 1 }] })
	const C = mk({ parents: [A] })
	const D = mk({ parents: [C] })
	scenario(
		"waiter-stuck",
		"waiting on a parent that arrives refused: added again, stuck; and what waits on it, stuck",
		[
			taken(R),
			waits(C, A),
			waits(D, C),
			waiting([C, [A]], [D, [C]]),
			refuses(A, "patches"),
			waiting(),
			refused([A, "patches"], [C, [A]], [D, [C]]),
			heads("value", R),
			hasnt(C),
			hasnt(D),
		],
	)
}

// ---- stuck lists every refused or stuck parent, whatever the order
{
	const R = mk()
	const A = mk({ parents: [R], lamport: 3 }) // refused lamport
	const B = mk({ parents: [R], patches: [{ path: ["q", "r"], value: 1 }] }) // refused patches
	const C = mk({ parents: [A, B], base: A }) // 4
	const D = mk({ parents: [C] })
	const end = [
		waiting(),
		refused([A, "lamport"], [B, "patches"], [C, [A, B]], [D, [C]]),
		heads("value", R),
	]
	scenario(
		"stuck-order-1",
		"stuck: refused() names every refused or stuck parent (parents first)",
		[taken(R), refuses(A, "lamport"), refuses(B, "patches"), stuck(C, A, B), stuck(D, C), ...end],
	)
	scenario(
		"stuck-order-2",
		"stuck: refused() names every refused or stuck parent, the same blops children first",
		[
			waits(D, C),
			waits(C, A, B),
			taken(R),
			refuses(A, "lamport"),
			waiting(),
			refuses(B, "patches"),
			...end,
		],
	)
}

// ---- added again: checked again
{
	const R = mk()
	const A = mk({ parents: [R], lamport: 5 }) // refused lamport
	const P = mk({ parents: [R] })
	const W = mk({ parents: [P] })
	const C = mk({ parents: [A] })
	const B = mk({ parents: [R], patches: [{ path: ["q"], value: 1 }] }) // refused patches
	const X = mk({ parents: [A, B], base: B, lamport: 6 })
	scenario(
		"added-again",
		"a name waiting, refused or stuck, added again: checked again from the start",
		[
			taken(R),
			refuses(A, "lamport"),
			refuses(A, "lamport"),
			waits(W, P),
			waits(W, P),
			stuck(C, A),
			stuck(C, A),
			stuck(X, A),
			refuses(B, "patches"),
			stuck(X, A, B),
			refuses(B, "patches"),
			taken(P),
			passed(W),
			waiting(),
			heads("value", W),
			refused([A, "lamport"], [B, "patches"], [C, [A]], [X, [A, B]]),
		],
	)
}

// ---- heads of an object with none
{
	const R = mk()
	scenario("no-heads", "heads of an object with no blops: []", [
		taken(R),
		heads(INFO),
		heads(["children", "t"]),
		heads(["info", "other"]),
		heads("value", R),
	])
}

// ---- objects by value
{
	const I1 = mk({ object: ["info", "t"] })
	const I2 = mk({ object: ["info", "t"], parents: [I1] })
	const K = mk({ object: ["children", "t"], parents: [I1] })
	const U = mk({ object: ["info", "u"], parents: [I2] })
	scenario(
		"objects-by-value",
		"info and children objects told apart by value, never by identity",
		[
			taken(I1),
			taken(I2),
			heads(["info", "t"], I2),
			refuses(K, "chain"),
			refuses(U, "chain"),
			heads(["children", "t"]),
			heads(["info", "u"]),
			refused([K, "chain"], [U, "chain"]),
		],
	)
}

// ---- heads: only blops taken in
{
	const R = mk()
	const A = mk({ parents: [R] })
	const P = mk()
	const S = mk({ parents: [A, P], base: A }) // waits on P
	const T = mk({ parents: [A], patches: [{ path: ["x"], value: 1 }] }) // refused
	const Rf = mk({ lamport: 3 }) // refused
	const U = mk({ parents: [A, Rf], base: A }) // stuck
	scenario(
		"heads-taken-only",
		"a blop waiting, refused or stuck is no part of the chain: its parents stay heads",
		[
			taken(R),
			taken(A),
			waits(S, P),
			refuses(T, "patches"),
			refuses(Rf, "lamport"),
			stuck(U, Rf),
			heads("value", A),
		],
	)
}

// ---- write
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
all.forEach(({ name, scenario }, i) => {
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	Deno.writeTextFileSync(new URL(file, out), JSON.stringify(scenario, null, "\t") + "\n")
})
console.log(`${all.length} scenarios`)
