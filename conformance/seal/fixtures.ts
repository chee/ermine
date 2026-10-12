// Writes the seal scenarios (sync/conformance/seal/*.json) from SEAL.tex, never importing seal.ts
// or blop.ts: blops are canonical maps made with the CBOR codec (BLOP.tex), signatures Ed25519 from
// noble, hashes BLAKE3. Run: deno run --allow-write --allow-read fixtures.ts
// A scenario: {title, ask: [requests], expect: [answers]}, an answer per request (harness.ts).
//
// The strict rule's vectors (SEAL.tex, Strict) are each checked here twice: by strict(), which
// names the rules a signature breaks, and by lax(), a check as a lenient library makes it (points
// decoded as ZIP 215 decodes them: y up to 2^255, x = 0 with the sign bit allowed, small order
// allowed; S not range-checked; [S]B = R + [k]A without the cofactor). Each strict vector must
// break the rules its title names, and only those, and lax() must accept it: so a seal() or
// unseal() that leans on such a library alone fails the scenario
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { sha512 } from "npm:@noble/hashes@1.8.0/sha2"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { decode, encode, type Value } from "@ermine/encoding/cbor"

const here = new URL(".", import.meta.url).pathname
const out = `${here}../../extensions/subduction/conformance/seal/`

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const utf8 = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Uint8Array[]) => {
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) all.set(p, (at += p.length) - p.length)
	return all
}
const fail = (why: string): never => {
	throw new Error(why)
}

// -- keys: seed A is RFC 8032's TEST 1, its public key checked against the RFC
const SEED_A = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
const SEED_B = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i)
const KEY_A = ed25519.getPublicKey(SEED_A)
const KEY_B = ed25519.getPublicKey(SEED_B)
if (hex(KEY_A) !== "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a") {
	fail("RFC 8032 TEST 1 key")
}

// -- blops (BLOP.tex), canonical maps; the codec sorts the keys
const NODE = "ermine://0c8c6f9648e6a9d929cf6d0cd4a04d186434b25d9b58dc1c984d4f31b85217ce"
const plain = (signer: Uint8Array, more: Record<string, Value> = {}) =>
	encode({
		node: NODE,
		object: "value",
		actor: "a",
		signer,
		nonce: Uint8Array.from({ length: 8 }, (_, i) => i + 1),
		parents: [],
		lamport: 1,
		patches: [],
		...more,
	})
const P1 = new Uint8Array(32).fill(0x11), P2 = new Uint8Array(32).fill(0x22)
const rich = (signer: Uint8Array) =>
	encode({
		node: NODE,
		object: ["info", "title"],
		actor: { device: "d", n: 2 },
		reader: "r",
		site: { file: "file:///a.ts", line: 3, column: 7, function: "f" },
		cause: ["merge", null],
		signer,
		nonce: new Uint8Array(8).fill(0xa5),
		parents: [P1, P2],
		base: P2,
		combine: true,
		lamport: 3,
		patches: [{ path: ["t", 0], range: [0, 2], value: "hi" }, {
			path: ["t"],
			move: { path: ["u"] },
		}],
	})

// -- sealing (SEAL.tex)
const message = (blop: Uint8Array) => cat(utf8("ermine/v0/change"), blake3(blop))
const sealed = (blop: Uint8Array, signer: Uint8Array, signature: Uint8Array) =>
	encode({ change: blop, signer, signature })
const sign = (blop: Uint8Array, seed: Uint8Array) => ed25519.sign(message(blop), seed)
const unsealed = (blop: Uint8Array, bytes: Uint8Array, signer: Uint8Array) => ({
	blop: hex(blop),
	name: hex(blake3(blop)),
	stored: hex(blake3(bytes)),
	signer: hex(signer),
})

// -- the curve, by hand
const p = 2n ** 255n - 19n
const L = 2n ** 252n + 27742317777372353535851937790883648493n
const le = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n)
const tole = (n: bigint) =>
	Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n))
const Point = ed25519.Point
const B = Point.BASE
const times = (P: typeof B, n: bigint) => n === 0n ? Point.ZERO : P.multiplyUnsafe(n)
const k = (R: Uint8Array, A: Uint8Array, M: Uint8Array) => le(sha512(cat(R, A, M))) % L
// RFC 8032's secret scalar from a seed
const scalar = (seed: Uint8Array) => {
	const h = sha512(seed).slice(0, 32)
	h[0] &= 248
	h[31] &= 127
	h[31] |= 64
	return le(h)
}
const IDENTITY = tole(1n)
const IDENTITY_P = tole(p + 1n) // y = p + 1 ≥ p: the identity's other spelling
const IDENTITY_SIGN = (() => { // x = 0 with the sign bit set
	const b = tole(1n)
	b[31] |= 0x80
	return b
})()

// the rules a signature breaks, SEAL.tex's Strict read plainly
function strict(R: Uint8Array, A: Uint8Array, S: Uint8Array, M: Uint8Array): string[] {
	const broken: string[] = []
	const s = le(S)
	if (s >= L) broken.push("S ≥ L")
	const points: Record<string, typeof B> = {}
	for (const [name, P] of [["A", A], ["R", R]] as const) {
		const y = le(P) & (2n ** 255n - 1n)
		const point = Point.fromHex(P, true)
		points[name] = point
		if (y >= p || (point.toAffine().x === 0n && (P[31] & 0x80) !== 0)) {
			broken.push(`${name} non-canonical`)
		}
		if (times(point, 8n).equals(Point.ZERO)) broken.push(`${name} small order`)
	}
	if (!times(B, s % L).equals(points.R.add(times(points.A, k(R, A, M))))) broken.push("equation")
	return broken
}
// a lenient library's check: everything but the equation, without the cofactor, skipped
function lax(R: Uint8Array, A: Uint8Array, S: Uint8Array, M: Uint8Array) {
	const r = Point.fromHex(R, true), a = Point.fromHex(A, true)
	return times(B, le(S) % L).equals(r.add(times(a, k(R, A, M))))
}

const GOOD = plain(KEY_A)
// R given, S = k·a mod L for key A's scalar a: [S]B = [k]A, so R + [k]A = [S]B for R the identity
const forged = (R: Uint8Array, blop: Uint8Array) =>
	cat(R, tole((k(R, KEY_A, message(blop)) * scalar(SEED_A)) % L))
// any scalar r: R = [r]B, S = r makes [S]B = R + [k]A, A the identity's either spelling
const r = 0x1234567890abcdefn
const R_R = cat(times(B, r).toBytes(), tole(r))

type Strict = {
	file: string
	title: string
	key: Uint8Array
	signature: Uint8Array
	breaks: string[]
}
const goodSig = sign(GOOD, SEED_A)
const strictVectors: Strict[] = [
	{
		file: "s1-s-not-below-l",
		title: "S ≥ L: a good signature's S + L; [S]B is unchanged, so a check without S < L passes",
		key: KEY_A,
		signature: cat(goodSig.slice(0, 32), tole(le(goodSig.slice(32)) + L)),
		breaks: ["S ≥ L"],
	},
	{
		file: "s2-a-non-canonical",
		title:
			"A non-canonical, y = p + 1 (the identity spelled with y ≥ p, so of small order too: every A with y ≥ p is, y < 19); R = [r]B, S = r. Passes ZIP 215 and any check reducing y mod p without a small-order test",
		key: IDENTITY_P,
		signature: R_R,
		breaks: ["A non-canonical", "A small order"],
	},
	{
		file: "s3-r-non-canonical",
		title:
			"R non-canonical, y = p + 1 (the identity spelled with y ≥ p, so of small order too); A key A, S = k·a mod L so [S]B = [k]A = R + [k]A. Passes ZIP 215 and any check reducing y mod p without a small-order test",
		key: KEY_A,
		signature: forged(IDENTITY_P, GOOD),
		breaks: ["R non-canonical", "R small order"],
	},
	{
		file: "s4-a-small-order",
		title:
			"A of small order: the identity, canonical; R = [r]B, S = r, so [S]B = R + [k]A for any k. Passes a check without the small-order test, cofactored or not",
		key: IDENTITY,
		signature: R_R,
		breaks: ["A small order"],
	},
	{
		file: "s5-r-small-order",
		title:
			"R of small order: the identity, canonical; A key A, S = k·a mod L. Passes a check without the small-order test, cofactored or not",
		key: KEY_A,
		signature: forged(IDENTITY, GOOD),
		breaks: ["R small order"],
	},
	{
		file: "s6-r-x-zero-sign",
		title:
			"R with x = 0 and the sign bit set (the identity, 01 00 … 80, so of small order too: x = 0 only at y = ±1); A key A, S = k·a mod L. Passes ZIP 215",
		key: KEY_A,
		signature: forged(IDENTITY_SIGN, GOOD),
		breaks: ["R non-canonical", "R small order"],
	},
	{
		file: "s7-a-x-zero-sign",
		title:
			"A with x = 0 and the sign bit set (the identity, 01 00 … 80, so of small order too); R = [r]B, S = r. Passes ZIP 215",
		key: IDENTITY_SIGN,
		signature: R_R,
		breaks: ["A non-canonical", "A small order"],
	},
	{
		file: "s8-a-and-r-identity-s-zero",
		title:
			"A and R the identity, S = 0: [0]B = R + [k]A for every message. Passes a lax or cofactored check",
		key: IDENTITY,
		signature: cat(IDENTITY, tole(0n)),
		breaks: ["A small order", "R small order"],
	},
]

type Scenario = { title: string; ask: Record<string, unknown>[]; expect: Record<string, unknown>[] }
const scenarios: [string, Scenario][] = []
const add = (file: string, s: Scenario) => scenarios.push([file, s])
// unseal of bytes that must fail with code
const refuse = (file: string, title: string, bytes: Uint8Array, code: string) =>
	add(file, { title, ask: [{ op: "unseal", bytes: hex(bytes) }], expect: [{ code }] })

// -- good
const GOOD_SEALED = sealed(GOOD, KEY_A, goodSig)
if (strict(goodSig.slice(0, 32), KEY_A, goodSig.slice(32), message(GOOD)).length) fail("good A")
add("01-good", {
	title:
		"a seal from RFC 8032's TEST 1 seed, bytes exactly (Ed25519 is deterministic); unseal and stored",
	ask: [
		{ op: "seal", blop: hex(GOOD), seed: hex(SEED_A) },
		{ op: "unseal", bytes: hex(GOOD_SEALED) },
		{ op: "stored", bytes: hex(GOOD_SEALED) },
	],
	expect: [
		{ bytes: hex(GOOD_SEALED) },
		unsealed(GOOD, GOOD_SEALED, KEY_A),
		{ stored: hex(blake3(GOOD_SEALED)) },
	],
})
const RICH = rich(KEY_B)
const RICH_SEALED = sealed(RICH, KEY_B, sign(RICH, SEED_B))
add("02-good-every-field", {
	title: "a seal of a blop with every optional field, another seed",
	ask: [
		{ op: "seal", blop: hex(RICH), seed: hex(SEED_B) },
		{ op: "unseal", bytes: hex(RICH_SEALED) },
	],
	expect: [{ bytes: hex(RICH_SEALED) }, unsealed(RICH, RICH_SEALED, KEY_B)],
})
add("03-stored", {
	title: "stored: the BLAKE3 of any bytes, a seal or not",
	ask: ["", "00", "ffff", hex(GOOD)].map((b) => ({ op: "stored", bytes: b })),
	expect: ["", "00", "ffff", hex(GOOD)].map((b) => ({ stored: hex(blake3(unhex(b))) })),
})

// -- seal refusals
add("04-seal-other-signer", {
	title: "seal: the blop's signer is key B, the seed's key is A: signature",
	ask: [{ op: "seal", blop: hex(plain(KEY_B)), seed: hex(SEED_A) }],
	expect: [{ code: "signature" }],
})
add("05-seal-not-a-blop", {
	title: "seal: bytes that are not a blop (a map of one key; bytes not CBOR): shape",
	ask: [
		{ op: "seal", blop: hex(encode({ a: 1 })), seed: hex(SEED_A) },
		{ op: "seal", blop: "ff", seed: hex(SEED_A) },
	],
	expect: [{ code: "shape" }, { code: "shape" }],
})
add("06-seal-shape-first", {
	title: "seal: a blop with lamport 0 whose signer is not the seed's key: shape before signature",
	ask: [{ op: "seal", blop: hex(plain(KEY_B, { lamport: 0 })), seed: hex(SEED_A) }],
	expect: [{ code: "shape" }],
})

// -- unseal: shape
const e = (x: Value) => encode(x)
const SIG = goodSig
const notCanonical: [string, Uint8Array][] = [
	[
		"keys out of order (signer before change)",
		cat(
			Uint8Array.of(0xa3),
			e("signer"),
			e(KEY_A),
			e("change"),
			e(GOOD),
			e("signature"),
			e(SIG),
		),
	],
	[
		"the signer's length in a longer head than needed (59 0020)",
		cat(
			Uint8Array.of(0xa3),
			e("change"),
			e(GOOD),
			e("signer"),
			Uint8Array.of(0x59, 0x00, 0x20),
			KEY_A,
			e("signature"),
			e(SIG),
		),
	],
	["a byte after the map", cat(GOOD_SEALED, Uint8Array.of(0))],
	[
		"an indefinite-length map",
		cat(
			Uint8Array.of(0xbf),
			e("change"),
			e(GOOD),
			e("signer"),
			e(KEY_A),
			e("signature"),
			e(SIG),
			Uint8Array.of(0xff),
		),
	],
]
for (const [why, b] of notCanonical) {
	try {
		decode(b)
	} catch {
		continue
	}
	fail(`the codec takes "${why}"`)
}
add("10-not-canonical", {
	title: `not the canonical encoding, each else a good seal: shape. ${
		notCanonical.map(([w]) => w).join("; ")
	}`,
	ask: notCanonical.map(([, b]) => ({ op: "unseal", bytes: hex(b) })),
	expect: notCanonical.map(() => ({ code: "shape" })),
})
add("11-not-a-map", {
	title: "not a map: a list of the three byte strings, or nothing at all: shape",
	ask: [
		{ op: "unseal", bytes: hex(e([GOOD, KEY_A, SIG])) },
		{ op: "unseal", bytes: "" },
	],
	expect: [{ code: "shape" }, { code: "shape" }],
})
refuse(
	"12-missing-key",
	"no signature key: shape",
	e({ change: GOOD, signer: KEY_A }),
	"shape",
)
refuse(
	"13-extra-key",
	'a fourth key, "time", beside a good seal\'s three: shape',
	e({ change: GOOD, signer: KEY_A, signature: SIG, time: new Uint8Array(8) }),
	"shape",
)
refuse(
	"14-signer-31",
	"signer 31 bytes, key A without its last byte: shape",
	sealed(GOOD, KEY_A.slice(0, 31), SIG),
	"shape",
)
refuse(
	"15-signature-63",
	"signature 63 bytes, a good one without its last byte: shape",
	sealed(GOOD, KEY_A, SIG.slice(0, 63)),
	"shape",
)
refuse(
	"16-signer-not-bytes",
	"signer a typed array (uint16, tag 69) of the key's 32 bytes, not a byte string: shape",
	e({ change: GOOD, signer: new Uint16Array(KEY_A.slice().buffer), signature: SIG }),
	"shape",
)
refuse(
	"17-change-a-map",
	"change the blop as a nested map, not a byte string of it: shape",
	e({ change: decode(GOOD), signer: KEY_A, signature: SIG }),
	"shape",
)
const LAMPORT0 = plain(KEY_A, { lamport: 0 })
const NO_NONCE = e({
	node: NODE,
	object: "value",
	actor: "a",
	signer: KEY_A,
	parents: [],
	lamport: 1,
	patches: [],
})
add("18-bad-blop", {
	title:
		"the change not a blop, each signed well by its signer over its BLAKE3: lamport 0; no nonce; an integer (00): shape",
	ask: [LAMPORT0, NO_NONCE, Uint8Array.of(0)].map((b) => ({
		op: "unseal",
		bytes: hex(sealed(b, KEY_A, sign(b, SEED_A))),
	})),
	expect: [0, 1, 2].map(() => ({ code: "shape" })),
})

// -- unseal: signature
const B_BLOP = plain(KEY_B)
refuse(
	"20-blop-signer-other",
	"the blop's signer key B, the seal's signer key A, signed well by A: signature",
	sealed(B_BLOP, KEY_A, sign(B_BLOP, SEED_A)),
	"signature",
)
const FLIPPED = SIG.slice()
FLIPPED[32] ^= 1
if (lax(FLIPPED.slice(0, 32), KEY_A, FLIPPED.slice(32), message(GOOD))) fail("flipped passes")
refuse(
	"21-flipped-bit",
	"a good signature with S's lowest bit flipped: signature",
	sealed(GOOD, KEY_A, FLIPPED),
	"signature",
)
refuse(
	"22-signed-other-blop",
	"a signature by key A over another blop's name: signature",
	sealed(GOOD, KEY_A, sign(plain(KEY_A, { lamport: 2 }), SEED_A)),
	"signature",
)

// -- strict
strictVectors.forEach((v, i) => {
	const blop = plain(v.key)
	const M = message(blop)
	const R = v.signature.slice(0, 32), S = v.signature.slice(32)
	if (v.signature.length !== 64) fail(`${v.file}: length`)
	const broken = strict(R, v.key, S, M)
	if (broken.join() !== v.breaks.join()) fail(`${v.file}: breaks ${broken} not ${v.breaks}`)
	if (!lax(R, v.key, S, M)) fail(`${v.file}: a lax check refuses it`)
	refuse(
		`3${i}-${v.file.slice(3)}`,
		`strict: ${v.title}: signature`,
		sealed(blop, v.key, v.signature),
		"signature",
	)
})

// -- two faults
add("40-shape-before-signature", {
	title:
		"two faults, shape first: lamport 0 and a flipped signature bit; a fourth key and the blop's signer not the seal's",
	ask: [
		sealed(
			LAMPORT0,
			KEY_A,
			(() => {
				const s = sign(LAMPORT0, SEED_A)
				s[32] ^= 1
				return s
			})(),
		),
		e({
			change: B_BLOP,
			signer: KEY_A,
			signature: sign(B_BLOP, SEED_A),
			time: new Uint8Array(8),
		}),
	].map((b) => ({ op: "unseal", bytes: hex(b) })),
	expect: [{ code: "shape" }, { code: "shape" }],
})

// -- no uint8 kind: bytes are bytes (the designer, 10-12)
// the seal's own signer: its key after the change's bytes, where the blop's signer is
const SEALED = hex(sealed(GOOD, KEY_A, SIG)), SIGNER = "667369676e65725820" + hex(KEY_A)
const OWN = SEALED.lastIndexOf(SIGNER)
refuse(
	"41-signer-tag-64",
	"signer as tag 64 over the key's 32 bytes: no encoding of a value: shape",
	unhex(SEALED.slice(0, OWN) + "667369676e6572d840" + SEALED.slice(OWN + 14)),
	"shape",
)

for (const f of Deno.readDirSync(out)) if (f.name.endsWith(".json")) Deno.removeSync(out + f.name)
for (const [name, s] of scenarios) {
	Deno.writeTextFileSync(`${out}${name}.json`, JSON.stringify(s, null, "\t") + "\n")
}
console.log(`${scenarios.length} scenarios in ${out}`)
