// A header's frame on the line protocol: the list of its infos, innermost first, as plain JSON.
import type { Frame, Info, Location } from "@ermine/changeable"

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

export function fromList(list: unknown): Frame | undefined {
	if (!Array.isArray(list) || list.length === 0 || !list.every(isMap)) return undefined
	let frame: Frame | undefined
	for (let i = list.length - 1; i >= 0; i--) frame = { info: list[i] as Info, parent: frame }
	return frame
}

export function toList(frame: Frame | undefined): Info[] {
	const out: Info[] = []
	for (let f = frame; f !== undefined; f = f.parent) out.push(f.info)
	return out
}

export type Classify = (locations: readonly Location[]) => string

export function show(frame: Frame | undefined, classify: Classify = () => "program") {
	return toList(frame).map((info) => {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(info)) {
			out[k] = k === "locations" && Array.isArray(v) ? [classify(v as Location[])] : v
		}
		return out
	})
}
