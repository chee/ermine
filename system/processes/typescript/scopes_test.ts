import { assertEquals, assertMatch } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createTable } from "@ermine/graph/table"
import { createScopeNodes } from "./scopes.ts"

function world() {
	const events: string[] = []
	const s = createScheduler()
	const table = createTable((part, id) => void events.push(`${String(part)} ${String(id)}`))
	const nodes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: "host" })
	return { s, table, nodes, host, events }
}

Deno.test("scope nodes: give makes one id, the same after; given or a uuid", () => {
	const { s, nodes, host } = world()
	const p = s.createScope({ process: ["work", "clock"] }, host)
	assertEquals(nodes.give(p, "P"), "P")
	assertEquals(nodes.give(p, "other"), "P")
	const q = s.createScope({ test: "q" }, host)
	assertMatch(String(nodes.give(q)), /^scope:/)
})

Deno.test("scope nodes: at the scope's teardown its node's entries go, as table events", () => {
	const { s, table, nodes, host, events } = world()
	const p = s.createScope({ process: ["p"] }, host)
	const id = nodes.give(p)!
	s.runWithScope(host, () => {
		table.add(
			"value",
			id,
			createEntry<unknown>({ title: "clock" }, {
				time: 0,
				actor: "host",
				frame: { info: {}, parent: undefined },
			}),
		)
		table.add(
			"attributes",
			id,
			createEntry<Record<string, unknown>>({ pin: "x" }, {
				time: 0,
				actor: "host",
				frame: { info: {}, parent: undefined },
			}),
		)
	})
	events.length = 0
	s.teardown(p)
	assertEquals([...table.get(id)], [])
	assertEquals(events.sort(), [`attributes ${String(id)}`, `value ${String(id)}`])
})
