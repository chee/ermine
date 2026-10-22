// deflate.ts on the line protocol (conformance/typescript/harness.ts): one JSON request a line in,
// one answer a line out. bytes as lowercase hex.
//   {op: "deflate", input} → {bytes}
//   {op: "deflate", make} → {length, blake3}: a big input made here (below), its deflate's length
//     and BLAKE3 hash, and whether it inflates back (inflated: true)
//   {op: "inflate", bytes, limit?} → {input}, or {length, blake3} when made is given; a refusal:
//     {code: "not-deflate" | "over-the-limit"}
// make: {repeat: text, times}: the text's UTF-8 that many times; {random: seed, length, alphabet}:
// bytes from a 32-bit LCG, x = x * 1103515245 + 12345 (mod 2^32), each byte (x >> 16) % alphabet;
// {words: seed, length}: the random's choices into "lemon cherry paper ink otter moth wren fox ",
// a word at a time, cut at length
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { serve } from "../../../conformance/typescript/harness.ts"
import { deflate, DeflateError, inflate } from "./deflate.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

type Make = {
	repeat?: string
	times?: number
	random?: number
	length?: number
	alphabet?: number
	words?: number
}
export function make(m: Make): Uint8Array {
	if (m.repeat !== undefined) {
		const one = new TextEncoder().encode(m.repeat), out = new Uint8Array(one.length * m.times!)
		for (let i = 0; i < m.times!; i++) out.set(one, i * one.length)
		return out
	}
	const seed = m.random ?? m.words!
	let x = seed >>> 0
	const next = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0, x >>> 16)
	const out = new Uint8Array(m.length!)
	if (m.random !== undefined) {
		for (let i = 0; i < out.length; i++) out[i] = next() % m.alphabet!
		return out
	}
	const words = "lemon cherry paper ink otter moth wren fox".split(" ").map((w) =>
		new TextEncoder().encode(w + " ")
	)
	for (let i = 0; i < out.length;) {
		const w = words[next() % words.length]
		for (let j = 0; j < w.length && i < out.length; j++) out[i++] = w[j]
	}
	return out
}

serve((r) => {
	try {
		if (r.op === "deflate") {
			if (r.make) {
				const input = make(r.make), z = deflate(input)
				const back = inflate(z)
				return {
					length: z.length,
					blake3: hex(blake3(z)),
					inflated: back.length === input.length && back.every((b, i) => b === input[i]),
				}
			}
			return { bytes: hex(deflate(unhex(r.input))) }
		}
		if (r.op === "inflate") {
			const out = inflate(unhex(r.bytes), r.limit ?? 2 ** 30)
			if (r.made) return { length: out.length, blake3: hex(blake3(out)) }
			return { input: hex(out) }
		}
		return { error: `unknown op ${r.op}` }
	} catch (e) {
		if (e instanceof DeflateError) {
			return { code: e.message === "over the limit" ? "over-the-limit" : "not-deflate" }
		}
		throw e
	}
})
