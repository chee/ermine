// a blop (BLOP.tex) signed by the device that made it, and the id it is stored under (SEAL.tex)
// signed: "ermine/v0/change", then the blop's name; checked strictly, by the rule below
import { blake3 } from "@ermine/blake3"
import { sha512 } from "npm:@noble/hashes@1.8.0/sha2"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import * as cbor from "@ermine/encoding/cbor"
import { type Blop, BlopError, decode, name } from "@ermine/encoding/blop"

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

// ---- checking fast: the strict rule's byte checks here, the equation by WebCrypto where this
// platform's WebCrypto decides the probe's signatures as good() does; noble's good() otherwise

const P = 2n ** 255n - 19n
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
// the 8 points of small order, encoded canonically
const SMALL = new Set([
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0000000000000000000000000000000000000000000000000000000000000080",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
])

// y < p; x = 0 (y = ±1) only with the sign bit clear; not of small order. on the curve: not here
function canonical(b: Uint8Array): boolean {
	const y = little(b) & ((1n << 255n) - 1n), sign = b[31] >> 7
	if (y >= P || (sign && (y === 1n || y === P - 1n))) return false
	return !SMALL.has(hexOf(b))
}

// every rule of good() but the curve and the equation
export function shaped(signature: Uint8Array, key: Uint8Array): boolean {
	if (signature.length !== 64 || key.length !== 32) return false
	return little(signature.subarray(32)) < L && canonical(key) &&
		canonical(signature.subarray(0, 32))
}

// signatures past shaped() good() decides each way: the equation without the cofactor, a key or R
// of mixed order, off the curve. [key, signature, good] over PROBE
const PROBE = "65726d696e652f76302f6368616e67652070726f6265"
const VECTORS: [string, string, boolean][] = [
	// ordinary
	[
		"93c9449be4e3975f799a691f11d3bdab8ac6348ba2afbdfb9310fdb6b32ebdd7",
		"62a1b4e66acb0b37d06030fb317ac0bca8b164f543999ac033114378078f8fcfc52120918230519588dc35be5e7908e0123c11e1d222ec7c7749bc787211d908",
		true,
	],
	// S altered
	[
		"93c9449be4e3975f799a691f11d3bdab8ac6348ba2afbdfb9310fdb6b32ebdd7",
		"62a1b4e66acb0b37d06030fb317ac0bca8b164f543999ac033114378078f8fcfc52120918230519589dc35be5e7908e0123c11e1d222ec7c7749bc787211d908",
		false,
	],
	// R of mixed order: good only with the cofactor
	[
		"93c9449be4e3975f799a691f11d3bdab8ac6348ba2afbdfb9310fdb6b32ebdd7",
		"0e1273217677fd3e28866d181567dbf608acbe80634c71a148bdee6044be12adc6bf9bcc6cca3b171763e848ee319bd7267cce980548bb8e2b7e8c105946d600",
		false,
	],
	// the key of mixed order: good only with the cofactor
	[
		"afe985e432d16abaeed0fbd848db44520ef193bdde65d944b6a942a8f97ab11c",
		"62a1b4e66acb0b37d06030fb317ac0bca8b164f543999ac033114378078f8fcf7e6caad09ad898d489cf66cdd8635b0cad053fa72a2dec50662f980a9f707c09",
		false,
	],
	// the key and R of mixed order, good without the cofactor
	[
		"afe985e432d16abaeed0fbd848db44520ef193bdde65d944b6a942a8f97ab11c",
		"55ae61520ca466adcc4ae4a32dc1633a5d749c64a5b50f136fc3469f27e487e6f46e9f97feac8f81d97a9cc0bfbb26cc99d2935b7a28dcd682a438949f670801",
		true,
	],
	// the key off the curve
	[
		"0200000000000000000000000000000000000000000000000000000000000000",
		"62a1b4e66acb0b37d06030fb317ac0bca8b164f543999ac033114378078f8fcfc52120918230519588dc35be5e7908e0123c11e1d222ec7c7749bc787211d908",
		false,
	],
	// R off the curve
	[
		"93c9449be4e3975f799a691f11d3bdab8ac6348ba2afbdfb9310fdb6b32ebdd7",
		"02000000000000000000000000000000000000000000000000000000000000006ceaac6a8562e801af1fead87be59d2b446768ec35717b8d66b66f0f4c8e6109",
		false,
	],
]

const unhexOf = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const keys = new Map<string, Promise<CryptoKey>>()
const cryptoKey = (key: Uint8Array) => {
	const k = hexOf(key)
	let c = keys.get(k)
	if (!c) {
		c = crypto.subtle.importKey("raw", key.slice(), { name: "Ed25519" }, false, ["verify"])
		keys.set(k, c)
		c.catch(() => keys.delete(k))
	}
	return c
}
async function subtle(signature: Uint8Array, key: Uint8Array, m: Uint8Array): Promise<boolean> {
	try {
		return await crypto.subtle.verify(
			"Ed25519",
			await cryptoKey(key),
			signature.slice(),
			m.slice(),
		)
	} catch {
		return false
	}
}

let which: "auto" | "noble" = "auto"
let probed: Promise<boolean> | undefined
// whether WebCrypto is used: it has Ed25519 and decides every vector as good() does. once
export function fast(): Promise<boolean> {
	if (which === "noble") return Promise.resolve(false)
	probed ??= (async () => {
		try {
			const m = unhexOf(PROBE)
			for (const [k, s, want] of VECTORS) {
				if (await subtle(unhexOf(s), unhexOf(k), m) !== want) return false
			}
			return true
		} catch {
			return false
		}
	})()
	return probed
}

// "auto": WebCrypto where the probe passes (the default); "noble": good() always
export function use(choice: "auto" | "noble"): void {
	which = choice
}

// good(), the same answer, sooner where it can
export async function verify(
	signature: Uint8Array,
	key: Uint8Array,
	m: Uint8Array,
): Promise<boolean> {
	if (!shaped(signature, key)) return false
	if (!(await fast())) return good(signature, key, m)
	return await subtle(signature, key, m)
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
	if (!(await verify(signature, key, m))) throw new SealError("signature")
	return cbor.encode({ change: blop, signer: key, signature })
}

const isBytes = (x: unknown, n?: number): x is Uint8Array =>
	x instanceof Uint8Array && (n === undefined || x.length === n)

// the blop decoded, its name, the stored id, and who signed it. id: the stored id, hashed already
export async function unseal(bytes: Uint8Array, id?: Uint8Array): Promise<Unsealed> {
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
	if (!(await verify(f.signature, signer, message(change)))) {
		throw new SealError("signature")
	}
	return { blop, name: name(change), stored: id ?? blake3(bytes), signer }
}

// the stored id: the BLAKE3 hash of the sealed change, signer and signature too
export function stored(bytes: Uint8Array): Uint8Array {
	return blake3(bytes)
}
