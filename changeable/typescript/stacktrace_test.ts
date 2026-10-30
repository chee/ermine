import { assertEquals } from "@std/assert"
import { capture, frames, keepStackTraceLimit } from "./stacktrace.ts"

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

type Kept = { stackTraceLimit: number; _ermineStackTraceLimit?: number }

// with ermine's limit set to n for f, put back after
function limited<T>(n: number | undefined, f: () => T): T {
	const E = Error as unknown as Kept
	const was = E._ermineStackTraceLimit
	if (n === undefined) delete E._ermineStackTraceLimit
	else E._ermineStackTraceLimit = n
	try {
		return f()
	} finally {
		if (was === undefined) delete E._ermineStackTraceLimit
		else E._ermineStackTraceLimit = was
	}
}

Deno.test("capture: as many lines as ermine's kept limit, the engine's own limit put back", () => {
	const E = Error as unknown as Kept
	const deep = (n: number): number => n === 0 ? capture().length : deep(n - 1)
	assertEquals(limited(Infinity, () => deep(40) > deep(0) + 39), true)
	assertEquals(limited(5, () => deep(40)), 5)
	assertEquals(E.stackTraceLimit, 10)
})

Deno.test("capture: none kept, the engine's limit as it is", () => {
	const E = Error as unknown as Kept
	const deep = (n: number): number => n === 0 ? capture().length : deep(n - 1)
	assertEquals(limited(undefined, () => deep(40)), E.stackTraceLimit)
})

Deno.test("keepStackTraceLimit: the engine's limit now, kept for every capture after", () => {
	const E = Error as unknown as Kept
	const was = E.stackTraceLimit
	limited(undefined, () => {
		E.stackTraceLimit = 7
		keepStackTraceLimit()
		E.stackTraceLimit = 3
		const deep = (n: number): number => n === 0 ? capture().length : deep(n - 1)
		assertEquals(deep(20), 7)
		assertEquals(E.stackTraceLimit, 3)
		E.stackTraceLimit = was
	})
})

Deno.test("capture: cut at a function, the first line is its caller's, none of it or inside it", () => {
	function api() {
		return inner()
	}
	function inner() {
		return capture(undefined, api)
	}
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const at = api()
	assertEquals(at[0].file, import.meta.url)
	assertEquals(at[0].line, line)
	assertEquals(at.some((l) => l.function === "inner" || l.function === "api"), false)
})

Deno.test("capture: a location known without a stack stands in for it", () => {
	const build = { file: "file:///program.ts", line: 4, column: 2, external: true }
	assertEquals(capture(build), [build])
})
