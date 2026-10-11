import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { type Blop, encode, name } from "../../encoding/ts/blop.ts"
import * as cbor from "../../encoding/ts/cbor.ts"
import { good, seal, SealError, type Signer, stored, unseal } from "./seal.ts"

const code = (f: () => unknown) => (assertThrows(f, SealError) as SealError).code
const rejected = async (f: () => Promise<unknown>) =>
	((await assertRejects(f, SealError)) as SealError).code
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16))
const L = ed25519.Point.Fn.ORDER

function device(seed: number): Signer {
	const secret = new Uint8Array(32).fill(seed)
	return { key: ed25519.getPublicKey(secret), sign: async (m) => ed25519.sign(m, secret) }
}
const alice = device(1), bob = device(2)

const blop = (signer: Uint8Array, more: Partial<Blop> = {}) =>
	encode({
		node: "n1",
		object: "value",
		actor: "alice",
		signer,
		nonce: new Uint8Array(8).fill(9),
		parents: [],
		lamport: 1,
		patches: [{ path: [], value: 1 }],
		...more,
	})

Deno.test("seal: RFC 8032 test 1 is good", () => {
	const key = unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
	const sig = unhex(
		"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
	)
	assertEquals(good(sig, key, new Uint8Array()), true)
	assertEquals(good(sig, key, new Uint8Array([0])), false)
})

Deno.test("seal: round trip", async () => {
	const b = blop(alice.key)
	const s = await seal(b, alice)
	const u = unseal(s)
	assertEquals(u.blop.node, "n1")
	assertEquals(u.name, name(b))
	assertEquals(u.stored, blake3(s))
	assertEquals(stored(s), u.stored)
	assertEquals(u.signer, alice.key)
	const raw = cbor.decode(s) as { [k: string]: cbor.Value }
	assertEquals(Object.keys(raw).sort(), ["change", "signature", "signer"])
	assertEquals(raw.change instanceof ArrayBuffer, true)
})

Deno.test("seal: signed is ermine/v0/change then the name", async () => {
	const b = blop(alice.key)
	const raw = cbor.decode(await seal(b, alice)) as { [k: string]: ArrayBuffer }
	const m = new Uint8Array([...new TextEncoder().encode("ermine/v0/change"), ...name(b)])
	assertEquals(m.length, 48)
	assertEquals(ed25519.verify(new Uint8Array(raw.signature), m, alice.key), true)
})

Deno.test("seal: the blop's signer is the seal's", async () => {
	assertEquals(await rejected(() => seal(blop(bob.key), alice)), "signature")
	const lying: Signer = { key: alice.key, sign: bob.sign }
	assertEquals(await rejected(() => seal(blop(alice.key), lying)), "signature")
})

Deno.test("seal: shape", async () => {
	assertEquals(await rejected(() => seal(new Uint8Array([0xf6]), alice)), "shape")
	const raw = cbor.decode(await seal(blop(alice.key), alice)) as { [k: string]: cbor.Value }
	assertEquals(code(() => unseal(new Uint8Array([0xff]))), "shape")
	assertEquals(code(() => unseal(cbor.encode({ ...raw, more: 1 }))), "shape")
	const { signer: _, ...two } = raw
	assertEquals(code(() => unseal(cbor.encode(two))), "shape")
	assertEquals(
		code(() =>
			unseal(cbor.encode({ ...raw, signer: new Uint8Array(raw.signer as ArrayBuffer) }))
		),
		"shape",
	)
	assertEquals(
		code(() => unseal(cbor.encode({ ...raw, signature: new ArrayBuffer(63) }))),
		"shape",
	)
	// shape before signature: a bad blop with a bad signature
	assertEquals(
		code(() =>
			unseal(cbor.encode({ ...raw, change: new ArrayBuffer(1), signature: new ArrayBuffer(64) }))
		),
		"shape",
	)
})

Deno.test("seal: a changed field, a signature not good", async () => {
	const raw = cbor.decode(await seal(blop(alice.key), alice)) as { [k: string]: ArrayBuffer }
	const other = blop(alice.key, { lamport: 2 }).slice().buffer
	assertEquals(code(() => unseal(cbor.encode({ ...raw, change: other }))), "signature")
	const sig = new Uint8Array(raw.signature)
	sig[0] ^= 1
	assertEquals(
		code(() => unseal(cbor.encode({ ...raw, signature: sig.slice().buffer }))),
		"signature",
	)
	// the blop's signer is bob, the seal's alice
	const bobs = blop(bob.key)
	const forged = cbor.encode({
		change: bobs.slice().buffer,
		signer: raw.signer,
		signature: raw.signature,
	})
	assertEquals(code(() => unseal(forged)), "signature")
})

const le = (n: bigint) => {
	const out = new Uint8Array(32)
	for (let i = 0; i < 32; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn)
	return out
}
const little = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n)

Deno.test("strict: S < L", () => {
	const m = new Uint8Array([1, 2, 3])
	const secret = new Uint8Array(32).fill(1)
	const sig = ed25519.sign(m, secret)
	assertEquals(good(sig, alice.key, m), true)
	const s = little(sig.subarray(32))
	const big = new Uint8Array([...sig.subarray(0, 32), ...le(s + L)])
	assertEquals(good(big, alice.key, m), false)
})

Deno.test("strict: small order and non-canonical points", () => {
	const m = new Uint8Array([1])
	// the identity: small order, as A and as R; with S = 0 the equation holds for any k
	const identity = le(1n)
	const zero = new Uint8Array(32)
	assertEquals(good(new Uint8Array([...identity, ...zero]), identity, m), false)
	// R the identity, A good, S = k·a would hold the equation but R is of small order
	assertEquals(good(new Uint8Array([...identity, ...zero]), alice.key, m), false)
	// y = p: not the canonical encoding of y = 0
	const p = (1n << 255n) - 19n
	const sig = ed25519.sign(m, new Uint8Array(32).fill(1))
	assertEquals(good(sig, le(p), m), false)
	// x = 0 with the sign bit set: not canonical
	const negzero = le(1n)
	negzero[31] |= 0x80
	assertEquals(good(sig, negzero, m), false)
})

Deno.test("strict: no cofactor", () => {
	// R + T, T of order 2 (y = -1): the cofactored check takes it, this one does not
	const m = new Uint8Array([7])
	const secret = new Uint8Array(32).fill(1)
	const T = ed25519.Point.fromBytes(le((1n << 255n) - 20n))
	assertEquals(T.isSmallOrder(), true)
	// a nonce r, R = rB + T, S = r + k a, with k over the new R
	const scalar = ed25519.utils.getExtendedPublicKey(secret).scalar
	const r = 12345n
	const R = ed25519.Point.BASE.multiply(r).add(T)
	const Rb = R.toBytes()
	const k = little(
		ed25519.CURVE.hash(new Uint8Array([...Rb, ...alice.key, ...m])),
	) % L
	const S = (r + k * scalar) % L
	const sig = new Uint8Array([...Rb, ...le(S)])
	assertEquals(ed25519.verify(sig, m, alice.key), true)
	assertEquals(good(sig, alice.key, m), false)
})
