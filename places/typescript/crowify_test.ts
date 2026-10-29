import { assertEquals } from "@std/assert"
import createEntry, { type ChangeHeader } from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createCrow } from "@ermine/crow"
import { crowify, updateEntry } from "./crowify.ts"

const h = (): ChangeHeader => ({ time: 1, actor: "test", frame: { info: {}, parent: undefined } })

Deno.test("crowify: what a run read before an await is let go of as it waits: a write then copies it", async () => {
	const s = createScheduler()
	const u = createCrow()
	const e = createEntry<{ list: Record<string, number> }>({ list: { a: 1 } }, h())
	// unread owns the root and the list from here
	updateEntry(u, e, [{ path: ["list", "b"], value: 2 }], h())
	const key = {}
	crowify(s, u, (k) => k === key ? e.value : undefined)
	let held: Record<string, number> | undefined
	let go!: () => void
	const waited = new Promise<void>((r) => go = r)
	s.runWithScope(s.createRootScope({ actor: "test" }), () =>
		s.createComputer(async () => {
			s.track(key)
			held = e.value!.list
			await waited
			return Object.keys(held).length
		}, () => {}))
	s.pulse()
	updateEntry(u, e, [{ path: ["list", "c"], value: 3 }], h())
	assertEquals(held, { a: 1, b: 2 })
	assertEquals(e.value!.list, { a: 1, b: 2, c: 3 })
	go()
	await waited
})
