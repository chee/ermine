// hydrate: a page's html, made by @ermine/render/html on one ermine, taken over by
// @ermine/render/dom on another holding the same nodes, nothing made again. LLM generated
import { assertEquals, assertStrictEquals } from "@std/assert"
import { parseHTML } from "npm:linkedom@0.18.12"
import {
	createAction,
	createErmine,
	ensureNode,
	executeAction,
	patch,
	peep,
	pulse,
	read,
} from "@ermine/system"
import { createRenderer, type Options } from "./render.ts"
import { bind, type Child, h, handler, under } from "./h.ts"
import { createRoot, html } from "./html.ts"

const setup = () => {
	ensureNode("items")
	ensureNode("items/apple", "apple")
	ensureNode("items/pear", "pear")
	ensureNode("count", 0)
	ensureNode("mode", "a")
	createAction(
		"on/inc",
		() => patch("count", [{ path: [], value: (peep(() => read("count")) as number) + 1 }]),
	)
}
const view = (): Child =>
	h(
		"div",
		{ class: bind("mode", (m: string) => `mode-${m}`) },
		h("h1", null, "hello ", "there"),
		h("p", null, h("b", null, "x"), " ", h("i", null, "y")),
		h("p", null, "count ", bind("count"), " clicks"),
		h("button", { onClick: handler("on/inc") }, "more"),
		h("ul", null, under("items", (i) => h("li", { key: i.name }, bind(i.at)))),
	)

// a process p on an ermine of its own, rendering view with r into into
function start(r: (into: never, view: Child, options: Options) => unknown, into: object) {
	const ermine = createErmine()
	const call = (action: unknown, ...args: unknown[]) =>
		ermine.within(() => executeAction(action as string, ...args))
	ermine.start(function p() {
		setup()
		r(into as never, view(), { name: "p", call: call as never })
	}, "/p")
	ermine.within(() => pulse())
	return ermine
}

Deno.test("hydrate takes the server's html over, making nothing", async () => {
	const root = createRoot()
	start(r(await import("./html.ts")), root)
	const page = html(root)

	const { document, window } = parseHTML(`<html><body>${page}</body></html>`)
	const g = globalThis as Record<string, unknown>
	for (const k of ["document", "Node", "Text", "CustomEvent", "Event"]) {
		g[k] = k === "document" ? document : (window as unknown as Record<string, unknown>)[k]
	}
	const { dom } = await import("./dom.ts")
	let made = 0
	const counted = createRenderer({
		...dom,
		element: (t) => (made++, dom.element(t)),
		text: (s) => (made++, dom.text(s)),
	})
	const main = document.querySelector("main")!
	const li = main.querySelector("li")!
	const ermine = start(counted.hydrate, main)

	assertEquals(made, 0)
	assertStrictEquals(main.querySelector("li"), li)
	assertEquals(main.innerHTML.replace(/ data-ermine-handler:click="[^"]*"/, ""), inner(page))
	// the button calls the page's own action, and the same p shows it
	const p = main.querySelectorAll("p")[1]!
	main.querySelector("button")!.dispatchEvent(new window.Event("click"))
	ermine.within(() => pulse())
	assertStrictEquals(main.querySelectorAll("p")[1], p)
	assertEquals(p.textContent, "count 1 clicks")
	ermine.within(() => patch("/p/mode", [{ path: [], value: "b" }]))
	ermine.within(() => pulse())
	assertEquals(main.querySelector("div")?.className, "mode-b")
})

const r = (m: { render: unknown }) => m.render as (into: never, view: Child, o: Options) => unknown
// a root's html, inside its tag
const inner = (page: string) => page.replace(/^<main[^>]*>/, "").replace(/<\/main>$/, "")
