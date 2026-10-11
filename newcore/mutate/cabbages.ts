// a fork of cabbages 0.2.10 (chee, MIT; ~/soft/chee/cabbages), for mutate_bench.ts only
// updated to GRAPH.tex's patches: { path, range?, value? | move? }; strings in code points;
// typed arrays; moves; the whole at []. kept from cabbages: changes the target in place,
// nothing copied, nothing undone when a patch fails
import type { Key, Patch } from "../notify.ts"

type Typed = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
const typed = (v: unknown): v is Typed => ArrayBuffer.isView(v) && !(v instanceof DataView)

function unit(s: string, n: number): number {
	let i = 0
	for (let k = 0; k < n; k++) {
		const c = s.charCodeAt(i)
		i += c >= 0xd800 && c < 0xdc00 ? 2 : 1
	}
	return i
}

// the container holding path's last key
function walk(root: any, path: readonly Key[]): any {
	let t = root
	for (let i = 0; i < path.length - 1; i++) {
		t = t[path[i]]
		if (t === undefined) throw new Error(`can't go down this road ${path}`)
	}
	return t
}

const at = (root: any, path: readonly Key[]) =>
	path.length ? walk(root, path)[path[path.length - 1]] : root

// what is at path becomes w (undefined: removed); the root after it
function set(root: any, path: readonly Key[], w: any): any {
	if (!path.length) return w
	const t = walk(root, path), k = path[path.length - 1]
	if (w === undefined) Array.isArray(t) ? t.splice(k as number, 1) : delete t[k]
	else t[k] = w
	return root
}

// [a, b) of the sequence at path replaced by w (undefined: removed); the root after it,
// and what was there
function splice(root: any, path: readonly Key[], a: number, b: number, w: any) {
	const seq = at(root, path)
	if (Array.isArray(seq)) {
		const taken = w === undefined ? seq.splice(a, b - a) : seq.splice(a, b - a, ...w)
		return { root, taken }
	}
	let out: any, taken: any
	if (typeof seq === "string") {
		const x = unit(seq, a), y = unit(seq, b)
		taken = seq.slice(x, y)
		out = seq.slice(0, x) + (w ?? "") + seq.slice(y)
	} else if (typed(seq)) {
		const wn = w ? w.length : 0
		out = new (seq.constructor as any)(seq.length - (b - a) + wn)
		out.set(seq.subarray(0, a), 0)
		if (w) out.set(w, a)
		out.set(seq.subarray(b), a + wn)
		taken = seq.slice(a, b)
	} else throw new Error("not a sequence")
	return { root: set(root, path, out), taken }
}

// applies p to target in place; the root after it (new only when p acts at [])
export function apply(target: any, p: Patch): any {
	let root = target
	let w: any = p.value
	if (p.move) {
		const f = p.move
		if (f.range) ({ root, taken: w } = splice(root, f.path, f.range[0], f.range[1], undefined))
		else {
			w = at(root, f.path)
			root = set(root, f.path, undefined)
			// one element into a list's span: as a list of one
			if (p.range && Array.isArray(at(root, p.path))) w = [w]
		}
	}
	if (p.range) return splice(root, p.path, p.range[0], p.range[1], w).root
	return set(root, p.path, w)
}

export const patch = apply
