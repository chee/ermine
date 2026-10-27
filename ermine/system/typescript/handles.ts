// a node handle: opaque, given only by @ermine/system's functions (getNode, ensureNode, createNode,
// ref, readChildren, readEntries, a memo's, an effect's or an action's node) or minted from what the
// host and features know (ermine.handleOf, FeatureAPI.handleOf). its data is in its ermine's WeakMap,
// so an object of the same shape isn't one, and one from another ermine is no handle here. it names
// a place, its path from the ermine's root (or a node by id), and nothing else: whoever uses it is
// resolved and asked as themselves. a builder's pick (decision-1.3), after chee 10-26: "take the
// maker out now", and her question "maybe it should be an absolute path? nothing can read it,
// right?". with the maker out, a handle holds no power, so "handles are capabilities" (a 10-25
// draft) no longer holds. not data: it won't serialize (toJSON and turning it into a value throw)
import type { NodeData } from "./context.ts"
import { ErmineError } from "./features.ts"
import { unfound } from "./registry.ts"

// thrown by the handle itself (JSON, a string), in no function: through the onError hooks of the
// first ermine open with any
const notData = () => {
	const e = new ErmineError(
		"not-a-value",
		"a node handle is not data: read its value (read(node))",
	)
	return unfound(e)
}

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

// a handle's data: where it reaches, its path from the ermine's root (or an id), and its part. no
// maker [chee 10-26: "take the maker out now"; "maybe it should be an absolute path?"]: a handle is
// a name, not power; whoever uses it is resolved and asked as themselves
export type HandleData = { readonly node: NodeData }
export type Handles = WeakMap<Handle, HandleData>

// a new handle for node
export function mint(handles: Handles, node: NodeData): Handle {
	const h = Object.freeze(new Handle())
	handles.set(h, { node })
	return h
}

export const isHandle = (x: unknown): x is Handle => x instanceof Handle

// what a handle reaches; not one of this ermine's: not-a-handle
export function dataOf(handles: Handles, x: unknown): HandleData {
	const d = isHandle(x) ? handles.get(x) : undefined
	if (d === undefined) {
		throw new ErmineError(
			"not-a-handle",
			"a node is given by @ermine/system's functions (getNode, ensureNode, createMemo …) or a path, never written as an object",
		)
	}
	return d
}
