// a commit signed by the device that made it, and the id it is stored under (extensions/subduction/
// plan.org, Rewrite for the new shape, 2). sealed: {commit: its bytes, signature}, the signer's key
// once (it is in the commit). signed: "ermine/v0/commit" then the commit's name. Ed25519 through
// WebCrypto, which every browser, Deno and Node have: a key made here never leaves as bytes
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, decode, name as nameOf } from "@ermine/encoding/commit"

export type Signer = { key: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> }

export type Code = "shape" | "signature"

export class SealError extends Error {
	constructor(readonly code: Code) {
		super(code)
	}
}

const DOMAIN = new TextEncoder().encode("ermine/v0/commit")
// what a seed is wrapped in for WebCrypto to take it (RFC 8410, PKCS#8)
const PKCS8 = Uint8Array.from([
	0x30,
	0x2e,
	0x02,
	0x01,
	0x00,
	0x30,
	0x05,
	0x06,
	0x03,
	0x2b,
	0x65,
	0x70,
	0x04,
	0x22,
	0x04,
	0x20,
])

const message = (name: Uint8Array) => {
	const m = new Uint8Array(DOMAIN.length + name.length)
	m.set(DOMAIN)
	m.set(name, DOMAIN.length)
	return m
}

const unbase64url = (s: string) =>
	Uint8Array.from(
		atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
		(c) => c.charCodeAt(0),
	)

// a signer: from a 32-byte seed (the same key on every run), or a new key that cannot be exported
export async function createSigner(seed?: Uint8Array): Promise<Signer> {
	let privateKey: CryptoKey, key: Uint8Array
	if (seed === undefined) {
		const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
			"sign",
			"verify",
		]) as CryptoKeyPair
		privateKey = pair.privateKey
		key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	} else {
		if (seed.length !== 32) throw new SealError("shape")
		const der = new Uint8Array(PKCS8.length + 32)
		der.set(PKCS8)
		der.set(seed, PKCS8.length)
		// its public half from its JWK, then the private half made again, not exportable
		const open = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"])
		key = unbase64url((await crypto.subtle.exportKey("jwk", open)).x!)
		privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"])
	}
	return {
		key,
		sign: async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, m.slice())),
	}
}

// the signature good for this key and message
export async function good(
	signature: Uint8Array,
	key: Uint8Array,
	m: Uint8Array,
): Promise<boolean> {
	try {
		const k = await crypto.subtle.importKey("raw", key.slice(), { name: "Ed25519" }, false, [
			"verify",
		])
		return await crypto.subtle.verify("Ed25519", k, signature.slice(), m.slice())
	} catch {
		return false
	}
}

// the sealed commit's bytes. the commit's signer must be this signer's key. made: its name, and
// its commit, from whoever just made it: not decoded or named again; given a name and no commit, the
// caller vouches that its signer is this one (a device sealing its own)
export async function seal(
	bytes: Uint8Array,
	signer: Signer,
	made?: { commit?: Commit; name: Uint8Array },
): Promise<Uint8Array> {
	const commit = made ? made.commit : decode(bytes)
	if (commit && !same(commit.signer, signer.key)) throw new SealError("signature")
	const signature = await signer.sign(message(made?.name ?? nameOf(bytes)))
	if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new SealError("shape")
	return cbor.encode({ commit: bytes, signature })
}

export type Unsealed = { commit: Commit; bytes: Uint8Array; name: Uint8Array; stored: Uint8Array }

// the commit, checked: its shape, and its signer's signature
export async function unseal(sealed: Uint8Array): Promise<Unsealed> {
	let x: unknown
	try {
		x = cbor.decode(sealed)
	} catch {
		throw new SealError("shape")
	}
	if (x === null || typeof x !== "object" || Array.isArray(x)) throw new SealError("shape")
	const o = x as Record<string, unknown>
	if (Object.keys(o).length !== 2 || !(o.commit instanceof Uint8Array)) {
		throw new SealError("shape")
	}
	const signature = o.signature
	if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new SealError("shape")
	let commit: Commit
	try {
		commit = decode(o.commit)
	} catch {
		throw new SealError("shape")
	}
	const name = nameOf(o.commit)
	if (!(await good(signature, commit.signer, message(name)))) throw new SealError("signature")
	return { commit, bytes: o.commit, name, stored: stored(sealed) }
}

// the id a sealed commit is stored under: the BLAKE3 hash of its sealed bytes
export function stored(sealed: Uint8Array): Uint8Array {
	return blake3(sealed)
}

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])
