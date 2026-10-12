import { capture, type Site } from "./stacktrace.ts"

// one version of an object: its content, the change that made it, why it is there
// change and because: the caller's, never read here
// content is absent (undefined at runtime) in a version that is a removal among racing heads
// (sync/APPLY.tex); readers that take every version guard it
export type Side<C, H> = { content: C; change: H; because?: unknown }

// a list: ids in order, and symbols, which name no node
export type List = readonly (string | symbol)[]

export type Node<V, H> = {
	id: string
	value: Side<V, H>[]
	attributes: Iterable<readonly [string, Side<V, H>][]>
	children: Iterable<readonly [string, Side<List, H>][]>
	// about it being made; the caller's, not copied: never change it. Given back as is when a node
	// comes back from storage
	change: ChangeHeader
}

// a change header's fields; which are required is checked above
export type ChangeHeader = {
	time?: number
	actor?: unknown
	reader?: string
	// where in code it was made
	site?: Site[]
	cause?: unknown
	// the author's clock, whole seconds since 1970, and a message (CHANGE.tex)
	wallclock?: number
}

// entries in order, as new Map takes them
export type Contents<V, H> = {
	value?: Side<V, H>[]
	attributes?: Iterable<readonly [string, Side<V, H>[]]>
	children?: Iterable<readonly [string, Side<List, H>[]]>
}

export type Options = {
	header?: ChangeHeader
	// made by code outside the graph, not a process: capture the call's site as the header's
	// site, when it gives none
	outside?: boolean
}

// where the engine cannot cut at make, these frames are passed over
const ours: ReadonlySet<string> = new Set([
	import.meta.url,
	new URL("./stacktrace.ts", import.meta.url).href,
])

// kept by the caller; nothing checked: checks are a layer above's
export default function createNode<V, H>(
	id: string,
	contents: Contents<V, H> = {},
	options: Options = {},
): Node<V, H> {
	const change: ChangeHeader = options.header ?? {}
	if (options.outside) {
		const site = capture(ours, createNode)
		if (site) {
			change.site = change.site ? change.site.concat(site) : [site]
		}
	}
	return {
		id,
		change: change,
		attributes: contents.attributes ?? [],
		children: contents.children ?? [],
		value: contents.value ?? [],
	}
}
