import { assert, assertEquals, assertThrows } from "@std/assert"
import { deflate, DeflateError, inflate } from "./deflate.ts"

const platform = async (b: Uint8Array, how: "compress" | "decompress") => {
	const s = new Blob([b.slice()]).stream().pipeThrough(
		how === "compress"
			? new CompressionStream("deflate-raw")
			: new DecompressionStream("deflate-raw"),
	)
	return new Uint8Array(await new Response(s).arrayBuffer())
}
const text = (s: string) => new TextEncoder().encode(s)
let seed = 7
const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
const cases: [string, Uint8Array][] = [
	["empty", new Uint8Array(0)],
	["one byte", Uint8Array.of(42)],
	["two bytes", Uint8Array.of(1, 2)],
	["a run", new Uint8Array(100000).fill(97)],
	["prose", text("the quick brown fox jumps over the lazy dog. ".repeat(3000))],
	["this file", Deno.readFileSync(new URL("./deflate.ts", import.meta.url))],
	["random", Uint8Array.from({ length: 70000 }, () => Math.floor(rand() * 256))],
	["few symbols", Uint8Array.from({ length: 50000 }, () => Math.floor(rand() * 3))],
	[
		"skewed",
		Uint8Array.from({ length: 200000 }, () => (rand() < 0.97 ? 0 : Math.floor(rand() * 256))),
	],
	[
		"a long varied text",
		Deno.readFileSync(new URL("../../../extensions/subduction/plan.org", import.meta.url)),
	],
]

Deno.test("deflate: any inflater reads it, and inflate reads it back", async () => {
	for (const [what, b] of cases) {
		const z = deflate(b)
		assertEquals(await platform(z, "decompress"), b, what)
		assertEquals(inflate(z), b, what)
	}
})

Deno.test("deflate: the same bytes every time", () => {
	for (const [what, b] of cases) assertEquals(deflate(b), deflate(b.slice()), what)
})

Deno.test("deflate: about as small as the platform's", async () => {
	for (const [what, b] of cases) {
		if (b.length < 1000) continue
		const ours = deflate(b).length, theirs = (await platform(b, "compress")).length
		assert(ours <= theirs * 1.15 + 16, `${what}: ${ours} against ${theirs}`)
	}
})

Deno.test("inflate: reads the platform's deflate", async () => {
	for (const [what, b] of cases) assertEquals(inflate(await platform(b, "compress")), b, what)
})

Deno.test("inflate: refuses what isn't deflate, and what is over its limit", () => {
	assertThrows(() => inflate(Uint8Array.of(0xff, 0xff)), DeflateError)
	assertThrows(() => inflate(Uint8Array.of(0x07)), DeflateError)
	assertThrows(() => inflate(deflate(new Uint8Array(100000)), 1000), DeflateError)
})
