import { assertEquals } from "@std/assert"
import { capture, frames } from "./stacktrace.ts"

Deno.test("frames: V8", () => {
	const stack = [
		"Error: x",
		"    at inner (file:///a/lib.ts:3:9)",
		"    at async Foo.bar (file:///a/app.ts:10:2)",
		"    at file:///a/main.ts:1:1",
	].join("\n")
	assertEquals(frames(stack), [
		{ file: "file:///a/lib.ts", line: 3, column: 9, function: "inner", external: true },
		{ file: "file:///a/app.ts", line: 10, column: 2, function: "async Foo.bar", external: true },
		{ file: "file:///a/main.ts", line: 1, column: 1, external: true },
	])
})

Deno.test("frames: a V8 message is not a frame", () => {
	const stack = "Error: mail me@host:80:1\n    at f (file:///a.ts:1:2)"
	assertEquals(frames(stack), [{
		file: "file:///a.ts",
		line: 1,
		column: 2,
		function: "f",
		external: true,
	}])
})

// from macOS's jsc, 2026-10-11, paths shortened
Deno.test("frames: JavaScriptCore", () => {
	const stack = [
		"inner@/s/j.js:1:36",
		"@/s/j.js:3:54",
		"map@[native code]",
		"eval code@",
		"eval@[native code]",
		"Foo@/s/j.js:2:43",
		"global code@/s/j.js:4:32",
	].join("\n")
	assertEquals(frames(stack), [
		{ file: "/s/j.js", line: 1, column: 36, function: "inner", external: true },
		{ file: "/s/j.js", line: 3, column: 54, external: true },
		{ file: "/s/j.js", line: 2, column: 43, function: "Foo", external: true },
		{ file: "/s/j.js", line: 4, column: 32, function: "global code", external: true },
	])
})

Deno.test("capture: every line of the stack now, this file's among them, the limit put back", () => {
	const limit = (Error as unknown as { stackTraceLimit: number }).stackTraceLimit
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const at = capture()
	assertEquals((Error as unknown as { stackTraceLimit: number }).stackTraceLimit, limit)
	assertEquals(at.every((l) => l.external), true)
	// its own function first: nothing is left out
	assertEquals(at[0].file, new URL("./stacktrace.ts", import.meta.url).href)
	assertEquals(at.some((l) => l.file === import.meta.url && l.line === line), true)
})

Deno.test("capture: deeper than the engine's usual limit, the whole stack", () => {
	const deep = (n: number): number => n === 0 ? capture().length : deep(n - 1)
	assertEquals(deep(40) > deep(0) + 39, true)
})

Deno.test("capture: a location known without a stack stands in for it", () => {
	const build = { file: "file:///program.ts", line: 4, column: 2, external: true }
	assertEquals(capture(build), [build])
})
