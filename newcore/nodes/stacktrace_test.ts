import { assertEquals } from "@std/assert"
import { capture, frames, outside } from "./stacktrace.ts"

Deno.test("frames: V8", () => {
	const stack = [
		"Error: x",
		"    at inner (file:///a/lib.ts:3:9)",
		"    at async Foo.bar (file:///a/app.ts:10:2)",
		"    at file:///a/main.ts:1:1",
	].join("\n")
	assertEquals(frames(stack), [
		{ file: "file:///a/lib.ts", line: 3, column: 9, function: "inner" },
		{ file: "file:///a/app.ts", line: 10, column: 2, function: "async Foo.bar" },
		{ file: "file:///a/main.ts", line: 1, column: 1 },
	])
})

Deno.test("frames: a V8 message is not a frame", () => {
	const stack = "Error: mail me@host:80:1\n    at f (file:///a.ts:1:2)"
	assertEquals(frames(stack), [{ file: "file:///a.ts", line: 1, column: 2, function: "f" }])
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
		{ file: "/s/j.js", line: 1, column: 36, function: "inner" },
		{ file: "/s/j.js", line: 3, column: 54 },
		{ file: "/s/j.js", line: 2, column: 43, function: "Foo" },
		{ file: "/s/j.js", line: 4, column: 32, function: "global code" },
	])
})

Deno.test("outside: first frame not ours", () => {
	const stack = "Error\n    at a (file:///lib.ts:1:1)\n    at b (file:///app.ts:2:2)"
	assertEquals(outside(stack, new Set(["file:///lib.ts"])), {
		file: "file:///app.ts",
		line: 2,
		column: 2,
		function: "b",
	})
	assertEquals(outside(stack, new Set(["file:///lib.ts", "file:///app.ts"])), undefined)
})

Deno.test("capture: this file, when stacktrace.ts is ours", () => {
	const site = capture(new Set([new URL("./stacktrace.ts", import.meta.url).href]))
	assertEquals(site?.file, import.meta.url)
})

Deno.test("capture: entry cuts the frames above it", () => {
	function enter() {
		return capture(new Set(), enter)
	}
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const site = enter()
	assertEquals([site?.file, site?.line], [import.meta.url, line])
})
