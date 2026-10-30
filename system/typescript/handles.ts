// A node handle: opaque, given only by @ermine/system's functions or minted by the host and
// features. Its data lives in its ermine's WeakMap, so lookalike objects and handles from another
// ermine are not handles here. It names a place (a path from the root, or a node by id) and gives
// no power: whoever uses it is resolved and asked as themselves. It is not data and will not
// serialize.
import type { NodeData } from "./context.ts"
import { ErmineError } from "./features.ts"
import { unfound } from "./registry.ts"

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

export type HandleData = { readonly node: NodeData }
export type Handles = WeakMap<Handle, HandleData>

export function mint(handles: Handles, node: NodeData): Handle {
	const h = Object.freeze(new Handle())
	handles.set(h, { node })
	return h
}

export const isHandle = (x: unknown): x is Handle => x instanceof Handle

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
