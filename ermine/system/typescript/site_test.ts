// build sites (site.ts): a call given one keeps it, captures nothing; anything else, the trace
import { assert, assertEquals } from "@std/assert"
import { createErmine } from "./ermine.ts"
import { createEffect, ensureNode, patch, peep, pulse, read } from "@ermine/system"
import { at, site } from "@ermine/system/site"
import { traceOf } from "@ermine/core/places/header"
import type { ChangeHeader } from "@ermine/core/node/entry"
import { manual } from "./manual_fixture.ts"

type E = ReturnType<typeof createErmine>
const changeAt = (e: E, name: string): ChangeHeader => {
	const kids = e.table.get("children", e.places.root as string)?.value as Record<string, string>
	return e.table.get("value", kids[name])!.change as ChangeHeader
}
const here = new URL(import.meta.url).href

Deno.test("site: a call given a build site keeps it, nothing captured; a call in its arguments, the trace", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 12, 3)
	e.start(() => {
		at(S, ensureNode)("/x", (ensureNode("/y", 1), 1))
	}, "/p")
	assertEquals(changeAt(e, "x").external, [{ file: "file:///program.ts", line: 12, column: 3 }])
	assertEquals(traceOf(changeAt(e, "x")), undefined)
	assertEquals(changeAt(e, "y").external?.[0]?.file, here)
	e.close()
})

Deno.test("site: a token not minted, or a function not @ermine/system's, gives nothing", () => {
	const e = createErmine({ features: [manual] })
	const mine = () => 1
	assert(at(site("file:///a.ts", 1, 1), mine) === mine)
	assert(at({} as never, patch) === patch)
	e.start(() => {
		at({} as never, ensureNode)("/x", 1)
	}, "/p")
	assertEquals(changeAt(e, "x").external?.[0]?.file, here)
	e.close()
})

Deno.test("site: what the function runs never gets it (taken as it starts)", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 3, 1)
	e.start(() => {
		at(S, peep)(() => ensureNode("/z", 1))
	}, "/p")
	assertEquals(changeAt(e, "z").external?.[0]?.file, here)
	e.close()
})

Deno.test("site: trace always keeps the text beside a build site", () => {
	const e = createErmine({ features: [manual], trace: "always" })
	const S = site("file:///program.ts", 5, 1)
	e.start(() => void at(S, ensureNode)("/x", 1), "/p")
	assertEquals(changeAt(e, "x").external, [{ file: "file:///program.ts", line: 5, column: 1 }])
	assert(traceOf(changeAt(e, "x"))?.includes(here))
	e.close()
})

Deno.test("site: a computer made through a call given a build site has that site; its run's writes too", () => {
	const e = createErmine({ features: [manual] })
	const S = site("file:///program.ts", 8, 2)
	e.start(() => {
		ensureNode("/n", 1)
		ensureNode("/m", 0)
		at(S, createEffect)("copy", () => read("/n"), (n) => patch("/m", [{ path: [], value: n }]))
	}, "/p")
	e.within(() => pulse())
	assertEquals(e.within(() => read("/m")), 1)
	assertEquals(changeAt(e, "m").external, [{ file: "file:///program.ts", line: 8, column: 2 }])
	e.close()
})
