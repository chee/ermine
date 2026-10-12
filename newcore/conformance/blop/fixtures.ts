// Writes the blop scenarios to newcore/encoding/conformance/blop/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/blop/fixtures.ts
// Expected bytes: a blop is a canonical CBOR map, so cbor.encode of the right object is the
// oracle; names are BLAKE3 of those bytes. blop.ts is never imported. Byte fields are ArrayBuffers
// (ENCODING.tex); a refused blop is given in JSON form (../pack/form.ts) like the rest.
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { encode } from "../../encoding/ts/cbor.ts"
import { toJson } from "../pack/form.ts"

const out = new URL("../../encoding/conformance/blop/", import.meta.url)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
// n bytes, each `first` then counting up
const bytes = (n: number, first: number): ArrayBuffer =>
	Uint8Array.from({ length: n }, (_, i) => (first + i) & 0xff).buffer
const h = (first: number) => bytes(32, first)

type O = Record<string, unknown>
// a valid minimal blop, with changes
const min = (more: O = {}): O => ({
	node: "n",
	object: "value",
	actor: "a",
	signer: h(1),
	nonce: bytes(8, 9),
	parents: [],
	lamport: 1,
	patches: [],
	...more,
})
// the same, with a key taken out
const without = (...keys: string[]): O => {
	const o = min()
	for (const k of keys) delete o[k]
	return o
}
const P1 = h(0x10), P2 = h(0x20), P3 = h(0x30)

type Fixture = { name: string; scenario: unknown }
const all: Fixture[] = []
const add = (name: string, scenario: unknown) => all.push({ name, scenario })

const ok = (name: string, title: string, blop: O) => {
	const b = encode(blop as never)
	add(name, { title, blop: toJson(blop), expect: { bytes: hex(b), name: hex(blake3(b)) } })
}
const refuse = (name: string, title: string, blop: O, code: string, field?: string) =>
	add(name, {
		title,
		blop: toJson(blop),
		expect: field === undefined ? { code } : { code, field },
	})
const bad = (name: string, title: string, blop: O, field: string) =>
	refuse(name, title, blop, "not-a-blop", field)
const decodes = (name: string, title: string, bytes: Uint8Array, field?: string) =>
	add(name, {
		title,
		bytes: hex(bytes),
		expect: field === undefined ? { code: "not-a-blop" } : { code: "not-a-blop", field },
	})

// ---- accepted
ok("minimal", "minimal: no optional fields, parents [], patches []", min())
ok(
	"everything",
	"every optional field present",
	min({
		reader: "r",
		site: { file: "file:///a.ts", line: 3, column: 7, function: "f" },
		cause: { why: "because" },
		parents: [P1, P2],
		base: P2,
		combine: true,
		lamport: 5,
		patches: [
			{ path: ["a", 0], range: [0, 1], value: "x" },
			{ path: ["c"], move: { path: ["b"], range: [2, 3] } },
		],
	}),
)
ok("object-value", 'object "value"', min({ object: "value" }))
ok("object-info", 'object ["info", s]', min({ object: ["info", "title"] }))
ok("object-children", 'object ["children", s]', min({ object: ["children", "kids"] }))
ok("actor-null", "actor null is a value", min({ actor: null }))
ok("actor-map", "actor a map", min({ actor: { name: "chee", n: 1 } }))
ok("actor-bytes", "actor bytes", min({ actor: bytes(4, 0xa0) }))
ok("actor-typed", "actor a typed array (tag 64)", min({ actor: new Uint8Array([1, 2, 3]) }))
ok("cause-null", "cause null is a value", min({ cause: null }))
ok("cause-bytes", "cause bytes", min({ cause: bytes(3, 0) }))
ok("reader", "reader a string", min({ reader: "someone" }))
ok(
	"site-short",
	"site with file and line only",
	min({ site: { file: "file:///a.ts", line: 10 } }),
)
ok(
	"site-column",
	"site with column, no function",
	min({ site: { file: "file:///a.ts", line: 10, column: 2 } }),
)
ok(
	"site-function",
	"site with function, no column",
	min({ site: { file: "file:///a.ts", line: 10, function: "go" } }),
)
ok(
	"site-full",
	"site with column and function",
	min({ site: { file: "file:///a.ts", line: 10, column: 2, function: "go" } }),
)
ok("parent-one", "one parent, no base", min({ parents: [P1], lamport: 2 }))
ok(
	"parents-three",
	"three parents sorted, base among them",
	min({
		parents: [P1, P2, P3],
		base: P2,
		lamport: 2,
	}),
)
ok(
	"base-two-parents",
	"base and two parents, choosing (no combine)",
	min({
		parents: [P1, P2],
		base: P1,
		lamport: 2,
	}),
)
ok(
	"combine",
	"combine true with base",
	min({
		parents: [P1, P2],
		base: P2,
		combine: true,
		lamport: 2,
	}),
)
ok(
	"patch-range",
	"patch with path and range",
	min({
		patches: [{ path: ["text"], range: [0, 5] }],
	}),
)
ok(
	"patch-value",
	"patch with path and value",
	min({ patches: [{ path: [], value: { a: [1, 2] } }] }),
)
ok(
	"patch-value-null",
	"patch value null is a value",
	min({ patches: [{ path: ["a"], value: null }] }),
)
ok(
	"patch-move",
	"patch with move and range",
	min({
		patches: [{ path: ["a"], move: { path: ["b"], range: [1, 2] } }],
	}),
)
ok(
	"patch-move-bare",
	"patch with move, no range",
	min({
		patches: [{ path: ["a"], move: { path: ["b", 3] } }],
	}),
)
ok(
	"patch-path-mixed",
	"patch path mixing strings and wholes",
	min({
		patches: [{ path: ["a", 0, "b", 2 ** 53 - 1, ""], value: 1 }],
	}),
)
ok(
	"patches-several",
	"several patches keep their order",
	min({
		patches: [{ path: ["z"], value: 1 }, { path: ["a"], value: 2 }, {
			path: ["z"],
			range: [0, 0],
		}],
	}),
)
ok("lamport-one", "lamport 1 is written f93c00", min({ lamport: 1 }))
ok("lamport-large", "lamport a large safe integer", min({ lamport: 2 ** 53 - 1 }))

// ---- refused when encoding
for (const k of ["node", "object", "actor", "signer", "nonce", "parents", "lamport", "patches"]) {
	bad(`missing-${k}`, `${k} missing`, without(k), k)
}
bad("unlisted-key", "a key not in the table", min({ extra: 1 }), "extra")
bad("time-key", "the header's time is never in a blop", min({ time: 5 }), "time")
bad(
	"unlisted-keys-canonical",
	"of several unlisted keys, the first in canonical key order (shorter first)",
	min({ zz: 1, y: 2, ab: 3 }),
	"y",
)
bad("node-kind", "node not a string", min({ node: 5 }), "node")
bad("node-bytes", "node as bytes is not a string", min({ node: bytes(4, 0) }), "node")
bad("signer-short", "signer 31 bytes", min({ signer: bytes(31, 1) }), "signer")
bad("signer-string", "signer a string", min({ signer: "k" }), "signer")
bad(
	"signer-typed",
	"signer a Uint16Array is not bytes",
	min({ signer: new Uint16Array(16) }),
	"signer",
)
bad("nonce-typed", "nonce a Uint16Array is not bytes", min({ nonce: new Uint16Array(4) }), "nonce")
bad("nonce-size", "nonce 9 bytes", min({ nonce: bytes(9, 0) }), "nonce")
bad("parents-kind", "parents not a list", min({ parents: "x" }), "parents")
bad("parent-size", "a parent of the wrong size", min({ parents: [bytes(31, 0)] }), "parents")
bad(
	"parents-unsorted",
	"parents not sorted",
	min({
		parents: [P2, P1],
		base: P1,
		lamport: 2,
	}),
	"parents",
)
bad(
	"parents-repeated",
	"parents repeated",
	min({
		parents: [P1, P1],
		base: P1,
		lamport: 2,
	}),
	"parents",
)
bad("base-one-parent", "base with one parent", min({ parents: [P1], base: P1, lamport: 2 }), "base")
bad("base-none-parents", "base with no parents", min({ base: P1 }), "base")
bad("base-missing", "base missing with two parents", min({ parents: [P1, P2], lamport: 2 }), "base")
bad(
	"base-not-parent",
	"base not among parents",
	min({
		parents: [P1, P2],
		base: P3,
		lamport: 2,
	}),
	"base",
)
bad(
	"base-size",
	"base the wrong size",
	min({
		parents: [P1, P2],
		base: bytes(8, 0),
		lamport: 2,
	}),
	"base",
)
bad("combine-no-base", "combine without base", min({ combine: true }), "combine")
bad(
	"combine-false",
	"combine false",
	min({
		parents: [P1, P2],
		base: P1,
		combine: false,
		lamport: 2,
	}),
	"combine",
)
bad(
	"combine-kind",
	"combine not a boolean",
	min({
		parents: [P1, P2],
		base: P1,
		combine: 1,
		lamport: 2,
	}),
	"combine",
)
bad("lamport-zero", "lamport 0", min({ lamport: 0 }), "lamport")
bad("lamport-fraction", "lamport 1.5", min({ lamport: 1.5 }), "lamport")
bad("lamport-big", "lamport 2^53", min({ lamport: 2 ** 53 }), "lamport")
bad("lamport-negative", "lamport -1", min({ lamport: -1 }), "lamport")
bad("lamport-string", "lamport a string", min({ lamport: "1" }), "lamport")
bad("reader-kind", "reader not a string", min({ reader: 5 }), "reader")
bad("reader-null", "reader null: null is a value, not a string", min({ reader: null }), "reader")
bad("site-null", "site null: wrong kind", min({ site: null }), "site")
bad(
	"site-extra",
	"site with another key",
	min({
		site: { file: "f", line: 1, extra: 1 },
	}),
	"site",
)
bad("site-line-fraction", "site line 1.5", min({ site: { file: "f", line: 1.5 } }), "site")
bad("site-missing-line", "site without line", min({ site: { file: "f" } }), "site")
bad("site-file-kind", "site file not a string", min({ site: { file: 1, line: 1 } }), "site")
bad("object-other", 'object ["other", "x"]', min({ object: ["other", "x"] }), "object")
bad("object-info-kind", 'object ["info", 1]', min({ object: ["info", 1] }), "object")
bad("object-word", 'object "info" alone', min({ object: "info" }), "object")
bad("patches-kind", "patches not a list", min({ patches: {} }), "patches")
bad(
	"patch-extra",
	"patch with another key",
	min({
		patches: [{ path: [], extra: 1 }],
	}),
	"patches",
)
bad("patch-no-path", "patch without path", min({ patches: [{ value: 1 }] }), "patches")
bad(
	"patch-range-three",
	"patch range of three",
	min({
		patches: [{ path: [], range: [0, 1, 2] }],
	}),
	"patches",
)
bad(
	"patch-path-kind",
	"patch path holding a float",
	min({
		patches: [{ path: ["a", 1.5] }],
	}),
	"patches",
)
bad(
	"patch-move-and-value",
	"patch with both move and value (mutate refuses it)",
	min({
		patches: [{ path: [], value: 1, move: { path: [] } }],
	}),
	"patches",
)
bad(
	"patch-move-extra",
	"patch move with another key",
	min({
		patches: [{ path: [], move: { path: [], extra: 1 } }],
	}),
	"patches",
)
bad(
	"patch-move-no-path",
	"patch move without path",
	min({
		patches: [{ path: [], move: { range: [0, 1] } }],
	}),
	"patches",
)

// ---- two faults: the first in the spec's order wins
bad("order-unlisted-first", "an unlisted key beats a missing node", {
	...without("node"),
	extra: 1,
}, "extra")
bad(
	"order-table",
	"table order: node's kind beats signer's size",
	min({
		node: 5,
		signer: bytes(31, 0),
	}),
	"node",
)
bad(
	"order-kind-before-rule",
	"a key's kind beats its own rule: lamport 0.5, not 0",
	min({
		lamport: 0.5,
	}),
	"lamport",
)
bad("order-missing-before-kind", "table order: a missing actor beats a bad nonce", {
	...without("actor"),
	nonce: "x",
}, "actor")
bad(
	"order-reader-before-lamport",
	"reader's kind beats lamport 0",
	min({
		reader: 1,
		lamport: 0,
	}),
	"reader",
)
bad(
	"order-parents-before-base",
	"parents unsorted beats base not among them",
	min({
		parents: [P2, P1],
		base: P3,
		lamport: 2,
	}),
	"parents",
)
bad(
	"order-base-before-combine",
	"base missing beats combine false",
	min({
		parents: [P1, P2],
		combine: false,
		lamport: 2,
	}),
	"base",
)
bad(
	"order-combine-before-lamport",
	"combine false beats lamport 0",
	min({
		combine: false,
		lamport: 0,
	}),
	"combine",
)
bad(
	"order-lamport-before-patches",
	"lamport 0 beats a bad patch",
	min({
		lamport: 0,
		patches: [{ path: [], extra: 1 }],
	}),
	"lamport",
)

// ---- refused when decoding: no field
const good = min()
const goodHex = hex(encode(good as never))
const swap = (from: string, to: string) => {
	if (goodHex.split(from).length !== 2) throw new Error(`${from} not once in the minimal blop`)
	return unhex(goodHex.replace(from, to))
}
// the minimal blop's entries as separate pieces, to be put in another order
const entries = Object.entries(good).map(([k, v]) => ({
	key: encode(k),
	bytes: Uint8Array.from([...encode(k), ...encode(v as never)]),
}))
entries.sort((a, b) =>
	a.key.length - b.key.length ||
	(a.key.findIndex((x, i) => x !== b.key[i]) < 0
		? 0
		: a.key[a.key.findIndex((x, i) => x !== b.key[i])] -
			b.key[a.key.findIndex((x, i) => x !== b.key[i])])
)
const join = (es: { bytes: Uint8Array }[]) =>
	Uint8Array.from([0xa0 + es.length, ...es.flatMap((e) => [...e.bytes])])
if (hex(join(entries)) !== goodHex) throw new Error("canonical order not rebuilt")
const swapped = [entries[1], entries[0], ...entries.slice(2)]

decodes("decode-not-cbor", "bytes that are not CBOR", Uint8Array.of(0x1c))
decodes("decode-truncated", "a canonical blop cut short", unhex(goodHex.slice(0, -4)))
decodes("decode-trailing", "a canonical blop followed by a byte", unhex(goodHex + "00"))
decodes("decode-empty", "no bytes", new Uint8Array())
decodes("decode-list", "a list, not a map", encode([]))
decodes("decode-string", "a string, not a map", encode("blop"))
decodes("decode-lamport-int", "lamport as the CBOR integer 01, not f93c00", swap("f93c00", "01"))
decodes(
	"decode-float-long",
	"lamport 1 as a float64, not the shortest form",
	swap("f93c00", "fb3ff0000000000000"),
)
decodes("decode-keys-order", "keys out of canonical order", join(swapped))
// valid CBOR maps that are not blops: the field comes from the table
add("decode-unlisted", {
	title: "decoding: a key not in the table names that key",
	bytes: hex(encode({ ...good, extra: 1 } as never)),
	expect: { code: "not-a-blop", field: "extra" },
})
add("decode-missing", {
	title: "decoding: a missing key names that key",
	bytes: hex(encode(without("lamport") as never)),
	expect: { code: "not-a-blop", field: "lamport" },
})
add("decode-not-sorted", {
	title: "decoding: parents unsorted names parents",
	bytes: hex(encode(min({ parents: [P2, P1], base: P1, lamport: 2 }) as never)),
	expect: { code: "not-a-blop", field: "parents" },
})

// ---- wallclock and message
ok(
	"wallclock-message",
	"wallclock and message both there",
	min({ wallclock: 1760000000, message: "tidy up" }),
)
ok("wallclock", "wallclock alone, whole seconds", min({ wallclock: 1760000000 }))
ok("wallclock-zero", "wallclock 0 is whole", min({ wallclock: 0 }))
ok("message", "message alone", min({ message: "tidy up" }))
ok("message-empty", "message the empty string", min({ message: "" }))
bad("wallclock-fraction", "wallclock 1.5: not whole", min({ wallclock: 1.5 }), "wallclock")
bad("wallclock-negative", "wallclock -1: not whole", min({ wallclock: -1 }), "wallclock")
bad("wallclock-string", "wallclock a string", min({ wallclock: "1760000000" }), "wallclock")
bad(
	"wallclock-null",
	"wallclock null: null is a value, not a whole",
	min({ wallclock: null }),
	"wallclock",
)
bad("message-kind", "message not a string", min({ message: 5 }), "message")
bad(
	"message-null",
	"message null: null is a value, not a string",
	min({ message: null }),
	"message",
)
bad("message-bytes", "message bytes, not a string", min({ message: bytes(3, 0) }), "message")
bad(
	"order-wallclock-before-message",
	"table order: wallclock's kind beats message's",
	min({ wallclock: -1, message: 5 }),
	"wallclock",
)
bad(
	"order-message-before-lamport",
	"message's kind beats lamport 0",
	min({ message: 1, lamport: 0 }),
	"message",
)

// ---- write
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
all.forEach(({ name, scenario }, i) => {
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	Deno.writeTextFileSync(new URL(file, out), JSON.stringify(scenario, null, "\t") + "\n")
})
console.log(`${all.length} scenarios`)
