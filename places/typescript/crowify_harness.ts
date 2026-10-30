// crow through crowify on the line protocol. Every write's change is { time: 1, actor: "test" }.
// { op: "start", value? }       → {}        new entry (none: nothing there) and crow; clears held and marked
// { op: "write", patches, hold?, marked? } → { undo }   crow's update; hold names the values put in
//    patch i gets what was marked under marked[i] (never marked: a removal); an op error answers
//    { error: code, patch: index }
// { op: "unwrite", hold? }      → { undo }  writes the last undo; nothing yet: { error: "nothing-written" }
// { op: "read", hold? }         → { value? } crow's read; hold names the value as given
// { op: "keep", path?, wrap?, handed?, scheduler?, hold?, writes?, by? } → {}
//    keeps what is at path (wrap: in a new list first); scheduler: true | "compute" | "fails" |
//    "effect" keeps it as a computation's result; writes are applied by the set, or by the run
//    when by is "run". Nothing kept ever changes afterwards. handed and scheduler may be ignored.
// { op: "held", name }          → { value? } what was held under name now; unknown: {}
// { op: "value" }               → { value? } the entry's value now; not a read
// { op: "mark", name, path? }   → {}        marks what is at path now, by identity
// { op: "same", name, path? }   → { same }  whether it is still what was marked, as === has it
// anything else: { error: "unknown op <op>" }, and the harness goes on
//
// path: keys from the root ([] or none: the whole value).
import createEntry, { type Entry } from "@ermine/graph/entry"
import { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { createScheduler } from "@ermine/reactivity"
import { createCrow } from "@ermine/crow"
import { crowify, updateEntry } from "./crowify.ts"

const change = () => ({ time: 1, actor: "test", frame: { info: {}, parent: undefined } })

function at(v: unknown, path: readonly Key[] = []): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
const value = (v: unknown) => v === undefined ? {} : { value: toJson(v) }

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
				const key = {}
				if (!r.scheduler) crow.letGoIn(k, r.handed ? new Set([v]) : undefined)
				else {
					const s = createScheduler()
					const stop = crowify(
						s,
						crow,
						r.handed ? (x) => x === key ? v : undefined : undefined,
					)
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
