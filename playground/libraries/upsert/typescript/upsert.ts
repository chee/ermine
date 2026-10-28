// an upsert: a value made or patched at a path inside a part's entry, written through a table's
// get and add. it gives back the entries it changed, for places' commit
//   - no entry under (part, id): one made holding the nested value (createEntry, table.add); the
//     table event tells readers, so nothing is given back to commit
//   - an entry: one patch at the path. levels missing on the way are made by putting the nested
//     remainder at the first missing level (a level that is no map is put over)
//   - the same value already there (deeply equal): nothing is written
// write: what changes the entry (default node's update; places' unread.update to change it in place)
// a path is names (strings); the levels it makes are maps
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Patch } from "@ermine/core/changeable/apply"
import type { Id, Key, Table } from "@ermine/core/table"
import { isPojo } from "@ermine/core/util/kinds"

// deeply equal: maps by their keys (in any order), lists, typed arrays by their bytes
function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
	}
	if (ArrayBuffer.isView(a)) {
		return ArrayBuffer.isView(b) && a.constructor === b.constructor &&
			a.byteLength === b.byteLength &&
			new Uint8Array(a.buffer, a.byteOffset, a.byteLength).every((x, i) =>
				x === new Uint8Array(b.buffer, b.byteOffset, b.byteLength)[i]
			)
	}
	if (isPojo(a)) {
		if (!isPojo(b)) return false
		const k = Object.keys(a)
		return k.length === Object.keys(b).length &&
			k.every((x) => Object.hasOwn(b, x) && equal(a[x], b[x]))
	}
	return false
}

// the value nested under names: {a: {b: value}}
const nest = (names: readonly string[], value: unknown): unknown =>
	names.reduceRight<unknown>((v, k) => ({ [k]: v }), value)

// the patches that make value be at path in the entry's value; none: it is already
function patches(there: unknown, path: readonly string[], value: unknown): Patch[] {
	let v = there
	for (let i = 0; i < path.length; i++) {
		if (!isPojo(v)) {
			// nothing, or no map: the nested remainder put over it
			return [{ path: path.slice(0, i), value: nest(path.slice(i), value) }]
		}
		if (!Object.hasOwn(v, path[i])) {
			return [{ path: path.slice(0, i + 1), value: nest(path.slice(i + 1), value) }]
		}
		v = v[path[i]]
	}
	return equal(v, value) ? [] : [{ path: [...path], value }]
}

export function upsert(
	table: Pick<Table, "get" | "add">,
	part: Key,
	id: Id,
	path: readonly string[],
	value: unknown,
	header: ChangeHeader,
	write: typeof update = update,
): Entry<unknown>[] {
	const there = table.get(part, id) as Entry<unknown> | undefined
	if (there === undefined) {
		table.add(part, id, createEntry<unknown>(nest(path, value), header) as never)
		return []
	}
	const ps = patches(there.value, path, value)
	if (ps.length === 0) return []
	write(there, ps, header)
	return [there]
}
