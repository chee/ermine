// patch nodes end to end, as a host makes them: a real table, paths and scheduler, the overlay in
// front of places' table. writes are made from outside with the host's scope open (a site each),
// at a time given where staleness needs one
import { assert, assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import type { Patch } from "@ermine/core/op/apply"
import produce from "@ermine/core/op/produce"
import { createPlaces, type Places, unread } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { get } from "@ermine/core/places/lib"
import { createScheduler, type Info } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key, type Table } from "@ermine/core/table"
import {
	createOverlay,
	entries,
	type Item,
	land,
	type Overlay,
	PatchError,
	type PatchNode,
	TABLE,
} from "./patch.ts"

function world(table0?: (event: (part: Key, id: Id) => void) => Table) {
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const event = (part: Key, id: Id) => overlay.onTableChange(part, id)
	const table = table0 ? table0(event) : createTable(event)
	const overlay: Overlay = createOverlay(table, () => places)
	const places: Places = createPlaces({
		root: "R",
		table: overlay,
		paths: createPaths(),
		scheduler: s,
	})
	const host = s.createRootScope({ actor: "host" })
	const reader = s.createRootScope({ actor: "reader" })
	// a write's header from outside, by the host: the time now, or the one given
	function header(time?: number, extra?: Info) {
		const h = s.runWithScope(host, () => createChangeHeader(s, extra))
		if (time !== undefined) h.time = time
		return h
	}
	// an entry put under a key, whole: a table event
	const put = <K extends Key>(part: K, id: Id, v: unknown, time?: number) =>
		table.sub(part, id, createEntry(v, header(time)) as never)
	const kids = (id: Id, v: Record<string, Id>) => put("children", id, v)
	const value = (id: Id, v: unknown, time?: number) => put("value", id, v, time)
	const patch = (p: Id, node: PatchNode, time?: number) => put("patch", p, node, time)
	// patches to the entry there, said through the overlay's commit
	function edit(part: Key, id: Id, patches: Patch[], time?: number, extra?: Info) {
		const entry = table.get(part, id)!
		update(entry, patches, header(time, extra))
		overlay.commit([entry])
	}
	// a compute of the reader's: its runs counted, its last value kept
	function watch<T>(f: () => T) {
		const w = { runs: 0, value: undefined as T | undefined }
		s.runWithScope(
			reader,
			() => s.createComputer(() => (w.runs++, f()), (v) => void (w.value = v)),
		)
		s.pulse()
		return w
	}
	// what is at path in N's value, as the reader reads it
	const read = (id: Id, path: (string | number)[] = []) => places.readValue("value", id, path)
	// N's value at path, as layers, without the change in each
	const layers = (id: Id, path: (string | number)[] = []) =>
		entries(places, overlay, "value", id, path)
	return {
		s,
		table,
		overlay,
		places,
		header,
		kids,
		value,
		patch,
		edit,
		watch,
		read,
		layers,
	}
}

// the time the target's entry is at: what a patch node made now is made against
const time = (w: { table: Table }, id: Id) => w.table.get("value", id)!.change.time

Deno.test("patch nodes: a patch node in my tree overrides N's title; a world without it sees the base", () => {
	const mine = world(), theirs = world()
	for (const w of [mine, theirs]) {
		w.kids("W", { doc: "N" })
		w.value("N", { title: "theirs", body: "hello" })
	}
	// my root holds /me/skins/title, the patch node; theirs never loads it
	mine.kids("R", { work: "W", me: "M" })
	mine.kids("M", { skins: "S" })
	mine.kids("S", { title: "P" })
	theirs.kids("R", { work: "W" })
	mine.patch("P", {
		on: "N",
		part: "value",
		at: time(mine, "N"),
		patches: [{ path: ["title"], value: "mine" }],
	})
	assertEquals(get(mine.places, ["me", "skins", "title"]), "P")

	const doc = (w: ReturnType<typeof world>) =>
		w.watch(() => {
			const id = get(w.places, ["work", "doc"])
			return id === undefined ? undefined : w.read(id)
		})
	const a = doc(mine), b = doc(theirs)
	assertEquals(a.value, { title: "mine", body: "hello" })
	assertEquals(b.value, { title: "theirs", body: "hello" })
	// nothing written on N: the table still says theirs
	assertEquals(mine.table.get("value", "N")!.value, { title: "theirs", body: "hello" })

	// a write goes to N, under the override: one part changed, the other kept
	mine.edit("value", "N", [{ path: ["body"], value: "hi" }])
	mine.s.pulse()
	assertEquals(a.value, { title: "mine", body: "hi" })
	assertEquals(mine.table.get("value", "N")!.value, { title: "theirs", body: "hi" })
})

Deno.test("patch nodes: a drag ghost moves a card while dragged, then goes", () => {
	const w = world()
	const board = { lists: { A: ["c1", "c2", "c7"], B: ["c4", "c5"] } }
	w.value("N", board)
	const A = w.watch(() => w.read("N", ["lists", "A"]))
	const B = w.watch(() => w.read("N", ["lists", "B"]))
	// c7 dragged from A into B at index to: patches against the board as it is
	const to = (i: number) =>
		produce(board, (d) => {
			const [c] = d.lists.A.splice(2, 1)
			d.lists.B.splice(i, 0, c)
		})
	w.patch("ghost", { on: "N", part: "value", at: time(w, "N"), patches: to(0) })
	w.s.pulse()
	assertEquals([A.value, B.value], [["c1", "c2"], ["c7", "c4", "c5"]])
	// pointermove: the ghost's patches replaced, in its own entry
	w.edit("patch", "ghost", [{ path: ["patches"], value: to(1) }])
	w.s.pulse()
	assertEquals(B.value, ["c4", "c7", "c5"])
	assertEquals(w.layers("N", ["lists", "B"]), [
		{ value: ["c4", "c7", "c5"], from: "ghost" },
		{ value: ["c4", "c5"], from: TABLE },
	])
	// the drag ends without a drop: the ghost goes, the board is as it was
	w.table.del("patch", "ghost")
	w.s.pulse()
	assertEquals([A.value, B.value], [["c1", "c2", "c7"], ["c4", "c5"]])
	assertEquals(w.overlay.index.size, 0)
})

Deno.test("patch nodes: an optimistic write shows until the base catches up, then is dropped", () => {
	const w = world()
	w.value("N", { title: "draft" }, 100)
	const title = w.watch(() => w.read("N", ["title"]))
	// juno's editor: the write as a patch node, sent on to the owner
	w.patch("pending/1", {
		on: "N",
		part: "value",
		at: 100,
		patches: [{ path: ["title"], value: "final" }],
	})
	w.s.pulse()
	assertEquals(title.value, "final")
	// the owner's change lands, answering it: the patch node, made against 100, is stale now
	w.edit("value", "N", [{ path: ["title"], value: "final" }], 160, { answers: "pending/1" })
	w.s.pulse()
	assertEquals(w.layers("N", ["title"]), [
		{ value: "final", from: "pending/1", stale: true },
		{ value: "final", from: TABLE },
	])
	// the editor sees the answer on N's change, and drops its patch node
	assertEquals(w.table.get("value", "N")!.change.metadata?.answers, "pending/1")
	w.table.del("patch", "pending/1")
	w.s.pulse()
	assertEquals(title.value, "final")
	assertEquals(w.layers("N", ["title"]), [{ value: "final", from: TABLE }])
})

Deno.test("patch nodes: a reader reruns on a patch node added, changed and taken out", () => {
	const w = world()
	w.value("N", { title: "base" })
	w.value("O", { title: "other" })
	const n = w.watch(() => w.read("N", ["title"]))
	const o = w.watch(() => w.read("O", ["title"]))
	assertEquals([n.runs, n.value], [1, "base"])
	w.patch("P", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "a" }],
	})
	w.s.pulse()
	assertEquals([n.runs, n.value], [2, "a"])
	w.edit("patch", "P", [{ path: ["patches", 0, "value"], value: "b" }])
	w.s.pulse()
	assertEquals([n.runs, n.value], [3, "b"])
	w.table.del("patch", "P")
	w.s.pulse()
	assertEquals([n.runs, n.value], [4, "base"])
	// a reader of another node: never told
	assertEquals(o.runs, 1)
	// a patch node turned to another target: both told
	w.patch("Q", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "q" }],
	})
	w.s.pulse()
	w.edit("patch", "Q", [{ path: ["on"], value: "O" }])
	w.s.pulse()
	assertEquals([n.value, o.value], ["base", "q"])
})

Deno.test("patch nodes: two patch nodes apply in the order they came; a changed one keeps its place", () => {
	const w = world()
	w.value("N", { title: "base", n: 0 })
	const r = w.watch(() => w.read("N"))
	w.patch("P1", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "one" }, { path: ["n"], value: 1 }],
	})
	w.patch("P2", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "two" }],
	})
	w.s.pulse()
	assertEquals(r.value, { title: "two", n: 1 })
	assertEquals(w.overlay.index.get("N"), ["P1", "P2"])
	w.edit("patch", "P1", [{ path: ["patches", 0, "value"], value: "uno" }])
	w.s.pulse()
	assertEquals(r.value, { title: "two", n: 1 })
	assertEquals(w.overlay.index.get("N"), ["P1", "P2"])
	w.table.del("patch", "P2")
	w.s.pulse()
	assertEquals(r.value, { title: "uno", n: 1 })
})

Deno.test("patch nodes: entries gives every layer at a path, front first, with from; told as a read", () => {
	const w = world()
	w.value("N", { title: "base", body: "b" })
	const e = w.watch(() => w.layers("N", ["title"]))
	assertEquals(e.value, [{ value: "base", from: TABLE }])
	w.patch("P1", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "one" }],
	})
	w.patch("P2", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "two" }],
	})
	w.s.pulse()
	assertEquals(e.value, [
		{ value: "two", from: "P2" },
		{ value: "one", from: "P1" },
		{ value: "base", from: TABLE },
	])
	// the front is what a plain read gives
	assertEquals(w.places.readValue("value", "N", ["title"]), "two")
	// the made entry says its patch nodes, after the table's change
	const change = w.places.readChange("value", "N")!
	assertEquals(change.metadata?.overlay, ["P1", "P2"])
	assertEquals(change.time, time(w, "N"))
	assertEquals(change.op, undefined)
	// nothing there: none
	assertEquals(entries(w.places, w.overlay, "value", "nobody"), [])
})

Deno.test("patch nodes: stale is applied and said; patches that no longer apply are set aside", () => {
	const w = world()
	w.value("N", { title: "t", tags: { a: 1 } }, 100)
	w.patch("P", { on: "N", part: "value", at: 100, patches: [{ path: ["title"], value: "mine" }] })
	w.patch("Q", { on: "N", part: "value", at: 100, patches: [{ path: ["tags", "a"], value: 2 }] })
	const r = w.watch(() => w.read("N"))
	assertEquals(r.value, { title: "mine", tags: { a: 2 } })
	assertEquals(w.layers("N").map((i: Item) => i.stale), [undefined, undefined, undefined])
	// the base changes after both were made: both stale; Q's tags are gone, so it can't apply
	w.edit("value", "N", [{ path: ["tags"] }], 200)
	w.s.pulse()
	assertEquals(r.value, { title: "mine" })
	const [q, p, base] = w.layers("N")
	assertEquals([q.from, q.stale, q.value], ["Q", true, { title: "mine" }])
	assert(q.error instanceof Error)
	assertEquals(p, { value: { title: "mine" }, from: "P", stale: true })
	assertEquals(base, { value: { title: "t" }, from: TABLE })
	// the made change says only what applied
	assertEquals(w.places.readChange("value", "N")!.metadata?.overlay, ["P"])
	// made again against the version now: no longer stale
	w.edit("patch", "P", [{ path: ["at"], value: 200 }])
	assertEquals(w.layers("N")[1], { value: { title: "mine" }, from: "P" })
})

Deno.test("patch nodes: land puts the override on its target for real and takes the patch node out", () => {
	const w = world()
	w.value("N", { title: "theirs" })
	const r = w.watch(() => w.read("N", ["title"]))
	w.patch("P", {
		on: "N",
		part: "value",
		at: time(w, "N"),
		patches: [{ path: ["title"], value: "mine" }],
	})
	w.s.pulse()
	assertEquals([r.runs, r.value], [2, "mine"])
	w.overlay.commit(land(w.table, "P", w.header()))
	w.s.pulse()
	assertEquals(r.value, "mine")
	assertEquals(w.table.get("value", "N")!.value, { title: "mine" })
	assertEquals(w.table.get("patch", "P"), undefined)
	assertEquals(w.layers("N", ["title"]), [{ value: "mine", from: TABLE }])
	// over nothing: the target made; no patch node: refused
	w.patch("Z", { on: "Y", part: "value", at: 0, patches: [{ path: [], value: { made: true } }] })
	assertEquals(w.read("Y"), { made: true })
	assertEquals(land(w.table, "Z", w.header()), [])
	assertEquals(w.table.get("value", "Y")!.value, { made: true })
	assertThrows(() => land(w.table, "Z", w.header()), PatchError)
})

Deno.test("patch nodes: cost: no patch node on the id is one Map check, and the table's entry as it is", () => {
	let gets = 0
	const w = world((event) => {
		const t = createTable(event)
		const g = t.get
		return {
			...t,
			get: ((...a: unknown[]) => (gets++, (g as (...a: unknown[]) => unknown)(...a))) as Table[
				"get"
			],
		}
	})
	w.value("N", { title: "base" })
	// another node with a patch node: the index is not empty
	w.value("O", { title: "o" })
	w.patch("P", {
		on: "O",
		part: "value",
		at: time(w, "O"),
		patches: [{ path: ["title"], value: "p" }],
	})
	let checks = 0
	const index = w.overlay.index as Map<Id, Id[]>
	const real = index.get.bind(index)
	index.get = (k: Id) => (checks++, real(k))
	gets = 0
	const entry = w.overlay.get("value", "N")
	assertEquals([checks, gets], [1, 1])
	assert(entry === w.table.get("value", "N"))
	// through places, as a reader reads: still one each
	checks = 0, gets = 0
	assertEquals(w.places.readValue("value", "N", ["title"]), "base")
	assertEquals([checks, gets], [1, 1])
})

Deno.test("patch nodes: an entry written through places' unread is copied on its next write once a patch node is made over it", () => {
	const w = world()
	w.table.sub("children", "N", createEntry({ a: "A" }, w.header()) as never)
	const n = w.table.get("children", "N")!
	// owned by unread, so the next write is in place
	unread.update(n, [{ path: ["b"], value: "B" }], w.header())
	const mine = n.value
	unread.update(n, [{ path: ["c"], value: "C" }], w.header())
	assert(n.value === mine)
	w.patch("P", {
		on: "N",
		part: "children",
		at: 0,
		patches: [{ path: ["m"], move: { path: ["a"] } }],
	})
	const r = w.watch(() => w.places.readValue("children", "N", ["m"]))
	assertEquals([r.runs, r.value], [1, "A"])
	const before = n.value
	unread.update(n, [{ path: ["a"], value: "A2" }], w.header())
	w.overlay.commit([n])
	w.s.pulse()
	// copied, not changed: the reader told where it lands
	assert(n.value !== before)
	assertEquals(before, { a: "A", b: "B", c: "C" })
	assertEquals([r.runs, r.value], [2, "A2"])
})
