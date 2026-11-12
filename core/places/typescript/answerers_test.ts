// Answerers: contributors that answer reads, in front of the table or behind it.
import { assertEquals } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import {
	type Answerer,
	type Changed,
	createPlaces,
	type Fact,
	type Make,
	type Version,
} from "./places.ts"
import { children } from "./children.ts"
import { createChangeHeader } from "./header.ts"
import { get, list } from "./lib.ts"

function world(contributors: readonly (Answerer | Make)[]) {
	const s = createScheduler()
	const table = createTable()
	const places = createPlaces({
		root: "R",
		table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors,
	})
	s.onTrackingEnd((key) => places.release(key))
	const host = s.createRootScope({ actor: "host" })
	const notes = s.createRootScope({ actor: "notes" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => places.tables.sub(part, id, createEntry<unknown>(v, createChangeHeader(s))))
	const edit = (part: Key, id: Id, patches: Patch[]) =>
		hosted(() => {
			const there = table.get(part, id)!
			update(there, patches, createChangeHeader(s))
			places.commit([there])
		})
	function watch<T>(f: () => T) {
		const w = { runs: 0, value: undefined as T | undefined }
		s.runWithScope(
			notes,
			() => s.createComputer(() => (w.runs++, f()), (v) => void (w.value = v)),
		)
		return w
	}
	return { s, table, places, hosted, put, edit, watch }
}

// An answerer holding lists of versions by part, id and path.
function holder(from: string, held: Record<string, Version[]> = {}) {
	const asked: string[] = []
	const answerer: Answerer = {
		from,
		read: (part, id, path) => {
			const key = [part, String(id), ...path].join("/")
			asked.push(key)
			return held[key] ?? []
		},
	}
	return { answerer, asked, held }
}

Deno.test("answerers: with none that reads, readAll is the table's one item, with its change", () => {
	const { places, put, table } = world([children])
	assertEquals(places.readAll("value", "n"), [])
	put("value", "n", { a: 1 })
	const change = table.get("value", "n")!.change
	assertEquals(places.readAll("value", "n"), [{
		value: { a: 1 },
		from: { change },
		by: "children",
		stored: true,
	}])
	assertEquals(places.readAll("value", "n", ["a"]), [{
		value: 1,
		from: { change },
		by: "children",
		stored: true,
	}])
	assertEquals(places.readAll("value", "n", ["b"]), [])
	assertEquals(places.readValue("value", "n", ["a"]), 1)
})

Deno.test("answerers: one behind the table adds its items after the table's; read is still the table's", () => {
	const old = holder("history", { "value/n": [{ value: "older" }, { value: "oldest" }] })
	const { places, put } = world([children, old.answerer])
	put("value", "n", "now")
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by]),
		[["now", "children"], ["older", "history"], ["oldest", "history"]],
	)
	assertEquals(places.readValue("value", "n"), "now")
})

Deno.test("answerers: a read never asks one behind the table: what it holds for a node the table has nothing for reads as nothing", () => {
	const old = holder("history", { "value/gone": [{ value: "older" }] })
	const { places, put } = world([children, old.answerer])
	put("value", "n", "now")
	assertEquals(places.readValue("value", "n"), "now")
	assertEquals(places.readValue("value", "gone"), undefined)
	assertEquals(places.readValue("value", "gone", [], [0, 0]), undefined)
	assertEquals(old.asked, [])
	assertEquals(places.readAll("value", "gone").map((v) => [v.value, v.by]), [["older", "history"]])
	assertEquals(old.asked, ["value/gone"])
})

Deno.test("answerers: a read never asks one in front; readAll shows its items first, gone ones with their value", () => {
	const over = holder("overlay", { "value/n": [{ value: "draft" }] })
	const { places, put } = world([over.answerer, children])
	put("value", "n", "saved")
	put("value", "g", "hidden")
	over.held["value/g"] = [{ value: "was", gone: true }]
	assertEquals(places.readValue("value", "n"), "saved")
	assertEquals(places.readValue("value", "g"), "hidden")
	assertEquals(over.asked, [])
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by]),
		[["draft", "overlay"], ["saved", "children"]],
	)
	assertEquals(
		places.readAll("value", "g").map((v) => [v.gone, v.value, v.by]),
		[[true, "was", "overlay"], [undefined, "hidden", "children"]],
	)
})

Deno.test("answerers: an answerer is asked with the path", () => {
	const over = holder("overlay", { "value/n/title": [{ value: "héllo" }] })
	const { places, put } = world([over.answerer, children])
	put("value", "n", { title: "saved", body: "text" })
	assertEquals(places.readAll("value", "n", ["title"]).map((v) => v.value), ["héllo", "saved"])
	assertEquals(over.asked, ["value/n/title"])
})

Deno.test("answerers: an item's own from is kept, and who answered is beside it", () => {
	const answerer: Answerer = {
		from: "history",
		read: () => [{ value: 1, from: { heads: [["b", 1]] } }],
	}
	const { places } = world([children, answerer])
	assertEquals(places.readAll("value", "n"), [{
		value: 1,
		from: { heads: [["b", 1]] },
		by: "history",
	}])
})

Deno.test("answerers: only the table's item is marked stored, though an answerer has children's name", () => {
	const twin: Answerer = {
		from: "children",
		read: () => [{ value: "twin's", from: { change: 1 } }],
	}
	const { places, put } = world([children, twin])
	put("value", "n", "table's")
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by, v.stored]),
		[["table's", "children", true], ["twin's", "children", undefined]],
	)
})

Deno.test("answerers: with none marked stored, the table is last", () => {
	const a = holder("a", { "value/n": [{ value: "a's" }] })
	const names: Answerer = { from: "names", step: () => undefined, names: () => [] }
	const { places, put } = world([names, a.answerer])
	put("value", "n", "table's")
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by]),
		[["a's", "a"], ["table's", "table"]],
	)
})

Deno.test("answerers: one with no step and no names changes no walk and no listing", () => {
	const old = holder("history")
	const { places, put } = world([children, old.answerer])
	put("children", "R", { a: "A" })
	assertEquals(get(places, ["a"]), "A")
	assertEquals(get(places, ["b"]), undefined)
	assertEquals([...list(places, [])], ["a"])
})

Deno.test("answerers: changed reruns a reader of what an answerer holds, and tells no watcher", () => {
	const old = holder("history", { "value/n": [{ value: 1 }] })
	const { s, places, watch } = world([old.answerer, children])
	const facts: Fact[] = []
	places.watchAll((f) => void facts.push(f))
	const all = watch(() => places.readAll("value", "n").length)
	const other = watch(() => places.readAll("value", "m").length)
	s.pulse()
	assertEquals([all.value, other.runs], [1, 1])
	old.held["value/n"] = [{ value: 2 }, { value: 1 }]
	places.changed("value", "n")
	s.pulse()
	assertEquals([all.runs, all.value, other.runs], [2, 2, 1])
	assertEquals(facts, [])
})

Deno.test("answerers: a Make is handed changed, and changed with patches reruns only readers of what they touch", () => {
	let changed: Changed | undefined
	const held: Record<string, unknown> = { title: "a", body: "b" }
	const make: Make = (setup) => {
		changed = setup.changed
		return { from: "served", read: (_part, _id, path) => [{ value: held[String(path[0])] }] }
	}
	const { s, places, watch } = world([make, children])
	const title = watch(() => places.readAll("value", "n", ["title"])[0]?.value)
	const body = watch(() => places.readAll("value", "n", ["body"])[0]?.value)
	s.pulse()
	held.body = "c"
	changed!("value", "n", [{ path: ["body"], value: "c" }])
	s.pulse()
	assertEquals([title.runs, title.value], [1, "a"])
	assertEquals([body.runs, body.value], [2, "c"])
})

Deno.test("answerers: a table change still reruns readers when answerers read too", () => {
	const old = holder("history")
	const { s, places, put, edit, watch } = world([children, old.answerer])
	put("value", "n", { a: 1, b: 1 })
	const a = watch(() => places.readValue("value", "n", ["a"]))
	const b = watch(() => places.readAll("value", "n", ["b"]).map((v) => v.value))
	s.pulse()
	edit("value", "n", [{ path: ["b"], value: 2 }])
	s.pulse()
	assertEquals([a.runs, a.value], [1, 1])
	assertEquals([b.runs, b.value], [2, [2]])
})

Deno.test("answerers: an item an answerer passes on with stored set is still the answerer's", () => {
	const passer: Answerer = {
		from: "passer",
		read: () => [{ value: "passed on", stored: true, from: { change: 1 } } as Version],
	}
	const { places, put } = world([children, passer])
	put("value", "n", "table's")
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by, v.stored]),
		[["table's", "children", true], ["passed on", "passer", undefined]],
	)
})

Deno.test("answerers: the one marked stored is asked too, right after the table's value", () => {
	const marked: Answerer = { from: "marked", stored: true, read: () => [{ value: "marked's" }] }
	const after = holder("after", { "value/n": [{ value: "after's" }] })
	const { places, put } = world([marked, after.answerer])
	put("value", "n", "table's")
	assertEquals(
		places.readAll("value", "n").map((v) => [v.value, v.by, v.stored]),
		[["table's", "marked", true], ["marked's", "marked", undefined], [
			"after's",
			"after",
			undefined,
		]],
	)
	assertEquals(places.readValue("value", "n"), "table's")
})
