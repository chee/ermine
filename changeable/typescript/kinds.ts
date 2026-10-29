// the kinds of value a patch walks into, one test for each, shared by core's libraries and the
// ones above them, so every library means the same thing by each
//
// a map: a plain object (a POJO), its prototype Object.prototype or none, as cbor.ts decodes a
// CBOR map. JavaScript's Map, a Date, a class instance, a list or a typed array: not a map
export function isPojo(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}

// a typed array: a sequence of its elements. bytes, a Uint8Array, are one whole value: never
// spliced (MUTATE.tex)
export type Typed = Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
export const isTyped = (v: unknown): v is Typed =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)
