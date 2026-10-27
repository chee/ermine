import { assertEquals, assertThrows } from "@std/assert"
import { fromJson, toJson } from "./form.ts"
import { parse } from "./json.ts"

Deno.test("a whole number of 309 digits is a bigint, not Infinity", () => {
	const digits = "1" + "0".repeat(308)
	assertEquals(parse(digits), BigInt(digits))
	assertEquals(parse("-" + digits), -BigInt(digits))
})

Deno.test("words are looked up, not inherited", () => {
	assertThrows(() => fromJson({ "/": { number: "toString" } }))
	assertThrows(() => fromJson({ "/": { float64: ["constructor"] } }))
	assertEquals(fromJson({ "/": { number: "Infinity" } }), Infinity)
})

Deno.test("bytes of 200k write as base64", () => {
	const b = new Uint8Array(200_000).fill(7)
	const j = toJson(b) as { "/": { bytes: string } }
	assertEquals(fromJson(j), b)
})

Deno.test("a harness answers a last line with no newline", async () => {
	const child = new Deno.Command("deno", {
		args: ["run", "--quiet", new URL("./last_harness.ts", import.meta.url).pathname],
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode('{"a":1}\n{"a":2}'))
	await w.close()
	const { stdout } = await child.output()
	assertEquals(new TextDecoder().decode(stdout), '{"a":1}\n{"a":2}\n')
})
