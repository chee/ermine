// a blop (BLOP.tex) signed by the device that made it, and the id it is stored under (SEAL.tex)
// signed: "ermine/v0/change", then the blop's name; checked strictly, by the rule below
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { sha512 } from "npm:@noble/hashes@1.8.0/sha2"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import * as cbor from "../../encoding/ts/cbor.ts"
import { type Blop, BlopError, decode, name } from "../../encoding/ts/blop.ts"

// the host's, never held by sync: the device's Ed25519 public key, and signing with it, which may
// wait on a keychain or a lock
export type Signer = { key: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> }

export type Unsealed = { blop: Blop; name: Uint8Array; stored: Uint8Array; signer: Uint8Array }

export type Code = "shape" | "signature"

export class SealError extends Error {
	constructor(readonly code: Code) {
		super(code)
	}
}

const DOMAIN = new TextEncoder().encode("ermine/v0/change")
const Point = ed25519.Point
const L = Point.Fn.ORDER

function message(blop: Uint8Array, named = name(blop)): Uint8Array {
	const m = new Uint8Array(DOMAIN.length + 32)
	m.set(DOMAIN)
	m.set(named, DOMAIN.length)
	return m
}

const little = (b: Uint8Array) => {
	let n = 0n
	for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
	return n
}
const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

// its one canonical encoding, of no small order; none otherwise
function point(b: Uint8Array) {
	try {
		const p = Point.fromBytes(b, false)
		if (!same(p.toBytes(), b) || p.isSmallOrder()) return
		return p
	} catch {
		return
	}
}

// good only if: S < L; A and R canonical and not of small order; [S]B = R + [k]A, no cofactor
export function good(signature: Uint8Array, key: Uint8Array, m: Uint8Array): boolean {
	if (signature.length !== 64 || key.length !== 32) return false
	const r = signature.subarray(0, 32), s = little(signature.subarray(32))
	if (s >= L) return false
	const A = point(key), R = point(r)
	if (!A || !R) return false
	const h = new Uint8Array(64 + m.length)
	h.set(r)
	h.set(key, 32)
	h.set(m, 64)
	const k = little(sha512(h)) % L
	return Point.BASE.multiplyUnsafe(s).equals(R.add(A.multiplyUnsafe(k)))
}

function blopOf(b: Uint8Array): Blop {
	try {
		return decode(b)
	} catch (e) {
		if (e instanceof BlopError) throw new SealError("shape")
		throw e
	}
}

// the sealed change's bytes: {change, signer, signature}. made: the blop decoded and its name, from
// the code that encoded it: taken as given, not decoded or named again
export async function seal(
	blop: Uint8Array,
	signer: Signer,
	made?: { blop: Blop; name: Uint8Array },
): Promise<Uint8Array> {
	const b = made?.blop ?? blopOf(blop)
	const key = signer.key
	if (!(key instanceof Uint8Array) || key.length !== 32) throw new SealError("shape")
	if (!same(b.signer, key)) throw new SealError("signature")
	const m = made ? message(blop, made.name) : message(blop)
	const signature = await signer.sign(m)
	if (!(signature instanceof Uint8Array) || signature.length !== 64) {
		throw new SealError("shape")
	}
	if (!good(signature, key, m)) throw new SealError("signature")
	return cbor.encode({ change: blop, signer: key, signature })
}

const isBytes = (x: unknown, n?: number): x is Uint8Array =>
	x instanceof Uint8Array && (n === undefined || x.length === n)

// the blop decoded, its name, the stored id, and who signed it
export function unseal(bytes: Uint8Array): Unsealed {
	let x: unknown
	try {
		x = cbor.decode(bytes)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new SealError("shape")
		throw e
	}
	if (x === null || typeof x !== "object" || Array.isArray(x)) throw new SealError("shape")
	const f = x as { [k: string]: unknown }
	const keys = Object.keys(f)
	if (keys.length !== 3) throw new SealError("shape")
	if (!isBytes(f.change) || !isBytes(f.signer, 32) || !isBytes(f.signature, 64)) {
		throw new SealError("shape")
	}
	const change = f.change, signer = f.signer
	const blop = blopOf(change)
	if (!same(blop.signer, signer)) throw new SealError("signature")
	if (!good(f.signature, signer, message(change))) {
		throw new SealError("signature")
	}
	return { blop, name: name(change), stored: blake3(bytes), signer }
}

// the stored id: the BLAKE3 hash of the sealed change, signer and signature too
export function stored(bytes: Uint8Array): Uint8Array {
	return blake3(bytes)
}
