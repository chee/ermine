// @ermine/render's checks: the engine through a renderer of plain objects (no DOM), and the DOM's
// (linkedom). bindings inside bindings (a list's rows, a derived view's) are made in a compute, as
// today's @ermine/system wants (an act makes nothing). LLM generated
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { parseHTML } from "npm:linkedom@0.18.12"
import {
	createAction,
	createErmine,
	createMemo,
	ensureNode,
	executeAction,
	getStatus,
	list,
	patch,
	peep,
	pulse,
	read,
	remove,
} from "@ermine/system"
import { createRenderer, type Listener, type Options, type Renderer } from "./render.ts"
import { bind, type Child, h, handler, track, under } from "./h.ts"

// ---- a renderer of plain objects ----
type O = {
	nodeType: number
	tag?: string
	text?: string
	parent?: O
	kids: O[]
	props: Record<string, unknown>
	says: Record<string, string>
	on: Map<string, Set<Listener>>
	told: string[]
}
const node = (nodeType: number, o: Partial<O>): O => ({
	nodeType,
	kids: [],
	props: {},
	says: {},
	on: new Map(),
	told: [],
	...o,
})
const objects: Renderer<O, O> = {
	element: (tag) => node(1, { tag }),
	text: (text) => node(3, { text }),
	setText: (t, s) => void (t.text = s),
	parentOf: (n) => n.parent,
	nextOf: (n) => n.parent?.kids[n.parent.kids.indexOf(n) + 1],
	insert: (parent, n, before) => {
		if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1)
		n.parent = parent
		const at = before ? parent.kids.indexOf(before) : -1
		if (at < 0) parent.kids.push(n)
		else parent.kids.splice(at, 0, n)
	},
	remove: (parent, n) => {
		parent.kids.splice(parent.kids.indexOf(n), 1)
		n.parent = undefined
	},
	set: (el, name, value) => {
		el.props[name] = value
		return "prop:" + name
	},
	unset: (el, what) => void delete el.props[what.slice("prop:".length)],
	listen: (el, type, fn) => {
		if (!el.on.has(type)) el.on.set(type, new Set())
		el.on.get(type)!.add(fn)
	},
	unlisten: (el, type, fn) => void el.on.get(type)?.delete(fn),
	isNode: (x): x is O => typeof x === "object" && x !== null && "nodeType" in x && "kids" in x,
	say: (el, name, value) => {
		if (value === undefined) delete el.says[name]
		else el.says[name] = value
	},
	tell: (el, name) => void el.told.push(name),
}
const { render } = createRenderer(objects)
// an object as text: its text, or <tag>kids</tag>
const shown = (o: O): string =>
	o.nodeType === 3 ? o.text ?? "" : `<${o.tag}>${o.kids.map(shown).join("")}</${o.tag}>`
const fire = (el: O, type: string, event: unknown = {}) => {
	for (const fn of el.on.get(type) ?? []) fn(event)
}

// a process at /p rendering view into an object root, and the host's ways in
function start(
	setup: () => void,
	view: () => Child,
	r: (into: never, view: Child, options: Options) => unknown = render,
	into: object = node(1, { tag: "root" }),
) {
	const ermine = createErmine()
	const call = (action: unknown, ...args: unknown[]) =>
		ermine.within(() => executeAction(action as string, ...args))
	const started = ermine.start(function p() {
		setup()
		r(into as never, view(), { name: "p", call: call as never })
	}, "/p")
	assert(!("refused" in started))
	const act = (path: string, ...args: unknown[]) => {
		call(path, ...args)
		ermine.within(() => pulse())
	}
	// every binding node under /p/view whose status isn't done
	const failing = () => {
		const out: string[] = []
		const walk = (p: string) => {
			for (const n of ermine.within(() => peep(() => list(p)))) {
				const q = `${p}/${n}`
				const st = ermine.within(() => peep(() => getStatus(q)))
				if (st && st.state !== "done") out.push(`${q} ${st.state} ${String(st.error)}`)
				walk(q)
			}
		}
		walk("/p/view")
		return out
	}
	const flush = () => ermine.within(() => pulse())
	return { ermine, into, act, flush, failing }
}
const items = () => {
	ensureNode("items")
	createAction("on/add", (t: string) => ensureNode(`items/${t}`, t))
	createAction("on/remove", (t: string) => remove(`items/${t}`))
}
const flip = () => {
	ensureNode("mode", "a")
	ensureNode("count", 0)
	createAction(
		"on/flip",
		() => patch("mode", [{ path: [], value: peep(() => read("mode")) === "a" ? "b" : "a" }]),
	)
	createAction(
		"on/inc",
		() => patch("count", [{ path: [], value: (peep(() => read("count")) as number) + 1 }]),
	)
}

Deno.test("a list's rows, each with a binding inside, made in the compute", () => {
	const { into, act, failing } = start(
		items,
		() => h("ul", null, under("items", (i) => h("li", null, bind(i.at)))),
	)
	assertEquals(shown(into as O), "<root><ul></ul></root>")
	act("/p/on/add", "apple")
	act("/p/on/add", "pear")
	// in the order the graph lists them
	const ul = (into as O).kids[0]
	assertEquals(ul.kids.map(shown).sort(), ["<li>apple</li>", "<li>pear</li>"])
	assertEquals(failing(), [])
})

Deno.test("a list with a row before the first render", () => {
	const { into, failing } = start(() => {
		items()
		ensureNode("items/first", "first")
	}, () => h("ul", null, under("items", (i) => h("li", null, bind(i.at)))))
	assertEquals(shown(into as O), "<root><ul><li>first</li></ul></root>")
	assertEquals(failing(), [])
})

Deno.test("a derived view made new: its binding, made again, fills the new node", () => {
	const { into, act, failing } = start(flip, () =>
		h(
			"div",
			null,
			bind("mode", (m: string) =>
				m === "a" ? h("b", null, "a ", bind("count")) : h("i", null, "b ", bind("count"))),
		))
	act("/p/on/inc")
	assertEquals(shown(into as O), "<root><div><b>a <span>1</span></b></div></root>")
	act("/p/on/flip")
	assertEquals(shown(into as O), "<root><div><i>b <span>1</span></i></div></root>")
	assertEquals(failing(), [])
})

Deno.test("a row's binding is its row's: one taken out, the others show theirs", () => {
	const { ermine, into, act, failing } = start(
		items,
		() => h("ul", null, under("items", (i) => h("li", null, bind(i.at)))),
	)
	for (const t of ["apple", "pear", "fig"]) act("/p/on/add", t)
	act("/p/on/remove", "apple")
	const ul = (into as O).kids[0]
	assertEquals(ul.kids.map(shown).sort(), ["<li>fig</li>", "<li>pear</li>"])
	// each row's binding under its key, so a row made again is its own
	assertEquals(ermine.within(() => peep(() => list("/p/view/0"))).sort(), ["fig:0", "pear:0"])
	assertEquals(failing(), [])
})

Deno.test("a derived view's other branch binds another way at the same place: made new", () => {
	const { into, act, failing } = start(() => {
		flip()
		ensureNode("label", "hi")
	}, () =>
		h(
			"div",
			null,
			bind("mode", (m: string) =>
				m === "a" ? h("input", { value: bind("count") }) : h("span", null, bind("label"))),
		))
	const first = () => (into as O).kids[0].kids[0]
	assertEquals(first().props.value, 0)
	act("/p/on/flip")
	assertEquals(shown(into as O), "<root><div><span>hi</span></div></root>")
	act("/p/on/inc")
	act("/p/on/flip")
	assertEquals([first().tag, first().props.value], ["input", 1])
	assertEquals(failing(), [])
})

Deno.test("a getter target: called in the binding's run, followed when what it read changes", () => {
	const { into, act, failing } = start(() => {
		ensureNode("x", "ex")
		ensureNode("y", "why")
		ensureNode("sel", "x")
		createAction("on/pick", (to: string) => patch("sel", [{ path: [], value: to }]))
	}, () => h("p", null, bind(() => read("sel") as string)))
	assertEquals(shown(into as O), "<root><p>ex</p></root>")
	act("/p/on/pick", "y")
	assertEquals(shown(into as O), "<root><p>why</p></root>")
	assertEquals(failing(), [])
})

// a parent and its binding due in one pulse, either first: the binding runs, then its parent's run
// claims it (its new code), and its act shows what its compute planned
for (const countFirst of [true, false]) {
	const both = () => {
		flip()
		const inc = () => executeAction("/p/on/inc"), turn = () => executeAction("/p/on/flip")
		createAction("on/both", () => countFirst ? (inc(), turn()) : (turn(), inc()))
	}
	Deno.test(`a binding claimed after it ran in the pulse shows its plan (count first: ${countFirst})`, () => {
		const { into, act, failing } = start(both, () =>
			h(
				"div",
				null,
				bind("mode", (m: string) =>
					h(
						"p",
						{ title: bind("count", (c: number) => `t${c}`) },
						m,
						" ",
						bind("count"),
					)),
			))
		act("/p/on/both")
		const p = (into as O).kids[0].kids[0]
		assertEquals([p.props.title, shown(p)], ["t1", "<p>b <span>1</span></p>"])
		assertEquals(failing(), [])
	})
}

Deno.test("a row changed and another added in one call: the changed row shows its change", () => {
	const { into, act, failing } = start(() => {
		items()
		ensureNode("items/apple", "apple")
		createAction("on/both", () => {
			patch("items/apple", [{ path: [], value: "APPLE" }])
			ensureNode("items/kiwi", "kiwi")
		})
	}, () => h("ul", null, under("items", (i) => h("li", { title: bind(i.at) }, bind(i.at)))))
	act("/p/on/both")
	const rows = (into as O).kids[0].kids.map((li) => [li.props.title, shown(li)]).sort()
	assertEquals(rows, [["APPLE", "<li>APPLE</li>"], ["kiwi", "<li>kiwi</li>"]])
	assertEquals(failing(), [])
})

Deno.test("rows taken out are let go: their elements, once nothing holds them", async () => {
	setFlagsFromString("--expose-gc")
	const gc = runInNewContext("gc") as () => void
	const rows: WeakRef<O>[] = []
	const { render: counted } = createRenderer({
		...objects,
		element: (tag) => {
			const o = objects.element(tag)
			if (tag === "li") rows.push(new WeakRef(o))
			return o
		},
	})
	const { into, act } = start(
		items,
		() => h("ul", null, under("items", (i) => h("li", null, bind(i.at)))),
		counted,
	)
	for (let i = 0; i < 20; i++) act("/p/on/add", `n${i}`)
	for (let i = 0; i < 20; i++) act("/p/on/remove", `n${i}`)
	act("/p/on/add", "last")
	assertEquals(shown(into as O), "<root><ul><li>last</li></ul></root>")
	for (let i = 0; i < 3; i++) {
		await new Promise((r) => setTimeout(r, 0))
		gc()
	}
	const alive = rows.filter((r) => r.deref() !== undefined).map((r) => shown(r.deref()!))
	assertEquals(alive, ["<li>last</li>"])
})

Deno.test("a place whose two names are still held (a run threw): a third branch gets its own", () => {
	const { into, act, failing } = start(() => {
		ensureNode("mode", "a")
		ensureNode("x", "ex")
		ensureNode("y", "why")
		ensureNode("z", "zed")
		createAction("on/mode", (m: string) => patch("mode", [{ path: [], value: m }]))
	}, () =>
		h(
			"div",
			null,
			bind("mode", (m: string) => {
				const p = h("p", null, bind(m === "a" ? "x" : m === "b" ? "y" : "z"))
				if (m === "b") throw new Error("b's run throws after its p's binding is made")
				return p
			}),
		))
	act("/p/on/mode", "b")
	act("/p/on/mode", "c")
	assertEquals(shown(into as O), "<root><div><p>zed</p></div></root>")
	assertEquals(failing(), [])
})

Deno.test("keys as names: a~2 beside a twice, a slash, a quote, a colon", () => {
	const { ermine, failing, into } = start(() => {
		ensureNode("x", "ex")
	}, () =>
		h(
			"ul",
			null,
			["a", "a", "a~2", "a/b", "a%2Fb", "it's", "a:0"].map((k) =>
				h("li", { key: k }, bind("x"))
			),
		))
	assertEquals((into as O).kids[0].kids.length, 7)
	assertEquals(new Set(ermine.within(() => peep(() => list("/p/view")))).size, 7)
	assertEquals(failing(), [])
})

Deno.test("bound functions are told apart: the other one is a new binding", () => {
	const label = (unit: string, v: number) => `${v}${unit}`
	const cm = label.bind(null, "cm"), inch = label.bind(null, "in")
	const { into, act, failing } = start(
		() => {
			ensureNode("unit", "cm")
			ensureNode("n", 3)
			createAction("on/unit", (u: string) => patch("unit", [{ path: [], value: u }]))
		},
		() =>
			h(
				"div",
				null,
				bind("unit", (u: string) => h("p", null, bind("n", u === "cm" ? cm : inch))),
			),
	)
	act("/p/on/unit", "in")
	assertEquals(shown(into as O), "<root><div><p>3in</p></div></root>")
	assertEquals(failing(), [])
})

Deno.test("a component's key is its view's: one put before it, its bindings stay its own", () => {
	const Icon = ({ x }: { x: string }) =>
		h("b", { class: bind("selected", (s: string) => (s === x ? "on" : "off")) }, x)
	const { into, act, failing } = start(() => {
		ensureNode("icons", ["b", "c"])
		ensureNode("selected", "b")
		createAction("on/icons", (l: string[]) => patch("icons", [{ path: [], value: l }]))
	}, () => h("div", null, bind("icons", (l: string[]) => l.map((x) => h(Icon, { key: x, x })))))
	const on = () =>
		(into as O).kids[0].kids.filter((b) => b.props.class === "on").map((b) => b.kids[0].text)
	act("/p/on/icons", ["a", "b", "c"])
	assertEquals(on(), ["b"])
	assertEquals(failing(), [])
})

Deno.test("says: a binding's and a handler's paths from the root, by the processes rule", () => {
	const { into } = start(() => {
		ensureNode("n", 1)
		createAction("on/go", () => {})
	}, () =>
		h(
			"p",
			{ title: bind("./n"), onClick: handler("on/go") },
			h("i", { title: bind("/p/n") }, bind("n")),
			h("b", null, track(() => read("n"), String, "n, tracked")),
		))
	const p = (into as O).kids[0], [i, b] = p.kids
	assertEquals(
		[p.says["bind:title"], p.says["on:click"], i.says["bind:title"], i.says["bind:text"]],
		["/n", "/p/on/go", "/p/n", "/p/n"],
	)
	assertEquals(b.says["bind:text"], "n, tracked")
})

Deno.test("a row keeps its node when another comes; its handler calls its action", () => {
	const { into, act, flush } = start(items, () =>
		h(
			"ul",
			null,
			under("items", (i) =>
				h(
					"li",
					{ class: bind(i.at, (v: string) => "row-" + v) },
					bind(i.at),
					h("button", { onClick: handler("on/remove", [i.name]) }, "x"),
				)),
		))
	act("/p/on/add", "pear")
	const ul = (into as O).kids[0]
	const pear = ul.kids[0]
	act("/p/on/add", "apple")
	assertStrictEquals(ul.kids.find((li) => li.says.key === "pear"), pear)
	assertEquals(pear.props.class, "row-pear")
	assertEquals(pear.says["on:click"], undefined)
	const button = pear.kids.find((k) => k.tag === "button")!
	assertEquals(button.says["on:click"], "/p/on/remove")
	fire(button, "click")
	assertEquals(button.told, ["ermine:call", "ermine:called"])
	flush()
	assertEquals(ul.kids.map((li) => li.says.key), ["apple"])
})

Deno.test("a pending memo: waiting said, an ellipsis, then its value", async () => {
	let settle = (_: string) => {}
	const { ermine, into } = start(
		() => void createMemo("slow", () => new Promise<string>((r) => (settle = r))),
		() =>
			h(
				"p",
				null,
				bind("slow"),
				h("i", null, track(() => read("slow") as string, (v) => "got " + v)),
			),
	)
	const p = (into as O).kids[0]
	ermine.within(() => pulse())
	assertEquals(shown(p), "<p><span>…</span><i>…</i></p>")
	assertEquals(p.kids[0].says.waiting, "")
	settle("done")
	await new Promise((r) => setTimeout(r, 0))
	ermine.within(() => pulse())
	assertEquals(shown(p), "<p><span>done</span><i>got done</i></p>")
	assertEquals(p.kids[0].says.waiting, undefined)
})

Deno.test("a change after the first is told; the same text again is not", () => {
	const { into, act } = start(
		flip,
		() => h("p", null, bind("count", (n: number) => (n > 1 ? "many" : "few"))),
	)
	const p = (into as O).kids[0]
	act("/p/on/inc")
	act("/p/on/inc")
	act("/p/on/inc")
	assertEquals(shown(p), "<p>many</p>")
	assertEquals(p.told, ["ermine:change"])
	assertEquals(p.says["bind:text"], "/p/count")
})

// ---- the DOM's ----
Deno.test("on the DOM: rows, a derived view, says and tells, an input kept", async () => {
	const { document, window } = parseHTML("<html><body><main></main></body></html>")
	const g = globalThis as Record<string, unknown>
	for (const k of ["document", "Text", "CustomEvent", "Event"]) {
		g[k] = k === "document" ? document : (window as unknown as Record<string, unknown>)[k]
	}
	const { render: dom } = await import("./dom.ts")
	const main = document.querySelector("main")!
	const { act, failing } = start(
		() => {
			items()
			flip()
			ensureNode("text", "hello")
		},
		() =>
			h(
				"div",
				null,
				h("ul", null, under("items", (i) => h("li", null, bind(i.at)))),
				bind(
					"mode",
					(m: string) =>
						h("form", null, h("input", { name: "q", value: bind("text") }), " mode ", m),
				),
			),
		dom,
		main,
	)
	act("/p/on/add", "apple")
	const input = main.querySelector("input")!
	let changes = 0
	main.addEventListener("ermine:change", () => changes++)
	act("/p/on/flip")
	assertEquals(main.querySelector("li")?.textContent, "apple")
	assertEquals(main.querySelector("ul")?.getAttribute("data-ermine-bind:children"), "/p/items")
	assertEquals(main.firstElementChild?.getAttribute("data-ermine-process"), "p")
	assertStrictEquals(main.querySelector("input"), input)
	assertEquals(input.value, "hello")
	assertEquals(main.querySelector("form")?.textContent, " mode b")
	assert(changes >= 1)
	assertEquals(failing(), [])
})
