// offers: what a den can run, as nodes. a runner, a compiler or a surface a den (or a process it
// runs) puts under its node, its attributes what travels and its value (the live function) the den's
// alone; and what counts as a runner. which question: what is on offer here
//
// offer(kind, name, attributes?, live?, by?): a node <owner id>/<kind>/<name> in the folder
// <owner id>/<kind> (made at the first offer of that kind, upserted into the owner's children:
// by, a process of this den's; none: the den), its attributes as given and ermine.type
// ermine.runner | ermine.compiler | ermine.surface over them, its value live (none: no value).
// a name taken (offered, or entries at its id already): refused taken, nothing made; not a name:
// PlacesError not-a-name; by no running process of this den's: PlacesError nothing-there; closed:
// refused stopped.
// an offer is a scope under its folder's, under its owner's: what runs on it runs under it (start's
// under), so its node going takes them, newest first.
// withdraw: its name out of its folder, then its scope torn down, its users stopped "withdrawn". its
// owner's stop takes it with the rest of the owner's scope, its users stopped "runner-stopped"
// a runner (a runner node's value): { start(code, start) → handle, load?(code, start) → live,
// api?(start) → api }, or a function, its start (its own load and api too, if it has them: a
// function is shorthand for { start })
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { type Id, type Path, PlacesError } from "@ermine/places"
import type { Process } from "@ermine/processes/start"
import { NODE } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import {
	ATTRIBUTE,
	bad,
	type Ctx,
	isMap,
	type Offer,
	ours,
	REASONS,
	STOPPED,
	TYPE,
} from "./common.ts"
import type { Runner, Stopped, Taken } from "./start.ts"

ours.add(import.meta.url)

// the attributes of an offer, as nodes carry them
export const TAKES = "ermine.runner.takes"
export const API = "ermine.runner.api"
export const WHERE = "ermine.runner.where"
export const COMPILER_TAKES = "ermine.compiler.takes"
export const GIVES = "ermine.compiler.gives"
export const KIND = "ermine.surface.kind"
export const SIZE = "ermine.surface.size"

export type Kind = "runners" | "compilers" | "surfaces"
const KINDS: readonly Kind[] = ["runners", "compilers", "surfaces"]

export type Offered = {
	readonly id: Id
	readonly at: Path
	readonly kind: Kind
	readonly name: string
	// the owner's node id: the den's, or a process's
	readonly by: Id
}

// a runner node's value as a Runner: a map's or function's own start (load, api), else a
// function as its start; none: undefined
export function runnerOf(v: unknown): Runner | undefined {
	if (typeof v !== "function" && !isMap(v)) return undefined
	const o = v as Partial<Runner>
	const own = typeof o.start === "function"
	if (!own && typeof v !== "function") return undefined
	const start: Runner["start"] = own
		? (code, start) => o.start!(code, start)
		: (code, start) => (v as Runner["start"])(code, start)
	return {
		start,
		...(typeof o.load === "function" ? { load: (code, start) => o.load!(code, start) } : {}),
		...(typeof o.api === "function" ? { api: (start) => o.api!(start) } : {}),
	}
}

export function createOffers(c: Ctx) {
	const { s, table, scopes, createScope, commit, headerOf, changed } = c

	function offer(
		kind: Kind,
		name: string,
		attributes: Readonly<Record<string, unknown>> = {},
		live?: unknown,
		by?: Process | Id,
	): Offered | Taken | Stopped {
		if (c.closed) return STOPPED
		if (!KINDS.includes(kind)) throw new TypeError(`not a kind of offer: ${String(kind)}`)
		if (bad(name)) throw new PlacesError("not-a-name", String(name))
		const o = c.ownerOf(by)
		const id: Id = `${String(o.id)}/${kind}/${name}`
		const at = [...o.at, kind, name]
		if (c.offers.has(id) || table.get(id).length > 0) return { refused: "taken", at }
		let folder = o.folders.get(kind)
		if (folder === undefined) {
			const fid: Id = `${String(o.id)}/${kind}`
			const scope = createScope({ offers: kind, [NODE]: fid }, o.under)
			scopes.give(scope, fid)
			folder = { id: fid, scope }
			o.folders.set(kind, folder)
			s.runWithScope(
				scope,
				() => commit(upsert(table, "children", o.id, [kind], fid, headerOf())),
			)
		}
		const scope = createScope({ offer: name, [NODE]: id }, folder.scope)
		scopes.give(scope, id)
		const made: Offer = { id, at, kind, name, by: o.id, owner: o, scope, gone: false }
		c.offers.set(id, made)
		o.offers.push(made)
		s.registerTeardown(scope, () => gone(made))
		const fid = folder.id
		s.runWithScope(scope, () => {
			const attrs: Record<string, unknown> = { ...attributes, [ATTRIBUTE]: TYPE[kind] }
			table.add("attributes", id, createEntry(attrs, headerOf()))
			if (live !== undefined) table.add("value", id, createEntry<unknown>(live, headerOf()))
			commit(upsert(table, "children", fid, [name], id, headerOf()))
		})
		changed()
		return { id, at, kind, name, by: o.id }
	}

	// an offer's node going (withdrawn, or torn down from above), what ran on it gone already: it out
	// of the lists
	function gone(o: Offer) {
		if (o.gone) return
		o.gone = true
		if (c.offers.get(o.id) === o) c.offers.delete(o.id)
		const i = o.owner.offers.indexOf(o)
		if (i !== -1) o.owner.offers.splice(i, 1)
		changed()
	}

	// its name out of its folder, then its scope torn down: its users stopped "withdrawn"
	function withdraw(x: Offered | Id) {
		const o = c.offers.get(typeof x === "object" ? x.id : x)
		if (o === undefined || o.gone) return
		o.why = REASONS.withdrawn
		const folder = o.owner.folders.get(o.kind)
		try {
			s.runWithScope(o.scope, () => {
				const there = folder && table.get("children", folder.id) as Entry<unknown> | undefined
				if (there !== undefined && isMap(there.value) && Object.hasOwn(there.value, o.name)) {
					update(there, [{ path: [o.name] }], headerOf())
					commit([there])
				}
			})
		} finally {
			s.teardown(o.scope)
		}
	}

	return { offer, withdraw }
}
