// @ermine/render/html's checks: a page rendered as html, what changed told as updates, its events
// by id. LLM generated
import { assert, assertEquals } from "@std/assert"
import { setFlagsFromString } from "node:v8"
import { parseHTML } from "npm:linkedom@0.18.12"
import { runInNewContext } from "node:vm"
import {
	createAction,
	createErmine,
	ensureNode,
	executeAction,
	hasNode,
	patch,
	peep,
	read,
	remove,
} from "@ermine/system"
import { bind, type Child, h, handler, under } from "./h.ts"
import {
	createRoot,
	type Element,
	fire,
	html,
	render,
	type RootOptions,
	sent,
	take,
} from "./html.ts"

const add = (path: string, n: number) =>
	patch(path, [{ path: [], value: (peep(() => read(path)) as number) + n }])

// a counter, a list to add to and take from, and a node every visitor's page binds
const view = (): Child =>
	h(
		"div",
		null,
		h("button", { onClick: handler("on/dec") }, "−"),
		h("output", { class: bind("count", (n: number) => n < 0 ? "below" : "") }, bind("count")),
		h("button", { onClick: handler("on/inc") }, "+"),
		h("p", null, "clicks: ", bind("/shared/clicks")),
		h(
			"ul",
			null,
			under("items", (item) =>
				h(
					"li",
					null,
					bind(item.at),
					h("button", { onClick: handler("on/remove", [item.name]) }, "×"),
				)),
		),
	)

function visitor(how: RootOptions = {}, setup = () => {}) {
	const ermine = createErmine({
		host: { setup: () => void ensureNode("/shared/clicks", 0) },
	})
	const into = createRoot(how)
	// deno-lint-ignore prefer-const
	let context: ReturnType<typeof ermine.getProcessContext>
	const started = ermine.start(function visitor() {
		ensureNode("count", 0)
		ensureNode("items")
		createAction("on/inc", () => (add("count", 1), add("/shared/clicks", 1)))
		createAction("on/dec", () => (add("count", -1), add("/shared/clicks", 1)))
		createAction("on/add", (name: string) => ensureNode(`items/${name}`, name))
		createAction("on/remove", (name: string) => remove(`items/${name}`))
		setup()
		render(into, view(), {
			name: "/visitors/a",
			call: (action, ...args) => context!.within(() => executeAction(action, ...args)),
		})
	}, "/visitors/a")
	if ("refused" in started) throw new Error(started.refused)
	context = ermine.getProcessContext(started.process)
	ermine.within(() => {})
	sent(into)
	const call = (action: string, ...args: unknown[]) =>
		context!.within(() => executeAction(`/visitors/a/${action}`, ...args))
	return { ermine, into, call }
}

// the id of the listener for the action at, the first in the page
function idOf(page: string, at: string): string {
	const from = page.indexOf(`data-ermine-on:click="${at}" data-ermine-handler:click="`)
	assert(from >= 0, `no listener for ${at}`)
	return page.slice(from).split('"')[3]
}
// the id of the listener of the row showing name (its remove button)
const rowOf = (page: string, name: string) =>
	page.slice(page.indexOf(`>${name}</span>`)).split(`data-ermine-handler:click="`)[1].split('"')[0]
const settled = () => new Promise((r) => setTimeout(r, 0))

Deno.test("the html says each binding's node, its target and the process's", () => {
	const { ermine, into } = visitor()
	const page = html(into)
	assert(
		page.startsWith(
			`<main><div data-ermine-process="/visitors/a" data-ermine-base="/visitors/a">`,
		),
	)
	assert(page.includes(
		`<output data-ermine-bind:class="count" data-ermine-binding="view/0 view/1" class ` +
			`data-ermine-bind:text="count">0</output>`,
	))
	assert(
		page.includes(
			`<span data-ermine-binding="view/2" data-ermine-bind:text="/shared/clicks">0</span>`,
		),
	)
	assert(page.includes(`data-ermine-on:click="on/inc" data-ermine-handler:click="`))
	ermine.close()
})

Deno.test("a click: each binding's new value once, by its node", async () => {
	const { ermine, into } = visitor()
	assertEquals(fire(into, idOf(html(into), "on/inc"), {}), true)
	await settled()
	assertEquals(take(into), [["view/1", "text", "1"], ["view/2", "text", "1"]])
	fire(into, idOf(html(into), "on/dec"), {})
	fire(into, idOf(html(into), "on/dec"), {})
	await settled()
	assertEquals(take(into), [
		["view/0", "className", "below"],
		["view/1", "text", "-1"],
		["view/2", "text", "3"],
	])
	assertEquals(take(into), [])
	ermine.close()
})

Deno.test("a list's kids, changed: sent whole, and nothing inside apart", async () => {
	const { ermine, into, call } = visitor()
	call("on/add", "apple")
	call("on/add", "pear")
	await settled()
	const told = take(into)
	assertEquals(told.map(([b, prop]) => [b, prop]), [["view/3", "children"]])
	const kids = told[0][2] as string
	// in the order the list gives (a folder's: any)
	assert(kids.includes(">apple<"))
	// a row says its list; a name in it, from it
	assert(kids.includes(`<li data-ermine-key="pear" data-ermine-in="view/3">`))
	assert(kids.includes(`data-ermine-binding=":0" data-ermine-bind:text="items/pear">pear<`))
	// a row's own change: told by its own binding
	ermine.within(() => patch("/visitors/a/items/pear", [{ path: [], value: "ripe" }]))
	await settled()
	assertEquals(take(into), [["view/3/pear:0", "text", "ripe"]])
	ermine.close()
})

Deno.test("by count: an id is its element's, and one gone calls nothing", async () => {
	const { ermine, into, call } = visitor()
	call("on/add", "apple")
	call("on/add", "pear")
	await settled()
	take(into)
	const apple = rowOf(html(into), "apple")
	call("on/add", "fig")
	await settled()
	take(into)
	// the rows made again by the list's run keep their elements, and so their ids
	assertEquals(rowOf(html(into), "apple"), apple)
	assertEquals(fire(into, apple, {}), true)
	await settled()
	take(into)
	assertEquals(fire(into, apple, {}), false)
	assertEquals(fire(into, "no such id", {}), false)
	ermine.close()
})

Deno.test("by place: the same state rendered again is the same html, its ids found", async () => {
	const rows = () => ["apple", "pear"].forEach((n) => ensureNode(`items/${n}`, n))
	const a = visitor({ ids: "place" }, rows)
	const b = visitor({ ids: "place" }, rows)
	const page = html(a.into)
	assertEquals(html(b.into), page)
	// the second row's: its button, the second kid of the second li in the ul (the div's fifth kid)
	const second = page.slice(page.lastIndexOf(`data-ermine-handler:click="`)).split('"')[1]
	assertEquals(second, "0.4.1.1:click")
	const name = page.slice(page.lastIndexOf(`data-ermine-key="`)).split('"')[1]
	assertEquals(fire(b.into, second, {}), true)
	await settled()
	assertEquals(take(b.into).map(([b, prop]) => [b, prop]), [["view/3", "children"]])
	assert(!html(b.into).includes(`>${name}<`))
	a.ermine.close()
	b.ermine.close()
})

Deno.test("an element the page has, given a listener or a binding, is sent again", async () => {
	const ermine = createErmine({ host: { setup: () => void ensureNode("/on", false) } })
	const into = createRoot()
	ermine.start(function p() {
		createAction("on/go", () => {})
		render(
			into,
			h(
				"div",
				null,
				bind(
					"/on",
					(on: boolean) =>
						on
							? h("b", { class: bind("/on", String), onClick: handler("on/go") }, "x")
							: h("b", null, "x"),
				),
			),
			{ name: "/p", call: () => {} },
		)
	}, "/p")
	ermine.within(() => {})
	sent(into)
	assert(html(into).includes("<b>x</b>"))
	ermine.within(() => patch("/on", [{ path: [], value: true }]))
	await settled()
	const [[b, prop, kids]] = take(into)
	assertEquals([b, prop], ["view/0", "children"])
	assert((kids as string).includes(`data-ermine-binding="view/0/0" class="true"`))
	assert((kids as string).includes(`data-ermine-handler:click="1"`))
	ermine.close()
})

// a page of view, its nodes made by setup, sent
function page(view: () => Child, setup: () => void) {
	const ermine = createErmine({ host: { setup } })
	const into = createRoot()
	ermine.start(function p() {
		render(into, view(), { name: "/p", call: () => {} })
	}, "/p")
	ermine.within(() => {})
	sent(into)
	const set = (path: string, value: unknown) =>
		ermine.within(() => patch(path, [{ path: [], value }]))
	return { ermine, into, set }
}

Deno.test("a binding taken off an element the page has: the element is sent again", async () => {
	const { ermine, into, set } = page(
		() =>
			h("div", null, bind("/flag", (f: boolean) => h("li", null, bind("/x"), f ? " ★" : null))),
		() => (ensureNode("/flag", false), ensureNode("/x", "a")),
	)
	assert(
		html(into).includes(`<li data-ermine-binding="view/0/0" data-ermine-bind:text="/x">a</li>`),
	)
	set("/flag", true)
	await settled()
	// its kids no longer x alone: x is a span's, and the page finds the span by it, not the li
	assertEquals(take(into), [[
		"view/0",
		"children",
		`<li><span data-ermine-binding="view/0/0" data-ermine-bind:text="/x">a</span> ★</li>`,
	]])
	set("/x", "b")
	await settled()
	assertEquals(take(into), [["view/0/0", "text", "b"]])
	ermine.close()
})

Deno.test("names on a page: no 's, and a space, a quote or a backslash escaped", async () => {
	const { ermine, into, set } = page(
		() =>
			h(
				"div",
				null,
				bind("/mode", (m: string) =>
					m === "a" ? h("b", { title: bind("/x") }) : h("b", { title: bind("/y") })),
				h(
					"ul",
					null,
					under("/rows", (row) =>
						h("li", null, bind(row.at))),
				),
			),
		() => {
			ensureNode("/mode", "a")
			ensureNode("/x", "ex")
			ensureNode("/y", "why")
			ensureNode("/rows")
			ensureNode('/rows/new york "ny"', "nyc")
		},
	)
	assert(html(into).includes(`data-ermine-binding="view/1/new%20york%20%22ny%22:0"`))
	// made again different: its node view/0/0', on the same element, its name on the page the
	// same state's: the page finds it as it did
	set("/mode", "b")
	await settled()
	assert(ermine.within(() => peep(() => hasNode("/p/view/0/0'"))))
	assertEquals(take(into), [["view/0/0", "title", "why"]])
	assert(
		html(into).includes(
			`<b data-ermine-bind:title="/y" data-ermine-binding="view/0/0" title="why">`,
		),
	)
	ermine.close()
})

Deno.test("by count: rows taken out are let go, their ids with them", async () => {
	setFlagsFromString("--expose-gc")
	const gc = runInNewContext("gc") as () => void
	const { ermine, into, call } = visitor()
	const freed: string[] = []
	const rows = new FinalizationRegistry<string>((name) => freed.push(name))
	for (let i = 0; i < 20; i++) {
		call("on/add", `n${i}`)
		await settled()
		take(into)
		const ul = (into.kids[0] as Element).kids[4] as Element
		rows.register(ul.kids.find((li) => html(li).includes(`>n${i}<`))!, `n${i}`)
		call("on/remove", `n${i}`)
		await settled()
		take(into)
	}
	for (let i = 0; i < 5; i++) {
		gc()
		await settled()
	}
	// all but the last taken out, at least (what is held till the next change, the engine's)
	assert(freed.length >= 19, `${freed.length} of 20 let go`)
	ermine.close()
})

Deno.test("not a root: render says so", () => {
	const ermine = createErmine({ host: {} })
	const started = ermine.start(function p() {
		render({ tag: "main", attrs: new Map(), kids: [] } as Element, "x", {
			name: "/p",
			call: () => {},
		})
	}, "/p")
	assert(!("refused" in started) && started.status()?.state === "failed")
	ermine.close()
})

// a page's whole name for a name an element says, by the rule the page scripts keep (ssr-live's
// client/live.js, whole): one in a row (":0") from the row's data-ermine-in, then its key
type Found = {
	getAttribute(name: string): string | null
	closest(selector: string): Found | null
	readonly parentElement: Found | null
	readonly children: ArrayLike<Found>
}
const whole = (name: string, el: Found): string => {
	const row = name[0] === ":" ? el.closest("[data-ermine-in]") : null
	if (!row) return name
	const list = whole(row.getAttribute("data-ermine-in")!, row.parentElement!)
	return `${list}/${row.getAttribute("data-ermine-key")}${name}`
}

Deno.test("a row's names are written from it, a row in a row's too, and a page works each out whole", () => {
	const ermine = createErmine({})
	const into = createRoot()
	const started = ermine.start(function shelves() {
		;["top", "low"].forEach((s) => {
			ensureNode(`shelves/${s}`, s)
			;["jam", "honey"].forEach((j) => ensureNode(`shelves/${s}/${j}`, j))
		})
		render(
			into,
			h(
				"ul",
				null,
				under("shelves", (shelf) =>
					h(
						"li",
						{ class: bind(shelf.at, (v: string) => `shelf-${v}`) },
						bind(shelf.at),
						h("ol", null, under(shelf.at, (jar) => h("li", null, bind(jar.at)))),
					)),
			),
			{ name: "/shelves", call: () => undefined },
		)
	}, "/shelves")
	if ("refused" in started) throw new Error(started.refused)
	const page = html(into)
	assert(page.includes(`<li data-ermine-key="top" data-ermine-bind:class="shelves/top"`))
	assert(page.includes(`data-ermine-binding=":0" class="shelf-top" data-ermine-in="view/0">`))
	// a row in a row: its list (view/0/top:2) said from the outer row
	assert(page.includes(
		`<li data-ermine-key="jam" data-ermine-binding=":0" data-ermine-bind:text="shelves/top/jam" ` +
			`data-ermine-in=":2">`,
	))
	const { document } = parseHTML(`<html><body>${page}</body></html>`) as unknown as {
		document: { body: { firstElementChild: Found } }
	}
	// each element as the page has it, beside the one it was written from
	const pairs = (a: Element, b: Found): [Element, Found][] => [
		[a, b],
		...a.kids.filter((k): k is Element => "tag" in k).flatMap((k, i) => pairs(k, b.children[i])),
	]
	// the root is written too (<main>)
	const named = pairs(into, document.body.firstElementChild)
		.filter(([a]) => a.attrs.has("data-ermine-binding"))
	// the list, each shelf's row, text and jars, and each jar
	assertEquals(named.length, 1 + 2 * 3 + 2 * 2)
	for (const [a, b] of named) {
		const said = b.getAttribute("data-ermine-binding")!.split(" ")
		assertEquals(
			said.map((n) => whole(n, b)).join(" "),
			a.attrs.get("data-ermine-binding"),
		)
	}
	ermine.close()
})

Deno.test("another attrPrefix: the page and take's html say it, the elements keep data-ermine-", async () => {
	const { ermine, into, call } = visitor({ attrPrefix: "e-" })
	const page = html(into)
	assert(page.startsWith(`<main><div e-process="/visitors/a" e-base="/visitors/a">`))
	assert(!page.includes("data-ermine-"))
	call("on/add", "apple")
	await settled()
	const [[, , kids]] = take(into)
	assert(
		String(kids).includes(
			`<li e-key="apple" e-in="view/3"><span e-binding=":0" e-bind:text="items/apple">`,
		),
	)
	assertEquals((into.kids[0] as Element).attrs.has("data-ermine-process"), true)
	ermine.close()
})
