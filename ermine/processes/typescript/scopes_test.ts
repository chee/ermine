import { assertEquals, assertMatch, assertStrictEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createTable } from "@ermine/table"
import { createScopeNodes } from "./scopes.ts"

function world() {
	const events: string[] = []
	const s = createScheduler()
	const table = createTable((part, id) => void events.push(`${String(part)} ${String(id)}`))
	const nodes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope([["actor", "host"]])
	return { s, table, nodes, host, events }
}

Deno.test("scope nodes: give makes one id, the same after; given or a uuid", () => {
	const { s, nodes, host } = world()
	const p = s.createScope([["process", ["work", "clock"]]], host)
	assertEquals(nodes.give(p, "P"), "P")
	assertEquals(nodes.give(p, "other"), "P")
	assertEquals(nodes.nodeOf(p), "P")
	const q = s.createScope([["test", "q"]], host)
	assertMatch(String(nodes.give(q)), /^scope:/)
	assertEquals(nodes.nodeOf(s.createScope([["test", "none"]], host)), undefined)
})

Deno.test("scope nodes: nearest is the scope's own, or the nearest above with one; a computer's is its process's", () => {
	const { s, nodes, host } = world()
	const p = s.createScope([["process", ["p"]]], host)
	nodes.give(p, "P")
	const inner = s.createScope([["test", "inner"]], p)
	const c = s.runWithScope(inner, () => s.createComputer(() => 0, () => {}))
	assertEquals(nodes.nearest(inner), "P")
	assertEquals(nodes.nearest(c), "P")
	assertEquals(nodes.nearest(host), undefined)
	nodes.give(inner, "I")
	assertEquals(nodes.nearest(c), "I")
})

Deno.test("scope nodes: at the scope's teardown its node's entries go, as table events", () => {
	const { s, table, nodes, host, events } = world()
	const p = s.createScope([["process", ["p"]]], host)
	const id = nodes.give(p)
	s.runWithScope(host, () => {
		table.add("value", id, createEntry<unknown>({ title: "clock" }, { time: 0, actor: "host" }))
		table.add(
			"attributes",
			id,
			createEntry<Record<string, unknown>>({ pin: "x" }, { time: 0, actor: "host" }),
		)
	})
	events.length = 0
	s.teardown(p)
	assertEquals([...table.get(id)], [])
	assertEquals(events.sort(), [`attributes ${String(id)}`, `value ${String(id)}`])
	assertStrictEquals(nodes.nodeOf(p), undefined)
})
