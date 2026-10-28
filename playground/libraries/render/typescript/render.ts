// @ermine/render: views (@ermine/render/h) made real by a renderer, inside a process (its setup),
// as @ermine/system's functions are. createRenderer(renderer) gives render(into, view, options);
// @ermine/render/dom is the DOM's. the nodes are the renderer's; what each was made from, what's
// placed where and what's set on each, the engine keeps
//   reuse     a node is the nth of its kind under its parent (a tag, a tag and key, text, a
//             binding): a render again changes and moves only what differs (shift's reconcile)
//   bind      an early effect at a node of its own under the view's folder (options.at, "view" if
//             none): view/0, view/1, and a binding made while another plans goes under that one's
//             node (view/3/0). so the page's bindings are in the graph, each one's value what it
//             last read. its compute reads and plans what it shows, the bindings inside made there
//             (an act makes nothing); its act places it
//   handler   onClick={handler("on/press", [args])}: the action there, called through
//             options.call (an event has nothing open: the host says who calls)
//   says      renderer.say(el, name, value): process, key, source (file:line), bind:<prop|text|
//             children>, on:<event>, waiting (""); undefined takes it back
//   tells     renderer.tell(el, name, detail): "ermine:change" on a bound node, "ermine:call" and
//             "ermine:called" around a handler; onErmineChange={…} listens
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
import {
	type Bound,
	type Child,
	type Handler,
	handler,
	isBound,
	isHandler,
	isSlot,
	isView,
	type Item,
	type Target,
	type View,
} from "./h.ts"

type Node = ReturnType<typeof getNode>

// what render needs from the host: a name the root says, and how an action is called from an
// event (nothing is open then, so the process can't call it itself)
export type Options = {
	name: string
	call: (action: Node, ...args: unknown[]) => unknown
	// the folder the bindings' nodes go under, from the process's node
	at?: string
}

// an event's listener, as a renderer calls it
export type Listener = (event: unknown) => void

// a renderer: its nodes made and changed, nothing more. N: any node it makes; E: one with props
// and kids. what it was asked for last, the engine remembers
export type Renderer<N extends object, E extends N> = {
	element: (tag: string) => E
	text: (s: string) => N
	// t's text, now s (the same again: nothing to do)
	setText: (t: N, s: string) => void
	// where n is placed (none: undefined or null), and what's after it there
	parentOf: (n: N) => E | null | undefined
	nextOf: (n: N) => N | null | undefined
	// n placed in parent before before (null: last); taken out
	insert: (parent: E, n: N, before: N | null) => void
	remove: (parent: E, n: N) => void
	// a prop set: gives a name for what it set (not "on:", "say:", "bound:" or "kids"), taken back
	// with unset when the prop goes
	set: (el: E, name: string, value: unknown) => string
	unset: (el: E, what: string) => void
	listen: (el: E, type: string, fn: Listener) => void
	unlisten: (el: E, type: string, fn: Listener) => void
	// a node the program made itself (a kept child): placed as it is
	isNode: (x: unknown) => x is N
	// a node shown as a value: <its name>
	nameOf?: (n: N) => string
	say?: (el: E, name: string, value: string | undefined) => void
	tell?: (el: E, name: string, detail: object) => void
}

// a node's value, pending; nothing there
const WAITING = Symbol.for("ermine-h.waiting")
const NOTHING = Symbol.for("ermine-h.nothing")

export function createRenderer<N extends object, E extends N>(
	r: Renderer<N, E>,
): { render: (into: E, view: Child, options: Options) => N | undefined } {
	// ---- where bindings go ----
	// the plan being made: the host's options, the folder a binding made now goes under, and how
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

	// ---- what the engine keeps ----
	// a node placed: what it was made from, to be matched again ("p", "li#a", "#text", "#bind")
	const kind = new WeakMap<N, string>()
	// an element's kids as placed last, in order
	const placed = new WeakMap<E, N[]>()
	// what was set on an element last: the renderer's names for its props, "on:<event>" (its
	// listener), "say:<name>", "bound:<prop>", "kids"
	const owned = new WeakMap<E, Map<string, unknown>>()
	// a bound prop's last set, by the renderer's name for it
	const boundAs = new WeakMap<E, Map<string, string>>()
	// what an element's own kids were said to be: text, or views
	const kidsAs = new WeakMap<E, "text" | "children">()

	type Slotted = View | Bound | N | string

	// kids, flat: lists opened, nothing for null, undefined and booleans
	function flat(kids: readonly Child[], out: Slotted[] = []): Slotted[] {
		for (const k of kids) {
			if (k == null || typeof k === "boolean") continue
			if (Array.isArray(k)) flat(k, out)
			else if (isView(k) || isBound(k) || r.isNode(k)) out.push(k as Slotted)
			else out.push(typeof k === "object" ? asText(k)! : String(k))
		}
		return out
	}

	// ---- planning it ----
	// a binding's compute reads, then plans what it shows: text, elements, and the bindings inside,
	// made there (an act makes nothing). its act places the plan: the renderer is asked for nothing
	// but in an act, or in render. the element a binding shows on is chosen by the act that places
	// it, after the binding is made, so a binding shows through its socket: at once when the socket
	// has its element, else waiting till it is given one (a binding made new acts at once, inside
	// the compute that made it, before there is an element)
	type Socket = {
		el?: E
		waiting?: (el: E) => void
		// told the element as it is given, before what waited is shown
		readonly given?: (el: E) => void
	}
	function give(k: Socket, show: (el: E) => void) {
		if (k.el) show(k.el)
		else k.waiting = show
	}
	function attach(k: Socket, el: E) {
		k.el = el
		k.given?.(el)
		const waiting = k.waiting
		k.waiting = undefined
		waiting?.(el)
	}

	// what a compute plans: text, a binding among other kids (its span's socket), an element (its
	// view, and what was made for it), or a kept node
	type Plan =
		| { readonly text: string }
		| { readonly bound: Socket }
		| { readonly view: View; readonly made: Made }
		| { readonly node: N }
	// what was made for a view: each bound prop's socket, each event's listener (its action's node
	// found then), and its kids planned, or bound
	type Made = {
		readonly bound: Map<string, Socket>
		readonly on: Map<string, Listening | undefined>
		readonly kids: Plan[] | Socket
	}

	// kids planned, their bindings made in the order render always made them: an element's bound
	// props, then its kids
	function plan(slots: Slotted[]): Plan[] {
		return slots.map((s): Plan =>
			typeof s === "string"
				? { text: s }
				: isBound(s)
				? { bound: bindKids(s) }
				: isView(s)
				? { view: s, made: prepare(s) }
				: { node: s }
		)
	}

	function prepare(v: View): Made {
		// one binding alone binds the element's own kids (its text, or a list); else they are planned
		const slots = flat(v.kids)
		const alone = slots.length === 1 && isBound(slots[0]) ? slots[0] : undefined
		const bound = new Map<string, Socket>()
		const on = new Map<string, Listening | undefined>()
		for (const [name, value] of Object.entries(v.props)) {
			if (name === "ref") continue
			if (/^on./.test(name) && value != null) on.set(eventOf(name), listening(value))
			else if (isBound(value)) bound.set(name, bindProp(name, value))
		}
		return { bound, on, kids: alone ? bindKids(alone) : plan(slots) }
	}

	const match = (p: Plan) =>
		"text" in p
			? "#text"
			: "bound" in p
			? "#bind"
			: "view" in p
			? p.view.key === undefined ? p.view.tag : `${p.view.tag}#${p.view.key}`
			: undefined

	// ---- placing it ----
	// the view rendered inside into, reusing what an earlier render put there. gives the root.
	// inside a process: its bindings are effects of the scope open now
	function render(into: E, view: Child, options: Options): N | undefined {
		const folder = options.at ?? "view"
		ensureNode(folder)
		place(into, within({ options, folder, n: 0 }, () => plan(flat([view]))))
		const root = placed.get(into)?.[0]
		// a root the view made says whose it is
		const k = root === undefined ? undefined : kind.get(root)
		if (k !== undefined && k !== "#text") r.say?.(root as E, "process", options.name)
		return root
	}

	// an element's kids: each the one of its kind before it, nth for nth, else made. then shift's
	// reconcile: take out only what is no longer wanted, move only what is out of place. what the
	// engine did not place is left where it is
	function place(parent: E, plans: Plan[]) {
		const prev = (placed.get(parent) ?? []).filter((n) => r.parentOf(n) === parent)
		const pool = new Map<string, N[]>()
		for (const n of prev) {
			const k = kind.get(n)
			if (k !== undefined) pool.has(k) ? pool.get(k)!.push(n) : pool.set(k, [n])
		}
		const next = plans.map((p) => {
			const k = match(p)
			if (k === undefined) return (p as { node: N }).node
			const was = pool.get(k)?.shift()
			const n = real(p, was)
			kind.set(n, k)
			return n
		})
		const keep = new Set(next)
		for (const n of prev) if (!keep.has(n) && r.parentOf(n) === parent) r.remove(parent, n)
		let before: N | null = null
		for (let i = next.length - 1; i >= 0; i--) {
			const n = next[i]
			if (r.parentOf(n) !== parent || (r.nextOf(n) ?? null) !== before) {
				r.insert(parent, n, before)
			}
			before = n
		}
		placed.set(parent, next)
	}

	function real(p: Plan, was: N | undefined): N {
		if ("text" in p) {
			if (was === undefined) return r.text(p.text)
			r.setText(was, p.text)
			return was
		}
		if ("bound" in p) {
			// a binding among other kids: a span of its own says what it shows
			const span = (was as E | undefined) ?? r.element("span")
			attach(p.bound, span)
			return span
		}
		const { view: v, made } = p as { view: View; made: Made }
		const el = (was as E | undefined) ?? r.element(v.tag)
		apply(el, v, made)
		return el
	}

	// props, then kids. what was set last time and is not now is taken back
	function apply(el: E, v: View, made: Made) {
		const was = owned.get(el) ?? new Map<string, unknown>()
		const now = new Map<string, unknown>()
		owned.set(el, now)
		const say = (name: string, value: string) => {
			r.say?.(el, name, value)
			now.set("say:" + name, true)
		}
		if (v.key !== undefined) say("key", v.key)
		if (v.source) say("source", v.source)
		if (!Array.isArray(made.kids)) now.set("kids", true)
		let ref: ((el: E) => void) | undefined
		for (const [name, value] of Object.entries(v.props)) {
			if (name === "ref") ref = value as typeof ref
			else if (/^on./.test(name) && value != null) {
				listen(el, eventOf(name), made.on.get(eventOf(name)), was, now)
			} else if (isBound(value)) {
				say(`bind:${name}`, said(value.target))
				now.set("bound:" + name, true)
				attach(made.bound.get(name)!, el)
			} else now.set(r.set(el, name, value), true)
		}
		for (const [what, old] of was) if (!now.has(what)) unset(el, what, old, now)
		if (Array.isArray(made.kids)) place(el, made.kids)
		else attach(made.kids, el)
		ref?.(el)
	}

	// what was set and isn't now, taken back
	function unset(el: E, what: string, old: unknown, now: Map<string, unknown>) {
		const at = what.indexOf(":")
		const how = at < 0 ? what : what.slice(0, at), name = what.slice(at + 1)
		if (how === "on") return r.unlisten(el, name, old as Listener)
		if (how === "say") return r.say?.(el, name, undefined)
		if (how === "bound") {
			r.say?.(el, `bind:${name}`, undefined)
			const as = boundAs.get(el)?.get(name)
			boundAs.get(el)?.delete(name)
			// what the binding set, unless a prop set it again now
			if (as !== undefined && !now.has(as)) r.unset(el, as)
			return
		}
		if (how === "kids") {
			r.say?.(el, "bind:text", undefined)
			r.say?.(el, "bind:children", undefined)
			kidsAs.delete(el)
			return
		}
		r.unset(el, what)
	}

	// an event: an action (handler(…), or a node) is called through the host's call; a plain
	// function is a plain listener, and says nothing; anything else is no listener. the action's
	// node is found in the compute, while the process is open; the call comes later, from the
	// event, when nothing is
	type Listening =
		| { readonly fn: Listener }
		| {
			readonly h: Handler
			readonly at: string
			readonly node: Node
			readonly call: Options["call"]
		}
	function listening(value: unknown): Listening | undefined {
		if (typeof value === "function") return { fn: value as Listener }
		if (!isHandler(value) && (typeof value !== "object" || value === null)) return undefined
		const h = isHandler(value) ? value : handler(value as Node)
		const at = typeof h.target === "string" ? h.target : "[node]"
		const node = typeof h.target === "string" ? getNode(h.target) : h.target
		return { h, at, node, call: here!.options.call }
	}
	// onClick: "click". onErmineChange: the engine's own "ermine:change" (jsx has no colon in a name)
	const eventOf = (name: string) =>
		name.startsWith("onErmine")
			? "ermine:" + name.slice(8).toLowerCase()
			: name.slice(2).toLowerCase()

	// an event's listener on the element, as its compute found it
	function listen(
		el: E,
		type: string,
		l: Listening | undefined,
		was: Map<string, unknown>,
		now: Map<string, unknown>,
	) {
		const old = was.get("on:" + type)
		if (old) r.unlisten(el, type, old as Listener)
		let listener: Listener
		if (l === undefined) return
		if ("fn" in l) listener = l.fn
		else {
			const { h, at, node, call } = l
			r.say?.(el, `on:${type}`, at)
			now.set(`say:on:${type}`, true)
			// a block, never cond && …: a listener returning false would cancel the event
			listener = (e) => {
				const args = typeof h.args === "function" ? h.args(e) : h.args ?? []
				if (!args) return
				const tell = (name: string, detail: object) =>
					r.tell?.(el, name, { path: at, type, ...detail })
				// said for the page (explain), never asked by the call: the host decides who is calling
				tell("ermine:call", { args, trusted: (e as { isTrusted?: boolean })?.isTrusted })
				let result: unknown
				try {
					result = call(node, ...args)
				} finally {
					tell("ermine:called", { result })
				}
			}
		}
		r.listen(el, type, listener)
		now.set("on:" + type, listener)
	}

	// ---- the bindings ----
	// a bound prop: fn's value (in the compute) set by the act. waiting: the prop stays as it was.
	// the same prop again is no change (no flash)
	function bindProp(name: string, b: Bound): Socket {
		let last: unknown = watch
		return watch(b, (x) => b.fn && x !== undefined ? b.fn(x) : x, (el, next, waiting) => {
			if (waiting) return false
			if (Object.is(next, last) && typeof next !== "object") return false
			const as = r.set(el, name, last = next)
			let all = boundAs.get(el)
			if (all === undefined) boundAs.set(el, all = new Map())
			all.set(name, as)
		})
	}

	// a binding of an element's own kids: what the node holds is shown there (text, or views)
	function bindKids(b: Bound): Socket {
		const path = said(b.target)
		const listed = b.read === "each" || b.read === "under"
		let last: unknown = watch
		return watch(
			b,
			(x, waiting) => {
				if (waiting) return undefined
				const shown = listed || b.fn && x !== undefined
					? b.fn!(x)
					: x === null
					? undefined
					: asText(x)
				const slots = flat([shown as Child])
				return { shown, slots, plans: plan(slots) }
			},
			(el, s) => {
				// waiting: what was shown stays (an ellipsis the first time)
				if (s === undefined) return void (placed.get(el)?.length || place(el, [{ text: "…" }]))
				const { shown, slots, plans } = s
				// the same text again is no change (no flash)
				if (typeof shown !== "object" && Object.is(shown, last)) return false
				last = shown
				// text, or views; a derived view that gives nothing keeps what it said it was
				const text = !listed && slots.every((s) => typeof s === "string") &&
					(!b.fn || slots.length > 0 || kidsAs.get(el) !== "children")
				r.say?.(el, `bind:${text ? "text" : "children"}`, path)
				r.say?.(el, `bind:${text ? "children" : "text"}`, undefined)
				kidsAs.set(el, text ? "text" : "children")
				place(el, plans)
			},
			(el) => {
				if (kidsAs.get(el) === "children") return
				r.say?.(el, "bind:text", path)
				kidsAs.set(el, "text")
			},
		)
	}

	// a node's own value is shown as text (true, a list, a map); only what a derived view gives is
	// jsx
	function asText(v: unknown): string | undefined {
		if (v === undefined) return undefined
		if (typeof v !== "object" || v === null) return String(v)
		if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ")
		if (r.isNode(v)) return `<${r.nameOf?.(v) ?? "node"}>`
		try {
			return JSON.stringify(v)
		} catch {
			return String(v)
		}
	}

	// an early effect at its own node, its value what it read. its compute reads, and make plans
	// what is shown from that (undefined: nothing there; waiting: a pending compute), what make
	// makes made under this binding's node. its act hands the plan to show, on the element its
	// socket is given. a change after the first is told on the element ("ermine:change"), unless
	// show says nothing it shows changed. every run acts (equal: never): its plan is new each run,
	// and a binding made again in its parent's next run acts later in the pulse, on an element its
	// parent's act may have just made
	function watch<S>(
		b: Bound,
		make: (v: unknown, waiting: boolean) => S,
		show: (el: E, s: S, waiting: boolean) => boolean | void,
		given?: (el: E) => void,
	): Socket {
		const now = here
		if (now === undefined) throw new Error("@ermine/render: a binding made outside render")
		const name = `${now.folder}/${now.n++}`
		const path = said(b.target)
		const k: Socket = { given }
		let first = true
		let planned: S
		createEffect(
			name,
			() => {
				const v = reading(b)
				// nothing for none; null is a value (fn sees it)
				const v2 = v === WAITING || v === NOTHING ? undefined : v
				planned = within(
					{ options: now.options, folder: name, n: 0 },
					() => make(v2, v === WAITING),
				)
				return v
			},
			(v) => {
				const s = planned
				give(k, (el) => {
					r.say?.(el, "waiting", v === WAITING ? "" : undefined)
					if (show(el, s, v === WAITING) !== false && !first) {
						r.tell?.(el, "ermine:change", { path })
					}
					first = false
				})
			},
			{ early: true, equal: () => false },
		)
		return k
	}

	return { render }
}

// ---- reading a node ----
// what's said of a target: its path as written; a handle is "[node]"
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

// what a binding is of, tracked: a node's value (NOTHING: no node there), an each's entries, an
// under's children, what track's get gives; WAITING for a pending compute
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
}
