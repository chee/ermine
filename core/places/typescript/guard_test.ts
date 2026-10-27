// the guard end to end: a composed world (table, paths, scheduler, places) and protect's policies.
// each test reads and writes as a process layer would: asking the guard, then calling places and
// the table itself, with a scope open
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert"
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Patch } from "@ermine/core/changeable/apply"
import { all, grants, no, pending, type Policy, yes } from "@ermine/core/protect"
import { createScheduler, PENDING, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createGuard, Refusal, REFUSED, type Setup, slot, target, type Thing } from "./guard.ts"
import { createPlaces } from "./places.ts"
import { get, members } from "./lib.ts"
import { createChangeHeader } from "./header.ts"

function world() {
	const s = createScheduler()
	s.onTrackingEnd((key) => l.release(key))
	const table = createTable((part, id) => l.onTableChange(part as Key, id))
	const l = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const places = l
	const host = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const guard = (more: Partial<Setup> = {}) =>
		createGuard({ places: l, scheduler: s, table, ...more })
	function edit(part: Key, id: Id, patches: Patch[]) {
		const h = createChangeHeader(s)
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h)
			update(node, patches, h)
			table.add(part, id, node)
		} else {
			update(there, patches, h)
			l.commit([there])
		}
	}
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, createChangeHeader(s))))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry<unknown>(v, createChangeHeader(s))))
	const reset = (id: Id, v: unknown) => hosted(() => edit("value", id, [{ path: [], value: v }]))
	// a thing: one given, or an id alone
	const thing = (x: Thing | Id): Thing => typeof x === "object" ? x : { id: x }
	// a guarded read of a value, and a guarded write of one
	const read = (g: ReturnType<typeof guard>, x: Thing | Id) => {
		g.read(target(thing(x), "value"))
		return l.readValue("value", thing(x).id)
	}
	const write = (g: ReturnType<typeof guard>, x: Thing | Id, v: unknown) => {
		g.write("edit", target(thing(x), "value", []))
		edit("value", thing(x).id, [{ path: [], value: v }])
	}
	// a compute of a process's, made in its scope, its results kept
	function watch(process: Scope, f: () => unknown) {
		const seen: unknown[] = []
		let runs = 0
		s.runWithScope(process, () => s.createComputer(() => (runs++, f()), (v) => void seen.push(v)))
		return { seen, runs: () => runs }
	}
	return { s, l, table, places, hosted, guard, kids, value, reset, read, write, watch }
}

const rules = grants({ part: "value", id: "rules" })
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
	w.kids("R", { apps: "Apps", notes: "N" })
	w.kids("Apps", { notes: "Notes" })
	w.kids("N", { today: "T" })
	w.value("T", "hello")
	const { asks, policy } = recording(() => yes)
	const g = w.guard({ may: policy, from: ["apps", "notes"] })
	const notes = w.s.createRootScope({ actor: "notes" })
	const path = ["notes", "today"]
	w.s.runWithScope(notes, () => {
		const [m] = g.members(members(w.places, ["notes"]), ["notes"])
		w.read(g, { id: m.id, path })
		w.write(g, { id: m.id, path }, "bye")
	})
	assertEquals(asks.map((a) => [a.op, a.target.part, a.target.path]), [
		["read", undefined, path],
		["read", "value", path],
		["edit", "value", path],
	])
	const info = { actor: "notes" }
	assertEquals(asks.map((a) => a.who), [
		{ actor: "notes", metadata: info },
		{ actor: "notes", metadata: info },
		{ actor: "notes", metadata: info },
	])
	assertEquals(asks[0].from?.path, ["apps", "notes"])
	// an id alone: no path
	asks.length = 0
	w.s.runWithScope(notes, () => w.read(g, "T"))
	assertEquals([asks[0].target.id, asks[0].target.path], ["T", undefined])
})

Deno.test("guard: a write is asked as the nearest actor: one under a scope naming another is that one", () => {
	const w = world()
	w.value("A", 1)
	w.value("rules", [{ actor: "chee", op: "edit" }])
	const g = w.guard({ may: rules })
	const juno = w.s.createRootScope({ actor: "juno" })
	// a scope under juno's with no actor is juno's
	const quiet = w.s.createScope({ why: "save" }, juno)
	assertEquals(tryout(() => w.s.runWithScope(quiet, () => w.write(g, "A", 2))), "refused")
	assertEquals(w.table.get("value", "A")?.value, 1)
	// one naming chee is chee's, the nearest
	const named = w.s.createScope({ actor: "chee" }, juno)
	w.s.runWithScope(named, () => w.write(g, "A", 3))
	assertEquals(w.table.get("value", "A")?.value, 3)
	w.s.runWithScope(w.s.createRootScope({ actor: "chee" }), () => w.write(g, "A", 2))
	assertEquals(w.table.get("value", "A")?.value, 2)
})

Deno.test("guard: a refused member stays in a list, its id REFUSED, in its place; asking of it is refused", () => {
	const w = world()
	w.kids("R", { a: "X", b: "Y" })
	const g = w.guard({ may: (ask) => ask.target.id === "Y" ? no("not Y") : yes })
	const got = w.hosted(() => g.members(members(w.places, []), []))
	assertEquals(got.map((m) => [m.id, m.name]), [["X", "a"], [REFUSED, "b"]])
	const refused = { id: got[1].id, path: ["b"] }
	for (
		const f of [
			() => w.read(g, refused),
			() => w.write(g, refused, 1),
			() => g.write("place", slot(refused, "n")),
		]
	) {
		assertEquals(tryout(() => w.hosted(f)), "refused")
	}
	const e = assertThrows(() => w.hosted(() => w.read(g, refused)))
	assertInstanceOf(e, Refusal)
	assertEquals(e.answer.reason, "refused")
})

Deno.test("guard: pending throws PENDING: the rules not there, a run ends pending and runs once they are; a write throws, nothing made", () => {
	const w = world()
	w.value("A", "x")
	const g = w.guard({ may: rules })
	const notes = w.s.createRootScope({ actor: "chee" })
	const { seen } = w.watch(notes, () => w.read(g, "A"))
	w.s.pulse()
	assertEquals(seen, [])
	w.value("rules", [{ actor: "chee" }])
	w.s.pulse()
	assertEquals(seen, ["x"])
	const later = w.guard({ may: grants({ part: "value", id: "later" }) })
	assertEquals(tryout(() => w.s.runWithScope(notes, () => w.write(later, "A", 2))), "pending")
	assertEquals(w.table.get("value", "A")?.value, "x")
})

Deno.test("guard: a refused read is still tracked: a rule change reruns it", () => {
	const w = world()
	w.value("A", "secret")
	w.value("rules", [])
	const g = w.guard({ may: rules })
	const chee = w.s.createRootScope({ actor: "chee" })
	const { seen, runs } = w.watch(chee, () => tryout(() => w.read(g, "A")))
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
		const a = read("value", "access")
		return a === undefined ? pending(["value", "access"]) : a === "allow" ? yes : no("closed")
	}
	const chee = w.s.createRootScope({ actor: "chee" })
	const asking = w.watch(chee, () => w.read(w.guard({ may: all(access, rules) }), "A"))
	const plain = w.watch(chee, () => w.read(w.guard(), "A"))
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
	w.s.runWithScope(
		w.s.createRootScope({ actor: "chee" }),
		() =>
			w.s.createEffect(() => 0, () => {
				acts++
				w.write(g, "A", acts)
			}),
	)
	w.s.pulse()
	w.reset("rules", [{ actor: "chee" }, { actor: "juno" }])
	w.s.pulse()
	assertEquals([acts, w.table.get("value", "A")?.value], [1, 1])
})

Deno.test("guard: the three: where the asker is, the path to the target, the id", () => {
	const w = world()
	w.kids("R", {
		apps: "Apps",
		docs: "Docs",
		trash: "Docs",
	})
	w.kids("Apps", { notes: "Notes", games: "Games" })
	w.kids("Docs", { a: "D", secret: "S" })
	w.kids("Notes", {})
	w.kids("Games", {})
	w.value("rules", [
		{ actor: "chee", op: "read", from: ["apps", "notes"], path: ["docs"] },
		{ actor: "chee", op: "read", id: "S", deny: true },
		{ actor: "chee", op: "read", from: ["apps", "notes"], path: ["trash"], id: "S" },
	])
	const at = (name?: string) => w.guard({ may: rules, from: name ? ["apps", name] : undefined })
	const chee = w.s.createRootScope({ actor: "chee" })
	// the thing at a path, asked through the guard
	const ids = (g: ReturnType<typeof at>, path: string[]) =>
		w.s.runWithScope(
			chee,
			() =>
				g.members([{ name: path.at(-1)!, id: get(w.places, path)! }], path.slice(0, -1)).map((
					m,
				) => m.id),
		)
	assertEquals(ids(at("notes"), ["docs", "a"]), ["D"])
	assertEquals(ids(at("games"), ["docs", "a"]), [REFUSED])
	assertEquals(ids(at("notes"), ["trash", "a"]), [REFUSED])
	assertEquals(ids(at("notes"), ["docs", "secret"]), [REFUSED])
	assertEquals(ids(at("notes"), ["trash", "secret"]), [REFUSED])
	// a host, at no place: from-grants do not match it
	assertEquals(ids(at(), ["docs", "a"]), [REFUSED])
	// by id alone, no path: the path grant does not match
	assertEquals(tryout(() => w.s.runWithScope(chee, () => w.read(at("notes"), "D"))), "refused")
})
