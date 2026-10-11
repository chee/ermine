import { assertEquals, assertThrows } from "@std/assert"
import createNode, { type List, type Node } from "./node.ts"
import createChange, { type Change } from "./change.ts"
import { createTable } from "./table.ts"
import { createPlaces, type Part, PlacesError } from "./places.ts"

type N = Node<unknown, unknown>
const change = {}

// a graph from {id: {name: [ids]}}; ids not given are not loaded
function graph(spec: Record<string, Record<string, List>>) {
	const nodes = new Map<string, N>()
	for (const [id, kids] of Object.entries(spec)) {
		nodes.set(
			id,
			createNode(id, {
				children: Object.entries(kids).map(([k, ids]) => [k, [{ content: ids, change }]]),
			}),
		)
	}
	return (id: string) => nodes.get(id)
}

// LIBRARY.tex's lift: / → home → chee → notes, theme at / and at /home
const get = graph({
	root: { home: ["home"], theme: ["classic"] },
	home: { chee: ["chee"], theme: ["plum", "butter"], tools: ["tools"] },
	chee: { notes: ["notes"] },
	notes: { editor: ["editor"] },
	plum: {},
	butter: {},
	classic: {},
	tools: {},
	editor: {},
})
const places = createPlaces(get, "root")
const ids = (items: { id: string }[]) => items.map((i) => i.id)
const notes = ["home", "chee", "notes"]

Deno.test("look: by name from the place, from the start, and back", () => {
	assertEquals(ids(places.look(notes, ["editor"])), ["editor"])
	assertEquals(ids(places.look(notes, ["/", "home", "theme"])), ["plum", "butter"])
	assertEquals(ids(places.look(notes, ["..", "..", "theme"])), ["plum", "butter"])
	assertEquals(ids(places.look(notes, [])), ["notes"])
	assertEquals(ids(places.look([], [])), ["root"])
})

Deno.test("look: a route per name of the address", () => {
	const [it] = places.look(["home"], ["chee", "notes"])
	assertEquals(it.route, [
		{ node: "home", name: "chee", id: "chee", at: 0 },
		{ node: "chee", name: "notes", id: "notes", at: 0 },
	])
})

Deno.test("look: pending in place; the walk passes ids without the next name", () => {
	const get = graph({ r: { t: ["gone", "m", "d"] }, m: { colors: ["c"] }, d: { fonts: ["f"] } })
	const t = createPlaces(get, "r")
	const all = t.look([], ["t"])
	assertEquals(all.map((i) => [i.id, i.node !== undefined]), [["gone", false], ["m", true], [
		"d",
		true,
	]])
	assertEquals(ids(t.look([], ["t", "fonts"])), ["f"])
	assertEquals(ids(t.look([], ["t", "colors"])), ["c"])
	assertEquals(t.look([], ["t", "nope"]), [])
})

Deno.test("look: not an address", () => {
	const code = (f: () => unknown) => (assertThrows(f, PlacesError) as PlacesError).code
	assertEquals(code(() => places.look(notes, ["a", ".."])), "wrong-field")
	assertEquals(code(() => places.look(notes, ["a", "/"])), "wrong-field")
	assertEquals(code(() => places.look(notes, ["."])), "wrong-field")
	assertEquals(code(() => places.look(notes, ["a/b"])), "wrong-field")
	assertEquals(code(() => places.look(["a/b"], [])), "wrong-field")
	assertEquals(code(() => places.lookup(notes, ["a/b"])), "wrong-field")
	assertEquals(code(() => places.look([], [".."])), "above-root")
})

Deno.test("another start: a person whose / is /home", () => {
	const home = createPlaces(get, "home")
	assertEquals(ids(home.look(["chee"], ["/", "tools"])), ["tools"])
	assertEquals(ids(home.look([], [])), ["home"])
	assertEquals(ids(home.lookups(["chee", "notes"], ["theme"])), ["plum", "butter"])
	assertEquals(
		(assertThrows(() => home.look([], [".."]), PlacesError) as PlacesError).code,
		"above-root",
	)
})

Deno.test("lookup: the nearest list, up to the start", () => {
	const it = places.lookup(notes, ["theme"])
	assertEquals(ids(it), ["plum", "butter"])
	assertEquals(it[0].up, 2)
	assertEquals(it[0].route, [{ node: "home", name: "theme", id: "plum", at: 0 }])
	assertEquals(ids(places.lookups(notes, ["theme"])), ["plum", "butter", "classic"])
})

Deno.test("lookup: a list with nothing loaded is passed", () => {
	const get = graph({ r: { a: ["a"], x: ["x0"] }, a: { x: ["gone"] }, x0: {} })
	assertEquals(ids(createPlaces(get, "r").lookup(["a"], ["x"])), ["x0"])
})

Deno.test("lookup: a walk stopped part way searches from the last node taken", () => {
	assertEquals(ids(places.lookup(["home", "chee", "nobody"], ["tools"])), ["tools"])
})

Deno.test("children: names, first seen first; a name's ids node by node", () => {
	assertEquals(places.children([], ["home"]), ["chee", "theme", "tools"])
	assertEquals(ids(places.children([], ["home"], "theme") as { id: string }[]), [
		"plum",
		"butter",
	])
})

Deno.test("depend: each place read, in order read", () => {
	const said: [string, Part][] = []
	places.lookup(["home"], ["theme"], (id, part) => said.push([id, part]))
	assertEquals(said, [
		["root", "loaded"],
		["root", ["children", "home"]],
		["home", "loaded"],
		["home", ["children", "theme"]],
		["plum", "loaded"],
		["butter", "loaded"],
	])
})

Deno.test("depend: a read's own, else the places's fallback", () => {
	const mine: string[] = [], theirs: string[] = []
	const t = createPlaces(get, "root", { fallback: (id) => theirs.push(id) })
	t.look([], ["home"])
	t.look([], ["home"], (id) => mine.push(id))
	assertEquals([theirs.length > 0, mine.length > 0], [true, true])
	assertEquals(theirs, mine)
})

// placing: ids in a table, lists changed through a places
let time = 0
function placing() {
	time = 0
	const t = createTable<unknown, Change>()
	t.intro(createNode("root"))
	const p = createPlaces(t.get, "root", { by: () => ({ actor: "me", time: ++time }) })
	const list = (id: string, name: string) => t.get(id)?.children.get(name)?.[0]?.content
	const all = () => t.get("root")?.children.get("kids")?.map((v) => v.content)
	return { t, p, list, all }
}
const placed = (f: () => unknown) => (assertThrows(f, PlacesError) as PlacesError).code

// a list with versions, newest first: [["a"], ["b"], ["c"]]
function versions(t: ReturnType<typeof placing>["t"]) {
	const v = (ids: string[]) => ({
		content: ids,
		change: createChange("root", { time: 0, actor: "x" }),
	})
	t.get("root")!.children.set("kids", [v(["a"]), v(["b"]), v(["c"])])
}

Deno.test("insert: an id in a list, one change each; it need not be loaded", () => {
	const { p, list } = placing()
	const c = p.insert("root", "kids", "a")
	p.insert("root", "kids", "b", 0)
	p.insert("root", "kids", "c", 1)
	assertEquals(c, { actor: "me", time: 1, node: "root" })
	assertEquals(list("root", "kids"), ["b", "c", "a"])
	assertEquals(placed(() => p.insert("nope", "kids", "d")), "nothing-there")
	assertEquals(placed(() => p.insert("root", "a/b", "d")), "wrong-field")
})

Deno.test("insert: the same id in two places", () => {
	const { p, list } = placing()
	p.insert("root", "x", "a")
	p.insert("root", "y", "a")
	assertEquals([list("root", "x"), list("root", "y")], [["a"], ["a"]])
})

Deno.test("insert: index a span replaces the ids there", () => {
	const { p, list } = placing()
	for (const id of ["a", "b", "c"]) p.insert("root", "kids", id)
	p.insert("root", "kids", "d", [0, 2])
	assertEquals(list("root", "kids"), ["d", "c"])
	assertEquals(placed(() => p.insert("root", "kids", "e", [1, 5])), "range")
})

Deno.test("insert: slotindex picks a version; a span becomes one version at its start", () => {
	const { t, p, all } = placing()
	versions(t)
	p.insert("root", "kids", "x", 0, 1)
	assertEquals(all(), [["a"], ["x", "b"], ["c"]])
	const c = p.insert("root", "kids", "y", undefined, [0, 2])
	assertEquals(all(), [["a", "y"], ["c"]])
	assertEquals(t.get("root")!.children.get("kids")![0].change, c)
	assertEquals(placed(() => p.insert("root", "kids", "z", 0, 2)), "range")
	assertEquals(placed(() => p.insert("root", "kids", "z", 0, [1, 1])), "range")
})

Deno.test("pop: drops versions whole; none left: the name gone", () => {
	const { t, p, all } = placing()
	versions(t)
	const c = p.pop("root", "kids", 1)
	assertEquals(c, { actor: "me", time: 1, node: "root" })
	assertEquals(all(), [["a"], ["c"]])
	assertEquals(placed(() => p.pop("root", "kids", [1, 3])), "range")
	p.pop("root", "kids", [0, 2])
	assertEquals(t.get("root")?.children.has("kids"), false)
	assertEquals(placed(() => p.pop("root", "kids", 0)), "range")
})

Deno.test("remove: ids out of a list, nothing in their place", () => {
	const { t, p, list, all } = placing()
	for (const id of ["a", "b", "c", "d"]) p.insert("root", "kids", id)
	const c = p.remove("root", "kids", 1)
	assertEquals(c, { actor: "me", time: 5, node: "root" })
	assertEquals(list("root", "kids"), ["a", "c", "d"])
	p.remove("root", "kids", [0, 2])
	assertEquals(list("root", "kids"), ["d"])
	assertEquals(placed(() => p.remove("root", "kids", 1)), "range")
	assertEquals(placed(() => p.remove("root", "kids", [0, 0])), "range")
	// a list left empty is gone (mutate's rule): the name, or that version
	p.remove("root", "kids", 0)
	assertEquals(t.get("root")!.children.has("kids"), false)
	versions(t)
	p.remove("root", "kids", 0, 1)
	assertEquals(all(), [["a"], ["c"]])
})

Deno.test("rename: keeps the slot, two changes", () => {
	const { t, p, list } = placing()
	p.insert("root", "one", "a")
	p.insert("root", "two", "b")
	p.insert("root", "three", "c")
	assertEquals(p.rename("root", "two", "deux").length, 2)
	assertEquals([...t.get("root")!.children.keys()], ["one", "deux", "three"])
	assertEquals(list("root", "deux"), ["b"])
	assertEquals(placed(() => p.rename("root", "one", "three")), "already-there")
	assertEquals(placed(() => p.rename("root", "nope", "x")), "nothing-there")
	assertEquals(placed(() => p.rename("root", "one", "..")), "wrong-field")
})

Deno.test("move: within a list is one change; across is two", () => {
	const { t, p, list } = placing()
	t.intro(createNode("box"))
	p.insert("root", "box", "box")
	for (const id of ["a", "b", "c"]) p.insert("root", "kids", id)
	assertEquals(p.move("root", "kids", 2, "root", "kids", 0).length, 1)
	assertEquals(list("root", "kids"), ["c", "a", "b"])
	assertEquals(p.move("root", "kids", 0, "box", "in").length, 2)
	assertEquals([list("root", "kids"), list("box", "in")], [["a", "b"], ["c"]])
	assertEquals(placed(() => p.move("root", "kids", 0, "box", "in", 5)), "range")
	assertEquals(list("root", "kids"), ["a", "b"])
})

Deno.test("placing: a places with no by only reads", () => {
	assertThrows(() => places.insert("root", "kids", "a"), TypeError)
})

Deno.test("placing: by the parent node itself, for a holder of the table", () => {
	const { t, p, list } = placing()
	const root = t.get("root")!
	p.insert(root, "kids", "a")
	p.insert("root", "kids", "b")
	assertEquals(list("root", "kids"), ["a", "b"])
	p.move(root, "kids", 0, root, "kids")
	assertEquals(list("root", "kids"), ["b", "a"])
})

Deno.test("write and set: patches at the node an address reaches, one change", () => {
	const { t, p } = placing()
	t.intro(createNode("a"))
	t.intro(createNode("b"))
	p.insert("root", "home", "gone")
	p.insert("root", "home", "a")
	p.insert("a", "notes", "b")
	const said: string[] = []
	const q = createPlaces(t.get, "root", {
		by: () => ({ actor: "me", time: 9 }),
		fallback: (id) => said.push(id),
	})
	const c = q.write(["home"], ["notes"], [{ path: [], value: "hi" }])
	assertEquals(t.get("b")!.value[0].content, "hi")
	assertEquals(c, { actor: "me", time: 9, node: "b" })
	q.set(["home"], [], "title", [{ path: [], value: "home" }])
	assertEquals(t.get("a")!.info.get("title")![0].content, "home")
	assertEquals(said, [])
	assertEquals(placed(() => q.write([], ["nope"], [{ path: [], value: 1 }])), "nothing-there")
	assertEquals(placed(() => q.set([], ["home"], "..", [])), "wrong-field")
})

Deno.test("write: index picks the item, slotindex the version", () => {
	const { t, p } = placing()
	const v = (content: unknown) => ({ content, change: createChange("x", { time: 0, actor: "x" }) })
	t.intro(createNode("a", { value: [v(1)] }))
	t.intro(createNode("b", { value: [v(2), v(3), v(4)] }))
	for (const id of ["gone", "a", "b"]) p.insert("root", "kids", id)
	const values = (id: string) => t.get(id)!.value.map((x) => x.content)
	p.write([], ["kids"], [{ path: [], value: 20 }], 2)
	assertEquals(values("b"), [20, 3, 4])
	p.write([], ["kids"], [{ path: [], value: 30 }], 2, 1)
	assertEquals(values("b"), [20, 30, 4])
	p.write([], ["kids"], [{ path: [], value: 0 }], 2, [0, 2])
	assertEquals(values("b"), [0, 4])
	assertEquals(values("a"), [1])
	assertEquals(placed(() => p.write([], ["kids"], [], 0)), "nothing-there")
	assertEquals(placed(() => p.write([], ["kids"], [], 3)), "range")
	assertEquals(placed(() => p.write([], ["kids"], [], 2, 5)), "range")
	p.set([], ["kids"], "title", [{ path: [], value: "B" }], 2)
	assertEquals(t.get("b")!.info.get("title")!.map((x) => x.content), ["B"])
	p.write([], ["kids"], [{ path: [] }], 1)
	assertEquals(values("a"), [])
})

Deno.test("cd: a trail gives what the names give, on a graph that holds still", () => {
	const cases: [string[], string[]][] = [
		[["home", "chee", "notes"], ["editor"]],
		[["home", "chee", "notes"], []],
		[["home", "chee", "notes"], ["..", "..", "theme"]],
		[["home", "chee", "notes"], ["/", "home"]],
		[["home", "chee", "notes"], ["/"]],
		[["home", "chee"], ["notes", "editor"]],
		[["home", "nobody"], ["x"]],
		[[], ["home"]],
	]
	for (const [place, address] of cases) {
		const here = places.cd(place)
		assertEquals(
			here.look(address),
			places.look(place, address),
			place.join("/") + " " + address.join("/"),
		)
		for (const name of ["theme", "tools", "editor"]) {
			assertEquals(here.lookup([name]), places.lookup(place, [name]))
			assertEquals(here.lookups([name]), places.lookups(place, [name]))
		}
	}
})

Deno.test("cd: from a place, relative; .. backs up the trail", () => {
	const chee = places.cd(["home", "chee"])
	assertEquals(chee.trail, ["root", "home", "chee"])
	assertEquals(chee.cd(["notes"]).trail, ["root", "home", "chee", "notes"])
	const up = chee.cd([".."])
	assertEquals([up.names, up.trail], [["home"], ["root", "home"]])
	assertEquals(chee.cd(["..", "theme"]).trail, ["root", "home", "plum"])
	assertEquals(chee.cd(["nobody", "x"]).trail, ["root", "home", "chee"])
})

Deno.test("cd: the trail holds its nodes when names above it move", () => {
	const { t, p } = placing()
	for (const id of ["home", "chee", "x"]) t.intro(createNode(id))
	p.insert("root", "home", "home")
	p.insert("home", "chee", "chee")
	p.insert("chee", "x", "x")
	const here = p.cd(["home", "chee"])
	p.move("root", "home", 0, "root", "house")
	assertEquals(ids(here.look(["x"])), ["x"])
	assertEquals(ids(p.look(["home", "chee"], ["x"])), [])
})

Deno.test("cd: a read from a trail says less to depend", () => {
	const deep = ["home", "chee", "notes"]
	const here = places.cd(deep)
	let a = 0, b = 0
	places.look(deep, ["editor"], () => a++)
	here.look(["editor"], () => b++)
	assertEquals([a, b], [9, 3])
})

Deno.test("cd: a walk stopped part way: .. reaches only steps the trail took", () => {
	const stopped = places.cd(["home", "nobody"])
	assertEquals(stopped.trail, ["root"])
	assertEquals(ids(stopped.look(["..", "theme"])), [])
	assertEquals(ids(places.look(["home", "nobody"], ["..", "theme"])), [
		"plum",
		"butter",
	])
})

Deno.test("lookup: a path, the nearest place it is whole", () => {
	const get = graph({
		root: { home: ["home"], theme: ["t0"] },
		home: { theme: ["t1"] },
		t0: { colors: ["c0"] },
		t1: {},
		c0: {},
	})
	const p = createPlaces(get, "root")
	const it = p.lookup(["home"], ["theme", "colors"])
	assertEquals(ids(it), ["c0"])
	assertEquals(it[0].up, 1)
	assertEquals(it[0].route, [
		{ node: "root", name: "theme", id: "t0", at: 0 },
		{ node: "t0", name: "colors", id: "c0", at: 0 },
	])
	assertEquals(ids(p.lookup(["home"], ["theme"])), ["t1"])
	assertEquals(p.lookup(["home"], []), [])
	assertEquals(placed(() => p.lookup([], ["theme", ".."])), "wrong-field")
})

Deno.test("content and info: every version, per item; pending without", () => {
	const v = <C>(content: C) => ({ content, change })
	const nodes = new Map<string, N>([
		["r", createNode<unknown, unknown>("r", { children: [["t", [v(["gone", "a", "b"])]]] })],
		[
			"a",
			createNode<unknown, unknown>("a", { value: [v(1), v(0)], info: [["title", [v("A")]]] }),
		],
		["b", createNode<unknown, unknown>("b", { value: [v(2)] })],
	])
	const p = createPlaces((id) => nodes.get(id), "r")
	const said: [string, Part][] = []
	const c = p.content([], ["t"], (id, part) => said.push([id, part]))
	assertEquals(c.map((it) => [it.id, it.versions?.map((x) => x.content)]), [
		["gone", undefined],
		["a", [1, 0]],
		["b", [2]],
	])
	assertEquals(said.slice(-2), [["a", "value"], ["b", "value"]])
	const i = p.info([], ["t"], "title")
	assertEquals(i.map((it) => it.versions?.map((x) => x.content)), [undefined, ["A"], []])
	assertEquals(placed(() => p.info([], ["t"], "..")), "wrong-field")
})

Deno.test("by: the whole change header, as given", () => {
	const t = createTable<unknown, Change>()
	t.intro(createNode("root"))
	const header = {
		time: 1,
		actor: { actor: "a1", person: "p1", trusted: true, code: ["c1"] },
		reader: "pid7",
		cause: "a new list",
		site: { file: "file:///x.ts", line: 3 },
	}
	const p = createPlaces(t.get, "root", { by: () => header })
	assertEquals(p.insert("root", "kids", "a"), { ...header, node: "root" })
	assertEquals(p.pop("root", "kids", 0), { ...header, node: "root" })
	assertEquals(p.write([], [], [{ path: [], value: 1 }]), { ...header, node: "root" })
})
