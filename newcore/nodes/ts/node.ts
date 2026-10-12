import { capture, type Site } from "./stacktrace.ts"

// one version of an object: its content, the change that made it, why it is there
// change and because: the caller's, never read here
// content is absent (undefined at runtime) in a version that is a removal among racing heads
// (sync/APPLY.tex); readers that take every version guard it
export type Version<C, H> = { content: C; change: H; because?: unknown }

// a list: ids in order, and symbols, which name no node
export type List = readonly (string | symbol)[]

export type Node<V, H> = {
	id: string
	value: Version<V, H>[]
	info: Map<string, Version<V, H>[]>
	children: Map<string, Version<List, H>[]>
	// about it being made, frozen; given back as is when a node comes back from storage
	header: Header
}

// a change header's fields; which are required is checked above
export type Header = {
	time?: number
	actor?: unknown
	reader?: string
	// where in code it was made
	site?: Site
	cause?: unknown
}

// entries in order, as new Map takes them
export type Contents<V, H> = {
	value?: Version<V, H>[]
	info?: Iterable<readonly [string, Version<V, H>[]]>
	children?: Iterable<readonly [string, Version<List, H>[]]>
}

export type Options = {
	header?: Header
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
	const header: Header = { ...options.header }
	if (options.outside && header.site === undefined) {
		const site = capture(ours, createNode)
		if (site) header.site = site
	}
	return {
		id,
		value: contents.value ?? [],
		info: new Map(contents.info),
		children: new Map(contents.children),
		header: Object.freeze(header),
	}
}
