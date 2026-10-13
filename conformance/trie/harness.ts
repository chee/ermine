// The reference trie (core/places/typescript/trie.ts) on the line protocol: one JSON request per
// line in, one answer per line out, in order. State lasts for the process: one trie, and entries
// held by name, so identity and operations from an entry are testable. Another implementation
// joins by speaking this (TRIE_HARNESS).
//
// handle: a string naming an entry. "root" is the root's, from the start. A request binds a
// handle with "as" (binding it again replaces it). Names in paths are any strings.
//
// DEAD HANDLES. Once an entry is dropped or pruned, its handle is dead, and so is every handle to
// an entry under it. The C trie frees what it drops, so a dead handle is all the suites rely on:
// the harness answers any op naming one with { error: "dead" } and never gives it to the trie.
// (A detached handle staying walkable is the TypeScript trie's own, tested in trie_test.ts.)
// The root is never dead: dropping it empties it.
//
// { op: "make", path, from?, as? }   → { name }        the entry at path from "from" (default the
//                                                      root), made where missing; its name
// { op: "at", path, from?, as? }     → { name }        the same, none made
//                                    → {}              nothing there
// { op: "path", entry }              → { path }        the names from the root to the entry
// { op: "parent", entry, as? }       → { name }        the parent's name
//                                    → {}              the root has none
// { op: "get", entry }               → { value }       the entry's value, a string
//                                    → {}              none
// { op: "set", entry, value? }       → {}              value a string; absent or null: none
// { op: "each", entry, stop? }       → { paths, stopped }  every entry under the entry and itself,
//                                                      first, depth first, kids in the order made;
//                                                      paths: [path]. stop n: the walk ends at the
//                                                      nth entry, stopped true
// { op: "drop", entry }              → {}              the entry and all under it, out
// { op: "prune", entry }             → {}              it if empty, then each empty parent
// { op: "size" }                     → { size }        the entries reachable from the root
// { op: "same", a, b }               → { same }        the handles name one entry
//
// Errors: { error: "no-entry" } a handle never bound, { error: "dead" } a dead one; anything not
// understood: { error: why }, not a code.
import { createTrie } from "@ermine/places/trie"
import type { Entry } from "@ermine/places/trie"

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
type E = Entry<string>

const trie = createTrie<string>()
// an entry by handle; null: dead
const handles = new Map<string, E | null>([["root", trie.root]])

class Failure extends Error {}

function entry(r: Request, field = "entry"): E {
	const h = r[field]
	if (typeof h !== "string") throw new Error(`${field}: not a handle`)
	const e = handles.get(h)
	if (e === undefined) throw new Failure("no-entry")
	if (e === null) throw new Failure("dead")
	return e
}
function path(r: Request): string[] {
	const p = r.path
	if (!Array.isArray(p) || !p.every((n) => typeof n === "string")) {
		throw new Error("path: not a list of strings")
	}
	return p
}
function bind(r: Request, e: E) {
	if (r.as === undefined) return
	if (typeof r.as !== "string") throw new Error("as: not a name")
	handles.set(r.as, e)
}
// after a drop or prune: what is no longer reached is dead
function bury() {
	const live = new Set<E>()
	trie.each(trie.root, (e) => void live.add(e))
	for (const [h, e] of handles) if (e !== null && !live.has(e)) handles.set(h, null)
}

function answer(r: Request): unknown {
	if (r === null || typeof r !== "object") throw new Error("not an object")
	switch (r.op) {
		case "make": {
			const p = path(r)
			const from = r.from === undefined ? undefined : entry(r, "from")
			const e = trie.make(p, from)
			bind(r, e)
			return { name: e.name }
		}
		case "at": {
			const p = path(r)
			const from = r.from === undefined ? undefined : entry(r, "from")
			const e = trie.at(p, from)
			if (e === undefined) return {}
			bind(r, e)
			return { name: e.name }
		}
		case "path":
			return { path: trie.path(entry(r)) }
		case "parent": {
			const parent = entry(r).parent
			if (parent === null) return {}
			bind(r, parent)
			return { name: parent.name }
		}
		case "get": {
			const v = entry(r).value
			return v === undefined ? {} : { value: v }
		}
		case "set": {
			const e = entry(r)
			if (r.value !== undefined && r.value !== null && typeof r.value !== "string") {
				throw new Error("value: not a string")
			}
			e.value = r.value ?? undefined
			return {}
		}
		case "each": {
			const e = entry(r)
			const stop = r.stop
			if (stop !== undefined && !Number.isInteger(stop)) throw new Error("stop: not a number")
			const paths: string[][] = []
			const stopped = trie.each(e, (x) => {
				paths.push(trie.path(x))
				return paths.length === stop
			})
			return { paths, stopped }
		}
		case "drop":
			trie.drop(entry(r))
			bury()
			return {}
		case "prune":
			trie.prune(entry(r))
			bury()
			return {}
		case "size":
			return { size: trie.size() }
		case "same":
			return { same: entry(r, "a") === entry(r, "b") }
	}
	throw new Error(`unknown op ${r.op}`)
}

function safe(line: string): string {
	try {
		return JSON.stringify(answer(JSON.parse(line)))
	} catch (e) {
		if (e instanceof Failure) return JSON.stringify({ error: e.message })
		return JSON.stringify({ error: String(e) })
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += safe(l) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
