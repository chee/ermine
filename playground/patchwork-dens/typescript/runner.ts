// runner: patchwork's tool contract as a runner on a den, and <patchwork-view> as start. a tool is
// a program (javascript source whose plugins export holds a patchwork:tool), run on
// runners/patchwork-tool { takes: javascript source, api: patchwork.tool }; a view is a process at
// <its box>/view, its box a folder holding ./doc, ./surface and what its parent's box held
//
//   den.offer("runners", "patchwork-tool", { [TAKES]: JS, [API]: TOOL_API }, createToolRunner(contextOf))
//   startView(den, { host, folder: "/apps/patchwork/frame", doc, surface, provide: { modules, selected } })
//   // { process, box }, or start's refusal, or { refused: "no-tool", datatype }
//   definePatchworkView()        // in a page: <patchwork-view doc-url tool-id> inside a tool's element
//
// the run, given code and the process's api (args ["/doc", tool id]): the code imported (a string:
// as a module from a data: url; a module given: as it is), its plugins' patchwork:tool with that id
// (none given: the first) loaded, the result called as patchwork calls a tool: tool(handle, element)
// with handle the doc's (handle.ts), element a new div appended to ./surface's live element, its
// repo the process's. a promise of the handle; its stop: the tool's cleanup, the views still in it
// stopped (newest first), its listeners off, the div out. no tool, a load giving no function, no
// surface: thrown (the process's status)
// contextOf(api): the den's Context the api was made from (noted by createProcessAPI, boot.ts): a
// runner is given code and an api only, and this one needs the den, its process and its box
//
// a view's element answers what bubbles to it, as patchwork's providers do, from its box:
//   patchwork:subscribe { type: "patchwork:selected-doc" }    ./selected's value (urls), and again
//                                                             at each write to it
//   patchwork:subscribe { type: "patchwork:tool-storage", toolId }   the url of ./storage/<toolId>,
//                                                             made ({}) if missing
//   patchwork:open-document { url }                           ./selected written [url]
// a name not in the box: not answered, left to bubble on. answers are { type: "change", value } on
// the port; { type: "unsubscribe" } from it ends one. every answer ends at the view's stop
//
// startView(den, o), a scope open: a box at o.folder (from o.parent's root, none: the host's; there
// already: placed over), holding every saved name of o.from's box but doc, surface and view, then
// o.provide over them, then doc and surface. the tool o.tool, else the lookup's pick over ./modules
// for the doc's datatype (its ermine.type, lookup.ts); started on RUNNER at /view in the box, args
// ["/doc", the tool's id]. a pulse asked for (a start asks none)
// <patchwork-view doc-url tool-id>, connected inside a view's element: a child view. its parent
// offers the element as a surface (surfaces/view-<n>, under the parent's node), its box is
// <the parent's node>/views/<n>, made from the parent's; started with the parent's scope open.
// disconnected: stopped, the surface withdrawn. a doc-url that is no ermine url: nothing started
// open: attributes changed on a connected view (no restart); the child box's folder left in the
// table after its stop (its children entry taken out); boxed processes are not seen at their paths
// from outside their box (processes' walk reads one root's rows), so /view/views/0/view is a path
// only inside the child's box
import type { API } from "@ermine/api"
import {
	type Address,
	type Box,
	box as boxIn,
	createBox,
	type Host,
	inside,
	unbox,
} from "@ermine/boxes"
import {
	type Context,
	type Den,
	type Handle,
	HERE,
	KIND,
	type Process,
	type Refused,
	type Runner,
} from "@ermine/dens"
import type { Id, Path } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createRepo, idOf, type Repo, urlOf } from "./handle.ts"
import { DATATYPE, datatypeOf, type Descriptor, pick, plugins, TOOL } from "./lookup.ts"

export const JS = "com.netscape.javascript-source"
export const TOOL_API = "patchwork.tool"
export const RUNNER: Path = [...HERE, "runners", "patchwork-tool"]
// a view's own names in its box: every other is its parent's, given on
export const OWN: readonly string[] = ["doc", "surface", "view"]

// as much of a DOM element as this reaches for
export type Element = EventTarget & {
	parentNode: Element | null
	readonly ownerDocument: { createElement: (tag: string) => Element } | null
	append: (...nodes: (Element | string)[]) => void
	remove: () => void
	getAttribute: (name: string) => string | null
	repo?: Repo
}

// a plugin as a module exports it
type Plugin = Descriptor & { load?: () => unknown }

// a running view: its process's context and api, its element, the views started inside it
type View = {
	readonly ctx: Context
	readonly api: API
	readonly host: Host
	readonly element: Element
	readonly children: Map<Element, Child>
	readonly answers: Set<() => void>
	n: number
}
type Child = { readonly offer: Id; readonly process?: Process; readonly box?: Box }

// a view's element: its view. a <patchwork-view>: the view it was started in
const views = new WeakMap<Element, View>()
const embedded = new WeakMap<Element, View>()

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

// a module from its source (a data: url, imported), or a module given as it is
export async function evaluate(code: unknown): Promise<{ plugins: Plugin[] }> {
	const mod = typeof code === "string"
		? await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`)
		: code
	if (!isMap(mod) || !Array.isArray(mod.plugins)) throw new TypeError("no plugins export")
	return mod as { plugins: Plugin[] }
}

// a module's plugin of a type (an id given: that one), loaded
export async function load(code: unknown, type: string, id?: string): Promise<unknown> {
	const { plugins } = await evaluate(code)
	const p = plugins.find((p) => isMap(p) && p.type === type && (id === undefined || p.id === id))
	if (p === undefined || typeof p.load !== "function") {
		throw new TypeError(`no ${type}${id === undefined ? "" : ` ${id}`}`)
	}
	return await p.load()
}

// a datatype's implementation: init(doc), getTitle(doc), setTitle?(doc, title)
export type Datatype = {
	init: (doc: Record<string, unknown>) => void
	getTitle: (doc: unknown) => string
	setTitle?: (doc: Record<string, unknown>, title: string) => void
}
export const datatype = (code: unknown, id?: string): Promise<Datatype> =>
	load(code, DATATYPE, id) as Promise<Datatype>

export function createToolRunner(contextOf: (api: unknown) => Context | undefined): Runner {
	return (code, api) => {
		const ctx = contextOf(api)
		if (ctx === undefined) throw new TypeError("an api the den's createProcessAPI did not note")
		return mount(code, api as API, ctx)
	}
}

async function mount(code: unknown, api: API, ctx: Context): Promise<Handle> {
	const [doc = "/doc", id] = api.args
	const tool = await load(code, TOOL, id)
	if (typeof tool !== "function") throw new TypeError(`${id ?? "the tool"}: load gave no function`)
	const surface = api.peep("/surface") as Element | undefined
	if (typeof surface?.ownerDocument?.createElement !== "function") {
		throw new TypeError("no element at ./surface")
	}
	const node = ctx.places.peep(() => get(ctx.places, inside(doc, ctx.process.cwd)))
	if (node === undefined) throw new TypeError(`no doc at ${doc}`)
	const repo = createRepo(api, ctx.places)
	const element = surface.ownerDocument!.createElement("div")
	element.repo = repo
	const host: Host = { places: ctx.places, table: ctx.table, scheduler: ctx.scheduler }
	const view: View = { ctx, api, host, element, children: new Map(), answers: new Set(), n: 0 }
	views.set(element, view)
	const off = listen(view)
	surface.append(element)
	const gone = () => {
		for (const el of [...view.children.keys()].reverse()) unembed(view, el)
		for (const end of [...view.answers]) end()
		off()
		repo.close()
		views.delete(element)
		element.remove()
	}
	let cleanup: unknown
	try {
		cleanup = tool(repo.handle(node), element)
	} catch (e) {
		gone()
		throw e
	}
	return {
		stop: () => {
			try {
				if (typeof cleanup === "function") cleanup()
			} finally {
				gone()
			}
		},
	}
}

// the id at a name in a view's box, untracked
const at = (v: View, path: Path) => v.ctx.places.peep(() => get(v.ctx.places, path))

// f told each write to a node's value
function watch(v: View, id: Id, f: (value: unknown) => void): () => void {
	return v.ctx.places.watchAll((fact) => {
		if (fact.part === "value" && fact.id === id) f(fact.entry?.value)
	})
}

type Respond = (value: unknown) => void
type Selector = { type?: unknown; toolId?: unknown }
// the providers: a selector's type, the box's name that answers it, and the answer
const PROVIDERS: Record<string, {
	name: string
	answer: (v: View, s: Selector, respond: Respond) => (() => void) | void
}> = {
	"patchwork:selected-doc": {
		name: "selected",
		answer(v, _, respond) {
			const id = at(v, ["selected"])!
			respond(v.api.peep({ id, part: "value" }) ?? [])
			return watch(v, id, (urls) => respond(urls ?? []))
		},
	},
	"patchwork:tool-storage": {
		name: "storage",
		answer(v, s, respond) {
			if (typeof s.toolId !== "string" || s.toolId === "" || s.toolId.includes("/")) return
			const path = ["storage", s.toolId]
			v.api.open(`/${path.join("/")}`, {})
			const id = at(v, path)
			if (id !== undefined) respond(urlOf(id))
		},
	},
}

type Port = {
	postMessage: (m: unknown) => void
	close: () => void
	onmessage: ((e: { data: unknown }) => void) | null
}

// a view's element answering patchwork:subscribe and patchwork:open-document from its box
function listen(v: View): () => void {
	const subscribe = (e: Event) => {
		const { selector, port } = ((e as CustomEvent).detail ?? {}) as {
			selector?: Selector
			port?: Port
		}
		const p = typeof selector?.type === "string" ? PROVIDERS[selector.type] : undefined
		if (p === undefined || port === undefined || at(v, [p.name]) === undefined) return
		e.stopPropagation()
		const stop = p.answer(v, selector!, (value) => port.postMessage({ type: "change", value }))
		const end = () => {
			v.answers.delete(end)
			stop?.()
			port.onmessage = null
			port.close()
		}
		v.answers.add(end)
		port.onmessage = (m) => {
			if (isMap(m.data) && m.data.type === "unsubscribe") end()
		}
	}
	const open = (e: Event) => {
		const url = ((e as CustomEvent).detail as { url?: unknown } | undefined)?.url
		if (typeof url !== "string" || at(v, ["selected"]) === undefined) return
		e.stopPropagation()
		v.api.edit("/selected", [{ path: [], value: [url] }])
	}
	v.element.addEventListener("patchwork:subscribe", subscribe)
	v.element.addEventListener("patchwork:open-document", open)
	return () => {
		v.element.removeEventListener("patchwork:subscribe", subscribe)
		v.element.removeEventListener("patchwork:open-document", open)
	}
}

export type ViewOptions = {
	// what the box is made over
	host: Host
	// the box's folder: an address from parent's root (none: the host's)
	folder: Address
	parent?: { readonly root: Id }
	doc: Id
	surface: Id
	// tool-id; none: the lookup's
	tool?: string
	// the box whose names are given on (but OWN)
	from?: Box
	// names placed over those (a provider's)
	provide?: Readonly<Record<string, Id>>
}

export function startView(
	den: Den,
	o: ViewOptions,
): { process: Process; box: Box } | Refused | { refused: "no-tool"; datatype: string } {
	const b = createBox(o.host, o.folder, o.parent)
	const names: Record<string, Id> = {}
	const given = o.from && o.host.table.get("children", o.from.root)?.value
	if (isMap(given)) {
		for (const [name, id] of Object.entries(given)) {
			if (!OWN.includes(name) && typeof id === "string") names[name] = id
		}
	}
	Object.assign(names, o.provide, { doc: o.doc, surface: o.surface })
	// placed over what a view before left in the folder
	const had = o.host.table.get("children", b.root)?.value
	for (const [name, id] of Object.entries(names)) {
		if (isMap(had) && had[name] === id) continue
		if (isMap(had) && Object.hasOwn(had, name)) unbox(b, [name])
		boxIn(b, [name], id)
	}
	const attrs = o.host.table.get("attributes", o.doc)?.value
	const type = datatypeOf(isMap(attrs) ? attrs["ermine.type"] : undefined)
	const found = b.places.peep(() => pick(plugins(b.places, ["modules"]), type, o.tool))
	if (found === undefined) return { refused: "no-tool", datatype: type }
	const p = den.start(RUNNER, found.at, ["view"], { box: b, args: ["/doc", found.plugin.id] })
	queueMicrotask(() => den.scheduler.pulse())
	return "refused" in p ? p : { process: p, box: b }
}

// a <patchwork-view> connected: a child view of the nearest view around it
export function connected(el: Element): void {
	if (embedded.has(el)) return
	for (let up = el.parentNode; up !== null; up = up.parentNode) {
		const v = views.get(up)
		if (v !== undefined) return void embed(v, el)
	}
}

// a <patchwork-view> disconnected: its view stopped
export function disconnected(el: Element): void {
	const v = embedded.get(el)
	if (v !== undefined) unembed(v, el)
}

// f with the view's process's scope open (gone already: as it is)
const within = <T>(v: View, f: () => T): T =>
	v.ctx.scope.state === "alive" ? v.ctx.scheduler.runWithScope(v.ctx.scope, f) : f()

function embed(v: View, el: Element) {
	const doc = idOf(el.getAttribute("doc-url"))
	if (doc === undefined || v.ctx.scope.state !== "alive") return
	const n = v.n++
	const den = v.ctx.den
	within(v, () => {
		const offered = den.offer("surfaces", `view-${n}`, { [KIND]: "dom" }, el, v.ctx.process.id)
		if ("refused" in offered) return
		const r = startView(den, {
			host: v.host,
			folder: ["views", String(n)],
			parent: { root: v.ctx.process.id },
			doc,
			surface: offered.id,
			tool: el.getAttribute("tool-id") ?? undefined,
			from: v.ctx.box,
		})
		v.children.set(el, "refused" in r ? { offer: offered.id } : { offer: offered.id, ...r })
		embedded.set(el, v)
	})
}

function unembed(v: View, el: Element) {
	const child = v.children.get(el)
	if (child === undefined) return
	v.children.delete(el)
	embedded.delete(el)
	within(v, () => {
		try {
			if (child.process) v.ctx.den.stop(child.process)
		} finally {
			v.ctx.den.withdraw(child.offer)
			if (child.box && v.ctx.table.get("children", child.box.root)) {
				v.ctx.table.del("children", child.box.root)
			}
		}
	})
}

// <patchwork-view> as a custom element, where there are custom elements
export function definePatchworkView(name = "patchwork-view"): void {
	const g = globalThis as unknown as {
		customElements?: {
			get: (name: string) => unknown
			define: (name: string, c: unknown) => void
		}
		HTMLElement?: new () => object
	}
	if (!g.customElements || !g.HTMLElement || g.customElements.get(name)) return
	g.customElements.define(
		name,
		class extends g.HTMLElement {
			connectedCallback() {
				connected(this as unknown as Element)
			}
			disconnectedCallback() {
				disconnected(this as unknown as Element)
			}
		},
	)
}
