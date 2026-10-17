import { assertEquals, assertThrows } from "@std/assert"
import { type Blop, BlopError, decode, encode, name } from "./blop.ts"
import * as cbor from "./cbor.ts"

const fail = (f: () => unknown) => {
	const e = assertThrows(f, BlopError) as BlopError
	return [e.code, e.field]
}
const fill = (n: number, x: number) => new Uint8Array(n).fill(x)

const blop = (more: Partial<Blop> = {}): Blop => ({
	node: "n1",
	object: ["children", "home"],
	actor: "alice",
	signer: fill(32, 1),
	nonce: fill(8, 2),
	parents: [],
	lamport: 1,
	patches: [{ path: [], value: ["a"] }],
	...more,
})

Deno.test("blop: round trip, byte fields as byte strings", () => {
	const b = blop({
		reader: "r",
		site: { file: "f.ts", line: 3, column: 4 },
		cause: { why: [1, 2] },
		parents: [fill(32, 3), fill(32, 4)],
		base: fill(32, 4),
		lamport: 7,
		patches: [
			{ path: ["a", 0], range: [1, 2], value: "x" },
			{ path: ["b"], move: { path: ["c"], range: [0, 1] } },
			{ path: ["t"], value: new Uint16Array([1, 2]) },
		],
	})
	const bytes = encode(b)
	assertEquals(decode(bytes), b)
	const raw = cbor.decode(bytes) as { [k: string]: cbor.Value }
	// byte strings, as bytes are everywhere
	const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")
	assertEquals(hex.includes("667369676e65725820"), true)
	assertEquals(raw.signer instanceof Uint8Array, true)
	assertEquals((raw.parents as cbor.Value[])[0] instanceof Uint8Array, true)
	assertEquals(name(bytes).length, 32)
	assertEquals(name(bytes), name(encode(decode(bytes))))
})

Deno.test("blop: lamport 1 is the integer 01; nothing left out", () => {
	const bytes = encode(blop({ reader: undefined }))
	const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")
	assertEquals(hex.includes("676c616d706f727401"), true)
	assertEquals("reader" in decode(bytes), false)
})

Deno.test("blop: not a blop, the first field in the table's order", () => {
	const { node: _, ...noNode } = blop()
	assertEquals(fail(() => encode(noNode as Blop)), ["not-a-blop", "node"])
	assertEquals(fail(() => encode(blop({ object: ["info"] as never }))), ["not-a-blop", "object"])
	assertEquals(fail(() => encode(blop({ reader: null as never }))), ["not-a-blop", "reader"])
	assertEquals(fail(() => encode(blop({ site: { file: "f" } as never }))), [
		"not-a-blop",
		"site",
	])
	assertEquals(fail(() => encode(blop({ signer: fill(31, 1) }))), ["not-a-blop", "signer"])
	assertEquals(fail(() => encode(blop({ nonce: fill(9, 1), lamport: 0 }))), [
		"not-a-blop",
		"nonce",
	])
	const p = [fill(32, 3), fill(32, 4)]
	assertEquals(fail(() => encode(blop({ parents: [p[1], p[0]], base: p[0] }))), [
		"not-a-blop",
		"parents",
	])
	assertEquals(fail(() => encode(blop({ parents: [p[0], p[0]], base: p[0] }))), [
		"not-a-blop",
		"parents",
	])
	assertEquals(fail(() => encode(blop({ parents: p }))), ["not-a-blop", "base"])
	assertEquals(fail(() => encode(blop({ parents: p, base: fill(32, 5) }))), [
		"not-a-blop",
		"base",
	])
	assertEquals(fail(() => encode(blop({ parents: [p[0]], base: p[0] }))), ["not-a-blop", "base"])
	assertEquals(fail(() => encode(blop({ lamport: 1.5 }))), ["not-a-blop", "lamport"])
	assertEquals(fail(() => encode(blop({ patches: [{ path: [], other: 1 } as never] }))), [
		"not-a-blop",
		"patches",
	])
	assertEquals(
		fail(() => encode(blop({ patches: [{ path: [], value: 1, move: { path: [] } }] }))),
		["not-a-blop", "patches"],
	)
	assertEquals(fail(() => encode({ ...blop(), extra: 1 } as Blop)), ["not-a-blop", "extra"])
})

Deno.test("blop: cannot carry a live value", () => {
	assertEquals(fail(() => encode(blop({ cause: () => 1 }))), ["cannot-carry", "cause"])
	assertEquals(fail(() => encode(blop({ actor: new Map() }))), ["cannot-carry", "actor"])
})

Deno.test("blop: decoding says no", () => {
	assertEquals(fail(() => decode(new Uint8Array([0xff]))), ["not-a-blop", undefined])
	assertEquals(fail(() => decode(cbor.encode([1]))), ["not-a-blop", undefined])
	// a typed array is not bytes
	const raw = cbor.decode(encode(blop())) as { [k: string]: cbor.Value }
	assertEquals(fail(() => decode(cbor.encode({ ...raw, nonce: new Uint16Array(4) }))), [
		"not-a-blop",
		"nonce",
	])
	// a view is bytes, as given
	const nonce = new Uint8Array(12).fill(2).subarray(2, 10)
	assertEquals(decode(cbor.encode({ ...raw, nonce })).nonce, fill(8, 2))
	// tag 64 over the nonce's bytes: no encoding, so no field
	const tagged = encode(blop())
	const at = Array.from(tagged).findIndex((_, i) =>
		[0x65, 0x6e, 0x6f, 0x6e, 0x63, 0x65, 0x48].every((x, j) => tagged[i + j] === x)
	)
	const t = new Uint8Array(tagged.length + 2)
	t.set(tagged.subarray(0, at + 6))
	t.set([0xd8, 0x40], at + 6)
	t.set(tagged.subarray(at + 6), at + 8)
	assertEquals(fail(() => decode(t)), ["not-a-blop", undefined])
	// keys out of order: not the canonical encoding
	const b = encode(blop())
	const swapped = new Uint8Array([0xa2, 0x61, 0x62, 0xf6, 0x61, 0x61, 0xf6])
	assertEquals(fail(() => decode(swapped)), ["not-a-blop", undefined])
	assertEquals(decode(b).lamport, 1)
})
