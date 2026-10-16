import { assertEquals, assertThrows } from "@std/assert"
import { type Commit, CommitError, decode, encode, name } from "./commit.ts"

const bytes = (n: number, b = 1) => new Uint8Array(n).fill(b)
const commit = (more: Partial<Commit> = {}): Commit => ({
	table: "children",
	actor: "chee",
	time: 1_760_000_000,
	signer: bytes(32),
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
	no(commit({ signer: bytes(31) }), "signer")
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
