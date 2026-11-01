// A plain second implementation of apply on maps, lists and strings, for the squish fuzzer to
// check against.
import type { Key, Patch, Target as Place } from "@ermine/changeable/apply"

export type V = unknown

export function at(v: V, keys: readonly Key[]): V {
	for (const k of keys) {
		if (v === null || typeof v !== "object") return undefined
		v = (v as Record<Key, V>)[k]
	}
	return v
}
function edit(v: V, keys: readonly Key[], f: (v: V) => V): V {
	if (keys.length === 0) return f(v)
	const [k, ...more] = keys
	if (Array.isArray(v)) return v.with(k as number, edit(v[k as number], more, f))
	const o = v as Record<Key, V>
	return { ...o, [k]: edit(o[k], more, f) }
}
export function slice(seq: V, a: number, b: number): V {
	if (typeof seq === "string") return Array.from(seq).slice(a, b).join("")
	return (seq as V[]).slice(a, b)
}
function splice(seq: V, a: number, b: number, put: V): V {
	if (typeof seq === "string") {
		const cs = Array.from(seq)
		cs.splice(a, b - a, ...Array.from(put as string))
		return cs.join("")
	}
	return (seq as V[]).toSpliced(a, b - a, ...(put as V[]))
}
function remove(v: V, p: Place): V {
	if (p.range) {
		return edit(
			v,
			p.path,
			(s) => splice(s, p.range![0], p.range![1], typeof s === "string" ? "" : []),
		)
	}
	if (p.path.length === 0) return undefined
	const k = p.path[p.path.length - 1]
	return edit(v, p.path.slice(0, -1), (o) => {
		if (Array.isArray(o)) return o.toSpliced(k as number, 1)
		const { [k]: _, ...rest } = o as Record<Key, V>
		return rest
	})
}
function put(v: V, p: Place, what: V, one: boolean): V {
	if (p.range) {
		return edit(
			v,
			p.path,
			(s) => splice(s, p.range![0], p.range![1], one && Array.isArray(s) ? [what] : what),
		)
	}
	return edit(v, p.path, () => what)
}
export function apply(v: V, p: Patch): V {
	if (p.move) {
		const m = p.move
		const what = m.range ? slice(at(v, m.path), m.range[0], m.range[1]) : at(v, m.path)
		return put(remove(v, m), p, what, !m.range)
	}
	if ("value" in p) return put(v, p, p.value, false)
	return remove(v, p)
}
