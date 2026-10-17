import { assertEquals, assertThrows } from "@std/assert"
import { type Commit, CommitError, decode, encode, joinKey, name, splitKey } from "./commit.ts"

const bytes = (n: number, b = 1) => new Uint8Array(n).fill(b)
const commit = (more: Partial<Commit> = {}): Commit => ({
	table: "children",
	actor: "chee",
	time: 1_760_000_000,
	signer: joinKey(0xed, bytes(32)),
	nonce: 7,
	parents: [bytes(32, 2)],
	lamport: 2,
	patches: [{ path: ["notes"], value: "ermine://" + "ab".repeat(32) }],
	...more,
})

Deno.test("commit: round trip, optional fields left out, the name its bytes' hash", () => {
	const c = commit({
		reader: "r",
		external: [{ file: "a.ts", line: 3, column: 1 }],
		metadata: [["cause", { why: 1 }]],
	})
	const b = encode({ ...c, reader: c.reader, base: undefined })
	const back = decode(b)
	assertEquals(back, c)
	assertEquals(name(b).length, 32)
	// the same commit, the same bytes and name
	assertEquals(
		name(
			encode(
				commit({
					reader: "r",
					external: [{ file: "a.ts", line: 3, column: 1 }],
					metadata: [["cause", { why: 1 }]],
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
	const p = [bytes(32, 2), bytes(32, 3)]
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
	const c = commit({ parents: [bytes(32, 2), bytes(32, 3)], merge: "eg-walker" })
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
	no(commit({ parents: [bytes(32, 3), bytes(32, 2)] }), "parents")
	// several parents need a base, one of them
	no(commit({ parents: [bytes(32, 2), bytes(32, 3)] }), "base")
	no(commit({ parents: [bytes(32, 2), bytes(32, 3)], base: bytes(32, 4) }), "base")
	// one parent: no base
	no(commit({ base: bytes(32, 2) }), "base")
	// merge: a rule's name, with several parents and no base
	no(commit({ merge: "eg-walker" }), "merge")
	no(commit({ parents: [bytes(32, 2), bytes(32, 3)], base: bytes(32, 3), merge: "x" }), "merge")
	no(commit({ parents: [bytes(32, 2), bytes(32, 3)], merge: 1 as never }), "merge")
	no(commit({ parents: [bytes(32, 2), bytes(32, 3)], merge: "" }), "merge")
	no(commit({ lamport: 0 }), "lamport")
	no(commit({ patches: [{ path: ["a"], value: 1, move: { path: ["b"] } }] }), "patches")
	no(commit({ metadata: [["a"]] as never }), "metadata")
	no({ ...commit(), node: "x" }, "node")
	const e = assertThrows(() => decode(new Uint8Array([0xff])), CommitError)
	assertEquals(e.code, "not-a-commit")
})
