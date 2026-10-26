// the wire between a page and a realm: messages in order over one port (a worker's or a
// MessagePort). values cross by structured clone; one that won't is sent again marked (enc):
//   a function as a node's whole "value" (a method): a stand-in whose calls cross; elsewhere: won't
//   PENDING, REFUSED: themselves
// still won't (a plain Error): thrown on the realm's side; on the page's, sent as bad (a read of it
// in the realm throws)
//
// the page's (seq: its count of what changed the realm's table, in order):
//   start    { code, process, root, contributors, loads, seq }   the program, where it runs; loads:
//            the root, the folders on the way to at and cwd, the process
//   loaded   { load, seq }                       an id's entries, every part (none: nothing there)
//   fact     { part, id, patches | gone | bad, change?, reset?, seq }   a change at a loaded id;
//            reset: the page's entry whole, in place of the realm's
//   call     { k, id, args, info }               a realm method called
//   sent     { k, value | error }                a realm send, landed
//   look     {}                                  what the realm has, asked (changes nothing)
// the realm's:
//   ready    { error? }                          setup ran (or threw)
//   load     { id }                              an id it reached and does not have
//   fact     { part, id, patches | gone, site?, call?, base }   a write; base: the page's seq it
//            had; call: the page's call open then
//   reset    { part, id }                        a write that won't cross: the page's entry again
//   send     { k, id, args }                     a call to a page method
//   called   { k, value | error }                a call of its method, landed
//   notice   { kind, id, path? }                 a memo, effect or method made (the page takes its
//            node out at stop)
//   error    { error }                           thrown after setup
//   looked   { tree? }                           its graph from its root: each node's state (here,
//            waiting, none), value, names. none: not started
import type { Patch } from "@ermine/core/op/apply"
import type { ChangeHeader, Metadata } from "@ermine/core/node/entry"
import { REFUSED } from "@ermine/core/places/guard"
import { type Info, PENDING } from "@ermine/core/scheduler"
import type { FileLocation } from "@ermine/core/util/stacktrace"

export type Path = readonly string[]

// what crosses for an entry: its value and change; bad: it won't cross (why)
export type Part = { part: string; value?: unknown; change?: ChangeHeader; bad?: string }
export type Load = { id: string; parts: Part[] }

export type Process = { id: string; at: Path; args: readonly string[]; cwd: Path }

export type PageMessage =
	| {
		t: "start"
		seq: number
		code: string | { url: string }
		process: Process
		root: string
		contributors: string[]
		loads: Load[]
		enc?: true
	}
	| { t: "loaded"; seq: number; load: Load; enc?: true }
	| {
		t: "fact"
		seq: number
		part: string
		id: string
		patches?: Patch[]
		gone?: true
		bad?: string
		change?: ChangeHeader
		reset?: true
		enc?: true
	}
	| { t: "call"; k: number; id: string; args: unknown[]; info: Info; enc?: true }
	| { t: "sent"; k: number; value?: unknown; error?: unknown; enc?: true }
	| { t: "look" }

export type RealmMessage =
	| { t: "ready"; error?: unknown; enc?: true }
	| { t: "load"; id: string }
	| {
		t: "fact"
		base: number
		part: string
		id: string
		patches?: Patch[]
		gone?: true
		site?: FileLocation[]
		// the realm's header's metadata: kept on the page when it ends at the process's node or one
		// the realm made (realms.ts)
		metadata?: Metadata
		call?: number
		enc?: true
	}
	| { t: "reset"; part: string; id: string }
	| { t: "send"; k: number; id: string; args: unknown[]; enc?: true }
	| { t: "called"; k: number; value?: unknown; error?: unknown; enc?: true }
	| { t: "notice"; kind: string; id: string; path?: Path }
	| { t: "error"; error: unknown; enc?: true }
	| { t: "looked"; tree?: Looked }

// a node of a realm's graph, as looked: shown, a short text of its value (a function: "ƒ")
export type Looked = {
	id: string
	name: string
	from: "children" | "process"
	state: "here" | "waiting" | "none"
	shown?: string
	kids: Looked[]
}

// a worker, a MessagePort, a window: what the wire needs of one
export type Port = {
	postMessage(message: unknown): void
	addEventListener(type: "message", f: (e: MessageEvent) => void): void
	removeEventListener(type: "message", f: (e: MessageEvent) => void): void
}

// the mark a value is put as, crossing
export const MARK = "\u0000ermine"
type Marked = { [MARK]: "method" | "pending" | "refused" | "opaque" }

const isPlain = (v: object) => {
	const proto = Object.getPrototypeOf(v)
	return proto === Object.prototype || proto === null
}

export const isCloneError = (e: unknown) => e instanceof DOMException && e.name === "DataCloneError"

// a value with its functions and ermine's symbols marked. top: the whole value of a node's "value"
// part (a function there is a method). loose: anything else that is no data marked opaque (a
// header's pairs), else it won't cross. arrays, plain objects, maps and sets are walked; anything
// else is left for structured clone to say
export function encode(
	v: unknown,
	top = false,
	loose = false,
	seen: Map<unknown, unknown> = new Map(),
): unknown {
	if (typeof v === "function") {
		if (top) return { [MARK]: "method" }
		if (loose) return { [MARK]: "opaque" }
		throw new Error("a function won't cross (only a node's whole value: a method)")
	}
	if (typeof v === "symbol") {
		if (v === PENDING) return { [MARK]: "pending" }
		if (v === REFUSED) return { [MARK]: "refused" }
		if (loose) return { [MARK]: "opaque" }
		throw new Error(`a symbol won't cross (${String(v)})`)
	}
	if (v === null || typeof v !== "object") return v
	if (seen.has(v)) return seen.get(v)
	if (Array.isArray(v)) {
		const out: unknown[] = []
		seen.set(v, out)
		for (const x of v) out.push(encode(x, false, loose, seen))
		return out
	}
	if (v instanceof Map) {
		const out = new Map()
		seen.set(v, out)
		for (const [k, x] of v) out.set(encode(k, false, loose, seen), encode(x, false, loose, seen))
		return out
	}
	if (v instanceof Set) {
		const out = new Set()
		seen.set(v, out)
		for (const x of v) out.add(encode(x, false, loose, seen))
		return out
	}
	if (!isPlain(v)) return v
	const out: Record<string, unknown> = {}
	seen.set(v, out)
	for (const k of Object.keys(v)) {
		out[k] = encode((v as Record<string, unknown>)[k], false, loose, seen)
	}
	return out
}

const isMark = (v: object): v is Marked =>
	isPlain(v) && Object.hasOwn(v, MARK) && Object.keys(v).length === 1

// a value marked as it was. method: the stand-in for a method mark (none: one that throws)
export function decode(
	v: unknown,
	method?: () => unknown,
	seen: Map<unknown, unknown> = new Map(),
): unknown {
	if (v === null || typeof v !== "object") return v
	if (seen.has(v)) return seen.get(v)
	if (isMark(v)) {
		switch (v[MARK]) {
			case "pending":
				return PENDING
			case "refused":
				return REFUSED
			case "method":
				return method?.() ?? (() => {
					throw new Error("a method only crosses as a node's whole value")
				})
			default:
				return undefined
		}
	}
	if (Array.isArray(v)) {
		const out: unknown[] = []
		seen.set(v, out)
		for (const x of v) out.push(decode(x, undefined, seen))
		return out
	}
	if (v instanceof Map) {
		const out = new Map()
		seen.set(v, out)
		for (const [k, x] of v) out.set(decode(k, undefined, seen), decode(x, undefined, seen))
		return out
	}
	if (v instanceof Set) {
		const out = new Set()
		seen.set(v, out)
		for (const x of v) out.add(decode(x, undefined, seen))
		return out
	}
	if (!isPlain(v)) return v
	const out: Record<string, unknown> = {}
	seen.set(v, out)
	for (const k of Object.keys(v)) {
		out[k] = decode((v as Record<string, unknown>)[k], undefined, seen)
	}
	return out
}

// patches marked: a function only as a node's whole value (part "value", at the root)
export const encodePatches = (part: string, patches: readonly Patch[], loose = false): Patch[] =>
	patches.map((p) =>
		p.value === undefined
			? p
			: { ...p, value: encode(p.value, part === "value" && p.path.length === 0, loose) }
	)

export const decodePatches = (
	part: string,
	patches: readonly Patch[],
	method: () => unknown,
): Patch[] =>
	patches.map((p) =>
		p.value === undefined ? p : {
			...p,
			value: decode(p.value, part === "value" && p.path.length === 0 ? method : undefined),
		}
	)

// m posted; it won't clone: posted again as marked (enc). marking fails, or it still won't: a plain
// Error saying why
export function post<M>(port: Pick<Port, "postMessage">, m: M, marked: (m: M) => M) {
	try {
		port.postMessage(m)
		return
	} catch (e) {
		if (!isCloneError(e)) throw e
	}
	let again: M
	try {
		again = { ...marked(m), enc: true }
	} catch (e) {
		throw new Error(`won't cross: ${(e as Error).message}`)
	}
	try {
		port.postMessage(again)
	} catch (e) {
		if (isCloneError(e)) throw new Error(`won't cross: ${(e as Error).message}`)
		throw e
	}
}

// the ids an entry of a part points to by name: a children map's, a process trie's leaves (places'
// children, ermine/processes' rows). what a realm can reach, and nothing else
export function pointed(part: string, v: unknown, out: string[] = []): string[] {
	if (part !== "children" && part !== "process") return out
	if (typeof v === "string") out.push(v)
	else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
		for (const x of Object.values(v)) {
			if (typeof x === "string") out.push(x)
			else if (part === "process") pointed(part, x, out)
		}
	}
	return out
}

// what patches put under names, with the names from the root: [names, id] (paths' learning). at:
// the entry's own path
export function named(
	part: string,
	at: Path,
	patches: readonly Patch[],
): [Path, string][] {
	const out: [Path, string][] = []
	const walk = (path: Path, v: unknown) => {
		if (typeof v === "string") {
			if (path.length) out.push([path, v])
		} else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			if (part === "children" && path.length > at.length) return
			for (const [k, x] of Object.entries(v)) walk([...path, k], x)
		}
	}
	if (part !== "children" && part !== "process") return out
	for (const p of patches) {
		if (p.value === undefined) continue
		if (!p.path.every((k) => typeof k === "string")) continue
		walk([...at, ...(p.path as string[])], p.value)
	}
	return out
}
