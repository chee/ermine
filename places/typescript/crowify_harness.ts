// crow through crowify (crowify.ts) on the line protocol: one JSON request per line in, one answer per line out,
// in order. state lasts for the process: one entry and its crow, what was held, what was
// marked. values as the form has them (conformance/typescript/form.ts). every write's change is
// { time: 1, actor: "test" }. another implementation joins by speaking this (HARNESS)
//
// { op: "start", value? }          → {}   a new entry with value (none: nothing there), a new
//    crow; what was held and marked let go. the value is the caller's, owned by no one: the
//    first write copies it. the entry's change has no op yet
// { op: "write", patches, hold?, marked? }  → { undo }   crow's update, its op's undo (as node's
//    update gives it: each patch's undo, the last patch's first). patches: [] is a write
//    ({ undo: [] }); patches not a list (or missing): { error: string }, nothing changes.
//    marked: a list beside patches: a name at i (not null) gives patch i the value what was
//    marked under it (mark), by identity: what the entry holds, crow or not (a name never
//    marked: nothing, a removal).
//    an ApplyError answers { error: code, patch: index }: code one of "not-a-patch", "no-key",
//    "wrong-kind", "range", "into-itself" (op's apply), index the first patch that failed,
//    counted from 0 in the whole write. a refused write changes nothing: the patches before it
//    put back, the root the same one, the entry's change the last landed write's. hold: a name
//    for the values the patches put (each that has a value), as they went in, in order; held
//    whether or not the write lands
// { op: "unwrite", hold? }         → { undo }   the last landed write's undo written (a write as
//    above: unwrite twice writes the first again), its values as the undo holds them; hold: a
//    name for those, in order. nothing landed since start: { error: "nothing-written" }
// { op: "read", hold? }            → { value? }   the entry read (crow's read). hold: a name
//    for its value as given
// { op: "keep", path?, wrap?, handed?, scheduler?, hold? } → {}   what is at path in the entry's
//    value kept (crow's readValue), not a read; wrap: in a list made for it first (nothing there:
//    [null]). handed: what is at path was handed to the run (readValue's handed; through a scheduler,
//    the computation tracks a key crowify's handed names it by). scheduler: kept as a
//    computation's result, as its body returns (a scheduler wired by crowify, a computation returning
//    it, a pulse): true or "compute" a compute's, given to set; "fails" a compute's whose set
//    throws; "effect" an effect's. hold: a name for what was kept
//    unobservable here: no answer tells handed or scheduler from neither. each lets go of what
//    kept alone does (every kind of run keeps its result): an implementation may ignore both
//    and pass. what was kept (handed too), held, or given back in an undo never changes after,
//    even where a span moved out of a list landed as a new list holding owned elements.
//    writes (with scheduler): patches written to the entry (crow's update; refused: nothing
//    written) by a compute's set, before it returns or throws: what was kept never changes after,
//    those writes too. by: "run": by the computation itself (an effect's too), in its body after
//    it took what it returns: its own writes, in place where owned, so what is kept is what it
//    holds once they landed (what is at path, changed in place, shows them; one copied does not);
//    it never changes after the run returned
// { op: "held", name }             → { value? }   what was held under name, as it is now; a name
//    never held: {}
// { op: "value" }                  → { value? }   the entry's value now; not a read
// { op: "mark", name, path? }      → {}   what is at path in the entry's value now, by identity;
//    not a read
// { op: "same", name, path? }      → { same }   whether what is at path now is what was marked,
//    as === has it: a container by identity, a number, string, boolean or null by content;
//    nothing there is the same as nothing there, and a name never marked stands for nothing
// anything else: { error: string } ("unknown op <op>"), and the harness goes on
//
// path (keep, mark, same): keys from the root, [] or none the whole value; a string into a map, a
// whole number into a list; into anything else, or a key not there: nothing there. a name given
// again (hold, mark) is replaced. a map's key order is not part of its value (op's apply.ts):
// answers are compared by content
import createEntry, { type Entry } from "@ermine/graph/entry"
import { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { createScheduler } from "@ermine/reactivity"
import { createCrow } from "@ermine/crow"
import { crowify, updateEntry } from "./crowify.ts"

const change = () => ({ time: 1, actor: "test", frame: { info: {}, parent: undefined } })

// what is at path, or undefined
function at(v: unknown, path: readonly Key[] = []): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
const value = (v: unknown) => v === undefined ? {} : { value: toJson(v) }

// a harness: its own entry, crow, held and marked; answer is a request's answer
export function createHarness(): (r: Request) => Record<string, unknown> {
	let crow = createCrow()
	let entry: Entry<unknown> = createEntry<unknown>(undefined, change())
	let held = new Map<string, unknown>()
	let marked = new Map<string, unknown>()

	function write(patches: readonly Patch[], hold?: string) {
		if (hold !== undefined) {
			held.set(
				hold,
				patches.filter((p) => p !== null && typeof p === "object" && "value" in p).map((p) =>
					p.value
				),
			)
		}
		try {
			updateEntry(crow, entry, patches, change())
		} catch (e) {
			if (e instanceof ApplyError) return { error: e.code, patch: e.patch }
			throw e
		}
		return { undo: toJson(entry.change.op!.undo) }
	}

	// marked's: patch i given what was marked under marked[i]
	function given(patches: Patch[], names: unknown): Patch[] {
		if (!Array.isArray(names)) return patches
		return patches.map((p, i) => {
			const name = names[i]
			if (typeof name !== "string") return p
			const { value: _, ...rest } = p
			const v = marked.get(name)
			return v === undefined ? rest : { ...rest, value: v }
		})
	}

	function answer(r: Request) {
		switch (r.op) {
			case "start":
				crow = createCrow()
				entry = createEntry<unknown>(revive(r.value), change())
				held = new Map(), marked = new Map()
				return {}
			case "write":
				if (!Array.isArray(r.patches)) throw new Error("write: patches is not a list")
				return write(given(revive(r.patches) as Patch[], r.marked), r.hold)
			case "unwrite": {
				const undo = entry.change.op?.undo
				if (undo === undefined) return { error: "nothing-written" }
				return write(undo, r.hold)
			}
			case "read":
				crow.letGo(entry)
				if (r.hold !== undefined) held.set(r.hold, entry.value)
				return value(entry.value)
			case "keep": {
				const v = at(entry.value, r.path)
				const k = r.wrap ? [v] : v
				// the key a computation tracks, which handed names what is at path by
				const key = {}
				if (!r.scheduler) crow.letGoIn(k, r.handed ? new Set([v]) : undefined)
				else {
					const s = createScheduler()
					const stop = crowify(
						s,
						crow,
						r.handed ? (x) => x === key ? v : undefined : undefined,
					)
					// what the set (or, by "run", the run) writes; refused: nothing
					const writes = () => {
						if (!Array.isArray(r.writes)) return
						try {
							updateEntry(crow, entry, revive(r.writes) as Patch[], change())
						} catch (e) {
							if (!(e instanceof ApplyError)) throw e
						}
					}
					const f = () => (s.track(key), r.by === "run" && writes(), k)
					s.runWithScope(s.createRootScope({ actor: "test" }), () => {
						if (r.scheduler === "effect") s.createEffect(f, () => {})
						else {
							s.createComputer(f, () => {
								if (r.by !== "run") writes()
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
