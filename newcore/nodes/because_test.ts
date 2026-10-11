import { assertEquals } from "@std/assert"
import createBecause from "./because.ts"
import make from "./node.ts"

Deno.test("createBecause: layer, place and why", () => {
	const why = { peer: "b", heads: ["h1"] }
	const b = createBecause("sync", { side: 1 }, why)
	assertEquals(b, { layer: "sync", place: { side: 1 }, why })
	assertEquals(b.why === why, true)
})

Deno.test("createBecause: no why, left out", () => {
	const b = createBecause("overlay", "front")
	assertEquals(b, { layer: "overlay", place: "front" })
	assertEquals("why" in b, false)
	assertEquals("site" in b, false)
})

Deno.test("createBecause: nothing checked", () => {
	const live = () => 1
	assertEquals(createBecause("", undefined, live).why, live)
})

Deno.test("createBecause: outside gives the caller's site", () => {
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const b = createBecause("sync", 0, undefined, { outside: true })
	assertEquals([b.site?.file, b.site?.line], [import.meta.url, line])
})

Deno.test("createBecause: a version's because for node.ts", () => {
	const because = createBecause("overlay", "front", { drag: true })
	const n = make("a", { value: [{ content: 1, change: { time: 0 }, because }] })
	assertEquals(n.value[0].because, because)
})
