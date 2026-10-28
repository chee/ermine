// @ermine/render's checks: the engine through a renderer of plain objects (no DOM), and the DOM's
// (linkedom). bindings inside bindings (a list's rows, a derived view's) are made in a compute, as
// today's @ermine/system wants (an act makes nothing). LLM generated
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
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
	assertEquals(button.says["on:click"], "on/remove")
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
	assertEquals(p.says["bind:text"], "count")
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
	assertEquals(main.querySelector("ul")?.getAttribute("data-ermine-bind:children"), "items")
	assertEquals(main.firstElementChild?.getAttribute("data-ermine-process"), "p")
	assertStrictEquals(main.querySelector("input"), input)
	assertEquals(input.value, "hello")
	assertEquals(main.querySelector("form")?.textContent, " mode b")
	assert(changes >= 1)
	assertEquals(failing(), [])
})
