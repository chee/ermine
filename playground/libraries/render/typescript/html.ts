// @ermine/render/html: views as html, with no DOM (a server's). createRoot() makes a root;
// render(into, view, options) makes the view real inside it as plain elements (@ermine/render:
// the engine, reusing what an earlier render put there); html(el) writes one out. a page kept live
// is told what changed since it was sent (take), and its events come back by id (fire)
//   says      data-ermine-<name> attributes, as /dom's (process, key, source, bind:<prop|text|
//             children>, on:<event>, waiting), and data-ermine-binding: the element's bindings'
//             nodes, as made (view/0: under the process's node), space-separated: what a page finds
//             an update's element by. a name there has no 's (a binding made again different has
//             one more: the same state always gives a page the same names, whatever came before),
//             and a space, a quote or a backslash in it is %20, %22, %5C
//   handlers  data-ermine-handler:<event>: an id fire(into, id, event) calls the listener by. by
//             count (the default): its element's own, kept while the element is, never used again;
//             or by place: its element's place under the root and the event ("0.3.1:click"), the
//             same for the same page rendered again (by another ermine, from the same state)
//   updates   take(into): what changed since sent(into) or the last take, each [binding, prop,
//             value]: a prop as the page's element names it ("className", "style", …), "text", or
//             "children" (the element's kids, as html). an element whose kids changed is sent
//             whole, and nothing inside it apart; one a page can't find (no binding) is sent inside
//             the nearest element that has one
//   not here  tells ("ermine:change", "ermine:call"): a page hears what take gives
import { createRenderer, type Listener, type Options, type Renderer } from "./render.ts"
import type { Child } from "./h.ts"

export type Element = {
	readonly tag: string
	readonly attrs: Map<string, string>
	readonly kids: Kid[]
	parent?: Element
}
export type Text = { text: string; parent?: Element }
export type Kid = Element | Text

// one change a page makes: the binding it finds the element by, the prop ("text", "children" or
// a property, as the page's element names it), and its value
export type Update = readonly [binding: string, prop: string, value: unknown]

export type RootOptions = {
	// the root's tag ("main")
	readonly tag?: string
	// how handlers are named: by count (the default), or by place
	readonly ids?: "count" | "place"
	// a change the page hasn't been told, the first since the last take
	readonly changed?: () => void
}

// what changed in an element the page has: its kids, and its props (the page's names: the binding
// of it, if bound, and the value)
type Change = {
	kids: boolean
	readonly props: Map<string, readonly [role: string, value: unknown]>
}
// a listener on an element, for an event: its id (by count), and the listener now (none: taken off)
type Slot = { id?: string; fn?: Listener }

type Root = {
	readonly into: Element
	readonly render: (into: Element, view: Child, options: Options) => Kid | undefined
	readonly ids: "count" | "place"
	readonly changed?: () => void
	readonly changes: Map<Element, Change>
	// the elements the page has, each with its bindings as the page has them, by what they bind
	readonly sent: WeakMap<Element, Map<string, string>>
	// by count: each id's element and event
	readonly byId: Map<string, readonly [Element, string]>
	count: number
}

const roots = new WeakMap<Element, Root>()
// what each element shows: its bindings, by what they bind; its listeners, by event
const bindings = new WeakMap<Element, Map<string, string>>()
const slots = new WeakMap<Element, Map<string, Slot>>()
const nodes = new WeakSet<object>()

const element = (tag: string): Element => {
	const el: Element = { tag, attrs: new Map(), kids: [] }
	nodes.add(el)
	return el
}

// a root to render into: an element of its own (no parent), its page told what changes
export function createRoot(options: RootOptions = {}): Element {
	const into = element(options.tag ?? "main")
	const root: Root = {
		into,
		render: undefined!,
		ids: options.ids ?? "count",
		changed: options.changed,
		changes: new Map(),
		sent: new WeakMap(),
		byId: new Map(),
		count: 0,
	}
	;(root as { render: Root["render"] }).render = createRenderer(rendererOf(root)).render
	roots.set(into, root)
	return into
}

function rootOf(into: Element): Root {
	const root = roots.get(into)
	if (root === undefined) throw new Error("@ermine/render/html: not a root (createRoot makes one)")
	return root
}

// the view rendered inside into (a root), reusing what an earlier render put there. gives the
// root's first kid. inside a process: its bindings are effects of the scope open now
export const render = (into: Element, view: Child, options: Options): Kid | undefined =>
	rootOf(into).render(into, view, options)

// ---- the renderer ----
// the props whose attribute is named otherwise, and back
const ATTRS: Record<string, string> = { className: "class", htmlFor: "for" }
const PROPERTIES: Record<string, string> = { class: "className", for: "htmlFor" }
// a prop as an attribute ("className" is "class"); an attribute as the page's element names it
const attrOf = (name: string) => ATTRS[name] ?? name
const propertyOf = (attr: string) => PROPERTIES[attr] ?? attr
// a style object as css text
const styled = (attr: string, value: unknown) =>
	attr === "style" && typeof value === "object" && value !== null
		// each capital a dash and its small letter: "fontSize" is "font-size"; "color" stays
		? Object.entries(value).map(([k, v]) =>
			`${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}:${v}`
		).join(";")
		: value

// an attribute's value: none for null, undefined and false; "" for true (there, with none)
function attrValue(v: unknown): string | undefined {
	if (v == null || v === false) return undefined
	return v === true ? "" : String(v)
}

// a binding's node as a page finds it: its 's dropped, and what a page's list of names (or its
// selector) can't hold as %xx: "view/0'" is "view/0", "view/1/new york:0" "view/1/new%20york:0"
const pageName = (name: string) =>
	name.replace(/'/g, "").replace(
		/[\s"\\]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
	)

// an element taken out for good (the engine places what it removed never again): its listeners'
// ids gone with it
function forget(root: Root, n: Kid) {
	if ("text" in n) return
	for (const slot of slots.get(n)?.values() ?? []) {
		if (slot.id !== undefined) root.byId.delete(slot.id)
	}
	for (const k of n.kids) forget(root, k)
}

function rendererOf(root: Root): Renderer<Kid, Element> {
	// what changed in el, when the page has it: else what el is now goes with what holds it
	function change(el: Element | undefined): Change | undefined {
		if (el === undefined || !root.sent.has(el)) return undefined
		let c = root.changes.get(el)
		if (c !== undefined) return c
		root.changes.set(el, c = { kids: false, props: new Map() })
		if (root.changes.size === 1) root.changed?.()
		return c
	}
	const kids = (el: Element | undefined) => {
		const c = change(el)
		if (c) c.kids = true
	}
	// el's bindings, written where a page finds them
	function said(el: Element, names: Map<string, string>) {
		if (names.size) el.attrs.set("data-ermine-binding", [...names.values()].join(" "))
		else el.attrs.delete("data-ermine-binding")
	}
	function take(n: Kid) {
		const p = n.parent
		if (p === undefined) return
		p.kids.splice(p.kids.indexOf(n), 1)
		n.parent = undefined
		kids(p)
	}
	return {
		element,
		text: (s) => {
			const t: Text = { text: s }
			nodes.add(t)
			return t
		},
		setText(t, s) {
			if ((t as Text).text === s) return
			;(t as Text).text = s
			kids(t.parent)
		},
		parentOf: (n) => n.parent,
		nextOf: (n) => n.parent?.kids[n.parent.kids.indexOf(n) + 1],
		insert(parent, n, before) {
			take(n)
			const at = before === null ? -1 : parent.kids.indexOf(before)
			if (at < 0) parent.kids.push(n)
			else parent.kids.splice(at, 0, n)
			n.parent = parent
			kids(parent)
		},
		remove(_, n) {
			take(n)
			forget(root, n)
		},
		set(el, name, value) {
			const attr = attrOf(name)
			const v = styled(attr, value)
			const now = attrValue(v)
			if (el.attrs.get(attr) !== now) {
				now === undefined ? el.attrs.delete(attr) : el.attrs.set(attr, now)
				change(el)?.props.set(propertyOf(attr), [name, v])
			}
			return "attr:" + attr
		},
		unset(el, what) {
			const attr = what.slice("attr:".length)
			if (!el.attrs.delete(attr)) return
			change(el)?.props.set(propertyOf(attr), ["", null])
		},
		listen(el, type, fn) {
			let all = slots.get(el)
			if (all === undefined) slots.set(el, all = new Map())
			const slot = all.get(type)
			if (slot !== undefined) return void (slot.fn = fn)
			const id = root.ids === "count" ? String(++root.count) : undefined
			all.set(type, { id, fn })
			if (id !== undefined) root.byId.set(id, [el, type])
			// a listener the page doesn't know of: el, sent again
			kids(el.parent)
		},
		// taken off: its id kept for a listener put on again (each apply does), gone when sent
		unlisten(el, type, fn) {
			const slot = slots.get(el)?.get(type)
			if (slot?.fn === fn) slot.fn = undefined
		},
		isNode: (x): x is Kid => typeof x === "object" && x !== null && nodes.has(x),
		nameOf: (n) => "tag" in n ? n.tag : "text",
		say(el, name, value) {
			const attr = `data-ermine-${name}`
			const was = el.attrs.get(attr)
			if (was === value) return
			value === undefined ? el.attrs.delete(attr) : el.attrs.set(attr, value)
			if (name === "waiting") change(el)?.props.set(attr, ["", value !== undefined])
			if (value !== undefined || !name.startsWith("bind:")) return
			// a binding taken off: its node no longer said (kids: neither text nor children)
			const role = name === "bind:text" || name === "bind:children"
				? "kids"
				: name.slice("bind:".length)
			if (
				role === "kids" &&
				(el.attrs.has("data-ermine-bind:text") || el.attrs.has("data-ermine-bind:children"))
			) return
			const names = bindings.get(el)
			if (!names?.delete(role)) return
			said(el, names)
			// a binding the page finds el by, gone: el, sent again
			kids(el.parent)
		},
		bound(el, role, as) {
			const name = pageName(as)
			let names = bindings.get(el)
			if (names === undefined) bindings.set(el, names = new Map())
			if (names.get(role) === name) return
			names.set(role, name)
			said(el, names)
			// a binding the page doesn't know of: el, sent again
			kids(el.parent)
		},
	}
}

// ---- what the page has ----
// the place of n under the root: each kid's index, from the root down ("0.3.1")
function placeOf(n: Kid): string {
	const at: number[] = []
	for (; n.parent !== undefined; n = n.parent) at.unshift(n.parent.kids.indexOf(n))
	return at.join(".")
}
const inside = (n: Kid, el: Element) => {
	for (let p: Kid | undefined = n; p !== undefined; p = p.parent) if (p === el) return true
	return false
}

// el and what's under it, as the page will have them: their handlers' ids written (a listener
// taken off, its id gone), their bindings what the page finds them by
function send(root: Root, el: Element) {
	const all = slots.get(el)
	for (const [type, slot] of all ?? []) {
		const attr = `data-ermine-handler:${type}`
		if (slot.fn !== undefined) {
			el.attrs.set(attr, slot.id ?? `${placeOf(el)}:${type}`)
			continue
		}
		el.attrs.delete(attr)
		all!.delete(type)
		if (slot.id !== undefined) root.byId.delete(slot.id)
	}
	root.sent.set(el, new Map(bindings.get(el)))
	for (const k of el.kids) if ("tag" in k) send(root, k)
}

// the page has into as it is now (its html is written next): what changes after is take's
export function sent(into: Element) {
	const root = rootOf(into)
	root.changes.clear()
	send(root, into)
}

// what changed since sent(into) or the last take, as the page makes it: each bound prop changed,
// by its binding; each element whose kids changed (or one under it the page can't find) whole.
// the page has them now
export function take(into: Element): Update[] {
	const root = rootOf(into)
	// the binding a page finds el by: the one of role, or its first (none: undefined)
	const nameOf = (el: Element, role: string) => {
		const names = root.sent.get(el)
		return names?.get(role) ?? names?.values().next().value
	}
	// el, or the nearest element holding it, a page can find
	const found = (el: Element | undefined) => {
		while (el !== undefined && nameOf(el, "") === undefined) el = el.parent
		return el
	}
	const wholes = new Set<Element>()
	const props: [Element, string, string, unknown][] = []
	for (const [el, c] of root.changes) {
		if (!inside(el, into)) continue
		const whole = (el: Element | undefined) => (el = found(el)) && wholes.add(el)
		if (c.kids) whole(el)
		for (const [prop, [role, value]] of c.props) {
			if (nameOf(el, role) !== undefined) props.push([el, role, prop, value])
			else whole(el)
		}
	}
	root.changes.clear()
	// inside an element sent whole
	const covered = (n: Kid) =>
		n.parent !== undefined && [...wholes].some((w) => inside(n.parent!, w))
	const out: Update[] = []
	for (const [el, role, prop, value] of props) {
		if (!covered(el)) out.push([nameOf(el, role)!, prop, value])
	}
	for (const w of wholes) {
		if (covered(w)) continue
		const name = nameOf(w, "kids")!
		for (const k of w.kids) if ("tag" in k) send(root, k)
		const text = w.kids.every((k) => "text" in k)
		out.push(
			text
				? [name, "text", w.kids.map((k) => (k as Text).text).join("")]
				: [name, "children", inner(w)],
		)
	}
	return out
}

// the listener id names, in the page into: called with event (what the page's event says: its
// type, target, …). false: no such listener (an id from before the page was sent again)
export function fire(into: Element, id: string, event: unknown): boolean {
	const root = rootOf(into)
	let at: readonly [Element, string] | undefined
	if (root.ids === "count") at = root.byId.get(id)
	else {
		const colon = id.lastIndexOf(":")
		let n: Kid | undefined = into
		for (const i of colon < 0 ? [] : id.slice(0, colon).split(".")) {
			n = n && "tag" in n ? n.kids[Number(i)] : undefined
		}
		if (colon >= 0 && n !== undefined && "tag" in n) at = [n, id.slice(colon + 1)]
	}
	const fn = at && inside(at[0], into) ? slots.get(at[0])?.get(at[1])?.fn : undefined
	fn?.(event)
	return fn !== undefined
}

// ---- html ----
export const VOID = new Set([
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
// & < > in text, & " < in a quoted attribute, as entities: "a<b" is "a&lt;b"; "ab" stays (each
// pattern one character: "&" matches /&/g, "a" doesn't)
const escaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
export const quoted = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

// an element (or text) as html
export function html(kid: Kid): string {
	if ("text" in kid) return escaped(kid.text)
	let s = "<" + kid.tag
	for (const [k, v] of kid.attrs) s += v === "" ? ` ${k}` : ` ${k}="${quoted(v)}"`
	return VOID.has(kid.tag) ? s + ">" : `${s}>${inner(kid)}</${kid.tag}>`
}
// an element's kids as html
export const inner = (el: Element): string => el.kids.map(html).join("")
