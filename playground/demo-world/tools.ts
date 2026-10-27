// the world's tools, imported by a program as it imports @ermine/system's functions: what hosts each
// wrote by hand, the process functions having no name for it. each is called while a setup, memo,
// effect or action runs (the scope open says which process); none gives an object. none lets a
// program set an actor, make a scope or re-enter one later: what @ermine/system doesn't give a
// program, these don't either [chee 10-26: "let's take them away, and see how those examples would
// be ported if those APIs never existed"]
//
//   import { createAction, ensureNode } from "@ermine/system"
//   import { who } from "@ermine/slaygrounds/tools"
//   createAction("on/hello", () => who().caller)
//
// the world (world.ts) hands them what they need, once, through use(); one world to a page
//   who()                who the call open now is: caller (a process's name where the world made
//                        it, else its node; the host: "host"; none: ""), "trusted-event" (a
//                        person's event is being dispatched now: read live, so a timer's is not),
//                        actor, metadata (an object). who(change): who wrote that change (a
//                        header: its caller and actor, and "trusted-event" when its scope said);
//                        none: nobody
//   change(x)            x's latest change (its header), tracked: a write to x reruns what read it
//   up(address, from?, { stop?, walk? }?)   the nearest place walking up from `from` (names from
//                        the root; none: the process's place) where address is: its node (by its
//                        path), the id found there and the place it was found in (parent), tracked.
//                        stop: the depth it ends at (1 leaves the root out); walk: the ids of the
//                        places visited pushed to it
//   inspect(address)     that node picked in the page's graph tab
//   host()               what the world's extend gave this process (its host's own, none: {})
import type { ChangeHeader, Metadata } from "@ermine/core/node/entry"
import { type Path, type Places } from "@ermine/core/places"
import { createChangeBase } from "@ermine/core/places/header"
import * as lib from "@ermine/core/places/lib"
import type { Info, Scheduler, Scope } from "@ermine/core/scheduler"
import { type Ermine, getNode } from "@ermine/system"

export type Who = { caller: string; "trusted-event": boolean; actor: unknown; metadata: Metadata }

// what the world gives, once
export type Core = {
	s: Scheduler
	places: Places
	ermine: Ermine
	// whether the event this window is dispatching now is a person's (read live: nothing else says
	// so, an action's call scope holding only its caller)
	trusted: () => boolean
	// a process's node → its name (where it runs)
	named: Map<unknown, string>
	// what extend gave each process, by its path joined with "/"
	extras: Map<string, Record<string, unknown>>
	// the page's: a node picked in the graph tab
	inspect: (address: readonly string[]) => void
}

let core: Core | undefined
// the world's, from here on (createWorld)
export function use(c: Core | undefined) {
	core = c
}
const need = (): Core => {
	if (core === undefined) throw new Error("no world here: createWorld has not been called")
	return core
}

// the nearest scope's key: the open scope's and every parent's info, innermost first
const nearest = (o: Scope | undefined, key: string) => {
	for (; o !== undefined; o = o.parent) if (key in o.info) return o.info[key]
	return undefined
}
// the process the scope open is in: its path (the process scope's info says it)
function at(): Path | undefined {
	const { s } = need()
	const p = nearest(s.getCurrentScope(), "process")
	return Array.isArray(p) ? p as Path : undefined
}

// a caller as the world names it: a process's node → its name, the host's node, else as it is
function callerName(c: unknown): string {
	const { named, ermine } = need()
	if (c === undefined) return ""
	const node = typeof c === "object" && c !== null && "node" in c
		? (c as { node: unknown }).node
		: c
	if (node === ermine.node) return "host"
	return named.get(node) ?? String(node)
}

export function who(...change: [] | [ChangeHeader | undefined]): Who {
	const { s } = need()
	const say = (actor: unknown, metadata: Metadata, caller: unknown, trust: unknown): Who => ({
		caller: callerName(caller),
		"trusted-event": trust === true,
		actor,
		metadata,
	})
	if (change.length) {
		const m = change[0]?.metadata ?? {}
		return say(change[0]?.actor, m, m.caller, m["trusted-event"])
	}
	// walking the open scope and every parent: a write's metadata stops at a memo's node, so a
	// caller above the memo is found only by walking on
	const o = s.getCurrentScope()
	const w = createChangeBase(s)
	return say(w?.actor, w?.metadata ?? {}, nearest(o, "caller"), need().trusted())
}

export function change(x: Parameters<typeof getNode>[0] | object): ChangeHeader | undefined {
	const { places, ermine } = need()
	const n = typeof x === "string" || Array.isArray(x) ? getNode(x as string) : x
	const d = ermine.dataOf(n)?.node
	if (d === undefined) return undefined
	const id = d.id ?? (d.path === undefined ? undefined : lib.get(places, d.path))
	return id === undefined ? undefined : places.readChange(d.part ?? "value", id)
}



export function up(
	address: readonly string[],
	from: readonly string[] = at() ?? [],
	{ stop = 0, walk }: { stop?: number; walk?: string[] } = {},
) {
	const { places } = need()
	for (let k = from.length; k >= stop; k--) {
		const here = k === 0 ? places.root : lib.get(places, from.slice(0, k))
		if (typeof here !== "string") continue
		walk?.push(here)
		const path = [...from.slice(0, k), ...address]
		const id = lib.get(places, path)
		if (typeof id === "string") return { path, part: "value", found: id, parent: here }
	}
}

export function inspect(address: readonly string[]) {
	need().inspect(address)
}


export function host<T = Record<string, unknown>>(): T {
	const { extras } = need()
	const p = at()
	return (p === undefined ? {} : extras.get(p.join("/")) ?? {}) as T
}
