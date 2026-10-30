// The cbor fuzz: random values of every kind and bytes near an encoding, over a few dozen seeds
// (SEEDS for more). Checks round trips (decode(encode(v)) is v, same bytes with keys reordered),
// numbers against a model on bigints and Math.fround, refusal of every non-canonical rewrite, and
// that the harness (HARNESS, e.g. the C one; default the TypeScript) answers as cbor_harness.ts.
import { assert, assertEquals, assertThrows } from "@std/assert"
import { CborError, decode, DEPTH, encode, Stand, type Value } from "./cbor.ts"
import { answer } from "./cbor_harness.ts"
import { line, toJson } from "../../conformance/typescript/form.ts"
import {
	canon,
	cat,
	hex,
	KEYS,
	lone,
	mutate,
	number,
	NUMBERS,
	PARTS,
	type Pick,
	rand,
	rewrites,
	same,
	show,
	shuffled,
	stable,
	value,
} from "./fuzz_values.ts"
import { ask, command } from "../../conformance/typescript/ask.ts"
import { read } from "../../conformance/typescript/json.ts"

const SEEDS = Number(Deno.env.get("SEEDS") ?? 40)
const subject = command("cbor")

// the model ---------------------------------------------------------------------

function integer(n: bigint): string {
	const negative = n < 0n, m = negative ? -1n - n : n
	const major = negative ? 0x20 : 0
	const be = (k: number) => m.toString(16).padStart(2 * k, "0")
	if (m < 24n) return (major | Number(m)).toString(16).padStart(2, "0")
	if (m < 0x100n) return (major | 24).toString(16) + be(1)
	if (m < 0x10000n) return (major | 25).toString(16) + be(2)
	if (m < 0x100000000n) return (major | 26).toString(16) + be(4)
	if (m < 0x10000000000000000n) return (major | 27).toString(16) + be(8)
	let h = m.toString(16)
	if (h.length % 2) h = "0" + h
	const k = h.length / 2
	const len = k < 24
		? (0x40 | k).toString(16)
		: k < 0x100
		? "58" + k.toString(16).padStart(2, "0")
		: "59" + k.toString(16).padStart(4, "0")
	return (negative ? "c3" : "c2") + len + h
}

function model(x: number | bigint): string {
	if (typeof x === "bigint") return integer(x)
	if (Number.isInteger(x)) return integer(BigInt(x))
	if (x !== x) return "f97e00"
	const v = new DataView(new ArrayBuffer(9))
	if (Object.is(Math.f16round(x), x)) {
		v.setUint8(0, 0xf9), v.setFloat16(1, x)
		return hex(new Uint8Array(v.buffer, 0, 3))
	}
	if (Object.is(Math.fround(x), x)) {
		v.setUint8(0, 0xfa), v.setFloat32(1, x)
		return hex(new Uint8Array(v.buffer, 0, 5))
	}
	v.setUint8(0, 0xfb), v.setFloat64(1, x)
	return hex(new Uint8Array(v.buffer, 0, 9))
}

// TypeScript alone --------------------------------------------------------------------------

Deno.test(`cbor fuzz: ${SEEDS} seeds, round trip, one encoding`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		for (let n = 0; n < 20; n++) {
			const v = value(pick)
			const b = encode(v)
			const at = `seed ${seed}.${n}: ${show(v)}`
			const back = decode(b)
			assert(same(back, v), `${at}: back as ${show(back)}`)
			assertEquals(hex(encode(back)), hex(b), `${at}: encoded again`)
			const w = shuffled(pick, v)
			assertEquals(hex(encode(w)), hex(b), `${at}: keys in another order`)
		}
	}
})

Deno.test(`cbor fuzz: ${SEEDS * 50} numbers, the integer or the shortest float, against the model`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 1000)
		for (let n = 0; n < 50; n++) {
			const x = n < NUMBERS.length && seed === 1 ? NUMBERS[n] : number(pick)
			assertEquals(hex(encode(x)), model(x), `${x}`)
			const back = decode(encode(x))
			assert(Object.is(back, canon(x)) || (x !== x && Number.isNaN(back)), `${x}`)
			const big = typeof back === "bigint"
			assertEquals(
				big,
				Number.isInteger(Number(x)) && !Number.isSafeInteger(Number(canon(x))),
				`${x}`,
			)
		}
	}
})

Deno.test(`cbor fuzz: ${SEEDS} seeds, every non-canonical rewrite is refused`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 2000)
		for (let n = 0; n < 10; n++) {
			const v = value(pick)
			const b = encode(v)
			for (const [what, r] of rewrites(pick, b)) {
				assertThrows(
					() => decode(r),
					CborError,
					undefined,
					`seed ${seed}.${n}: ${what}: ${hex(r)} taken (was ${hex(b)})`,
				)
			}
		}
	}
})

Deno.test(`cbor fuzz: ${SEEDS} seeds, bytes near an encoding: refused, or exactly one`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 3000)
		for (let n = 0; n < 50; n++) {
			const m = mutate(pick, encode(value(pick)))
			let v: Value
			try {
				v = decode(m)
			} catch (e) {
				if (e instanceof CborError) continue
				throw e
			}
			assertEquals(hex(encode(v)), hex(m), `seed ${seed}.${n}: taken, and not canonical`)
		}
	}
})

Deno.test("cbor fuzz: lone surrogates have no encoding, in strings and keys, anywhere", () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 4000)
		for (let n = 0; n < 20; n++) {
			const v = value(pick, true)
			if (!lone(v)) {
				assert(same(decode(encode(v)), v))
				continue
			}
			assertThrows(() => encode(v), CborError, undefined, `seed ${seed}.${n}: ${show(v)}`)
		}
	}
})

Deno.test("cbor fuzz: what is not a value has no encoding", () => {
	const proto = { a: 1 }
	const cyclic: unknown[] = []
	let deep: unknown[] = cyclic
	for (let i = 0; i < 100; i++) deep.push(deep = [])
	deep.push(cyclic)
	const sparse = [1, , 3]
	const NOT = [
		undefined,
		() => 1,
		Symbol("s"),
		new Map(),
		new Set(),
		new Date(0),
		/x/,
		new ArrayBuffer(2),
		new DataView(new ArrayBuffer(2)),
		new Uint8ClampedArray(2),
		new Float16Array(2),
		new (class Point {
			x = 1
		})(),
		Object.create(proto),
		{ [Symbol("k")]: 1 },
		[undefined],
		{ a: undefined },
		sparse,
		cyclic,
		new Stand(undefined as never),
		{ a: [1, { b: undefined }] },
	]
	for (const x of NOT) {
		assertThrows(() => encode(x as Value), CborError, undefined, String(x))
	}
})

Deno.test(`cbor fuzz: ${DEPTH} containers deep is a value, one more is not`, () => {
	for (let seed = 1; seed <= 6; seed++) {
		const { pick } = rand(seed + 5000)
		const nest = (d: number): Value => {
			let v: Value = [null, [], {}][pick(3)]
			if (v !== null) d--
			for (let i = 0; i < d; i++) {
				const k = pick(3)
				v = k === 0 ? [v] : k === 1 ? { k: v } : new Stand(v)
			}
			return v
		}
		const ok = nest(DEPTH)
		const b = encode(ok)
		assert(same(decode(b), ok))
		const deeper = nest(DEPTH + 1)
		assertThrows(() => encode(deeper), CborError)
		const bytesOver = cat(new Uint8Array(DEPTH + 1).fill(0x81), [0xf6])
		assertThrows(() => decode(bytesOver), CborError)
		assert(
			same(
				decode(bytesOver.subarray(1)),
				JSON.parse("[".repeat(DEPTH) + "null" + "]".repeat(DEPTH)),
			),
		)
	}
})

// across: the harness against cbor_harness.ts here ---------------------------------------------

function near(pick: Pick, b: Uint8Array): Uint8Array[] {
	return [...rewrites(pick, b).map(([, r]) => r), mutate(pick, b), mutate(pick, b)]
}

async function across(requests: Record<string, unknown>[]) {
	const got = await ask(subject, requests)
	const wrong: string[] = [], counts: Record<string, number> = {}
	requests.forEach((r, i) => {
		const want = read(line(answer(read(line(r)) as never))) as Record<string, unknown>
		const kind = `${r.op} ${want.error ?? "taken"}`
		counts[kind] = (counts[kind] ?? 0) + 1
		if (stable(got[i]) !== stable(want)) {
			wrong.push(
				`${stable(r).slice(0, 400)}\n  here  ${stable(want).slice(0, 300)}\n  there ${
					stable(got[i]).slice(0, 300)
				}`,
			)
		}
	})
	console.log(`  ${subject.at(-1)?.split("/").at(-1)}: ${line(counts)}`)
	assertEquals(wrong.slice(0, 10).join("\n"), "", `${wrong.length} of ${requests.length} differ`)
}

Deno.test(`cbor fuzz: ${SEEDS} seeds across, encoding values (lone surrogates too)`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 6000)
		for (let n = 0; n < 25; n++) {
			requests.push({ op: "encode", value: toJson(value(pick, n % 3 === 0)) })
		}
	}
	for (const x of NUMBERS) requests.push({ op: "encode", value: toJson(x) })
	for (const k of KEYS) requests.push({ op: "encode", value: toJson({ [k]: k }) })
	for (const p of PARTS) requests.push({ op: "encode", value: toJson({ [p]: [p, p + p] }) })
	const big: Record<string, number> = {}
	for (let i = 0; i < 2000; i++) big[i % 3 ? `k${i}` : String.fromCodePoint(0x20 + i * 37)] = i
	requests.push({ op: "encode", value: big })
	requests.push({ op: "encode", value: "😀é中a".repeat(30000) })
	await across(requests)
})

Deno.test(`cbor fuzz: ${SEEDS} seeds across, decoding bytes near encodings`, async () => {
	const requests: Record<string, unknown>[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 7000)
		for (let n = 0; n < 10; n++) {
			const b = encode(value(pick))
			requests.push({ op: "decode", bytes: hex(b) })
			for (const m of near(pick, b)) requests.push({ op: "decode", bytes: hex(m) })
		}
	}
	const { pick } = rand(8000)
	for (let n = 0; n < 500; n++) {
		requests.push({
			op: "decode",
			bytes: hex(Uint8Array.from({ length: 1 + pick(12) }, () => pick(256))),
		})
	}
	for (const d of [DEPTH, DEPTH + 1]) {
		for (const open of [0x81, 0xa1]) {
			const key = [0x61, 0x6b]
			const parts: number[] = []
			for (let i = 0; i < d; i++) parts.push(open, ...(open === 0xa1 ? key : []))
			requests.push({ op: "decode", bytes: hex(cat(parts, [0xf6])) })
		}
		requests.push({
			op: "decode",
			bytes: hex(
				cat(...Array.from({ length: d }, () => [0xda, 0x12, 0x34, 0x56, 0x78]), [0xf6]),
			),
		})
	}
	await across(requests)
})
