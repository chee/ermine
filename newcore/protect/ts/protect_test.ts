import { assertEquals } from "@std/assert"
import {
	type Answer,
	anyone,
	check,
	edit,
	first,
	list,
	matches,
	type May,
	pass,
	placing,
	type Read,
	read,
	rules,
	yes,
} from "./protect.ts"

const at = (values: Record<string, unknown>): Read => (id) =>
	Object.hasOwn(values, id) ? { value: values[id] } : undefined

const no = (rule: number): Answer => ({ no: { code: "rule", rule } })

Deno.test("rules: the first match wins; none: allowed", () => {
	const may = rules("r")
	const r = at({
		r: [{ actor: "bob", node: "mine", allow: false }, { actor: "bob", allow: true }],
	})
	assertEquals(may("bob", "read", { node: "mine", object: "value" }, r), no(0))
	assertEquals(may("bob", "read", { node: "default" }, r), yes)
	assertEquals(may("carol", "read", { node: "mine" }, r), yes)
})

Deno.test("rules: a field the ask lacks never matches", () => {
	const r = at({ r: [{ name: "theme", allow: false }] })
	assertEquals(rules("r")("bob", "read", { node: "home" }, r), yes)
	assertEquals(rules("r")("bob", "pass", { node: "home", name: "theme" }, r), no(0))
})

Deno.test("rules: passing, not listing (PROTECT.tex)", () => {
	const r = at({
		r: [
			{ op: "pass", node: "home", name: "theme", allow: true },
			{ op: "pass", node: "home", allow: false },
			{ op: "list", node: "home", allow: false },
		],
	})
	const may = rules("r")
	assertEquals(may("bob", "pass", { node: "home", name: "theme" }, r), yes)
	assertEquals(may("bob", "pass", { node: "home", name: "notes" }, r), no(1))
	assertEquals(may("bob", "list", { node: "home" }, r), no(2))
	assertEquals(may("bob", "read", { node: "home", object: "value" }, r), yes)
})

Deno.test("rules: tagging, not retyping (PROTECT.tex)", () => {
	const r = at({
		r: [
			{ actor: "a", op: "write", object: ["info", "tags"], allow: true },
			{ actor: "a", op: "write", allow: false },
		],
	})
	const may = rules("r")
	assertEquals(may("a", "write", { node: "n", object: ["info", "tags"], at: 0 }, r), yes)
	assertEquals(may("a", "write", { node: "n", object: ["info", "type"], at: 0 }, r), no(1))
})

Deno.test("rules: the scheduler's actor: its actor, peer, last step's process and program", () => {
	const actor = {
		actor: "bob",
		peer: "k1",
		code: [{ process: "p1" }, { process: "p2", program: { node: "prog", time: 3 } }],
	}
	const may = (rule: Record<string, unknown>) =>
		rules("r")(actor, "read", { node: "n" }, at({ r: [{ ...rule, allow: false }] }))
	assertEquals(may({ actor: "bob" }), no(0))
	assertEquals(may({ actor: actor }), yes)
	assertEquals(may({ peer: "k1" }), no(0))
	assertEquals(may({ person: "bob" }), yes)
	assertEquals(may({ process: "p2" }), no(0))
	assertEquals(may({ process: "p1" }), yes)
	assertEquals(may({ program: "prog" }), no(0))
})

Deno.test("rules: no actor field: the whole actor", () => {
	const r = at({ r: [{ actor: { name: "x" }, allow: false }] })
	assertEquals(rules("r")({ name: "x" }, "read", { node: "n" }, r), no(0))
})

Deno.test("rules: not loaded: pending; malformed: wrong-field", () => {
	assertEquals(rules("r")("bob", "read", { node: "n" }, at({})), { pending: true })
	for (const bad of [undefined, {}, [1], [{ allow: "yes" }], [{ who: "bob", allow: true }]]) {
		const a = rules("r")("bob", "read", { node: "n" }, at({ r: bad }))
		assertEquals("no" in a && a.no.code === "wrong-field" && a.no.field === "rules", true)
	}
	const none: Read = () => ({})
	assertEquals("no" in rules("r")("bob", "read", { node: "n" }, none), true)
})

Deno.test("first: the first answer not yes, outside in", () => {
	const refuse: May = () => ({ no: { code: "lock" } })
	const wait: May = () => ({ pending: true })
	const r = at({})
	assertEquals(first(anyone, refuse, wait)("a", "read", { node: "n" }, r), {
		no: { code: "lock" },
	})
	assertEquals(first(wait, refuse)("a", "read", { node: "n" }, r), { pending: true })
	assertEquals(first()("a", "read", { node: "n" }, r), yes)
})

Deno.test("check: along a route, the first refusal and its step", () => {
	const r = at({ r: [{ op: "pass", node: "mine", allow: false }] })
	const route = [
		{ node: "root", name: "theme", id: "mine", at: 0 },
		{ node: "mine", name: "colors", id: "c", at: 0 },
	]
	assertEquals(pass(route), [
		{ op: "pass", args: { node: "root", name: "theme" } },
		{ op: "pass", args: { node: "mine", name: "colors" } },
	])
	assertEquals(check(rules("r"), "bob", pass(route), r), { answer: no(0), at: 1 })
	assertEquals(check(anyone, "bob", pass(route), r), { answer: yes })
	assertEquals(list("home"), { op: "list", args: { node: "home" } })
})

Deno.test("read: one ask per object of a node", () => {
	const node = {
		id: "n",
		value: [{}],
		info: new Map([["type", []]]),
		children: new Map([["notes", []]]),
	}
	assertEquals(read(node).map((a) => a.args.object), ["value", ["info", "type"], [
		"children",
		"notes",
	]])
	assertEquals(read({ ...node, value: [] }).length, 2)
})

Deno.test("edit: an op at an object and version", () => {
	assertEquals(edit("write", "n", "value"), {
		op: "write",
		args: { node: "n", object: "value", at: 0 },
	})
	assertEquals(edit("pop", "n", ["children", "a"], [0, 2]).args.at, [0, 2])
})

Deno.test("placing: unplace each removed, place each added, as often", () => {
	assertEquals(placing("n", "theme", ["a", "b", "a"], ["b", "c", "c", "a"]), [
		{ op: "unplace", args: { node: "n", name: "theme", id: "a" } },
		{ op: "place", args: { node: "n", name: "theme", id: "c" } },
		{ op: "place", args: { node: "n", name: "theme", id: "c" } },
	])
	assertEquals(placing("n", "x", ["a", "b"], ["b", "a"]), [])
})

// found by the audit of 10-11

Deno.test("matches: a rule that is not a map matches nothing", () => {
	assertEquals(matches(null as never, { op: "read" }), false)
})
