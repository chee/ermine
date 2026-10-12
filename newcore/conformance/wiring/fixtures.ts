// Writes the wiring scenarios to newcore/sync/conformance/wiring/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/wiring/fixtures.ts
// A scenario: {title, steps: [{request, expect}]}, one session started by reset (harness.ts has
// the protocol). Every expected answer is worked out by hand from WIRING.tex, COMMIT.tex,
// APPLY.tex, CHAIN.tex and PLACES.tex and written here by label; the only things computed are each
// blop's name (blop.ts), the devices' keys, the ids (id.ts) and, where the agreed order falls to
// names, which of two is the greater. wiring.ts, the graph and the scheduler are never imported.
//
// Readings of WIRING.tex these scenarios rest on:
//   each version versions sets keeps its own blop's change and because, unwrapped; only the
//     change versions makes (what marked readers are given) has the cause wrapped
//     {sync: {signer, name}} (the blop's cause inside as cause: none here, no host change has
//     one), signer and name hex as APPLY.tex writes them;
//   a record per object changed, for every node, ermine:// or not; only documents and ephemeral
//     nodes make blops.
// A node in view on the receiver is put there as a setup step (created empty with its id): when
// and from where a node gets into view is not sync's business, and is never tested. The
// documents synced are followed as a setup step too (following every reachable ermine:// id is
// the rule; a second follow changes nothing). Skipped (skip: why): which layer's versions an
// object shows, open with the designer.
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { type Blop, encode, name as blopName } from "../../encoding/ts/blop.ts"
import { id } from "../../sync/ts/id.ts"
import { toJson } from "../pack/form.ts"

const out = new URL("../../sync/conformance/wiring/", import.meta.url)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const fill = (n: number, len = 32) => new Uint8Array(len).fill(n)
const range = (from: number) => Uint8Array.from({ length: 32 }, (_, i) => from + i)

// the root: ID.tex's vector; X: a node made with made range(0x40)
const DOC = id("unlocked", range(0x20))
const MADE = hex(range(0x40))
const X = id("unlocked", range(0x40))

// a device: its key, and how many blops it has made (its nonces: COMMIT.tex's random, harness.ts)
type Dev = { name: string; seed: Uint8Array; key: Uint8Array; k: number }
const dev = (name: string, n: number): Dev => {
	const seed = fill(n)
	return { name, seed, key: ed25519.getPublicKey(seed), k: 0 }
}
let A = dev("a", 1), B = dev("b", 2)
const fresh = () => {
	A = dev("a", 1), B = dev("b", 2)
}

type Which = "value" | ["info", string] | ["children", string]
type Patch = Record<string, unknown>

// a blop as COMMIT.tex makes it on by, next of its nonces; its name
type Made = { name: string; lamport: number; by: Dev; node: string }
function blop(
	by: Dev,
	node: string,
	object: Which,
	patches: Patch[],
	parents: Made[] = [],
	o: { base?: Made; combine?: true } = {},
): Made {
	const nonce = new Uint8Array(8)
	new DataView(nonce.buffer).setUint32(0, ++by.k)
	const lamport = 1 + Math.max(0, ...parents.map((p) => p.lamport))
	const b: Blop = {
		node,
		object,
		actor: by.name,
		signer: by.key,
		nonce,
		parents: parents.map((p) => p.name).sort().map(unhex),
		lamport,
		patches: patches as never,
	}
	if (o.base) b.base = unhex(o.base.name)
	if (o.combine) b.combine = true
	return { name: hex(blopName(encode(b))), lamport, by, node }
}

// the agreed order: higher lamport first; equal, the greater name
const agreed = (...bs: Made[]) =>
	[...bs].sort((x, y) =>
		x.lamport !== y.lamport ? y.lamport - x.lamport : x.name < y.name ? 1 : -1
	)

// a version as versions sets it (APPLY.tex, WIRING.tex In)
const version = (b: Made, content: unknown) => ({
	content: toJson(content),
	change: {
		node: b.node,
		actor: b.by.name,
	},
	because: {
		layer: "sync",
		place: { lamport: b.lamport, name: b.name },
		why: { signer: hex(b.by.key) },
	},
})

// a record (WIRING.tex Out); header without time
const record = (
	by: Dev,
	node: string,
	object: Which,
	patches: Patch[],
	at: unknown,
	ephemeral = false,
) => ({ node, object, patches: toJson(patches), header: { actor: by.name }, at, ephemeral })

// ---- steps
type Step = { request: Record<string, unknown>; expect: unknown }
const ok = (request: Record<string, unknown>): Step => ({ request, expect: {} })
const reset = () => ok({ op: "reset" })
const device = (d: Dev): Step => ({
	request: { op: "device", name: d.name, seed: hex(d.seed), root: DOC, actor: d.name },
	expect: { key: hex(d.key) },
})
const follow = (d: Dev, doc: string) => ok({ op: "follow", device: d.name, doc })
const link = (a: Dev, b: Dev) => ok({ op: "link", a: a.name, b: b.name })
const pump = () => ok({ op: "pump" })
const host = (d: Dev, op: string, args: Record<string, unknown>, expect: unknown = {}): Step => ({
	request: { op, device: d.name, ...args },
	expect,
})
const write = (d: Dev, patches: Patch[], slotindex?: unknown) =>
	host(d, "write", {
		address: [],
		patches: toJson(patches),
		...(slotindex === undefined ? {} : { slotindex }),
	})
const insert = (d: Dev, name: string, child: string) => host(d, "insert", { id: DOC, name, child })
const read = (d: Dev, node: string, object: Which, expect: unknown, only?: string[]): Step => ({
	request: { op: "read", device: d.name, id: node, object, ...(only ? { only } : {}) },
	expect,
})
const records = (d: Dev, expect: unknown[], o: { node?: string; only?: string[] } = {}): Step => ({
	request: { op: "records", device: d.name, ...o },
	expect,
})
const both = (node: string, object: Which, expect: unknown) => [
	read(A, node, object, expect),
	read(B, node, object, expect),
]
// two devices on the root, linked
const two = () => [reset(), device(A), device(B), link(A, B)]
// two devices on the root, apart
const apart = () => [reset(), device(A), device(B)]

const all: { name: string; title: string; steps: Step[]; skip?: string }[] = []
const scenario = (name: string, title: string, steps: () => Step[], skip?: string) => {
	fresh()
	all.push({ name, title, steps: steps(), ...(skip ? { skip } : {}) })
}

const notes: Which = ["children", "notes"]

// ---- each operation crosses
scenario(
	"write",
	"a write crosses: one record, at 0; both read one version, its header the blop's, cause wrapped; no echo",
	() => {
		const p = [{ path: [], value: 1 }]
		const w = blop(A, DOC, "value", p)
		return [
			...two(),
			write(A, p),
			pump(),
			records(A, [record(A, DOC, "value", p, 0)]),
			records(B, []),
			...both(DOC, "value", [version(w, 1)]),
		]
	},
)
scenario("set", "a set crosses: one record for that info, at 0", () => {
	const p = [{ path: [], value: "hi" }]
	const s = blop(A, DOC, ["info", "title"], p)
	return [
		...two(),
		host(A, "set", { address: [], name: "title", patches: p }),
		pump(),
		records(A, [record(A, DOC, ["info", "title"], p, 0)]),
		records(B, []),
		...both(DOC, ["info", "title"], [version(s, "hi")]),
	]
})
scenario("insert", "an insert crosses: one record for that list, at 0", () => {
	const p = [{ path: [], range: [0, 0], value: ["x"] }]
	const i = blop(A, DOC, notes, p)
	return [
		...two(),
		insert(A, "notes", "x"),
		pump(),
		records(A, [record(A, DOC, notes, p, 0)]),
		records(B, []),
		...both(DOC, notes, [version(i, ["x"])]),
	]
})
scenario("remove", "a remove crosses: the ids taken out, each change its own blop", () => {
	const p1 = [{ path: [], range: [0, 0], value: ["x"] }]
	const p2 = [{ path: [], range: [1, 1], value: ["y"] }]
	const p3 = [{ path: [], range: [0, 1] }]
	const i1 = blop(A, DOC, notes, p1)
	const i2 = blop(A, DOC, notes, p2, [i1])
	const r = blop(A, DOC, notes, p3, [i2])
	return [
		...two(),
		insert(A, "notes", "x"),
		insert(A, "notes", "y"),
		host(A, "remove", { id: DOC, name: "notes", index: 0 }),
		pump(),
		records(A, [
			record(A, DOC, notes, p1, 0),
			record(A, DOC, notes, p2, 0),
			record(A, DOC, notes, p3, 0),
		]),
		records(B, []),
		...both(DOC, notes, [version(r, ["y"])]),
	]
})
scenario(
	"pop",
	"a pop crosses: record {pop: 1}, patches []; the blop chooses the first kept, one version left",
	() => {
		const pa = [{ path: [], range: [0, 0], value: ["x"] }]
		const pb = [{ path: [], range: [0, 0], value: ["y"] }]
		const ax = blop(A, DOC, notes, pa), by = blop(B, DOC, notes, pb)
		const [first, second] = agreed(ax, by)
		const content = (b: Made) => (b === ax ? ["x"] : ["y"])
		const pop = blop(A, DOC, notes, [], [second, first], { base: first })
		return [
			...apart(),
			insert(A, "notes", "x"),
			insert(B, "notes", "y"),
			link(A, B),
			pump(),
			records(A, [record(A, DOC, notes, pa, 0)]),
			records(B, [record(B, DOC, notes, pb, 0)]),
			...both(DOC, notes, [version(first, content(first)), version(second, content(second))]),
			host(A, "pop", { id: DOC, name: "notes", slotindex: 1 }),
			pump(),
			records(A, [record(A, DOC, notes, [], { pop: 1 })]),
			records(B, []),
			...both(DOC, notes, [version(pop, content(first))]),
		]
	},
)
scenario(
	"rename",
	"a rename crosses: two records, the old name removed at [], each with the patches places made",
	() => {
		const p = [{ path: [], range: [0, 0], value: ["x"] }]
		const gone = [{ path: [] }], put = [{ path: [], range: [0, 0], value: ["x"] }]
		const i = blop(A, DOC, ["children", "old"], p)
		// the old name's removal: a's second nonce, before the new name's
		blop(A, DOC, ["children", "old"], gone, [i])
		const rn = blop(A, DOC, ["children", "new"], put)
		return [
			...two(),
			insert(A, "old", "x"),
			host(A, "rename", { id: DOC, name: "old", to: "new" }),
			pump(),
			records(A, [
				record(A, DOC, ["children", "old"], p, 0),
				record(A, DOC, ["children", "old"], gone, 0),
				record(A, DOC, ["children", "new"], put, 0),
			]),
			records(B, []),
			...both(DOC, ["children", "old"], []),
			...both(DOC, ["children", "new"], [version(rn, ["x"])]),
		]
	},
)
scenario(
	"rename-first-version",
	"a rename moves the first version only: the second stays under the old name, on both",
	() => {
		const pa = [{ path: [], range: [0, 0], value: ["x"] }]
		const pb = [{ path: [], range: [0, 0], value: ["y"] }]
		const ax = blop(A, DOC, ["children", "old"], pa)
		const by = blop(B, DOC, ["children", "old"], pb)
		const [first, second] = agreed(ax, by)
		const content = (b: Made) => (b === ax ? ["x"] : ["y"])
		// the old name's first version removed: a's nonce before the new name's
		blop(A, DOC, ["children", "old"], [{ path: [] }], [first])
		const rn = blop(A, DOC, ["children", "new"], [{
			path: [],
			range: [0, 0],
			value: content(first),
		}])
		return [
			...apart(),
			insert(A, "old", "x"),
			insert(B, "old", "y"),
			link(A, B),
			pump(),
			records(A, [record(A, DOC, ["children", "old"], pa, 0)]),
			host(A, "rename", { id: DOC, name: "old", to: "new" }),
			pump(),
			records(A, [
				record(A, DOC, ["children", "old"], [{ path: [] }], 0),
				record(A, DOC, ["children", "new"], [{
					path: [],
					range: [0, 0],
					value: content(first),
				}], 0),
			]),
			...both(DOC, ["children", "old"], [version(second, content(second))]),
			...both(DOC, ["children", "new"], [version(rn, content(first))]),
		]
	},
)
scenario("move-within", "a move within one list crosses: one record, its move patch", () => {
	const ps = ["x", "y", "z"].map((c, i) => [{ path: [], range: [i, i], value: [c] }])
	const i1 = blop(A, DOC, notes, ps[0])
	const i2 = blop(A, DOC, notes, ps[1], [i1])
	const i3 = blop(A, DOC, notes, ps[2], [i2])
	const mv = [{ path: [], range: [2, 2], move: { path: [0] } }]
	const m = blop(A, DOC, notes, mv, [i3])
	return [
		...two(),
		insert(A, "notes", "x"),
		insert(A, "notes", "y"),
		insert(A, "notes", "z"),
		records(A, ps.map((p) => record(A, DOC, notes, p, 0))),
		host(A, "move", { id: DOC, name: "notes", index: 0, toid: DOC, toname: "notes", toindex: 2 }),
		pump(),
		records(A, [record(A, DOC, notes, mv, 0)]),
		records(B, []),
		...both(DOC, notes, [version(m, ["y", "z", "x"])]),
	]
})
scenario("move-across", "a move across lists crosses: two records, a remove and an insert", () => {
	const p1 = [{ path: [], range: [0, 0], value: ["x"] }]
	const p2 = [{ path: [], range: [1, 1], value: ["y"] }]
	const cut = [{ path: [], range: [0, 1] }]
	const put = [{ path: [], range: [0, 0], value: ["x"] }]
	const done: Which = ["children", "done"]
	const i1 = blop(A, DOC, notes, p1)
	const i2 = blop(A, DOC, notes, p2, [i1])
	const r = blop(A, DOC, notes, cut, [i2])
	const d = blop(A, DOC, done, put)
	return [
		...two(),
		insert(A, "notes", "x"),
		insert(A, "notes", "y"),
		records(A, [record(A, DOC, notes, p1, 0), record(A, DOC, notes, p2, 0)]),
		host(A, "move", { id: DOC, name: "notes", index: 0, toid: DOC, toname: "done" }),
		pump(),
		records(A, [record(A, DOC, notes, cut, 0), record(A, DOC, done, put, 0)]),
		records(B, []),
		...both(DOC, notes, [version(r, ["y"])]),
		...both(DOC, done, [version(d, ["x"])]),
	]
})
scenario(
	"create",
	"a create gets an ermine:// id from the lock's make; its value crosses to where it is loaded",
	() => {
		const v = [{ path: [], value: "hello" }]
		const c = blop(A, X, "value", v)
		const ip = [{ path: [], range: [0, 0], value: [X] }]
		const i = blop(A, DOC, notes, ip)
		return [
			...apart(),
			host(B, "create", { id: X }, { id: X }),
			follow(A, X),
			follow(B, X),
			host(A, "create", { value: "hello", made: MADE }, { id: X }),
			insert(A, "notes", X),
			link(A, B),
			pump(),
			records(A, [record(A, X, "value", v, 0), record(A, DOC, notes, ip, 0)]),
			records(B, []),
			...both(X, "value", [version(c, "hello")]),
			...both(DOC, notes, [version(i, [X])]),
		]
	},
)

// ---- concurrent writes and versions
const concurrent = () => {
	const pa = [{ path: [], value: "a" }], pb = [{ path: [], value: "b" }]
	const wa = blop(A, DOC, "value", pa), wb = blop(B, DOC, "value", pb)
	const [first, second] = agreed(wa, wb)
	const content = (b: Made) => (b === wa ? "a" : "b")
	return {
		wa,
		wb,
		first,
		second,
		content,
		steps: [
			...apart(),
			write(A, pa),
			write(B, pb),
			link(A, B),
			pump(),
			records(A, [record(A, DOC, "value", pa, 0)]),
			records(B, [record(B, DOC, "value", pb, 0)]),
			...both(DOC, "value", [version(first, content(first)), version(second, content(second))]),
		],
	}
}
scenario(
	"concurrent",
	"concurrent writes on two devices converge: two versions, in the agreed order, on both",
	() => concurrent().steps,
)
scenario(
	"later-version",
	"a write at version 1 reorders: its blop's lamport is higher, so its version comes first",
	() => {
		const c = concurrent()
		const p = [{ path: [], value: "c" }]
		const w = blop(A, DOC, "value", p, [c.second])
		return [
			...c.steps,
			write(A, p, 1),
			pump(),
			records(A, [record(A, DOC, "value", p, 1)]),
			records(B, []),
			...both(DOC, "value", [version(w, "c"), version(c.first, c.content(c.first))]),
		]
	},
)
scenario(
	"span",
	"a write at the span [0, 2] merges both versions: record at [0, 2], one version",
	() => {
		const c = concurrent()
		const p = [{ path: [], value: "m" }]
		const w = blop(A, DOC, "value", p, [c.first, c.second], { base: c.first, combine: true })
		return [
			...c.steps,
			write(A, p, [0, 2]),
			pump(),
			records(A, [record(A, DOC, "value", p, [0, 2])]),
			records(B, []),
			...both(DOC, "value", [version(w, "m")]),
		]
	},
)
scenario(
	"two-ops",
	"two operations with nothing between: the first committed before the second, so one chain",
	() => {
		const p1 = [{ path: [], value: 1 }], p2 = [{ path: [], value: 2 }]
		const w1 = blop(A, DOC, "value", p1)
		const w2 = blop(A, DOC, "value", p2, [w1])
		return [
			...two(),
			{
				request: {
					op: "ops",
					device: "a",
					ops: [{ op: "write", address: [], patches: p1 }, {
						op: "write",
						address: [],
						patches: p2,
					}],
				},
				expect: [{}, {}],
			},
			pump(),
			records(A, [record(A, DOC, "value", p1, 0), record(A, DOC, "value", p2, 0)]),
			records(B, []),
			...both(DOC, "value", [version(w2, 2)]),
		]
	},
)

// ---- ids
scenario(
	"not-a-document",
	"a node with an id not ermine://: the list holding it syncs, its own contents do not",
	() => {
		const v = [{ path: [], value: "p" }]
		const ip = [{ path: [], range: [0, 0], value: ["plain"] }]
		const i = blop(A, DOC, notes, ip)
		return [
			...apart(),
			host(B, "create", { id: "plain" }, { id: "plain" }),
			host(A, "create", { value: "p", id: "plain" }, { id: "plain" }),
			insert(A, "notes", "plain"),
			link(A, B),
			pump(),
			records(A, [record(A, "plain", "value", v, 0), record(A, DOC, notes, ip, 0)]),
			records(B, []),
			...both(DOC, notes, [version(i, ["plain"])]),
			read(A, "plain", "value", [{ content: "p", change: { node: "plain", actor: "a" } }]),
			read(B, "plain", "value", []),
		]
	},
)

// ---- versions, internal and dangerous
scenario(
	"wrong-versions",
	"versions given a wrong list: the device differs, with no record, until the next blop for it",
	() => {
		const p1 = [{ path: [], value: 1 }], p2 = [{ path: [], value: 2 }]
		const w1 = blop(A, DOC, "value", p1)
		const w2 = blop(A, DOC, "value", p2, [w1])
		const wrong = [{ content: "wrong", change: { node: DOC, time: 0, actor: "x" } }]
		return [
			...two(),
			write(A, p1),
			pump(),
			records(A, [record(A, DOC, "value", p1, 0)]),
			host(B, "versions", { id: DOC, object: "value", list: wrong }),
			records(B, []),
			read(B, DOC, "value", [{ content: "wrong", change: { node: DOC, actor: "x" } }]),
			pump(),
			read(A, DOC, "value", [version(w1, 1)]),
			read(B, DOC, "value", [{ content: "wrong", change: { node: DOC, actor: "x" } }]),
			write(A, p2),
			pump(),
			records(A, [record(A, DOC, "value", p2, 0)]),
			records(B, []),
			...both(DOC, "value", [version(w2, 2)]),
		]
	},
)

// ---- ephemeral
scenario(
	"ephemeral",
	"an ephemeral node's change makes a record marked ephemeral and crosses as ephemeral: never stored",
	() => {
		const v = [{ path: [], value: 7 }]
		return [
			...apart(),
			host(B, "create", { id: X }, { id: X }),
			follow(A, X),
			follow(B, X),
			link(A, B),
			host(A, "create", { value: 7, id: X, ephemeral: true }, { id: X }),
			pump(),
			records(A, [{ object: "value", patches: v, at: 0, ephemeral: true }], {
				node: X,
				only: ["object", "patches", "at", "ephemeral"],
			}),
			records(B, []),
			read(A, X, "value", [{ content: 7 }], ["content"]),
			read(B, X, "value", [{ content: 7 }], ["content"]),
			{ request: { op: "stored", device: "a", doc: X }, expect: [] },
			{ request: { op: "stored", device: "b", doc: X }, expect: [] },
		]
	},
	"layers: B shows the ephemeral layer's versions; which layer's versions an object shows is open",
)

// ---- the change versions makes
scenario(
	"arriving-header",
	"an arriving change: readers are marked by the blop's header, its cause wrapped {sync: {signer, name}}",
	() => {
		const p = [{ path: [], value: 1 }]
		const w = blop(A, DOC, "value", p)
		return [
			...two(),
			{ request: { op: "watch", device: "b", address: [] }, expect: {} },
			{ request: { op: "marked", device: "b" }, expect: [{ actor: "b" }] },
			write(A, p),
			pump(),
			{
				request: { op: "marked", device: "b" },
				expect: [{ actor: "a", cause: { sync: { signer: hex(A.key), name: w.name } } }],
			},
			read(B, DOC, "value", [version(w, 1)]),
		]
	},
)

// ---- refused
scenario("refused", "an operation refused, or that throws, makes no record", () => [
	...two(),
	host(A, "write", { address: ["nowhere"], patches: [{ path: [], value: 1 }] }, {
		error: "nothing-there",
	}),
	host(A, "pop", { id: DOC, name: "none", slotindex: 0 }, { error: "range" }),
	host(A, "rename", { id: DOC, name: "none", to: "other" }, { error: "nothing-there" }),
	pump(),
	records(A, []),
	records(B, []),
	read(B, DOC, "value", []),
])

// ---- write
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
for (const [i, s] of all.entries()) {
	const file = `${String(i + 1).padStart(2, "0")}-${s.name}.json`
	await Deno.writeTextFile(
		new URL(file, out),
		JSON.stringify(
			{ title: s.title, ...(s.skip ? { skip: s.skip } : {}), steps: s.steps },
			null,
			"\t",
		) + "\n",
	)
}
console.log(`${all.length} scenarios written`)
