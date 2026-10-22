import { assertEquals, assertThrows } from "@std/assert"
import {
	type Commit,
	CommitError,
	decode,
	encode,
	joinKey,
	joinName,
	name,
	splitKey,
	splitName,
} from "./commit.ts"
import * as cbor from "@ermine/encoding/cbor"

const bytes = (n: number, b = 1) => new Uint8Array(n).fill(b)
// a name of BLAKE3: its code, its length, a digest of b bytes
const nm = (b: number) => joinName(0x1e, bytes(32, b))
const commit = (more: Partial<Commit> = {}): Commit => ({
	table: "children",
	actor: "chee",
	time: 1_760_000_000,
	signer: joinKey(0xed, bytes(32)),
	nonce: 7,
	parents: [nm(2)],
	lamport: 2,
	patches: [{ path: ["notes"], value: "ermine:0010" + "ab".repeat(16) }],
	...more,
})

Deno.test("commit: round trip, optional fields left out, the name its bytes' hash", () => {
	const c = commit({
		reader: "r",
		external: [{ file: "a.ts", line: 3, column: 1 }],
		metadata: { cause: { why: 1 } },
	})
	const b = encode({ ...c, reader: c.reader, base: undefined })
	const back = decode(b)
	assertEquals(back, c)
	assertEquals(name(b).length, 34)
	// the same commit, the same bytes and name
	assertEquals(
		name(
			encode(
				commit({
					reader: "r",
					external: [{ file: "a.ts", line: 3, column: 1 }],
					metadata: { cause: { why: 1 } },
				}),
			),
		),
		name(b),
	)
})

Deno.test("commit: a signer is a multikey: any well formed one is carried, its code and key told apart", () => {
	// ed25519-pub (0xed 0x01), secp256k1-pub (0xe7 0x01), p256-pub (a two byte code), one byte, the longest
	for (
		const [code, size] of [[0xed, 32], [0xe7, 33], [0x1200, 33], [0x12, 8], [0x3fffffff, 1019]]
	) {
		const signer = joinKey(code, bytes(size, 9))
		assertEquals(splitKey(signer), { code, key: bytes(size, 9) })
		const c = commit({ signer })
		assertEquals(decode(encode(c)), c)
	}
	assertEquals(joinKey(0xed, bytes(32)).slice(0, 2), Uint8Array.of(0xed, 0x01))
	// none: no key, an unfinished code, a code not in its shortest form, too long a code
	for (
		const b of [[], [0xed], [0xed, 0x01], [0x80, 0x00, 1], [
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			1,
			1,
		]]
	) {
		assertEquals(splitKey(Uint8Array.from(b)), undefined)
	}
})

Deno.test("commit: a move, a range, several parents with base", () => {
	const p = [nm(2), nm(3)]
	const c = commit({
		parents: p,
		base: p[1],
		patches: [{ path: ["new"], move: { path: ["old"] } }, {
			path: ["list"],
			range: [0, 2],
			value: [1],
		}],
	})
	assertEquals(decode(encode(c)), c)
})

Deno.test("commit: a merge, several parents and a rule's name, no base", () => {
	const c = commit({ parents: [nm(2), nm(3)], merge: "eg-walker" })
	assertEquals(decode(encode(c)), c)
})

Deno.test("commit: refused, naming the first field that says no", () => {
	const no = (c: unknown, field?: string) => {
		const e = assertThrows(() => encode(c as Commit), CommitError)
		assertEquals(e.field, field)
	}
	no(commit({ table: "" }), "table")
	no(commit({ time: -1 }), "time")
	// a signer is a multikey: a shortest-form varint code, then a key
	no(commit({ signer: bytes(0) }), "signer")
	no(commit({ signer: Uint8Array.of(0xed, 0x01) }), "signer")
	no(commit({ signer: Uint8Array.of(0xed) }), "signer")
	no(commit({ signer: Uint8Array.of(0x80, 0x00, 0x01) }), "signer")
	no(commit({ signer: new Uint8Array(1025).fill(1) }), "signer")
	no(commit({ parents: [nm(3), nm(2)] }), "parents")
	// several parents need a base, one of them, unless every patch is a key patch
	const ranged = [{ path: ["notes"], range: [0, 0] as const, value: "x" }]
	no(commit({ parents: [nm(2), nm(3)], patches: ranged }), "base")
	encode(commit({ parents: [nm(2), nm(3)] }))
	no(commit({ parents: [nm(2), nm(3)], base: nm(4) }), "base")
	// one parent: no base
	no(commit({ base: nm(2) }), "base")
	// merge: a rule's name, with several parents and no base
	no(commit({ merge: "eg-walker" }), "merge")
	no(commit({ parents: [nm(2), nm(3)], base: nm(3), merge: "x" }), "merge")
	no(commit({ parents: [nm(2), nm(3)], merge: 1 as never }), "merge")
	no(commit({ parents: [nm(2), nm(3)], merge: "" }), "merge")
	no(commit({ lamport: 0 }), "lamport")
	no(commit({ patches: [{ path: ["a"], value: 1, move: { path: ["b"] } }] }), "patches")
	no(commit({ metadata: [["a", 1]] as never }), "metadata")
	no(commit({ metadata: "a" as never }), "metadata")
	no({ ...commit(), node: "x" }, "node")
	const e = assertThrows(() => decode(new Uint8Array([0xff])), CommitError)
	assertEquals(e.code, "not-a-commit")
})

Deno.test("commit: metadata in the old form, [key, value] pairs, is read as an object, of a key repeated the first; never written", () => {
	const { metadata: _, ...rest } = commit()
	const old = cbor.encode({ ...rest, metadata: [["why", "x"], ["a", 1], ["why", "y"]] } as never)
	const back = decode(old)
	assertEquals(back.metadata, { why: "x", a: 1 })
	// written again: a map
	const again = encode(back)
	assertEquals((cbor.decode(again) as { metadata: unknown }).metadata, { a: 1, why: "x" })
	// a pair not a pair: not a commit
	const bad = cbor.encode({ ...rest, metadata: [["a", 1, 2]] } as never)
	assertEquals(assertThrows(() => decode(bad), CommitError).field, "metadata")
})

Deno.test("commit: a name is a multihash: BLAKE3's code, length 32, the digest; any other is no name", () => {
	const n = nm(5)
	assertEquals(n.slice(0, 2), Uint8Array.of(0x1e, 0x20))
	assertEquals(splitName(n), { code: 0x1e, digest: bytes(32, 5) })
	assertEquals(splitName(name(new Uint8Array(0)))?.code, 0x1e)
	const no = (b: unknown) => assertEquals(splitName(b), undefined)
	no(bytes(32, 5))
	no(Uint8Array.of(0x1f, 0x20, ...bytes(32)))
	no(Uint8Array.of(0x1e, 0x21, ...bytes(33)))
	no(Uint8Array.of(0x1e, 0x20, ...bytes(31)))
	no(Uint8Array.of(0x1e, 0x20, ...bytes(33)))
	no(Uint8Array.of(0x9e, 0x00, 0x20, ...bytes(32)))
	no(Uint8Array.of(0x1e, 0xa0, 0x00, ...bytes(32)))
	no(Uint8Array.of(0x1e))
	no("1e20")
})
