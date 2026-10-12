import { assertEquals, assertStrictEquals } from "@std/assert"
import make from "./node.ts"

Deno.test("make: the whole node, entries in order", () => {
	const v = { content: 1, change: { time: 0 } }
	const n = make("a", { value: [v], children: [["b", []], ["a", []]] })
	assertEquals(n.value, [v])
	assertEquals([...n.children.keys()], ["b", "a"])
	assertEquals(n.info.size, 0)
	assertEquals(n.header, {})
})

Deno.test("make: outside gives the caller's site in the header", () => {
	const line = Number(new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)![1]) + 1
	const n = make("a", {}, { header: { time: 1, actor: "me" }, outside: true })
	assertEquals([n.header.site?.file, n.header.site?.line], [import.meta.url, line])
	assertEquals([n.header.time, n.header.actor], [1, "me"])
})

Deno.test("make: the header given is the node's, not copied; outside never changes it", () => {
	const h = { time: 1 }
	assertStrictEquals(make("a", {}, { header: h }).header, h)
	make("a", {}, { header: h, outside: true })
	assertEquals(h, { time: 1 })
})

Deno.test("make: a header's own site is kept, as from storage", () => {
	const site = { file: "file:///old.ts", line: 3 }
	const n = make("a", {}, { header: { time: 0, actor: "me", site }, outside: true })
	assertEquals(n.header.site, site)
})
