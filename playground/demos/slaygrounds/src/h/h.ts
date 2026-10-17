/// <reference lib="dom" />
// ermine-h: the playground's own view library (not ermine's). jsx or h(tag, props, ...kids)
// describes a view; render(into, view, process) makes it real inside an element.
//   reuse     an element is the nth of its tag under its parent, or its key; a render again
//             changes and moves only what differs (shift's reconcile)
//   bind      bind("n"), bind("/data/n", (v) => …): an effect in the scope open when made, so a
//             reload or the binding acting again takes the old one away
//   lists     each(target, (item) => view): what is placed at a path or slot, in order;
//             under(target, (item) => view): a node's members. keyed by item, or the view's key
//   handler   onClick={handler("on/press")}: the process's own call; who calls is the host's to say
//   targets   "n" under the process's node, "/data/n" from the root, an unknown name from the root;
//             an entry or item: that node; [parent, name]: what is at name under parent
//   kept      a node the program made (a canvas, a textarea) as a child: placed, never touched
//             inside; t.keep keeps it across reloads
//   says      data-ermine-process, -bind:<prop|text|children>, -on:<event>, -key, -source
//             (program.ts:line), -waiting; a bound entry: "/board/lists/cards#<id>"
//   tells     bubbling events: "ermine:change" on a bound element, "ermine:call" and
//             "ermine:called" around a handler; onErmineChange={…}

// ---- what h needs of the process it renders for: handed by the host ----
// a node as a program holds it: the id, and its path (names from the root) and name where they are
// known, as when it came from a read by path
export type Item = {
	readonly id: unknown
	readonly path?: readonly string[]
	readonly name?: string
}
export type Entry = Item
export type Slot = readonly [parent: Entry | Item, name: string]
export type Target = string | Entry | Item | Slot
export type Process = {
	// the process's name: data-ermine-process
	name: string
	// a node's names from the root; none given: the process's own node
	where: (entry?: Entry | Item) => readonly string[] | undefined
	// the items at an address, from the process's node, or from the item given ("/" first: from
	// the root); read in a binding's effect, so tracked there
	find: (address: string[], from?: Entry | Item) => readonly Item[]
	get: (item: Entry | Item) => unknown
	// an item whose compute is out: the host reads its computation's status (a tracked read)
	pending?: (item: Item) => boolean
	// the members under a node, every name in order (for under)
	members?: (item: Entry | Item) => readonly Item[]
	// the process calling a handler node: names from the root, the arguments
	call: (address: string[], args: unknown[]) => unknown
	// an effect in the scope open now; name: what the scheduler pane calls it
	effect: (
		read: () => unknown,
		act: (value: unknown, before: unknown) => void,
		name?: string,
	) => unknown
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
	// value: the node's value; each: everything at the target; under: the members under it
	readonly read: "value" | "each" | "under"
	readonly fn?: (value: any) => unknown
}
export type Handler = {
	readonly [HANDLER]: true
	readonly target: string | Entry
	readonly args?: readonly unknown[] | ((event: any) => readonly unknown[] | undefined | void)
}
export type Child =
	| View
	| Bound
	| Node
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
const isEntry = (x: unknown): x is Entry =>
	typeof x === "object" && x !== null && !Array.isArray(x) && "id" in x
const isSlot = (x: unknown): x is Slot =>
	Array.isArray(x) && x.length === 2 && typeof x[0] === "object" && typeof x[1] === "string"
const isItem = isEntry

// a value bound to a node; fn: what is shown is fn(value), run when there is a node (its value
// may be null); no node there: nothing, and fn is not run
export function bind(target: Target, fn?: (value: any) => unknown): Bound {
	return { [BOUND]: true, target, read: "value", fn }
}
// a view for each thing placed at a path or a slot (every entry there, in order)
export function each(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "each", fn: list(fn) }
}
// a view for each member under a node (every name, in order)
export function under(target: Target, fn: (item: Item, index: number) => Child): Bound {
	return { [BOUND]: true, target, read: "under", fn: list(fn) }
}
// items to views, each keyed by its item unless it has a key of its own
const list = (fn: (item: Item, index: number) => Child) => (items: readonly Item[]) =>
	(items ?? []).map((item, i) => {
		const v = fn(item, i)
		const key = `${item.name ?? ""}:${String(item.id)}`
		return isView(v) && v.key === undefined ? { ...v, key } : v
	})

// an event calling the handler node at a path (or the entry t.handler gave). args: the call's
// arguments, or a function of the event giving them (undefined: no call)
export function handler(
	target: string | Entry,
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
		at?.lineNumber ? `${at.fileName || "program.ts"}:${at.lineNumber}` : undefined,
	)

// ---- making it real ----
// a node h placed: what it was made from, to be matched again ("p", "li#a", "#text", "#bind")
const kind = new WeakMap<Node, string>()
// an element's kids as h placed them last, in order
const placed = new WeakMap<Element, Node[]>()
// what h set on an element last: "attr:x", "prop:x", "on:click" (its listener), "bound:x", "kids"
const owned = new WeakMap<Element, Map<string, unknown>>()

type Slotted = View | Bound | Node | string

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

// the view rendered inside into, reusing what an earlier render put there. gives the root
export function render(into: Element, view: Child, p: Process): Node | undefined {
	homes.delete(p)
	place(into, flat([view]), p)
	const root = placed.get(into)?.[0]
	if (root instanceof Element) root.setAttribute("data-ermine-process", p.name)
	return root
}

// an element's kids: each the one of its kind before it, nth for nth, else made. then shift's
// reconcile: take out only what is no longer wanted, move only what is out of place. what h did
// not place is left where it is
function place(parent: Element, slots: Slotted[], p: Process) {
	const prev = (placed.get(parent) ?? []).filter((n) => n.parentNode === parent)
	const pool = new Map<string, Node[]>()
	for (const n of prev) {
		const k = kind.get(n)
		if (k !== undefined) pool.has(k) ? pool.get(k)!.push(n) : pool.set(k, [n])
	}
	const next = slots.map((s) => {
		const k = match(s)
		if (k === undefined) return s as Node
		const was = pool.get(k)?.shift()
		const n = real(s, was, p)
		kind.set(n, k)
		return n
	})
	const keep = new Set(next)
	for (const n of prev) if (!keep.has(n) && n.parentNode === parent) parent.removeChild(n)
	let before: Node | null = null
	for (let i = next.length - 1; i >= 0; i--) {
		const n = next[i]
		if (n.parentNode !== parent || n.nextSibling !== before) parent.insertBefore(n, before)
		before = n
	}
	placed.set(parent, next)
}

function real(s: Slotted, was: Node | undefined, p: Process): Node {
	if (typeof s === "string") {
		const text = (was as Text | undefined) ?? new Text(s)
		if (text.data !== s) text.data = s
		return text
	}
	if (isBound(s)) {
		// a binding among other kids: a span of its own says what it shows
		const span = (was as HTMLElement | undefined) ?? document.createElement("span")
		bindKids(span, s, p)
		return span
	}
	const v = s as View
	const el = (was as Element | undefined) ?? document.createElement(v.tag)
	apply(el, v, p)
	return el
}

// props, then kids. what was set last time and is not now is taken back
function apply(el: Element, v: View, p: Process) {
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
			listen(el, type, value, p, was, now)
		} else if (isBound(value)) {
			attr(`data-ermine-bind:${name}`, said(p, value.target))
			now.set("bound:" + name, true)
			// waiting: the prop stays as it was. the same prop again is no change (no flash)
			let last: unknown = watch
			watch(p, value, el, (x, waiting) => {
				if (waiting) return false
				const next = value.fn && x !== undefined ? value.fn(x) : x
				if (Object.is(next, last) && typeof next !== "object") return false
				set(el, name, last = next)
			})
		} else now.set(set(el, name, value), true)
	}
	for (const [name, old] of was) if (!now.has(name)) unset(el, name, old)
	if (alone) bindKids(el, alone, p)
	else place(el, slots, p)
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

// an event: a handler node (handler(…), or an entry) is called through the process; a plain
// function is a plain listener, and says nothing; anything else is no listener
function listen(
	el: Element,
	type: string,
	value: unknown,
	p: Process,
	was: Map<string, unknown>,
	now: Map<string, unknown>,
) {
	const old = was.get("on:" + type)
	if (old) el.removeEventListener(type, old as EventListener)
	let listener: EventListener
	if (typeof value === "function") listener = value as EventListener
	else if (isHandler(value) || isEntry(value)) {
		const h = isHandler(value) ? value : handler(value)
		const names = resolve(p, h.target)
		const path = "/" + names.join("/")
		el.setAttribute(`data-ermine-on:${type}`, path)
		now.set(`attr:data-ermine-on:${type}`, true)
		// a block, never cond && …: a listener returning false would cancel the event
		listener = (e) => {
			const args = typeof h.args === "function" ? h.args(e) : h.args ?? []
			if (!args) return
			const tell = (name: string, detail: object) =>
				el.dispatchEvent(
					new CustomEvent(name, { bubbles: true, detail: { path, type, ...detail } }),
				)
			// said for the page (explain), never asked by the call: the host decides who is calling
			tell("ermine:call", { args, trusted: e.isTrusted })
			let result: unknown
			try {
				result = p.call(names, [...args])
			} finally {
				tell("ermine:called", { result })
			}
		}
	} else return
	el.addEventListener(type, listener)
	now.set("on:" + type, listener)
}

// a binding of an element's own kids: what the node holds is shown there (text, or views)
function bindKids(el: Element, b: Bound, p: Process) {
	const path = said(p, b.target)
	if (!el.hasAttribute("data-ermine-bind:children")) el.setAttribute("data-ermine-bind:text", path)
	let last: unknown = watch
	watch(p, b, el, (x, waiting) => {
		// waiting: what was shown stays (an ellipsis the first time)
		if (waiting) return void (placed.get(el)?.length || place(el, ["…"], p))
		const shown = b.read !== "value" || b.fn && x !== undefined
			? b.fn!(x)
			: x === null
			? undefined
			: asText(x)
		// the same text again is no change (no flash)
		if (typeof shown !== "object" && Object.is(shown, last)) return false
		last = shown
		const slots = flat([shown as Child])
		// text, or views; a derived view that gives nothing keeps what it said it was
		const text = b.read === "value" && slots.every((s) => typeof s === "string") &&
			(!b.fn || slots.length > 0 || !el.hasAttribute("data-ermine-bind:children"))
		el.setAttribute(`data-ermine-bind:${text ? "text" : "children"}`, path)
		el.removeAttribute(`data-ermine-bind:${text ? "children" : "text"}`)
		place(el, slots, p)
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
const WAITING = Symbol("waiting")

// a path's names from the root. "n" is the process's own, "/a/b" from the root; a name the process
// does not have is from the root. an entry: where it is placed; a slot: its parent's, and the name.
// the process's own place is asked once a render
const homes = new WeakMap<Process, readonly string[] | undefined>()
function resolve(p: Process, target: Target): string[] {
	if (isSlot(target)) return [...resolve(p, target[0]), target[1]]
	if (typeof target !== "string") return [...(p.where(target) ?? [])]
	const names = target.split("/").filter(Boolean)
	if (target.startsWith("/")) return names
	if (!homes.has(p)) homes.set(p, p.where())
	const own = homes.get(p)
	return own && p.find(names).length ? [...own, ...names] : names
}
// what an attribute says of a target: its path; a node's id after it when it is an entry or an item
function said(p: Process, target: Target) {
	const path = "/" + resolve(p, target).join("/")
	if (typeof target === "string" || isSlot(target)) return path
	return `${path}#${String((target as Item).id)}`
}

// the items a binding reads: at a path (from the root), at a slot, or the node itself
function items(p: Process, target: Target, path: string): readonly Item[] {
	if (isSlot(target)) return p.find([target[1]], target[0])
	if (isItem(target)) return [target]
	return p.find(["/", ...path.split("/").filter(Boolean)])
}

// an effect reading what a binding is of: show is handed it (undefined: nothing there), or told
// it is waiting (a pending compute: data-ermine-waiting). a change after the first is told on
// the element ("ermine:change"), unless show says nothing it shows changed (false)
function watch(
	p: Process,
	b: Bound,
	el: Element,
	show: (v: unknown, waiting?: boolean) => boolean | void,
) {
	const path = said(p, b.target).split("#")[0]
	let first = true
	p.effect(
		() => {
			const all = items(p, b.target, path)
			if (b.read === "each") return all
			if (all[0] && p.pending?.(all[0])) return WAITING
			const item = all[0]
			if (b.read === "under") return item ? (p.members?.(item) ?? []) : []
			return item ? p.get(item) : undefined
		},
		(v) => {
			el.toggleAttribute("data-ermine-waiting", v === WAITING)
			// nothing for none, nor for a symbol (a pending compute's); null is a value (fn sees it)
			const v2 = v === WAITING || typeof v === "symbol" ? undefined : v
			if (show(v2, v === WAITING) !== false && !first) {
				el.dispatchEvent(
					new CustomEvent("ermine:change", { bubbles: true, detail: { path } }),
				)
			}
			first = false
		},
		`${b.read === "value" ? "bind" : b.read} ${path}`,
	)
}

// ---- the types jsx is checked against ----
type On<E> = Handler | Entry | ((event: E) => void)
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
