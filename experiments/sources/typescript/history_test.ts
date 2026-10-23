import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { place } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { ORPHAN } from "./holder.ts"
import { named } from "./write.ts"
import { createWorld } from "./world.ts"
import { readRecord, SKIPPED } from "./status.ts"

Deno.test("each write as it lands is named, on top of the part's head: each on the one before", () => {
	const w = createWorld("A")
	w.set("N", { a: 1 })
	w.set("N", 2, ["a"])
	const [first, second] = w.history.writes()
	assertEquals(first.parents, [])
	assertEquals(first.patches, [{ path: [], value: { a: 1 } }])
	assertEquals(first.change.actor, "A")
	assertEquals(second.parents, [first.name])
	assertEquals(second.patches, [{ path: ["a"], value: 2 }])
	assertEquals(w.history.heads("N", "value"), [second.name])
	assert(named(first) && named(second))
	// the site of the write made, as every write from outside has
	assert(first.change.external?.[0].file.endsWith("world.ts"))
})

Deno.test("a write put in lands as its patches, as its own change says; it is not named again", async () => {
	const a = createWorld("A"), b = createWorld("B")
	a.set("N", { a: 1 })
	a.set("N", 2, ["a"])
	assertEquals(await b.history.put(a.history.writes()), ["taken", "taken"])
	assertEquals(b.value("N"), { a: 2 })
	assertEquals(b.history.writes(), a.history.writes())
	assertEquals(b.table.get("value", "N")?.change.actor, "A")
	assertEquals(b.table.get("value", "N")?.change.op?.patches, [{ path: ["a"], value: 2 }])
	assertEquals(await b.history.put(a.history.writes()), ["passed", "passed"])
	assertEquals(
		await b.history.put(a.history.writes().slice(1).map((x) => ({ ...x, name: "y" }))),
		[
			{ refused: "misnamed" },
		],
	)
})

Deno.test("a write without its parents is refused", async () => {
	const a = createWorld("A"), b = createWorld("B")
	a.set("N", 1)
	a.set("N", 2)
	assertEquals(await b.history.put(a.history.writes().slice(1)), [{ refused: ORPHAN }])
	assertEquals(b.value("N"), undefined)
})

Deno.test("writes made at once: every graph holding them holds one value, whatever order they came in", async () => {
	const base = createWorld("O")
	base.set("N", { a: 0, b: 0 })
	const a = createWorld("A"), b = createWorld("B")
	await a.history.put(base.history.writes())
	await b.history.put(base.history.writes())
	a.set("N", 1, ["a"])
	a.set("N", "x", ["b"])
	b.set("N", 2, ["a"])
	const fromA = a.history.writes().slice(1), fromB = b.history.writes().slice(1)
	await a.history.put(fromB)
	await b.history.put(fromA)
	assertEquals(a.value("N"), b.value("N"))
	assertEquals(a.history.heads("N", "value"), b.history.heads("N", "value"))
	assertEquals(a.history.heads("N", "value").length, 2)
	// played again in name order: of the two writes to a ready together, the lower name first
	const firstA = fromA[0].name, lastA = fromA[1].name, lastB = fromB[0].name
	assertEquals((a.value("N") as { a: number }).a, firstA < lastB ? 2 : 1)
	assertEquals((a.value("N") as { b: string }).b, "x")
	// the next write is made on top of both
	a.set("N", 3, ["a"])
	assertEquals(a.history.writes().at(-1)!.parents, [lastA, lastB].sort())
	await b.history.put(a.history.writes().slice(-1))
	assertEquals(b.value("N"), { a: 3, b: "x" })
	assertEquals(b.history.heads("N", "value").length, 1)
})

Deno.test("a folder's children changed in place later never change a named write", () => {
	const w = createWorld("A")
	w.scheduler.runWithScope(w.scope, () => {
		w.table.add("children", "D", createEntry({}, createChangeHeader(w.scheduler)) as never)
		w.places.commit(
			place(w.table.get("children", "D")!, "a", "X", createChangeHeader(w.scheduler)),
		)
		w.places.commit(
			place(w.table.get("children", "D")!, "b", "Y", createChangeHeader(w.scheduler)),
		)
	})
	const writes = w.history.writes()
	assertEquals(writes.map((x) => x.patches), [
		[{ path: [], value: {} }],
		[{ path: ["a"], value: "X" }],
		[{ path: ["b"], value: "Y" }],
	])
	assert(writes.every(named))
})

Deno.test("an entry taken out is a write too: in a scope, its change; none open, one made here", async () => {
	const a = createWorld("A"), b = createWorld("B")
	a.set("N", 1)
	a.scheduler.runWithScope(a.scope, () => a.table.del("value", "N"))
	const gone = a.history.writes()[1]
	assertEquals(gone.patches, [{ path: [] }])
	assertEquals(gone.change.actor, "A")
	assert(gone.change.external?.[0].file.endsWith("history_test.ts"))
	a.set("K", 1)
	a.table.del("value", "K")
	assertEquals(a.history.writes().at(-1)!.change.actor, null)
	await b.history.put(a.history.writes())
	assertEquals(b.table.get("value", "N"), undefined)
})

Deno.test("what has no encoding is skipped, counted; drop lets go of a node's history, not its value", async () => {
	const w = createWorld("A")
	w.set("F", () => 1)
	// on the history's own node, which it never records
	assertEquals(readRecord(w.places, w.history.id)[SKIPPED], 1)
	assertEquals(w.history.writes(), [])
	w.set("N", 1)
	await w.history.drop("N")
	assertEquals(w.history.writes(), [])
	assertEquals(w.history.heads("N", "value"), [])
	assertEquals(w.value("N"), 1)
	// written again: a first write again, with no parents (a second root, for anyone holding the first)
	w.set("N", 2)
	assertEquals(w.history.writes()[0].parents, [])
})
