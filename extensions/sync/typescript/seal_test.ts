import { assertEquals, assertRejects } from "@std/assert"
import { type Commit, encode, joinKey, name as nameOf } from "@ermine/encoding/commit"
import * as cbor from "@ermine/encoding/cbor"
import { createSigner, seal, SealError, unseal, type Verifier } from "./seal.ts"

const DOC = new Uint8Array(32).fill(0x2a)

const commitBy = (key: Uint8Array): Commit => ({
	table: "value",
	actor: "t",
	time: 1,
	signer: key,
	nonce: 1,
	parents: [],
	lamport: 1,
	patches: [{ path: [], value: 1 }],
})

Deno.test("seal: sealed, unsealed and checked; a seed gives the same key every time", async () => {
	const s = await createSigner(new Uint8Array(32).fill(7))
	assertEquals((await createSigner(new Uint8Array(32).fill(7))).key, s.key)
	const bytes = encode(commitBy(s.key))
	const sealed = await seal(bytes, s, DOC)
	const u = await unseal(sealed, DOC)
	assertEquals(u.bytes, bytes)
	assertEquals(u.commit.table, "value")
	// a new key, not from a seed
	const n = await createSigner()
	// a multikey: 0xed 0x01, then the 32 bytes; its signatures begin with the varsig header
	assertEquals(n.key.length, 34)
	assertEquals(n.key.slice(0, 2), Uint8Array.of(0xed, 0x01))
	assertEquals(n.header.length, 8)
	await unseal(await seal(encode(commitBy(n.key)), n, DOC), DOC)
})

Deno.test("seal: another's commit refused; a signature changed refused; a shape not a seal refused", async () => {
	const a = await createSigner(new Uint8Array(32).fill(1)),
		b = await createSigner(new Uint8Array(32).fill(2))
	const e = await assertRejects(() => seal(encode(commitBy(b.key)), a, DOC), SealError)
	assertEquals(e.code, "signature")
	const sealed = await seal(encode(commitBy(a.key)), a, DOC)
	const o = cbor.decode(sealed) as { commit: Uint8Array; signature: Uint8Array }
	o.signature[0] ^= 1
	assertEquals(
		(await assertRejects(() => unseal(cbor.encode(o), DOC), SealError)).code,
		"signature",
	)
	assertEquals(
		(await assertRejects(() => unseal(new Uint8Array([1]), DOC), SealError)).code,
		"shape",
	)
})

Deno.test("seal: a signature is checked by the verifier its header names, for a key of its type", async () => {
	const a = await createSigner(new Uint8Array(32).fill(1))
	const raw = (await createSigner(new Uint8Array(32).fill(1))).key.slice(2)
	// a key of another type under the Ed25519 header
	const secp = joinKey(0xe7, new Uint8Array(33).fill(2))
	const odd = await seal(encode(commitBy(secp)), a, DOC, { name: nameOf(encode(commitBy(secp))) })
	const e = await assertRejects(() => unseal(odd, DOC), SealError)
	assertEquals([e.code, e.reason], ["signature", "the header and the signer's key differ"])
	// a header no verifier is built in for, and a signature with none
	const sealed = await seal(encode(commitBy(a.key)), a, DOC)
	const o = cbor.decode(sealed) as { commit: Uint8Array; signature: Uint8Array }
	const other = {
		...o,
		signature: Uint8Array.from([
			0x34,
			0x01,
			0xec,
			0x01,
			0xe7,
			0x01,
			0x16,
			0x5f,
			...o.signature.slice(8),
		]),
	}
	assertEquals(
		(await assertRejects(() => unseal(cbor.encode(other), DOC), SealError)).code,
		"signature",
	)
	const bare = { ...o, signature: o.signature.slice(8) }
	assertEquals(
		(await assertRejects(() => unseal(cbor.encode(bare), DOC), SealError)).code,
		"signature",
	)
	// the right header with a wrong size of signature
	const short = { ...o, signature: o.signature.slice(0, -1) }
	assertEquals(
		(await assertRejects(() => unseal(cbor.encode(short), DOC), SealError)).code,
		"shape",
	)
	// a caller's verifier, added for the header: then it is the one that says
	const header = other.signature.slice(0, 8)
	let asked = 0
	const mine: Verifier = {
		header,
		code: 0xed,
		size: 64,
		verify: (_signature, key) => (asked++, Promise.resolve(key.length === raw.length)),
	}
	assertEquals((await unseal(cbor.encode(other), DOC, [mine])).commit.table, "value")
	assertEquals(asked, 1)
})

Deno.test("seal: a seal is good in its own document only: what is signed is the domain, the document, then the name", async () => {
	const a = await createSigner(new Uint8Array(32).fill(1))
	const sealed = await seal(encode(commitBy(a.key)), a, DOC)
	assertEquals((await unseal(sealed, DOC)).commit.table, "value")
	const elsewhere = new Uint8Array(32).fill(0x2b)
	assertEquals((await assertRejects(() => unseal(sealed, elsewhere), SealError)).code, "signature")
	assertEquals(
		(await assertRejects(() => unseal(sealed, new Uint8Array(31)), SealError)).code,
		"shape",
	)
})
