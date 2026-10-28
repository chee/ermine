// writes: the page's own ways to write, in a file of their own so a write's site (createChangeHeader's
// skip) is the line that called them, not these helpers
//
//   const { header, commit, put, patch } = createWrites({ scheduler, table, places, scope })
//   put("value", "sync", v)          // its site: this line, not writes.ts
//   drop("value", keys, [who])        // one key taken out
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Id, Key, Table } from "@ermine/core/table"
import type { Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/upsert"
import { encode, type Value } from "@ermine/encoding/cbor"

const ours = [import.meta.url]

// a value's encoding; none: undefined
export function bytesOf(v: unknown): Uint8Array | undefined {
	try {
		return encode(v as Value)
	} catch {
		return undefined
	}
}

const same = (a?: Uint8Array, b?: Uint8Array) =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i])

export function createWrites(o: {
	scheduler: Scheduler
	table: Table
	places: Pick<Places, "commit">
	// the host's scope: every write here is made under it
	scope: Scope
	// files of the caller's own to pass over too, so the site is whoever called them (made.ts)
	skip?: readonly string[]
}) {
	const { scheduler: s, table, places, scope } = o
	const skip = [...ours, ...o.skip ?? []]
	const hosted = <T>(f: () => T) => s.runWithScope(scope, f)
	// a write's header, from the host's scope as if open, made before the scope is opened so no
	// scheduler frame is under it: its site the first frame outside this file
	const as = { getCurrentFrame: () => scope.frame, getRun: () => s.getRun() }
	const header = () => createChangeHeader(as, undefined, skip)
	const commit = (changed: readonly Entry<unknown>[]) =>
		changed.length > 0 && places.commit(changed)
	// a whole value, written only when it is another (as its encoding)
	const put = (part: Key, id: Id, v: unknown) => {
		const was = table.get(part, id)?.value
		if (was !== undefined && same(bytesOf(was), bytesOf(v))) return
		const h = header()
		hosted(() => table.sub(part, id, createEntry(v as never, h)))
	}
	const patch = (part: Key, id: Id, path: string[], v: unknown) => {
		const h = header()
		hosted(() => commit(upsert(table, part, id, path, v, h)))
	}
	// one key of a value taken out (nothing there: nothing written)
	const drop = (part: Key, id: Id, path: string[]) => {
		const there = table.get(part, id) as Entry<unknown> | undefined
		let v: unknown = there?.value
		for (const k of path) {
			v = typeof v === "object" && v !== null && Object.hasOwn(v, k)
				? (v as Record<string, unknown>)[k]
				: undefined
		}
		if (there === undefined || v === undefined) return
		const h = header()
		hosted(() => (update(there, [{ path }], h), commit([there])))
	}
	return { header, commit, put, patch, drop }
}
