// the guard end to end: a composed world (table, places, paths, scheduler, link) and protect's
// policies. each test reads and writes as a process layer would: asking the guard, then calling
// places, link and the table itself, with a scope open
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces, type Entry, type Item } from "@ermine/places"
import { all, grants, no, pending, type Policy, yes } from "@ermine/protect"
import { createScheduler, PENDING, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/graph/table"
import { createGuard, Refusal, REFUSED, type Setup, slot, target } from "./guard.ts"
import { createLink } from "./link.ts"

const isEntry = (x: Item | Entry): x is Entry => Array.isArray(x)

function world() {
	const s = createScheduler({ forget: (key) => l.forget(key) })
	const table = createTable((part, id) => l.event(part as Key, id))
	const l = createLink({ table, paths: createPaths<unknown>(), scheduler: s })
	const places = createPlaces({
		root: ["stored", "R"],
		children: (_, id) => table.get("children", id),
		read: l.read,
	})
	const host = s.root([["actor", "host"]])
	const hosted = <T>(f: () => T) => s.run(host, f)
	const guard = (more: Partial<Setup> = {}) => createGuard({ link: l, table, ...more })
	function edit(part: Key, id: Id, patches: Patch[]) {
		const h = l.header()
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h)
			update(node, patches, h)
			table.add(part, id, node)
		} else {
			update(there, patches, h)
			l.wrote([{ node: there }])
		}
	}
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, l.header())))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry<unknown>(v, l.header())))
	const reset = (id: Id, v: unknown) => hosted(() => edit("value", id, [{ path: [], value: v }]))
	const ids = (x: Item | Entry): Entry => isEntry(x) ? x : [x.source, x.id]
	// a guarded read of a value, and a guarded write of one
	const read = (g: ReturnType<typeof guard>, x: Item | Entry) => {
		g.read(target(x, "value"))
		return l.get("value", ids(x)[1])
	}
	const write = (g: ReturnType<typeof guard>, x: Item | Entry, v: unknown) => {
		g.write("edit", target(x, "value", []))
		edit("value", ids(x)[1], [{ path: [], value: v }])
	}
	// a compute of a process's, made in its scope, its results kept
	function watch(process: Scope, f: () => unknown) {
		const seen: unknown[] = []
		let runs = 0
		s.run(process, () => s.compute(() => (runs++, f()), (v) => void seen.push(v)))
		return { seen, runs: () => runs }
	}
	return { s, l, table, places, hosted, guard, kids, value, reset, read, write, watch }
}

const rules = grants({ source: "stored", part: "value", id: "rules" })
const tryout = (f: () => unknown) => {
	try {
		return f()
	} catch (e) {
		return e instanceof Refusal ? "refused" : e === PENDING ? "pending" : (e as Error).message
	}
}

// a policy that writes down what it was asked
function recording(then: Policy) {
	const asks: Parameters<Policy>[0][] = []
	const policy: Policy = (ask, read) => (asks.push(ask), then(ask, read))
	return { asks, policy }
}

Deno.test("guard: reads and writes are asked of the policy: who is the scope open, from where the asker is", () => {
	const w = world()
	w.kids("R", { apps: [["stored", "Apps"]], notes: [["stored", "N"]] })
	w.kids("Apps", { notes: [["stored", "Notes"]] })
	w.kids("N", { today: [["stored", "T"]] })
	w.value("T", "hello")
	const { asks, policy } = recording(() => yes)
	const g = w.guard({ may: policy, from: w.places.get(["apps", "notes"])[0] })
	const notes = w.s.root([["actor", "notes"]])
	w.s.run(notes, () => {
		const [item] = g.items(w.places.get(["notes", "today"]))
		w.read(g, item)
		w.write(g, item, "bye")
	})
	const route: Entry[] = [["stored", "R"], ["stored", "N"], ["stored", "T"]]
	assertEquals(asks.map((a) => [a.op, a.target.part, a.target.path, a.target.route]), [
		["read", undefined, ["notes", "today"], route],
		["read", "value", ["notes", "today"], route],
		["edit", "value", ["notes", "today"], route],
	])
	assertEquals(asks.map((a) => a.who), [{ actor: "notes" }, { actor: "notes" }, {
		actor: "notes",
	}])
	assertEquals(asks[0].from?.path, ["apps", "notes"])
	// an entry is by id: no path, no route
	asks.length = 0
	w.s.run(notes, () => w.read(g, ["stored", "T"]))
	assertEquals([asks[0].target.id, asks[0].target.path, asks[0].target.route], [
		"T",
		undefined,
		undefined,
	])
})

Deno.test("guard: a write can't name another actor: it is asked as the scope's", () => {
	const w = world()
	w.value("A", 1)
	w.value("rules", [{ actor: "chee", op: "edit" }])
	const g = w.guard({ may: rules })
	const juno = w.s.root([["actor", "juno"]])
	// a scope under juno's naming chee only adds a pair
	const forged = w.s.scope([["actor", "chee"]], juno)
	assertEquals(tryout(() => w.s.run(forged, () => w.write(g, ["stored", "A"], 2))), "refused")
	assertEquals(w.table.get("value", "A")?.value, 1)
	w.s.run(w.s.root([["actor", "chee"]]), () => w.write(g, ["stored", "A"], 2))
	assertEquals(w.table.get("value", "A")?.value, 2)
})

Deno.test("guard: a refused item stays in a list as REFUSED, in its place; asking of it is refused", () => {
	const w = world()
	w.kids("R", { a: [["stored", "X"], ["stored", "Y"]] })
	const g = w.guard({ may: (ask) => ask.target.id === "Y" ? no("not Y") : yes })
	const got = w.hosted(() => g.items(w.places.get(["a"])))
	assertEquals(got.map((i) => [i.source, i.id, i.name, i.at]), [
		["stored", "X", "a", 0],
		[REFUSED, REFUSED, "a", 1],
	])
	assertEquals(w.hosted(() => g.items(w.places.members(["stored", "R"]))).map((i) => i.id), [
		"X",
		REFUSED,
	])
	for (
		const f of [
			() => w.read(g, got[1]),
			() => w.write(g, got[1], 1),
			() => g.write("place", slot([got[1], "n"])),
		]
	) {
		assertEquals(tryout(() => w.hosted(f)), "refused")
	}
	const e = assertThrows(() => w.hosted(() => w.read(g, got[1])))
	assertInstanceOf(e, Refusal)
	assertEquals(e.answer.reason, "refused")
})

Deno.test("guard: pending throws PENDING: the rules not there, a run ends pending and runs once they are; a write throws, nothing made", () => {
	const w = world()
	w.value("A", "x")
	const g = w.guard({ may: rules })
	const notes = w.s.root([["actor", "chee"]])
	const { seen } = w.watch(notes, () => w.read(g, ["stored", "A"]))
	w.s.pulse()
	assertEquals(seen, [])
	w.value("rules", [{ actor: "chee" }])
	w.s.pulse()
	assertEquals(seen, ["x"])
	const later = w.guard({ may: grants({ source: "stored", part: "value", id: "later" }) })
	assertEquals(tryout(() => w.s.run(notes, () => w.write(later, ["stored", "A"], 2))), "pending")
	assertEquals(w.table.get("value", "A")?.value, "x")
})

Deno.test("guard: a refused read is still tracked: a rule change reruns it", () => {
	const w = world()
	w.value("A", "secret")
	w.value("rules", [])
	const g = w.guard({ may: rules })
	const chee = w.s.root([["actor", "chee"]])
	const { seen, runs } = w.watch(chee, () => tryout(() => w.read(g, ["stored", "A"])))
	w.s.pulse()
	assertEquals(seen, ["refused"])
	w.reset("rules", [{ actor: "chee", op: "read" }])
	w.s.pulse()
	assertEquals([seen, runs()], [["refused", "secret"], 2])
	w.reset("rules", [])
	w.s.pulse()
	assertEquals(seen.at(-1), "refused")
})

Deno.test("guard: policies are colourless: a policy reads an access node, pending until it is there; only the runs that asked rerun", () => {
	const w = world()
	w.value("A", "x")
	w.value("rules", [{ actor: "chee" }])
	const access: Policy = (_, read) => {
		const a = read("stored", "value", "access")
		return a === undefined
			? pending(["stored", "value", "access"])
			: a === "allow"
			? yes
			: no("closed")
	}
	const chee = w.s.root([["actor", "chee"]])
	const asking = w.watch(chee, () => w.read(w.guard({ may: all(access, rules) }), ["stored", "A"]))
	const plain = w.watch(chee, () => w.read(w.guard(), ["stored", "A"]))
	w.s.pulse()
	assertEquals([asking.seen, plain.seen], [[], ["x"]])
	// a background check writes the answer, as a host does
	w.value("access", "allow")
	w.s.pulse()
	assertEquals([asking.seen, asking.runs(), plain.runs()], [["x"], 2, 1])
	// both nodes are read, tracked: revoke the rules and it reruns, refused (its last value kept)
	w.reset("rules", [])
	w.s.pulse()
	assertEquals([asking.runs(), asking.seen], [3, ["x"]])
})

Deno.test("guard: a write's check doesn't make an effect depend on the rules", () => {
	const w = world()
	w.value("rules", [{ actor: "chee" }])
	w.value("A", 1)
	const g = w.guard({ may: rules })
	let acts = 0
	w.s.run(w.s.root([["actor", "chee"]]), () =>
		w.s.effect(() => 0, () => {
			acts++
			w.write(g, ["stored", "A"], acts)
		}))
	w.s.pulse()
	w.reset("rules", [{ actor: "chee" }, { actor: "juno" }])
	w.s.pulse()
	assertEquals([acts, w.table.get("value", "A")?.value], [1, 1])
})

Deno.test("guard: the three: where the asker is, the route to the target, the id", () => {
	const w = world()
	w.kids("R", {
		apps: [["stored", "Apps"]],
		docs: [["stored", "Docs"]],
		trash: [["stored", "Docs"]],
	})
	w.kids("Apps", { notes: [["stored", "Notes"]], games: [["stored", "Games"]] })
	w.kids("Docs", { a: [["stored", "D"]], secret: [["stored", "S"]] })
	w.kids("Notes", {})
	w.kids("Games", {})
	w.value("rules", [
		{ actor: "chee", op: "read", from: ["apps", "notes"], path: ["docs"] },
		{ actor: "chee", op: "read", id: "S", deny: true },
		{ actor: "chee", op: "read", from: ["apps", "notes"], path: ["trash"], id: "S" },
	])
	const at = (name?: string) =>
		w.guard({ may: rules, from: name ? w.places.get(["apps", name])[0] : undefined })
	const chee = w.s.root([["actor", "chee"]])
	const ids = (g: ReturnType<typeof at>, address: string[]) =>
		w.s.run(chee, () => g.items(w.places.get(address)).map((i) => i.id))
	assertEquals(ids(at("notes"), ["docs", "a"]), ["D"])
	assertEquals(ids(at("games"), ["docs", "a"]), [REFUSED])
	assertEquals(ids(at("notes"), ["trash", "a"]), [REFUSED])
	assertEquals(ids(at("notes"), ["docs", "secret"]), [REFUSED])
	assertEquals(ids(at("notes"), ["trash", "secret"]), [REFUSED])
	// a host, at no place: from-grants do not match it
	assertEquals(ids(at(), ["docs", "a"]), [REFUSED])
	// by id alone, no route: the path grant does not match
	assertEquals(tryout(() => w.s.run(chee, () => w.read(at("notes"), ["stored", "D"]))), "refused")
})
