// @ermine/render/h: views, described. jsx (@ermine/jsx-runtime) or h(tag, props, ...kids)
// makes one; bind, each, under and track say what in the graph it shows; handler, what an event
// calls. plain objects, told apart by Symbol.for (ermine-h's keys, so its copies agree); a
// renderer makes them real (@ermine/render/dom)
//   targets   "n" under the process's node, "./n" from its cwd, "/n" from its root, a node
//             handle, or [parent, name]: what is at name under parent
//   kept      a node the program made (a canvas) as a child: placed as it is, never touched inside
import type { getNode } from "@ermine/system"

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
// a node the program made, as its renderer makes nodes (the DOM's have a nodeType)
export type Kept = { readonly nodeType: number }
export type Child =
	| View
	| Bound
	| Kept
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| readonly Child[]
export type Component<P = any> = (props: P) => Child

export const isView = (x: unknown): x is View => typeof x === "object" && x !== null && VIEW in x
export const isBound = (x: unknown): x is Bound => typeof x === "object" && x !== null && BOUND in x
export const isHandler = (x: unknown): x is Handler =>
	typeof x === "object" && x !== null && HANDLER in x
export const isSlot = (x: unknown): x is Slot =>
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
// what it gives is shown, or handed to fn. what: a word for what's said of it (none: "track")
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
// a view from jsx's (tag, props, key), and where it was written (the jsx runtime's)
export function make(
	tag: string | Component,
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
// its kids, as they are
export const Fragment = (props: { children?: Child }): any => props.children ?? []
