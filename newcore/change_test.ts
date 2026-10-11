import { assertEquals } from "@std/assert"
import createChange from "./change.ts"
import node from "./node.ts"

Deno.test("createChange: the header and node, absent fields left out", () => {
	const h = { time: 3, actor: "chee" }
	const c = createChange("a", h)
	assertEquals(c, { time: 3, actor: "chee", node: "a" })
	assertEquals("site" in c, false)
	assertEquals(c === (h as object), false)
})

Deno.test("createChange: nothing checked", () => {
	const c = createChange("a", { time: -1, actor: undefined, cause: { why: "x" } })
	assertEquals(c, { time: -1, actor: undefined, cause: { why: "x" }, node: "a" })
})

Deno.test("createChange: outside gives the caller's site", () => {
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const c = createChange("a", { time: 1, actor: "chee" }, { outside: true })
	assertEquals([c.site?.file, c.site?.line], [import.meta.url, line])
})

Deno.test("createChange: outside keeps a given site", () => {
	const site = { file: "x.c", line: 4 }
	const c = createChange("a", { time: 1, actor: "chee", site }, { outside: true })
	assertEquals(c.site, site)
})

Deno.test("createChange: a version's change for node.ts", () => {
	const change = createChange("a", { time: 0, actor: "host" })
	const n = node("a", { value: [{ content: 1, change }] })
	assertEquals(n.value[0].change.node, n.id)
})
