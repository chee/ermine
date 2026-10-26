// a design's handle carries the real node under NODE; anything the real api takes as a target
// is unwrapped on the way in
import type { NodeData as Node } from "@ermine/ermine"

export const NODE = Symbol("node")

export const unwrap = (x: unknown): unknown =>
	(typeof x === "object" || typeof x === "function") && x !== null && NODE in x
		? (x as { [NODE]: Node })[NODE]
		: x

// a change that replaces the whole value
export const whole = (v: unknown) => [{ path: [], value: v }]
