import { capture, type Site } from "./stacktrace.ts"

// why a version is there: the layer that put it there, where it put it, and that layer's reason
// (GRAPH.tex, Object). place and why: the layer's, never read here
export type Because<P = unknown, W = unknown> = {
	layer: string
	place: P
	why?: W
	site?: Site
}

export type Options = {
	// capture the call's site as site
	outside?: boolean
}

// where the engine cannot cut at createBecause, these frames are passed over
const ours: ReadonlySet<string> = new Set([
	import.meta.url,
	new URL("./stacktrace.ts", import.meta.url).href,
])

// a new object; why not given: left out; nothing checked: checks are a layer above's
export default function createBecause<P, W>(
	layer: string,
	place: P,
	why?: W,
	options: Options = {},
): Because<P, W> {
	const b: Because<P, W> = { layer, place }
	if (why !== undefined) b.why = why
	if (options.outside) {
		const site = capture(ours, createBecause)
		if (site) b.site = site
	}
	return b
}
