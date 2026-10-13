// values in the update and node suites' JSON: typed arrays as { "$Int8Array": [1, 2] } (Uint16,
// Int16, Uint32 and Int32 too), bytes, a Uint8Array, as ENCODING.tex writes them:
// { "/": { "bytes": b64 } }. An implementation without typed arrays skips those scenarios.
import { fromJson, toJson } from "../pack/form.ts"

type Json = unknown

const kinds = {
	Int8Array,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
} as Record<string, new (a: number[]) => ArrayBufferView>

// the values the JSON stands for
export function revive(v: Json): Json {
	if (Array.isArray(v)) return v.map(revive)
	if (v !== null && typeof v === "object") {
		const keys = Object.keys(v)
		if (keys.length === 1 && keys[0].startsWith("$") && kinds[keys[0].slice(1)]) {
			return new kinds[keys[0].slice(1)]((v as Record<string, number[]>)[keys[0]])
		}
		const form = (v as Record<string, unknown>)["/"]
		if (keys.length === 1 && form !== null && typeof form === "object" && "bytes" in form) {
			return fromJson(v)
		}
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))
	}
	return v
}

// and back
export function dehydrate(v: Json): Json {
	if (Array.isArray(v)) return v.map(dehydrate)
	if (v instanceof Uint8Array) return toJson(v)
	if (ArrayBuffer.isView(v)) return { ["$" + v.constructor.name]: [...(v as Int8Array)] }
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dehydrate(x)]))
	}
	return v
}
