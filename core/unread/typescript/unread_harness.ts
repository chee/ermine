// unread (unread.ts) on the line protocol: one JSON request per line in, one answer per line out,
// in order. state lasts for the process: one entry and its unread, what was held, what was
// marked. values as the form has them (conformance/typescript/form.ts). every write's change is
// { time: 1, actor: "test" }. another implementation joins by speaking this (HARNESS)
//
// { op: "start", value? }          → {}   a new entry with value (none: nothing there), a new
//    unread; what was held and marked let go
// { op: "write", patches, hold? }  → { undo }   unread's update, its op's undo; an ApplyError
//    answers { error: code, patch: index }. hold: a name for the values the patches put, as they
//    went in, in order
// { op: "unwrite", hold? }         → { undo }   the last write's undo written, its values as the
//    undo holds them; hold: a name for those, in order. none: { error: "nothing-written" }
// { op: "read", hold? }            → { value? }   the entry read (unread's read). hold: a name
//    for its value as given
// { op: "keep", path?, wrap?, handed?, scheduler?, hold? } → {}   what is at path in the entry's
//    value kept (unread's kept), not a read; wrap: in a list made for it first. handed: what is at
//    path was handed to the run (kept's handed; through a scheduler, the computation tracks a key
//    keeping's handed names it by). scheduler: kept as a computation's result, at its run's end (a
//    scheduler wired by keeping, a computation returning it, a pulse): true or "compute" a
//    compute's, given to set; "fails" a compute's whose set throws; "effect" an effect's. hold: a
//    name for what was kept
// { op: "held", name }             → { value? }   what was held under name, as it is now
// { op: "value" }                  → { value? }   the entry's value now; not a read
// { op: "mark", name, path? }      → {}   what is at path in the entry's value now, by identity;
//    not a read
// { op: "same", name, path? }      → { same }   whether what is at path now is what was marked
import createEntry, { type Entry } from "@ermine/node/entry"
import { ApplyError, type Key, type Patch } from "@ermine/op/apply"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createScheduler } from "@ermine/scheduler"
import { createUnread, keeping } from "./unread.ts"

const change = () => ({ time: 1, actor: "test" })

// what is at path, or undefined
function at(v: unknown, path: readonly Key[] = []): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
const value = (v: unknown) => v === undefined ? {} : { value: toJson(v) }

// a harness: its own entry, unread, held and marked; answer is a request's answer
export function createHarness(): (r: Request) => Record<string, unknown> {
	let unread = createUnread()
	let entry: Entry<unknown> = createEntry<unknown>(undefined, change())
	let held = new Map<string, unknown>()
	let marked = new Map<string, unknown>()

	function write(patches: readonly Patch[], hold?: string) {
		if (hold !== undefined) {
			held.set(
				hold,
				patches.filter((p) => "value" in p).map((p) => p.value),
			)
		}
		try {
			unread.update(entry, patches, change())
		} catch (e) {
			if (e instanceof ApplyError) return { error: e.code, patch: e.patch }
			throw e
		}
		return { undo: toJson(entry.change.op!.undo) }
	}

	function answer(r: Request) {
		switch (r.op) {
			case "start":
				unread = createUnread()
				entry = createEntry<unknown>(revive(r.value), change())
				held = new Map(), marked = new Map()
				return {}
			case "write":
				return write(revive(r.patches) as Patch[], r.hold)
			case "unwrite": {
				const undo = entry.change.op?.undo
				if (undo === undefined) return { error: "nothing-written" }
				return write(undo, r.hold)
			}
			case "read":
				unread.read(entry)
				if (r.hold !== undefined) held.set(r.hold, entry.value)
				return value(entry.value)
			case "keep": {
				const v = at(entry.value, r.path)
				const k = r.wrap ? [v] : v
				// the key a computation tracks, which handed names what is at path by
				const key = {}
				if (!r.scheduler) unread.kept(k, r.handed ? new Set([v]) : undefined)
				else {
					const s = createScheduler()
					const stop = keeping(
						s,
						unread,
						r.handed ? (x) => x === key ? v : undefined : undefined,
					)
					const f = () => (s.track(key), k)
					s.runWithScope(s.createRootScope([["actor", "test"]]), () => {
						if (r.scheduler === "effect") s.createEffect(f, () => {})
						else {
							s.createComputer(f, () => {
								if (r.scheduler === "fails") throw new Error("set fails")
							})
						}
					})
					s.pulse()
					stop()
				}
				if (r.hold !== undefined) held.set(r.hold, k)
				return {}
			}
			case "held":
				return value(held.get(r.name))
			case "value":
				return value(entry.value)
			case "mark":
				marked.set(r.name, at(entry.value, r.path))
				return {}
			case "same":
				return { same: marked.get(r.name) === at(entry.value, r.path) }
		}
		return { error: `unknown op ${r.op}` }
	}
	return answer
}

if (import.meta.main) await serve(createHarness())
