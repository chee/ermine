// ermine-h on the server. LLM generated: a prototype, ported from ermine-h's h.ts (ermine-mac's
// relay/src/next/h.ts; playground/devtools/src/finder/h.ts is the same). the same views (h, jsx,
// bind, each, under, track, handler: the same descriptions, by Symbol.for), made into a tree of
// plain elements and written out as html, inside a process (its setup), as ermine-h is.
//   bind      an early effect at a node of its own under the view's folder, as ermine-h's: view/0,
//             view/1, and a binding made while another builds goes under that one's node
//             (view/3/0). its compute reads and builds what it shows, so the bindings inside are
//             made there (today's @ermine/system: an act makes nothing); its act places it and
//             tells the host
//   tells     options.tell, each act: ["view/0", "text", "3"], ["view/1", "className", "odd"],
//             ["view/3", "children", element] (its kids are new: the host writes them out)
//   handler   kept here by an id of its own (a count, never used again: a page sending an id from
//             before a re-render is told nothing, never another item's action); fire(into, id,
//             event) calls it through options.call
//   says      ermine-h's data-ermine-process, -bind:<prop|text|children>, -on:<event>, -key,
//             -source, -waiting, and the server's: data-ermine-binding (the element's bindings'
//             nodes, space-separated: what a page finds an update's element by) and
//             data-ermine-handler:<event> (the handler's id)
//   not here  a kept element (a canvas: there is none on the server), ref, plain-function
//             listeners (the page's code: the server has none to run), ermine-h's reuse (each
//             build makes new elements: what changed is sent whole), "ermine:change" and
//             "ermine:call"
import {
	createEffect,
	ensureNode,
	getNode,
	getStatus,
	hasNode,
	list,
	PENDING,
	read,
	readChildren,
	readEntries,
} from "@ermine/system"

type Node = ReturnType<typeof getNode>
export type Slot = readonly [parent: Target, name: string]
export type Target = string | Node | Slot
// a child under a node (under), or an entry a path reaches (each)
export type Item = {
	readonly name?: string
	readonly index: number
	readonly at: Target
	readonly value?: unknown
}

// one change a page makes: the binding's node, the prop ("text", "children" or a property, as the
// page's element names it), and its value (children: the element whose kids are new)
export type Update = readonly [binding: string, prop: string, value: unknown]

// what render needs from the host: ermine-h's (a name for data-ermine-process, how an action is
// called, the bindings' folder), and where each act's update goes
export type Options = {
	name: string
	call: (action: Node, ...args: unknown[]) => unknown
	at?: string
	tell?: (update: Update) => void
}

// ---- the server's elements ----
export type Element = { readonly tag: string; readonly attrs: Map<string, string>; kids: Kid[] }
export type Kid = Element | { readonly text: string }
export const element = (tag: string): Element => ({ tag, attrs: new Map(), kids: [] })

// ---- descriptions: what jsx and h() make (ermine-h's, as they are) ----
const VIEW = Symbol.for("ermine-h.view")
const BOUND = Symbol.for("ermine-h.bound")
const HANDLER = Symbol.for("ermine-h.handler")

export type View = {
	readonly [VIEW]: true
	readonly tag: string
	readonly props: Record<string, unknown>
	readonly kids: readonly Child[]
	readonly key?: string
	readonly source?: string
}
export type Bound = {
	readonly [BOUND]: true
	readonly target: Target
	readonly read: "value" | "each" | "under" | "track"
	// deno-lint-ignore no-explicit-any
	readonly fn?: (value: any) => unknown
	readonly get?: () => unknown
}
export type Handler = {
	readonly [HANDLER]: true
	readonly target: string | Node
	// deno-lint-ignore no-explicit-any
	readonly args?: readonly unknown[] | ((event: any) => readonly unknown[] | undefined | void)
}
export type Child =
	| View
	| Bound
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| readonly Child[]
// deno-lint-ignore no-explicit-any
export type Component<P = any> = (props: P) => Child

const isView = (x: unknown): x is View => typeof x === "object" && x !== null && VIEW in x
const isBound = (x: unknown): x is Bound => typeof x === "object" && x !== null && BOUND in x
const isHandler = (x: unknown): x is Handler => typeof x === "object" && x !== null && HANDLER in x
// a slot is a pair: [parent, name]
const PAIR = 2
const isSlot = (x: unknown): x is Slot =>
	Array.isArray(x) && x.length === PAIR && typeof x[1] === "string"

// deno-lint-ignore no-explicit-any
export function bind(target: Target, fn?: (value: any) => unknown): Bound {
	return { [BOUND]: true, target, read: "value", fn }
}
export function each(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "each", fn: items(fn) }
}
export function under(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "under", fn: items(fn) }
}
export function track<T>(get: () => T, fn?: (value: T) => Child, what = "track"): Bound {
	return { [BOUND]: true, target: what, read: "track", get, fn: fn as (v: unknown) => unknown }
}
const items = (fn: (item: Item, index: number) => Child) => (all: readonly Item[]) =>
	(all ?? []).map((item, i) => {
		const v = fn(item, i)
		const key = item.name ?? String(i)
		return isView(v) && v.key === undefined ? { ...v, key } : v
	})

export function handler(
	target: string | Node,
	// deno-lint-ignore no-explicit-any
	args?: readonly unknown[] | ((event: any) => readonly unknown[] | undefined | void),
): Handler {
	return { [HANDLER]: true, target, args }
}

export function h(
	tag: string | Component,
	props?: Record<string, unknown> | null,
	...kids: Child[]
): View {
	return make(tag, { ...props, children: kids }, (props?.key as string) ?? undefined)
}
function make(
	tag: string | Component,
	// deno-lint-ignore no-explicit-any
	props: Record<string, any>,
	key?: unknown,
	source?: string,
): View {
	if (typeof tag === "function") return tag(props) as View
	const { children, key: _key, ...rest } = props
	return {
		[VIEW]: true,
		tag,
		props: rest,
		kids: children === undefined ? [] : [children],
		key: key == null ? undefined : String(key),
		source,
	} as View
}

// deno-lint-ignore no-explicit-any
export const Fragment = (props: { children?: Child }): any => props.children ?? []
export const jsx = (
	tag: string | Component,
	props: Record<string, unknown>,
	key?: unknown,
): View => make(tag, props, key)
export const jsxs = jsx
export const jsxDEV = (
	tag: string | Component,
	props: Record<string, unknown>,
	key?: unknown,
	_static?: boolean,
	at?: { fileName?: string; lineNumber?: number },
): View =>
	make(
		tag,
		props,
		key,
		at?.lineNumber ? `${at.fileName || "program.tsx"}:${at.lineNumber}` : undefined,
	)

// ---- where bindings and handlers go ----
// a handler kept: the folder it was made in (gone when that folder builds again), its action's
// node, its args, and the call to make it through
type Kept = {
	readonly folder: string
	readonly node: Node
	readonly args: Handler["args"]
	readonly call: Options["call"]
}
// one render's: the host's options, its handlers by id, and the last id given
type Top = { readonly options: Options; readonly kept: Map<string, Kept>; count: number }
// the build being made: its render, the folder a binding made now goes under, how many so far
type Here = { readonly top: Top; readonly folder: string; n: number }
let here: Here | undefined

function within<T>(h: Here, f: () => T): T {
	const was = here
	here = h
	try {
		return f()
	} finally {
		here = was
	}
}

// each render's handlers, by the element rendered into
const handlers = new WeakMap<Element, Map<string, Kept>>()

// the handlers made in folder, and in the folders under it, gone: it is building again
function forget(kept: Map<string, Kept>, folder: string) {
	for (const [id, k] of kept) {
		if (k.folder === folder || k.folder.startsWith(folder + "/")) kept.delete(id)
	}
}

// ---- making it ----
type Slotted = View | Bound | string

function flat(kids: readonly Child[], out: Slotted[] = []): Slotted[] {
	for (const k of kids) {
		if (k == null || typeof k === "boolean") continue
		if (Array.isArray(k)) flat(k, out)
		else if (isView(k) || isBound(k)) out.push(k)
		else if (typeof k === "object" && "nodeType" in k) {
			throw new Error("ermine-h on the server: a kept element (a page's own) has no html")
		} else out.push(typeof k === "object" ? asText(k)! : String(k))
	}
	return out
}

// the view rendered inside into. gives the root. inside a process: its bindings are effects of
// the scope open now
export function render(into: Element, view: Child, options: Options): Element | undefined {
	const folder = options.at ?? "view"
	ensureNode(folder)
	let kept = handlers.get(into)
	if (kept === undefined) handlers.set(into, kept = new Map())
	forget(kept, folder)
	const top: Top = { options, kept, count: 0 }
	into.kids = within({ top, folder, n: 0 }, () => build(flat([view])))
	const root = into.kids[0]
	if (root !== undefined && "tag" in root) root.attrs.set("data-ermine-process", options.name)
	return root as Element | undefined
}

const build = (slots: Slotted[]): Kid[] => slots.map(real)

function real(s: Slotted): Kid {
	if (typeof s === "string") return { text: s }
	if (isBound(s)) {
		// a binding among other kids: a span of its own says what it shows
		const span = element("span")
		bindKids(span, s)
		return span
	}
	const el = element(s.tag)
	apply(el, s)
	return el
}

function apply(el: Element, v: View) {
	if (v.key !== undefined) el.attrs.set("data-ermine-key", v.key)
	if (v.source) el.attrs.set("data-ermine-source", v.source)
	const slots = flat(v.kids)
	const alone = slots.length === 1 && isBound(slots[0]) ? slots[0] : undefined
	for (const [name, value] of Object.entries(v.props)) {
		if (name === "ref") continue
		// an event prop: "on" and more ("onClick", "onErmineChange"; not "on" alone)
		else if (/^on./.test(name) && value != null) {
			const type = name.startsWith("onErmine")
				? "ermine:" + name.slice("onErmine".length).toLowerCase()
				: name.slice(2).toLowerCase()
			listen(el, type, value)
		} else if (isBound(value)) bindProp(el, name, value)
		else set(el, name, value)
	}
	if (alone) bindKids(el, alone)
	else el.kids = build(slots)
}

// a prop, as an attribute (the page makes the property from it)
function set(el: Element, name: string, value: unknown) {
	const attr = name === "className" ? "class" : name === "htmlFor" ? "for" : name
	if (value == null || value === false) el.attrs.delete(attr)
	else el.attrs.set(attr, value === true ? "" : String(styled(attr, value)))
}
// a style object as css text
const styled = (name: string, value: unknown) =>
	name === "style" && typeof value === "object" && value !== null
		// each capital a dash and its small letter: "fontSize" is "font-size"; "color" stays
		? Object.entries(value).map(([k, v]) =>
			`${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`
		).join(";")
		: value
// a prop as the page's element names it
const property = (name: string) =>
	name === "class" ? "className" : name === "for" ? "htmlFor" : name

// an event: an action (handler(…), or a node) kept by id, for fire to call through the host's call
function listen(el: Element, type: string, value: unknown) {
	if (!isHandler(value) && (typeof value !== "object" || value === null)) return
	const h = isHandler(value) ? value : handler(value as Node)
	const now = here!
	const id = String(++now.top.count)
	now.top.kept.set(id, {
		folder: now.folder,
		node: typeof h.target === "string" ? getNode(h.target) : h.target,
		args: h.args,
		call: now.top.options.call,
	})
	el.attrs.set(`data-ermine-on:${type}`, typeof h.target === "string" ? h.target : "[node]")
	el.attrs.set(`data-ermine-handler:${type}`, id)
}

// the handler id names, in the render into: called with what its args make of event (a stand-in
// for the page's: its type, target's value, checked, a form's elements). false: no such handler
// (an id from before a re-render)
export function fire(into: Element, id: string, event: unknown): boolean {
	const k = handlers.get(into)?.get(id)
	if (k === undefined) return false
	const args = typeof k.args === "function" ? k.args(event) : k.args ?? []
	if (args) k.call(k.node, ...args)
	return true
}

const KEEP = Symbol("keep")

function bindProp(el: Element, name: string, b: Bound) {
	el.attrs.set(`data-ermine-bind:${name}`, said(b.target))
	let last: unknown = KEEP
	watch(
		b,
		el,
		(x, waiting) => waiting ? KEEP : b.fn && x !== undefined ? b.fn(x) : x,
		(next, tell) => {
			// waiting: the prop stays as it was. the same prop again is no change
			if (next === KEEP || (Object.is(next, last) && typeof next !== "object")) return
			set(el, name, last = next)
			tell(property(name), styled(name, next))
		},
	)
}

type Shown = typeof KEEP | { readonly text: string } | { readonly kids: Kid[] }

function bindKids(el: Element, b: Bound) {
	const path = said(b.target)
	const listed = b.read === "each" || b.read === "under"
	if (!el.attrs.has("data-ermine-bind:children")) el.attrs.set("data-ermine-bind:text", path)
	let last: string | undefined
	watch<Shown>(
		b,
		el,
		(x, waiting) => {
			if (waiting) return KEEP
			const shown = listed || b.fn && x !== undefined
				? b.fn!(x)
				: x === null
				? undefined
				: asText(x)
			const slots = flat([shown as Child])
			// text, or views; a derived view that gives nothing keeps what it said it was
			const text = !listed && slots.every((s) => typeof s === "string") &&
				(!b.fn || slots.length > 0 || !el.attrs.has("data-ermine-bind:children"))
			return text ? { text: (slots as string[]).join("") } : { kids: build(slots) }
		},
		(s, tell) => {
			// waiting: what was shown stays (an ellipsis the first time)
			if (s === KEEP) return void (el.kids.length || (el.kids = [{ text: "…" }]))
			const text = "text" in s
			el.attrs.set(`data-ermine-bind:${text ? "text" : "children"}`, path)
			el.attrs.delete(`data-ermine-bind:${text ? "children" : "text"}`)
			if (text) {
				// the same text again is no change
				if (s.text === last) return
				el.kids = s.text === "" ? [] : [{ text: last = s.text }]
				return tell("text", s.text)
			}
			last = undefined
			el.kids = s.kids
			tell("children", el)
		},
	)
}

// a node's own value is shown as text (true, a list, a map); only what a derived view gives is jsx
function asText(v: unknown): string | undefined {
	if (v === undefined) return undefined
	if (typeof v !== "object" || v === null) return String(v)
	if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ")
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

// ---- reading a node ----
const WAITING = Symbol.for("ermine-h.waiting")
const NOTHING = Symbol.for("ermine-h.nothing")

function said(target: Target): string {
	if (isSlot(target)) return `${said(target[0])}/${target[1]}`
	return typeof target === "string" ? target : "[node]"
}

function reach(target: Target): string | Node | undefined {
	if (!isSlot(target)) return target
	const [parent, name] = target
	const p = reach(parent)
	if (p === undefined) return undefined
	if (typeof p === "string") return p === "/" ? `/${name}` : `${p}/${name}`
	return readChildren(p)[name]
}

// what a binding is of, tracked: ermine-h's watch's compute, as it is
function reading(b: Bound): unknown {
	if (b.read === "track") {
		try {
			return b.get!()
		} catch (e) {
			if (e === PENDING) return WAITING
			throw e
		}
	}
	const t = reach(b.target)
	if (t === undefined) return b.read === "value" ? NOTHING : []
	if (b.read === "each") {
		return readEntries(t).map((e, index): Item => ({ index, at: e.node ?? t, value: e.value }))
	}
	if (b.read === "under") {
		if (!hasNode(t)) return []
		return list(t).map((name, index): Item => ({ name, index, at: [t, name] }))
	}
	if (!hasNode(t)) return NOTHING
	if (getStatus(t)?.state === "pending") return WAITING
	try {
		return read(t)
	} catch (e) {
		if (e === PENDING) return WAITING
		throw e
	}
}

// an early effect at its own node: its compute reads what the binding is of and makes what is
// shown (what that makes, bindings and handlers, under this binding's node: made in a compute, as
// an act makes nothing); its act shows it and tells the host. every run acts (equal: never): a
// binding made again by its parent's next build is given a new element, and its act must fill it,
// the same value or not
function watch<S>(
	b: Bound,
	el: Element,
	make: (v: unknown, waiting: boolean) => S,
	show: (s: S, tell: (prop: string, value: unknown) => void) => void,
) {
	const now = here
	if (now === undefined) throw new Error("ermine-h: a binding made outside render")
	const { top } = now
	const name = `${now.folder}/${now.n++}`
	const at = el.attrs.get("data-ermine-binding")
	el.attrs.set("data-ermine-binding", at ? `${at} ${name}` : name)
	const tell = (prop: string, value: unknown) => top.options.tell?.([name, prop, value])
	let waited = false
	createEffect(
		name,
		() =>
			within({ top, folder: name, n: 0 }, () => {
				forget(top.kept, name)
				const v = reading(b)
				const waiting = v === WAITING
				return { waiting, made: make(waiting || v === NOTHING ? undefined : v, waiting) }
			}),
		({ waiting, made }: { waiting: boolean; made: S }) => {
			if (waiting !== waited) {
				waited = waiting
				if (waiting) el.attrs.set("data-ermine-waiting", "")
				else el.attrs.delete("data-ermine-waiting")
				tell("data-ermine-waiting", waiting)
			}
			show(made, tell)
		},
		{ early: true, equal: () => false },
	)
}

// ---- html ----
const VOID = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"source",
	"track",
	"wbr",
])
// & < > in text, & " < in a quoted attribute, as entities: "a<b" is "a&lt;b"; "ab" stays
const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const quoted = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

// an element (or text) as html
export function html(kid: Kid): string {
	if ("text" in kid) return text(kid.text)
	let s = "<" + kid.tag
	for (const [k, v] of kid.attrs) s += v === "" ? ` ${k}` : ` ${k}="${quoted(v)}"`
	return VOID.has(kid.tag) ? s + ">" : `${s}>${inner(kid)}</${kid.tag}>`
}
// an element's kids as html
export const inner = (el: Element): string => el.kids.map(html).join("")

// ---- the types jsx is checked against: loose (the server has no dom's) ----
export declare namespace JSX {
	export type Element = View
	// deno-lint-ignore no-explicit-any
	export type ElementType = string | ((props: any) => Child)
	export interface IntrinsicElements {
		[tag: string]: Record<string, unknown> & { key?: string | number; children?: Child }
	}
	export interface ElementChildrenAttribute {
		// deno-lint-ignore ban-types
		children: {}
	}
	export interface IntrinsicAttributes {
		key?: string | number
	}
}
