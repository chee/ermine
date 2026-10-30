// Crow (crow.ts) on the line protocol: one JSON request per line in, one answer per line out,
// in order. State lasts for the process: one root and its crow, what was held, what was marked.
// Values are as in conformance/typescript/form.ts. Only crow's own api, with no scheduler or
// graph (places/typescript/crowify_harness.ts adds those).
//
// { op: "start", value? }  → {}  a new root with value (absent: nothing there) and a new crow;
//   what was held and marked is let go. The value is owned by no one, so the first write copies it.
// { op: "write", patches, hold?, marked? }  → { undo }  crow's update. undo is each patch's undo,
//   the last patch's first. patches [] is a write ({ undo: [] }); patches missing or not a list is
//   { error: string } and changes nothing. marked: a name at i (not null) gives patch i the value
//   marked under it, by identity (a name never marked gives nothing, a removal). An ApplyError
//   answers { error: code, patch: index } with code one of "not-a-patch", "no-key",
//   "wrong-kind", "range", "into-itself", and index counted from 0 in the whole write. A refused
//   write changes nothing: the root is the same and its undo is the last landed write's.
//   hold: a name for the values the patches put (each that has a value), in order, held whether
//   or not the write lands.
// { op: "unwrite", hold? }  → { undo }  writes the last landed write's undo (twice writes the first
//   again). hold: a name for its values, in order. Nothing landed since start:
//   { error: "nothing-written" }
// { op: "read", hold? }  → { value? }  the root read. hold: a name for its value as given.
// { op: "keep", path?, wrap?, handed?, hold? }  → {}  crow's letGoIn on what is at path in the
//   root's value; not a read. wrap: put it in a list made for it first (nothing there: [null]).
//   handed: what is at path was handed to the run (letGoIn's subtrees); no answer tells handed
//   from not, so an implementation may ignore it. hold: a name for what was let go. What was
//   let go, held, or given back in an undo never changes after.
// { op: "held", name }  → { value? }  what was held under name, as it is now; {} if never held
// { op: "value" }  → { value? }  the root's value now; not a read
// { op: "mark", name, path? }  → {}  what is at path in the root's value now, by identity
// { op: "same", name, path? }  → { same }  whether what is at path now is what was marked, as
//   === has it: a container by identity, a number, string, boolean or null by content; nothing
//   there equals nothing there, and a name never marked stands for nothing
// Anything else is { error: string } ("unknown op <op>") and the harness goes on.
//
// path: keys from the root, [] or absent for the whole value; a string into a map, a whole
// number into a list; anything else, or a key not there, is nothing there. A name given again
// (hold, mark) is replaced. A map's key order is not part of its value (answers compare by content).
import { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"
import { revive, toJson } from "../../conformance/typescript/form.ts"
import { type Request, serve } from "../../conformance/typescript/harness.ts"
import { createCrow } from "./crow.ts"
import { createRoot, type Root, write as writeRoot } from "./root_harness.ts"

// What is at path, or undefined.
function at(v: unknown, path: readonly Key[] = []): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}
const value = (v: unknown) => v === undefined ? {} : { value: toJson(v) }

// A harness with its own root, crow, held and marked. It answers a request.
export function createHarness(): (r: Request) => Record<string, unknown> {
	let crow = createCrow()
	let root: Root = createRoot()
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
			writeRoot(crow, root, patches)
		} catch (e) {
			if (e instanceof ApplyError) return { error: e.code, patch: e.patch }
			throw e
		}
		return { undo: toJson(root.undo) }
	}

	// Patch i is given what was marked under marked[i].
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
				root = createRoot(revive(r.value))
				held = new Map(), marked = new Map()
				return {}
			case "write":
				if (!Array.isArray(r.patches)) throw new Error("write: patches is not a list")
				return write(given(revive(r.patches) as Patch[], r.marked), r.hold)
			case "unwrite": {
				const undo = root.undo
				if (undo === undefined) return { error: "nothing-written" }
				return write(undo, r.hold)
			}
			case "read":
				crow.letGo(root)
				if (r.hold !== undefined) held.set(r.hold, root.value)
				return value(root.value)
			case "keep": {
				const v = at(root.value, r.path)
				const k = r.wrap ? [v] : v
				crow.letGoIn(k, r.handed ? new Set([v]) : undefined)
				if (r.hold !== undefined) held.set(r.hold, k)
				return {}
			}
			case "held":
				return value(held.get(r.name))
			case "value":
				return value(root.value)
			case "mark":
				marked.set(r.name, at(root.value, r.path))
				return {}
			case "same":
				return { same: marked.get(r.name) === at(root.value, r.path) }
		}
		return { error: `unknown op ${r.op}` }
	}
	return answer
}

if (import.meta.main) await serve(createHarness())
