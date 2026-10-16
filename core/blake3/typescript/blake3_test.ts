import { assertEquals } from "@std/assert"
import { blake3, js, use, wasm } from "./blake3.ts"

const input = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// official test_vectors.json, first 32 bytes
const known: Record<number, string> = {
	0: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
	1: "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213",
	1024: "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7",
	1025: "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444",
	102400: "bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085",
}

const lengths = [
	0,
	1,
	1023,
	1024,
	1025,
	2048,
	2049,
	3072,
	3073,
	4096,
	4097,
	5120,
	5121,
	6144,
	6145,
	7168,
	7169,
	8192,
	8193,
	16384,
	31744,
	102400,
]

Deno.test("official vectors", () => {
	for (const [n, want] of Object.entries(known)) {
		assertEquals(hex(wasm(input(+n))), want, `wasm ${n}`)
		assertEquals(hex(js(input(+n))), want, `js ${n}`)
	}
})

Deno.test("wasm matches js at every vector length", () => {
	for (const n of lengths) assertEquals(wasm(input(n)), js(input(n)), `${n}`)
})

Deno.test("wasm matches js at random lengths", () => {
	for (let i = 0; i < 60; i++) {
		const n = Math.floor(Math.random() ** 3 * 1_000_000)
		const data = crypto.getRandomValues(new Uint8Array(n % 65536))
		const big = new Uint8Array(n)
		for (let o = 0; o < n; o += 65536) big.set(data.subarray(0, Math.min(65536, n - o)), o)
		assertEquals(wasm(big), js(big), `${n}`)
	}
})

Deno.test("wasm returns a copy", () => {
	const a = wasm(input(10))
	const b = wasm(input(11))
	assertEquals(a.length, 32)
	assertEquals(hex(a), hex(wasm(input(10))))
	assertEquals(a.buffer === b.buffer, false)
})

Deno.test("use switches", () => {
	const data = input(5000)
	use("js")
	const a = blake3(data)
	use("wasm")
	const b = blake3(data)
	assertEquals(a, b)
	assertEquals(a, js(data))
})
