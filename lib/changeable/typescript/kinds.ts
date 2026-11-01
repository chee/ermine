// The kinds of value a patch walks into, with one shared test for each.
//
// A map is a plain object whose prototype is Object.prototype or null. A JavaScript Map, a Date,
// a class instance, a list or a typed array is not a map.
export function isPojo(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}

// A typed array is bytes (a Uint8Array) or any other typed array: a patch splices either by range.
export type Typed = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
export const isTyped = (v: unknown): v is Typed => ArrayBuffer.isView(v) && !(v instanceof DataView)
