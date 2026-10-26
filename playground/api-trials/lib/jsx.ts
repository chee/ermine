// jsx for programs: a .jsx program's elements, rendered to a string as show is given them.
// deno compiles a .jsx file's JSX to React.createElement(type, props, ...children) (its default,
// classic jsx; the repo's deno.json sets no compilerOptions), or to h(…) under a /** @jsx h */
// pragma. the harness gives all three names as globals, so a program writes JSX with no imports
// and no pragma. an element is plain data until shown; show renders it (lib/trial.ts).
// rendering: a string or number child is its text (escaped); an element is its tag, its
// attributes and its children; a list is its items; anything else is String(it), so a handle put
// in the braces shows as what it is ([object Object], a function's source, [node /work/count]),
// and undefined, null, true and false show as words (React drops them; here they'd hide a bug)
//
// components are reactive (chee, 10-25: yes). h(Counter, props) makes an instance: an early
// effect of the process's real api (api.early), so a node of its own as a memo is, at
// .jsx-Counter-N in the program's own node, its scope a child of the scope open (its SCOPE
// attribute names the node above it: the effect, memo or component that drew it). its f, the
// tracked part, calls Counter({ ...props, children }) and gives back the instance's text (the
// node's value); what Counter read is tracked, so when it changes that instance, and only it,
// renders again. early: made, it runs and acts at once, so h has the first render to give back.
// h gives back a slot, an element standing for the instance, rendered as the instance's latest.
// what Counter makes (memos, effects, handlers) is under the instance: on a re-render the same
// words find them (ermine's claim of a computer made again by its owner's next run; a handler
// placed again at its path keeps its node), so they are made on the first render and kept. an
// instance is known by its place among the components its owner drew in one run (or act): the
// owner drawing again draws the same instances, with new props (made due); one it no longer
// draws goes with that run's end (or before the next act), its scope and all under it.
// show (lib/trial.ts) keeps what it was given as the trial's tree; an instance rendering again
// shows the whole tree again, so the last shown is always the tree now, as a string.
// no process found from the scope open (nothing open, a timer): the component is called plainly
import type { API } from "@ermine/ermine"
import type { Scheduler, Scope } from "@ermine/core/scheduler"

export const ELEMENT = Symbol("jsx element")
// a slot's type: an element standing for a component's instance
export const SLOT = Symbol("jsx component")

export type Element = {
	readonly [ELEMENT]: true
	readonly type: unknown
	readonly props: Record<string, unknown>
	readonly children: readonly unknown[]
}

let scheduler: Scheduler | undefined
// a process's scope → its real api (lib/trial.ts registers each setup's scope and its parent)
const apis = new WeakMap<Scope, API>()
// the trial's trees: what show was given last, per output, and the text it showed then
const trees = new Map<(text: string) => void, { tree: unknown; last: string }>()

// a new trial: its scheduler; no trees yet
export function useScheduler(s: Scheduler) {
	scheduler = s
	trees.clear()
}
export const register = (scope: Scope, api: API) => void apis.set(scope, api)

function apiOpen(): API | undefined {
	for (let o = scheduler?.getCurrentScope(); o !== undefined; o = o.parent) {
		const api = apis.get(o)
		if (api !== undefined) return api
	}
	return undefined
}

type Instance = { element: unknown }
// an instance by its node's name; a slot's instance
const instances = new Map<string, Instance>()
const slotOf = new WeakMap<object, Instance>()
// per owner (a computer, an act, a setup): which run it is in, how many components it drew so
// far in it, and the name each place had
const places = new WeakMap<Scope, { run: unknown; i: number; names: Map<string, string> }>()
let made = 0

function nameFor(owner: Scope, type: { name?: string }): string {
	const run = (owner.info as { run?: unknown }).run
	let p = places.get(owner)
	if (p === undefined) places.set(owner, p = { run, i: 0, names: new Map() })
	if (p.run !== run) {
		p.run = run
		p.i = 0
	}
	const key = `${p.i++}:${type.name || "component"}`
	let name = p.names.get(key)
	if (name === undefined) {
		name = `.jsx-${type.name || "component"}-${++made}`
		p.names.set(key, name)
	}
	return name
}

function slot(instance: Instance): Element {
	const s = Object.freeze({ [ELEMENT]: true, type: SLOT, props: {}, children: [] }) as Element
	slotOf.set(s, instance)
	return s
}

// every tree shown again whose text changed
function refresh() {
	for (const [push, t] of trees) {
		const text = render(t.tree)
		if (text === t.last) continue
		t.last = text
		push(text)
	}
}

// show's: tree is the trial's tree now, its text pushed
export function showing(tree: unknown, push: (text: string) => void) {
	const text = render(tree)
	trees.set(push, { tree, last: text })
	push(text)
}

function component(
	type: (props: Record<string, unknown>) => unknown,
	given: Record<string, unknown>,
) {
	const api = apiOpen()
	const owner = scheduler?.getCurrentScope()
	if (api === undefined || owner === undefined) return type(given)
	const name = nameFor(owner, type as { name?: string })
	let instance = instances.get(name)
	if (instance === undefined) instances.set(name, instance = { element: undefined })
	const me = instance
	// an act inside this h is the tree still being drawn (its first render, if it acts at once:
	// a first run that wrote a node it read acts later); after, a render of its own
	let drawing = true
	api.early(
		name,
		() => {
			me.element = type(given)
			return render(me.element)
		},
		() => {
			if (!drawing) refresh()
		},
	)
	drawing = false
	return slot(me)
}

export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
	if (typeof type === "function") {
		return component(type as (p: Record<string, unknown>) => unknown, { ...props, children })
	}
	return Object.freeze({ [ELEMENT]: true, type, props: props ?? {}, children }) as Element
}
export const Fragment = Symbol("jsx fragment")

// "in", not a property read: F's handles throw on any property
export const isElement = (x: unknown): x is Element =>
	typeof x === "object" && x !== null && ELEMENT in x

const escape = (s: string) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const quote = (s: string) => escape(s).replaceAll('"', "&quot;")

function attrs(props: Record<string, unknown>): string {
	let out = ""
	for (const [k, v] of Object.entries(props)) {
		if (k === "children" || k === "key" || v === false || v === null || v === undefined) continue
		if (typeof v === "function") continue
		out += v === true ? ` ${k}` : ` ${k === "className" ? "class" : k}="${quote(String(v))}"`
	}
	return out
}

export function render(x: unknown): string {
	if (typeof x === "string") return escape(x)
	if (typeof x === "number" || typeof x === "bigint") return String(x)
	if (Array.isArray(x)) return x.map(render).join("")
	// unescaped: a function's source shown as written
	if (!isElement(x)) return String(x)
	const { type, props, children } = x
	// an instance: its latest render (none yet, pending or failed: nothing)
	if (type === SLOT) {
		const i = slotOf.get(x)
		return i === undefined || i.element === undefined ? "" : render(i.element)
	}
	if (type === Fragment) return children.map(render).join("")
	// a component is called by h (above), so an element's type is never one
	return `<${String(type)}${attrs(props)}>${children.map(render).join("")}</${String(type)}>`
}

for (
	const [k, v] of Object.entries({ h, Fragment, React: { createElement: h, Fragment } })
) {
	Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
}
