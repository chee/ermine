// offers: what can run here, as nodes. a runner, a compiler or a surface an owner puts under its
// node, its attributes what travels and its value (the live function) this session's alone; and
// what counts as a runner. which question: what is on offer here
//
// offer(by, kind, name, attributes?, live?): a node <by.id>/<kind>/<name> in the folder
// <by.id>/<kind> (made at the first offer of that kind, upserted into the owner's children), its
// attributes as given and ermine.type ermine.runner | ermine.compiler | ermine.surface over them,
// its value live (none: no value). an offer is a scope under its folder's, under its owner's: what
// runs on it runs under it, so its node going takes them, newest first.
// a stored owner's offers (an install's node): their folders and attributes stay when its scope
// goes, only the live value goes, and a later offer of the name goes over them. any other owner's
// go whole with it, the folder's name out of the owner's children too.
// a name taken (offered now; a live value there; for an owner not stored, any entry at its id):
// refused taken, nothing made. not a name: PlacesError not-a-name; an owner whose scope is gone:
// PlacesError nothing-there
// withdraw: its name out of its folder and its attributes out, then its scope torn down, what runs
// on it stopped "withdrawn". an id none offers now but its folder (<owner>/<kind>) names: out of
// the folder (every name pointing at it), its attributes out. its owner going takes it with the rest of
// its scope, what runs on it stopped "runner-stopped"
// a runner (a runner node's value): { start(code, start) → handle, load?(code, start) → live,
// api?(start) → api }, or a function, its start (its own load and api too, if it has them)
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { NODE } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Scope } from "@ermine/core/scheduler"
import { ATTRIBUTE, bad, type Ctx, isMap, type Offer, ours, type Place, TYPE } from "./common.ts"
import { REASONS, type Runner } from "./run.ts"

ours.add(import.meta.url)

// the attributes of an offer, as nodes carry them. takes and gives are programs' names for now
// (@ermine/programs' ATTRIBUTES), one set for both: a runner's and a compiler's takes, the UTIs it
// takes (a list; one string: a list of one), a type fitting when it conforms to one; a compiler's
// gives, the UTI it gives. each name said here once
export const TAKES = "ermine.programs.takes"
export const API = "ermine.runner.api"
export const WHERE = "ermine.runner.where"
export const COMPILER_TAKES = "ermine.programs.takes"
export const GIVES = "ermine.programs.gives"
export const KIND = "ermine.surface.kind"
export const SIZE = "ermine.surface.size"

export type Kind = "runners" | "compilers" | "surfaces"
const KINDS: readonly Kind[] = ["runners", "compilers", "surfaces"]

export type Offered = {
	readonly id: Id
	readonly at: Path
	readonly kind: Kind
	readonly name: string
	// the owner's node id
	readonly by: Id
}

// a takes as a list of its strings: a string, a list of one; anything else, none
export const takesOf = (v: unknown): string[] =>
	typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : []

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

	// a stored node's live value just written: it goes at the scope's teardown (if it is still the
	// one there); the node's other parts stay
	function liveUntil(scope: Scope, id: Id) {
		const written = table.get("value", id)
		if (written === undefined) return
		s.registerTeardown(scope, () => {
			if (table.get("value", id) === written) table.del("value", id)
		})
	}

	function offer(
		by: Place,
		kind: Kind,
		name: string,
		attributes: Readonly<Record<string, unknown>> = {},
		live?: unknown,
	): Offered | { readonly refused: "taken"; readonly at: Path } {
		if (!KINDS.includes(kind)) throw new TypeError(`not a kind of offer: ${String(kind)}`)
		if (bad(name)) throw new PlacesError("not-a-name", String(name))
		const o = c.ownerOf(by)
		const stored = o.stored === true
		const id: Id = `${String(o.id)}/${kind}/${name}`
		const at = [...o.at, kind, name]
		const there = stored ? table.get("value", id) !== undefined : table.get(id).length > 0
		if (c.offers.has(id) || there) return { refused: "taken", at }
		let folder = o.folders.get(kind)
		if (folder === undefined) {
			const fid: Id = `${String(o.id)}/${kind}`
			const scope = createScope({ offers: kind, [NODE]: fid }, o.under)
			if (!stored) {
				scopes.give(scope, fid)
				// its name out of the owner's children as it goes (a process's whole node goes anyway;
				// a place's stays). the host's scope going: everything goes, nothing to tidy
				s.registerTeardown(scope, () => {
					const there = table.get("children", o.id) as Entry<unknown> | undefined
					if (there === undefined || !isMap(there.value) || there.value[kind] !== fid) return
					if (c.scope.state !== "alive") return
					s.runWithScope(c.scope, () => {
						update(there, [{ path: [kind] }], headerOf())
						commit([there])
					})
				})
			}
			folder = { id: fid, scope }
			o.folders.set(kind, folder)
			s.runWithScope(
				scope,
				() => commit(upsert(table, "children", o.id, [kind], fid, headerOf())),
			)
		}
		const scope = createScope({ offer: name, [NODE]: id }, folder.scope)
		if (!stored) scopes.give(scope, id)
		const made: Offer = { id, at, kind, name, by: o.id, owner: o, scope, gone: false }
		c.offers.set(id, made)
		o.offers.push(made)
		s.registerTeardown(scope, () => gone(made))
		const fid = folder.id
		s.runWithScope(scope, () => {
			const attrs: Record<string, unknown> = { ...attributes, [ATTRIBUTE]: TYPE[kind] }
			table.sub("attributes", id, createEntry(attrs, headerOf()))
			if (live !== undefined) table.add("value", id, createEntry<unknown>(live, headerOf()))
			if (stored) liveUntil(scope, id)
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

	function withdraw(x: Offered | Id) {
		const id = typeof x === "object" ? x.id : x
		const o = c.offers.get(id)
		if (o === undefined || o.gone) return unlist(id)
		o.why = REASONS.withdrawn
		const folder = o.owner.folders.get(o.kind)
		try {
			s.runWithScope(o.scope, () => {
				const there = folder && table.get("children", folder.id) as Entry<unknown> | undefined
				if (there !== undefined && isMap(there.value) && Object.hasOwn(there.value, o.name)) {
					update(there, [{ path: [o.name] }], headerOf())
					commit([there])
				}
				if (table.get("attributes", o.id) !== undefined) table.del("attributes", o.id)
			})
		} finally {
			s.teardown(o.scope)
		}
	}

	// a name a stored owner's folder holds, offered by none now: every name pointing at it out of
	// the folder, its attributes out. the folder is <owner>/<kind>, the id's own
	function unlist(id: Id) {
		const kind = KINDS.find((k) => String(id).includes(`/${k}/`))
		if (kind === undefined) return
		const fid: Id = String(id).slice(0, String(id).lastIndexOf("/"))
		const there = table.get("children", fid) as Entry<unknown> | undefined
		const names = there?.value
		if (there === undefined || !isMap(names)) return
		const gone = Object.keys(names).filter((k) => names[k] === id)
		if (gone.length === 0) return
		update(there, gone.map((name) => ({ path: [name] })), headerOf())
		commit([there])
		if (table.get("attributes", id) !== undefined) table.del("attributes", id)
		changed()
	}

	return { offer, withdraw }
}
