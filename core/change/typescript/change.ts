import { capture, type Site } from "./stacktrace.ts"

// what a change says, given by the caller (GRAPH.tex, Changes)
// actor and cause: the caller's, never read here
export type Header = {
	time: number
	actor: unknown
	reader?: string
	site?: Site
	cause?: unknown
	// the author's clock, whole seconds since 1970, and a string from the author: the caller's, never read here
	wallclock?: number
	message?: string
}

// a version's change: its header and node, never its edits
export type Change = Header & { node: string }

export type Options = {
	// capture the call's site as site, where the header gives none
	outside?: boolean
}

// where the engine cannot cut at make, these frames are passed over
const ours: ReadonlySet<string> = new Set([
	import.meta.url,
	new URL("./stacktrace.ts", import.meta.url).href,
])

// a new object, the header's fields as given; nothing checked: checks are a layer above's
export default function createChange(node: string, header: Header, options: Options = {}): Change {
	const c: Change = { ...header, node }
	if (options.outside && !("site" in header)) {
		const site = capture(ours, createChange)
		if (site) c.site = site
	}
	return c
}
