/// <reference lib="dom" />
// ermine-h on @ermine/system: jsx or h(tag, props, ...kids) describes a view; render(into, view,
// options) makes it real inside an element. called inside a process (its setup), as every word is.
//   reuse     an element is the nth of its tag under its parent, or its key; a render again
//             changes and moves only what differs (shift's reconcile)
//   bind      bind("n"), bind("/page/mode", (v) => …): an early effect at a node of its own under
//             the view's folder (options.at, "view" if none): view/0, view/1, and a binding made
//             while another acts goes under that one's node (view/3/0). so the page's bindings are
//             in the graph, each one's value what it last read
//   lists     each(target, (item) => view): every entry a path reaches, in order;
//             under(target, (item) => view): a node's children, by name
//   handler   onClick={handler("on/press", [args])}: the action there, called through
//             options.call (a click has nothing open: the host says who calls)
//   targets   "n" under the process's node, "./n" from its cwd, "/n" from its root, a node
//             handle, or [parent, name]: what is at name under parent
//   kept      an element the program made (a canvas) as a child: placed, never touched inside
//   says      data-ermine-process, -bind:<prop|text|children>, -on:<event>, -key, -source
//             (file:line), -waiting
//   tells     bubbling events: "ermine:change" on a bound element, "ermine:call" and
//             "ermine:called" around a handler; onErmineChange={…}
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
	// a target for what it is: [parent, name], or the entry's node
	readonly at: Target
	readonly value?: unknown
}

// what render needs from the host: a name for data-ermine-process, and how an action is called
// from an event (nothing is open then, so the process can't call it itself)
export type Options = {
	name: string
	call: (action: Node, ...args: unknown[]) => unknown
	// the folder the bindings' nodes go under, from the process's node
	at?: string
}

// ---- descriptions: what jsx and h() make ----
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
	readonly fn?: (value: any) => unknown
	// track's: what is read, tracked
	readonly get?: () => unknown
}
export type Handler = {
	readonly [HANDLER]: true
	readonly target: string | Node
	readonly args?: readonly unknown[] | ((event: any) => readonly unknown[] | undefined | void)
}
export type Child =
	| View
	| Bound
	| globalThis.Node
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| readonly Child[]
export type Component<P = any> = (props: P) => Child

const isView = (x: unknown): x is View => typeof x === "object" && x !== null && VIEW in x
const isBound = (x: unknown): x is Bound => typeof x === "object" && x !== null && BOUND in x
const isHandler = (x: unknown): x is Handler => typeof x === "object" && x !== null && HANDLER in x
const isSlot = (x: unknown): x is Slot =>
	Array.isArray(x) && x.length === 2 && typeof x[1] === "string"

// a node's value; fn: what is shown is fn(value), run when there is a node (its value may be
// null); no node there: nothing, and fn is not run
export function bind(target: Target, fn?: (value: any) => unknown): Bound {
	return { [BOUND]: true, target, read: "value", fn }
}
// a view for each entry a path reaches (one, unless sync or a mount gives more), in order
export function each(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "each", fn: items(fn) }
}
// a view for each child of a node, by name, in order
export function under(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "under", fn: items(fn) }
}
// a view of anything read: get runs tracked (read, readAttributes, getStatus, explain, list…), and
// what it gives is shown, or handed to fn. what: a word for data-ermine-bind (none: "track")
export function track<T>(get: () => T, fn?: (value: T) => Child, what = "track"): Bound {
	return { [BOUND]: true, target: what, read: "track", get, fn: fn as (v: any) => unknown }
}
const items = (fn: (item: Item, index: number) => Child) => (all: readonly Item[]) =>
	(all ?? []).map((item, i) => {
		const v = fn(item, i)
		const key = item.name ?? String(i)
		return isView(v) && v.key === undefined ? { ...v, key } : v
	})

// an event calling the action at a path (or a node). args: the call's arguments, or a function of
// the event giving them (undefined: no call)
export function handler(
	target: string | Node,
	args?: readonly unknown[] | ((event: any) => readonly unknown[] | undefined | void),
): Handler {
	return { [HANDLER]: true, target, args }
}

// a view: a tag, its props, its kids. a function tag is a component: called now with the props
export function h(
	tag: string | Component,
	props?: Record<string, unknown> | null,
	...kids: Child[]
): View {
	return make(tag, { ...props, children: kids }, (props?.key as string) ?? undefined)
}
function make(tag: string | Component, props: Record<string, any>, key?: unknown, source?: string) {
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

// the automatic runtime: jsx(type, props, key), and jsxDEV with where it was written
export const Fragment = (props: { children?: Child }): any => props.children ?? []
export const jsx = (tag: string | Component, props: Record<string, unknown>, key?: unknown) =>
	make(tag, props, key)
export const jsxs = jsx
export const jsxDEV = (
	tag: string | Component,
	props: Record<string, unknown>,
	key?: unknown,
	_static?: boolean,
	at?: { fileName?: string; lineNumber?: number },
) =>
	make(
		tag,
		props,
		key,
		at?.lineNumber ? `${at.fileName || "program.tsx"}:${at.lineNumber}` : undefined,
	)

// ---- where bindings go ----
// the render being made: the host's options, the folder a binding made now goes under, and how
// many have been made there in this run (a binding made again in its parent's next run, at the
// same place, is the same node: its effect claimed again with its new code)
type Here = { options: Options; folder: string; n: number }
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

// ---- making it real ----
// a node h placed: what it was made from, to be matched again ("p", "li#a", "#text", "#bind")
const kind = new WeakMap<globalThis.Node, string>()
// an element's kids as h placed them last, in order
const placed = new WeakMap<Element, globalThis.Node[]>()
// what h set on an element last: "attr:x", "prop:x", "on:click" (its listener), "bound:x", "kids"
const owned = new WeakMap<Element, Map<string, unknown>>()

type Slotted = View | Bound | globalThis.Node | string

// kids, flat: lists opened, nothing for null, undefined and booleans
function flat(kids: readonly Child[], out: Slotted[] = []): Slotted[] {
	for (const k of kids) {
		if (k == null || typeof k === "boolean") continue
		if (Array.isArray(k)) flat(k, out)
		else if (isView(k) || isBound(k) || (typeof k === "object" && "nodeType" in k)) {
			out.push(k as Slotted)
		} else out.push(typeof k === "object" ? asText(k)! : String(k))
	}
	return out
}

const match = (s: Slotted) =>
	typeof s === "string"
		? "#text"
		: isBound(s)
		? "#bind"
		: isView(s)
		? s.key === undefined ? s.tag : `${s.tag}#${s.key}`
		: undefined

// the view rendered inside into, reusing what an earlier render put there. gives the root.
// inside a process: its bindings are effects of the scope open now
export function render(into: Element, view: Child, options: Options): globalThis.Node | undefined {
	const folder = options.at ?? "view"
	ensureNode(folder)
	within({ options, folder, n: 0 }, () => place(into, flat([view])))
	const root = placed.get(into)?.[0]
	if (root instanceof Element) root.setAttribute("data-ermine-process", options.name)
	return root
}

// an element's kids: each the one of its kind before it, nth for nth, else made. then shift's
// reconcile: take out only what is no longer wanted, move only what is out of place. what h did
// not place is left where it is
function place(parent: Element, slots: Slotted[]) {
	const prev = (placed.get(parent) ?? []).filter((n) => n.parentNode === parent)
	const pool = new Map<string, globalThis.Node[]>()
	for (const n of prev) {
		const k = kind.get(n)
		if (k !== undefined) pool.has(k) ? pool.get(k)!.push(n) : pool.set(k, [n])
	}
	const next = slots.map((s) => {
		const k = match(s)
		if (k === undefined) return s as globalThis.Node
		const was = pool.get(k)?.shift()
		const n = real(s, was)
		kind.set(n, k)
		return n
	})
	const keep = new Set(next)
	for (const n of prev) if (!keep.has(n) && n.parentNode === parent) parent.removeChild(n)
	let before: globalThis.Node | null = null
	for (let i = next.length - 1; i >= 0; i--) {
		const n = next[i]
		if (n.parentNode !== parent || n.nextSibling !== before) parent.insertBefore(n, before)
		before = n
	}
	placed.set(parent, next)
}

function real(s: Slotted, was: globalThis.Node | undefined): globalThis.Node {
	if (typeof s === "string") {
		const text = (was as Text | undefined) ?? new Text(s)
		if (text.data !== s) text.data = s
		return text
	}
	if (isBound(s)) {
		// a binding among other kids: a span of its own says what it shows
		const span = (was as HTMLElement | undefined) ?? document.createElement("span")
		bindKids(span, s)
		return span
	}
	const v = s as View
	const el = (was as Element | undefined) ?? document.createElement(v.tag)
	apply(el, v)
	return el
}

// props, then kids. what was set last time and is not now is taken back
function apply(el: Element, v: View) {
	const was = owned.get(el) ?? new Map<string, unknown>()
	const now = new Map<string, unknown>()
	owned.set(el, now)
	const attr = (name: string, value: string) => {
		if (el.getAttribute(name) !== value) el.setAttribute(name, value)
		now.set("attr:" + name, true)
	}
	if (v.key !== undefined) attr("data-ermine-key", v.key)
	if (v.source) attr("data-ermine-source", v.source)
	// one binding alone binds the element's own kids (its text, or a list); else they are placed
	const slots = flat(v.kids)
	const alone = slots.length === 1 && isBound(slots[0]) ? slots[0] : undefined
	if (alone) now.set("kids", true)
	let ref: ((el: Element) => void) | undefined
	for (const [name, value] of Object.entries(v.props)) {
		if (name === "ref") ref = value as typeof ref
		else if (/^on./.test(name) && value != null) {
			// onClick: "click". onErmineChange: h's own "ermine:change" (jsx has no colon in a name)
			const type = name.startsWith("onErmine")
				? "ermine:" + name.slice(8).toLowerCase()
				: name.slice(2).toLowerCase()
			listen(el, type, value, was, now)
		} else if (isBound(value)) {
			attr(`data-ermine-bind:${name}`, said(value.target))
			now.set("bound:" + name, true)
			// waiting: the prop stays as it was. the same prop again is no change (no flash)
			let last: unknown = watch
			watch(value, el, (x, waiting) => {
				if (waiting) return false
				const next = value.fn && x !== undefined ? value.fn(x) : x
				if (Object.is(next, last) && typeof next !== "object") return false
				set(el, name, last = next)
			})
		} else now.set(set(el, name, value), true)
	}
	for (const [name, old] of was) if (!now.has(name)) unset(el, name, old)
	if (alone) bindKids(el, alone)
	else place(el, slots)
	ref?.(el)
}

// a prop: an attribute, or a property when the element has one (value, checked, className…)
function set(el: Element, name: string, value: unknown): string {
	if (name === "class" || name === "className") name = "className"
	if (name === "style" && typeof value === "object" && value !== null) {
		Object.assign((el as HTMLElement).style, value)
		return "prop:style"
	}
	if (name in el && !name.includes("-") && name !== "style") {
		// the same value is not written again: an input keeps its caret
		if ((el as any)[name] !== value) (el as any)[name] = value ?? ""
		return "prop:" + name
	}
	if (value == null || value === false) el.removeAttribute(name)
	else el.setAttribute(name, value === true ? "" : String(value))
	return "attr:" + name
}

function unset(el: Element, what: string, old: unknown) {
	const [how, name] = [what.slice(0, what.indexOf(":")), what.slice(what.indexOf(":") + 1)]
	if (how === "on") return el.removeEventListener(name, old as EventListener)
	if (how === "attr") return el.removeAttribute(name)
	if (how === "bound") {
		el.removeAttribute(`data-ermine-bind:${name}`)
		return unset(el, "prop:" + name, 0)
	}
	if (what === "kids") {
		for (const k of ["text", "children"]) el.removeAttribute(`data-ermine-bind:${k}`)
		return
	}
	try {
		if (name === "style") (el as HTMLElement).style.cssText = ""
		else (el as any)[name] = typeof (el as any)[name] === "boolean" ? false : ""
	} catch { /* a read-only property: left as it is */ }
}

// an event: an action (handler(…), or a node) is called through the host's call; a plain function
// is a plain listener, and says nothing; anything else is no listener. the action's node is found
// now, while the process is open; the call comes later, from the event, when nothing is
function listen(
	el: Element,
	type: string,
	value: unknown,
	was: Map<string, unknown>,
	now: Map<string, unknown>,
) {
	const old = was.get("on:" + type)
	if (old) el.removeEventListener(type, old as EventListener)
	let listener: EventListener
	if (typeof value === "function") listener = value as EventListener
	else if (isHandler(value) || (typeof value === "object" && value !== null)) {
		const h = isHandler(value) ? value : handler(value as Node)
		const at = typeof h.target === "string" ? h.target : "[node]"
		const node = typeof h.target === "string" ? getNode(h.target) : h.target
		const call = here!.options.call
		el.setAttribute(`data-ermine-on:${type}`, at)
		now.set(`attr:data-ermine-on:${type}`, true)
		// a block, never cond && …: a listener returning false would cancel the event
		listener = (e) => {
			const args = typeof h.args === "function" ? h.args(e) : h.args ?? []
			if (!args) return
			const tell = (name: string, detail: object) =>
				el.dispatchEvent(
					new CustomEvent(name, { bubbles: true, detail: { path: at, type, ...detail } }),
				)
			// said for the page (explain), never asked by the call: the host decides who is calling
			tell("ermine:call", { args, trusted: e.isTrusted })
			let result: unknown
			try {
				result = call(node, ...args)
			} finally {
				tell("ermine:called", { result })
			}
		}
	} else return
	el.addEventListener(type, listener)
	now.set("on:" + type, listener)
}

// a binding of an element's own kids: what the node holds is shown there (text, or views)
function bindKids(el: Element, b: Bound) {
	const path = said(b.target)
	if (!el.hasAttribute("data-ermine-bind:children")) el.setAttribute("data-ermine-bind:text", path)
	let last: unknown = watch
	watch(b, el, (x, waiting) => {
		// waiting: what was shown stays (an ellipsis the first time)
		if (waiting) return void (placed.get(el)?.length || place(el, ["…"]))
		const listed = b.read === "each" || b.read === "under"
		const shown = listed || b.fn && x !== undefined
			? b.fn!(x)
			: x === null
			? undefined
			: asText(x)
		// the same text again is no change (no flash)
		if (typeof shown !== "object" && Object.is(shown, last)) return false
		last = shown
		const slots = flat([shown as Child])
		// text, or views; a derived view that gives nothing keeps what it said it was
		const text = !listed && slots.every((s) => typeof s === "string") &&
			(!b.fn || slots.length > 0 || !el.hasAttribute("data-ermine-bind:children"))
		el.setAttribute(`data-ermine-bind:${text ? "text" : "children"}`, path)
		el.removeAttribute(`data-ermine-bind:${text ? "children" : "text"}`)
		place(el, slots)
	})
}

// a node's own value is shown as text (true, a list, a map); only what a derived view gives is jsx
function asText(v: unknown): string | undefined {
	if (v === undefined) return undefined
	if (typeof v !== "object" || v === null) return String(v)
	if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ")
	if ("nodeType" in v) return `<${(v as Element).localName ?? "node"}>`
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

// ---- reading a node ----
const WAITING = Symbol.for("ermine-h.waiting")
const NOTHING = Symbol.for("ermine-h.nothing")

// what an attribute says of a target: its path as written; a handle is "[node]"
function said(target: Target): string {
	if (isSlot(target)) return `${said(target[0])}/${target[1]}`
	return typeof target === "string" ? target : "[node]"
}

// the node a target is now: a path, a handle, or what is at name under parent (undefined: none)
function reach(target: Target): string | Node | undefined {
	if (!isSlot(target)) return target
	const [parent, name] = target
	const p = reach(parent)
	if (p === undefined) return undefined
	if (typeof p === "string") return p === "/" ? `/${name}` : `${p}/${name}`
	return readChildren(p)[name]
}

// an early effect at its own node, reading what a binding is of: show is handed it (undefined:
// nothing there), or told it is waiting (a pending compute: data-ermine-waiting). a change after
// the first is told on the element ("ermine:change"), unless show says nothing it shows changed.
// what show places is made under this binding's node
function watch(b: Bound, el: Element, show: (v: unknown, waiting?: boolean) => boolean | void) {
	const now = here
	if (now === undefined) throw new Error("ermine-h: a binding made outside render")
	const name = `${now.folder}/${now.n++}`
	const path = said(b.target)
	let first = true
	createEffect(
		name,
		() => {
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
				return readEntries(t).map((e, index): Item => ({
					index,
					at: e.node ?? t,
					value: e.value,
				}))
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
		},
		(v) => {
			within({ options: now.options, folder: name, n: 0 }, () => {
				el.toggleAttribute("data-ermine-waiting", v === WAITING)
				// nothing for none; null is a value (fn sees it)
				const v2 = v === WAITING || v === NOTHING ? undefined : v
				if (show(v2, v === WAITING) !== false && !first) {
					el.dispatchEvent(new CustomEvent("ermine:change", { bubbles: true, detail: { path } }))
				}
				first = false
			})
		},
		{ early: true },
	)
}

// ---- the types jsx is checked against ----
type On<E> = Handler | Node | ((event: E) => void)
type Writable<E> = {
	[
		K in keyof E as K extends `on${string}` | "children" | "style" | "className" ? never
			: E[K] extends (...a: any[]) => any ? never
			: K extends string ? K
			: never
	]?: E[K] | Bound
}
type Events = {
	[K in keyof HTMLElementEventMap as `on${Capitalize<K>}`]?: On<HTMLElementEventMap[K]>
}
export type Props<E> =
	& Writable<E>
	& Events
	& { [on: `on${string}`]: On<any> | undefined }
	& { [data: `data-${string}`]: unknown }
	& {
		key?: string | number
		ref?: (el: E) => void
		class?: string | Bound
		className?: string | Bound
		style?: string | Bound | Partial<CSSStyleDeclaration>
		children?: Child
	}
type Tags = { [K in keyof HTMLElementTagNameMap]: Props<HTMLElementTagNameMap[K]> }

export declare namespace JSX {
	export type Element = View
	// a component may give any child: a list, text, nothing
	export type ElementType = keyof IntrinsicElements | ((props: any) => Child)
	export interface IntrinsicElements extends Tags {}
	export interface ElementChildrenAttribute {
		children: {}
	}
	export interface IntrinsicAttributes {
		key?: string | number
	}
}
