// a header's frame in the line protocol: the list of its frames' infos, innermost first, plain JSON
// ([info, info, ...]); a frame with no parent ends it. what a harness reads is made into frames,
// what it answers is the list again
import type { Frame, Info, Location } from "@ermine/changeable"

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

// a list of infos as a frame, the first innermost; not a list of maps, or empty: undefined
export function fromList(list: unknown): Frame | undefined {
	if (!Array.isArray(list) || list.length === 0 || !list.every(isMap)) return undefined
	let frame: Frame | undefined
	for (let i = list.length - 1; i >= 0; i--) frame = { info: list[i] as Info, parent: frame }
	return frame
}

// a frame as its list of infos, innermost first, as they are
export function toList(frame: Frame | undefined): Info[] {
	const out: Info[] = []
	for (let f = frame; f !== undefined; f = f.parent) out.push(f.info)
	return out
}

// the locations of an info as a harness shows them: one string, the nearest one the harness cares
// about, named (classify; "program" when it does not say), so what is shown does not depend on how
// deep the stack is or on a file's path
export type Classify = (locations: readonly Location[]) => string

// a frame as the harness shows it: its infos, innermost first, each key as it is but locations
export function show(frame: Frame | undefined, classify: Classify = () => "program") {
	return toList(frame).map((info) => {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(info)) {
			out[k] = k === "locations" && Array.isArray(v) ? [classify(v as Location[])] : v
		}
		return out
	})
}
