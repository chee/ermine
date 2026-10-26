// a node handle: opaque, given only by the words (open, create, make, ref, info, a memo's, an
// effect's or a method's node) or minted from what the host and features know (ermine.handleOf,
// FeatureAPI.handleOf). its data is in its ermine's WeakMap, so an object of the same shape isn't
// one, and one from another ermine is no handle here. bound to the context that made it: a word
// used on it resolves it and asks as that context, so one passed to an action still means its
// maker's node, and what the action does through it is asked as the maker; a string an action
// resolves itself is the action's own [chee 10-25: "this is actually quite beautiful"]. not data:
// it won't serialize (toJSON and turning it into a value throw)
import type { Inner, NodeData } from "./context.ts"
import { ErmineError } from "./features.ts"

const notData = () =>
	new ErmineError("not-a-value", "a node handle is not data: read its value (read(node))")

export class Handle {
	toJSON(): never {
		throw notData()
	}
	[Symbol.toPrimitive](): never {
		throw notData()
	}
	[Symbol.for("Deno.customInspect")](): string {
		return "[node]"
	}
}

// a handle's data: where it reaches, and the context that made it
export type HandleData = { readonly node: NodeData; readonly maker: Inner }
export type Handles = WeakMap<Handle, HandleData>

// a new handle for node, made by maker
export function mint(handles: Handles, node: NodeData, maker: Inner): Handle {
	const h = Object.freeze(new Handle())
	handles.set(h, { node, maker })
	return h
}

export const isHandle = (x: unknown): x is Handle => x instanceof Handle

// what a handle reaches; not one of this ermine's: not-a-handle
export function dataOf(handles: Handles, x: unknown): HandleData {
	const d = isHandle(x) ? handles.get(x) : undefined
	if (d === undefined) {
		throw new ErmineError(
			"not-a-handle",
			"a node is given by the words (open, make, a memo …) or a path, never written as an object",
		)
	}
	return d
}
