import { assertEquals, assertRejects } from "@std/assert"
import { type Commit, encode } from "@ermine/encoding/commit"
import * as cbor from "@ermine/encoding/cbor"
import { createSigner, seal, SealError, unseal } from "./seal.ts"

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
	const sealed = await seal(bytes, s)
	const u = await unseal(sealed)
	assertEquals(u.bytes, bytes)
	assertEquals(u.commit.table, "value")
	// a new key, not from a seed
	const n = await createSigner()
	assertEquals(n.key.length, 32)
	await unseal(await seal(encode(commitBy(n.key)), n))
})

Deno.test("seal: another's commit refused; a signature changed refused; a shape not a seal refused", async () => {
	const a = await createSigner(new Uint8Array(32).fill(1)),
		b = await createSigner(new Uint8Array(32).fill(2))
	const e = await assertRejects(() => seal(encode(commitBy(b.key)), a), SealError)
	assertEquals(e.code, "signature")
	const sealed = await seal(encode(commitBy(a.key)), a)
	const o = cbor.decode(sealed) as { commit: Uint8Array; signature: Uint8Array }
	o.signature[0] ^= 1
	assertEquals((await assertRejects(() => unseal(cbor.encode(o)), SealError)).code, "signature")
	assertEquals((await assertRejects(() => unseal(new Uint8Array([1])), SealError)).code, "shape")
})
