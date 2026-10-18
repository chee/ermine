// the port on one page den: a world (boot.ts' createHost: places from root R), the den "tab", its
// root surface a fake document's body (fake_dom.ts), the three example tools installed under
// /apps/patchwork/modules/basics, and docs under /docs. a view's box at /apps/patchwork/frame
// holds ./modules, ./selected ([]), ./storage, beside its ./doc and ./surface
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import type { Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { PENDING } from "@ermine/scheduler"
import type { Id } from "@ermine/table"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { type Box, createBox } from "@ermine/boxes"
import { createHost, createPageDen } from "./boot.ts"
import { connected, disconnected, type Element, startView } from "./runner.ts"
import { urlOf } from "./handle.ts"
import { datatypeOf, type Found, pick, plugins } from "./lookup.ts"
import { createDoc, install, installTools, providers, writer } from "./examples.ts"
import { createDocument, type FakeElement, find } from "./fake_dom.ts"

const tick = () => new Promise((r) => setTimeout(r, 0))

async function world() {
	const h = createHost()
	const { scheduler: s, table, places, hosted } = h
	const dom = createDocument({
		connected: (el) => connected(el as unknown as Element),
		disconnected: (el) => disconnected(el as unknown as Element),
	})
	const page = hosted(() =>
		createPageDen({ ...h, id: "tab", root: dom.root as unknown as Element })
	)
	const write = writer(h)
	const top: Box = hosted(() => createBox({ places, table, scheduler: s }, []))
	const { code, modules } = await installTools(write, top)
	const { selected, storage } = providers(write)
	const at = (path: string[]) => places.peep(() => get(places, path))
	const doc = (name: string, value: unknown, type: string) => {
		const id = write.node(value, { "ermine.type": type })
		write.place(top, ["docs", name], id)
		return id
	}
	// the frame: a view of doc in the box at /apps/patchwork/frame
	const frame = (doc: Id, tool?: string) => {
		const r = hosted(() =>
			startView(page.den, {
				host: { places, table, scheduler: s },
				folder: ["apps", "patchwork", "frame"],
				doc,
				surface: page.surface!.id,
				...(tool === undefined ? {} : { tool }),
				provide: { modules, selected, storage },
			})
		)
		if ("refused" in r) throw new Error(r.refused)
		return r
	}
	// promises landed, then a pulse, a few times over
	const settle = async () => {
		for (let i = 0; i < 6; i++) {
			await tick()
			s.pulse()
		}
	}
	// a write to a node's value from outside (the host): patches on its entry, committed
	const edit = (id: Id, patches: { path: (string | number)[]; value?: unknown }[]) =>
		hosted(() => {
			const e = table.get("value", id) as Entry<unknown>
			update(e, patches, createChangeHeader(s))
			places.commit([e])
		})
	const value = (id: Id) => table.get("value", id)?.value
	return {
		s,
		table,
		places,
		page,
		dom,
		write,
		code,
		top,
		doc,
		frame,
		settle,
		edit,
		value,
		at,
		selected,
		hosted,
	}
}

Deno.test("a tool renders a node through the shim: the lookup's pick for its datatype, run on runners/patchwork-tool, drawn into ./surface", async () => {
	const w = await world()
	const note = w.doc("note", { title: "hi", tags: ["a"] }, "public.json")
	const { process, box } = w.frame(note)
	assertEquals(w.table.get("attributes", process.id)?.value?.["ermine.process.args"], [
		"/doc",
		"json",
	])
	await w.settle()
	assertEquals(w.table.get("attributes", process.id)?.value?.[STATUS], undefined)
	assertEquals(JSON.parse(w.dom.root.textContent), { title: "hi", tags: ["a"] })
	// the box: the view's own names and its providers'
	assertEquals(
		w.places.peep(() => [...box.places.readKeys("children", box.root)].sort()),
		["doc", "modules", "selected", "storage", "surface"],
	)
	assertEquals(w.places.peep(() => get(box.places, ["view"])), process.id)
	w.hosted(() => w.page.den.stop(process))
	assertEquals([w.dom.root.textContent, w.page.den.processes()], ["", []])
})

Deno.test("a change through the shim lands as patches on the node; a change made on the node is told to the tool", async () => {
	const w = await world()
	const counter = await createDoc(w.write, w.code["counter.js"], "counter")
	assertEquals(w.value(counter), { title: "a counter", count: 0 })
	const seen: unknown[] = []
	const stop = w.places.watchAll((f) => {
		if (f.part === "value" && f.id === counter) seen.push(f.patches)
	})
	const { process } = w.frame(counter)
	await w.settle()
	assertEquals(w.dom.root.textContent, "a counter0+10 clicks, every counter")
	find(w.dom.root, "button")[0].click()
	assertEquals(seen, [[{ path: ["count"], value: 1 }]])
	assertEquals(w.value(counter), { title: "a counter", count: 1 })
	await w.settle()
	assertEquals(w.dom.root.textContent, "a counter1+11 clicks, every counter")
	// the tool's storage: ./storage/counter, made at its first ask
	const kept = w.at(["apps", "patchwork", "frame", "storage", "counter"])
	assert(kept !== undefined)
	assertEquals(w.value(kept), { clicks: 1 })
	// from outside: the host's write, drawn
	w.edit(counter, [{ path: ["count"], value: 41 }, { path: ["title"], value: "the answer" }])
	assertEquals(w.dom.root.textContent, "the answer41+11 clicks, every counter")
	w.hosted(() => w.page.den.stop(process))
	stop()
})

Deno.test("the fallback lookup: exact datatype before *, then by id; unlisted passed over; a tool-id wins; read off attributes", async () => {
	const w = await world()
	const found = w.places.peep(() => plugins(w.places, ["apps", "patchwork", "modules"]))
	assertEquals(found.map((f) => [f.at.at(-1), f.plugin.type, f.plugin.id]), [
		["json.js", "patchwork:tool", "json"],
		["counter.js", "patchwork:datatype", "counter"],
		["counter.js", "patchwork:tool", "counter"],
		["stack.js", "patchwork:tool", "stack"],
	])
	const id = (f: Found | undefined) => f?.plugin.id
	assertEquals(id(pick(found, "counter")), "counter")
	assertEquals(id(pick(found, "folder")), "stack")
	assertEquals(id(pick(found, "essay")), "json")
	assertEquals(id(pick(found, "counter", "json")), "json")
	assertEquals(id(pick(found, "counter", "nope")), undefined)
	const more = (id: string, d: "*" | string[], unlisted = false): Found => ({
		program: id,
		at: [],
		plugin: { type: "patchwork:tool", id, supportedDatatypes: d, unlisted },
	})
	const others = [
		more("b-raw", "*"),
		more("a-raw", "*"),
		more("z-counter", ["counter"]),
		more("hid", ["essay"], true),
	]
	assertEquals(id(pick([...found, ...others], "counter")), "counter")
	assertEquals(id(pick([...found, ...others], "essay")), "a-raw")
	assertEquals(id(pick(others, "essay", "hid")), "hid")
	assertEquals(
		[datatypeOf("patchwork.counter"), datatypeOf("public.json"), datatypeOf(undefined)],
		[
			"counter",
			"public.json",
			"",
		],
	)
	// a doc no tool opens, the json tool gone: refused, nothing started
	const bare = await world()
	const r = bare.hosted(() =>
		startView(bare.page.den, {
			host: { places: bare.places, table: bare.table, scheduler: bare.s },
			folder: ["frame"],
			doc: bare.doc("x", 1, "public.data"),
			surface: bare.page.surface!.id,
			tool: "none",
		})
	)
	assertEquals(r, { refused: "no-tool", datatype: "public.data" })
	assertEquals(bare.page.den.processes(), [])
})

Deno.test("a nested view is a child process, its box inside its parent's node made from its parent's; stopped with its parent", async () => {
	const w = await world()
	const counter = await createDoc(w.write, w.code["counter.js"], "counter")
	const note = w.doc("note", { n: 1 }, "public.json")
	const folder = w.doc("folder", {
		docs: [{ name: "count", url: urlOf(counter) }, { name: "note", url: urlOf(note) }],
	}, "patchwork.folder")
	const { process, box } = w.frame(folder)
	await w.settle()
	const all = w.page.den.processes()
	assertEquals(all.length, 3)
	const [, a, b] = all
	assertEquals([a.at, b.at], [["view"], ["view"]])
	// each child's box: <the parent's node>/views/<n>, its doc, a surface its parent offered, and
	// the parent's providers: the same nodes
	const inParent = (path: string[]) => w.places.peep(() => get(box.places, path))
	const child = inParent(["view", "views", "0"])!
	assertEquals(w.table.get("children", child)?.value, {
		doc: counter,
		modules: inParent(["modules"]),
		selected: w.selected,
		storage: inParent(["storage"]),
		surface: `${String(process.id)}/surfaces/view-0`,
	})
	assertEquals(w.table.get("attributes", `${String(process.id)}/surfaces/view-0`)?.value, {
		"ermine.surface.kind": "dom",
		"ermine.type": "ermine.surface",
	})
	assertEquals(w.table.get("attributes", a.id)?.value?.["ermine.process.args"], ["/doc", "counter"])
	assertEquals(w.table.get("attributes", b.id)?.value?.["ermine.process.args"], ["/doc", "json"])
	const text = w.dom.root.textContent
	assert(text.startsWith("counta counter0+1"), text)
	assert(text.includes(`"n": 1`), text)
	// the folder losing a doc: its row out, its view stopped, the rest running
	w.edit(folder, [{ path: ["docs", 1] }])
	await w.settle()
	assertEquals(w.page.den.processes().map((p) => p.id), [process.id, a.id])
	// the parent stopped: its child with it, every surface it offered withdrawn, the page empty
	w.hosted(() => w.page.den.stop(process))
	assertEquals(w.page.den.processes(), [])
	assertEquals(w.page.den.offers().map((o) => o.name), ["javascript", "patchwork-tool", "root"])
	assertEquals(w.dom.root.textContent, "")
})

Deno.test("the box exposes ./selected: open-document writes it, selected-doc answers from it, a child's box the same node", async () => {
	const w = await world()
	const one = w.doc("one", { n: 1 }, "public.json")
	const two = w.doc("two", { n: 2 }, "public.json")
	const folder = w.doc("folder", {
		docs: [{ name: "one", url: urlOf(one) }, { name: "two", url: urlOf(two) }],
	}, "patchwork.folder")
	const { process } = w.frame(folder)
	await w.settle()
	const pressed = () => find(w.dom.root, "button").map((b) => b.getAttribute("aria-pressed"))
	assertEquals(pressed(), ["false", "false"])
	find(w.dom.root, "button")[1].click()
	assertEquals(w.value(w.selected), [urlOf(two)])
	await w.settle()
	assertEquals(pressed(), ["false", "true"])
	// from outside, as a hash change would
	w.edit(w.selected, [{ path: [], value: [urlOf(one)] }])
	await w.settle()
	assertEquals(pressed(), ["true", "false"])
	// an open-document from inside a child view (one's json) is answered by the child's box: its
	// ./selected is the same node
	const inner = find(w.dom.root, "pre")[0] as FakeElement
	inner.dispatchEvent(
		new CustomEvent("patchwork:open-document", { bubbles: true, detail: { url: "ermine:x" } }),
	)
	assertEquals(w.value(w.selected), ["ermine:x"])
	// written by the child's process (the first child: one's view)
	const by = w.table.get("value", w.selected)?.change.metadata as { node?: unknown } | undefined
	assertEquals(by?.node, w.page.den.processes()[1].id)
	w.hosted(() => w.page.den.stop(process))
	await w.settle()
	assertStrictEquals(w.page.den.processes().length, 0)
})

Deno.test("a view stopped while its tool loads: pending until then, its cleanup run as the load lands, nothing left drawn; a failing tool its status", async () => {
	const w = await world()
	const note = w.doc("note", { n: 1 }, "public.json")
	const { process } = w.frame(note)
	w.s.pulse()
	assertEquals(w.table.get("attributes", process.id)?.value?.[STATUS], PENDING)
	w.hosted(() => w.page.den.stop(process))
	await w.settle()
	assertEquals([w.dom.root.textContent, w.page.den.processes()], ["", []])
	// a tool whose load throws: the process stays, its status the error
	const bad = `export const plugins = [{ type: "patchwork:tool", id: "bad", supportedDatatypes: "*",
		load: () => { throw new Error("no engine") } }]`
	const id = await install(w.write, bad)
	w.write.place(w.top, ["apps", "patchwork", "modules", "bad.js"], id)
	const failed = w.frame(note, "bad")
	await w.settle()
	const st = w.table.get("attributes", failed.process.id)?.value?.[STATUS]
	assert(st instanceof Error && st.message === "no engine", String(st))
	w.hosted(() => w.page.den.close())
})
