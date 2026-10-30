// places: walks names from a root through the children table and ties reads to the scheduler.
// Writes are plain functions on a children entry, announced with commit.
//
//   const places = createPlaces({ root, table, paths, scheduler, contributors: [other, children] })
//   places.commit(place(table.get("children", id)!, name, entry, createChangeHeader(scheduler)))
//
// A name is any string except "", ".", ".." and "/".
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import { createCrow, type Crow } from "@ermine/crow"
import { updateEntry } from "./crowify.ts"
import type { Key as Step, Patch } from "@ermine/changeable/apply"
import type { Scheduler } from "@ermine/reactivity"
import { createChangeHeader } from "./header.ts"
import { keyorder } from "@ermine/changeable/keyorder"
import { isPojo, isTyped } from "@ermine/changeable/kinds"
import type { createPaths, Spot } from "@ermine/reactivity/paths"
import type { Id, Key, Table } from "@ermine/graph/table"

export type { Id }

export type Paths = ReturnType<typeof createPaths<unknown>>

export type Path = readonly string[]

export type Setup = {
	root: Id
	table: Pick<Table, "get" | "who"> & Partial<Pick<Table, "del">>
	paths: Paths
	scheduler:
		& Pick<Scheduler, "track" | "mark" | "getRun">
		& Partial<Pick<Scheduler, "getCurrentFrame">>
	contributors?: readonly Contributor[]
	now?: () => number
}

export const map: unique symbol = /* @__PURE__ */ Symbol("map")

export const level: Id = /* @__PURE__ */ Symbol("level")

export const none: unique symbol = /* @__PURE__ */ Symbol("none")

export type Here = { readonly id: Id; readonly path?: Path; readonly gone?: number }

const bit = (i: number) => i < 32 ? 1 << i : 0

export type Reads = {
	read(part: Key, id: Id, path?: readonly Step[]): unknown
	keys(part: Key, id: Id, path?: readonly Step[], ids?: boolean): string[]
	here(part: Key, id: Id, path?: readonly Step[]): unknown
	track(key: unknown): void
}

export type Contributor = {
	readonly from: string
	step(here: Here, name: string, reads: Reads): Id | undefined | typeof none
	names(here: Here, reads: Reads): string[] | typeof none
	level?(here: Here, name: string, reads: Reads): boolean
}

export type Slot = { readonly folder: Id; readonly name: string }

export type Answer = { readonly id: Id; readonly from: string }

export type Named = { readonly name: string; readonly from: string }

export type Answers = Answer[] & { readonly gone: number }

export type Names = Named[] & { readonly gone: number }

export type Where = {
	readonly part: Key
	readonly id: Id
	readonly path: readonly Step[] | null
	readonly keys?: true
}

export type Member = { readonly name: string; readonly id: Id; readonly from?: string }

export type Fact = {
	readonly part: Key
	readonly id: Id
	readonly patches: readonly Patch[]
	readonly change: ChangeHeader | undefined
	readonly entry: Entry<unknown> | undefined
}

export type Code = "not-a-name" | "nothing-there" | "already-there"

export class PlacesError extends Error {
	constructor(readonly code: Code, readonly at?: string) {
		super(at === undefined ? code : `${code} (${at})`)
	}
}

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "symbol"

export const asId = (v: unknown): Id | undefined => isId(v) ? v : undefined

export const children: Contributor = {
	from: "children",
	step: ({ id }, name, r) => id === level ? undefined : asId(r.read("children", id, [name])),
	names: ({ id }, r) => id === level ? [] : r.keys("children", id),
}

export function at(v: unknown, path: readonly Step[]): unknown {
	for (const k of path) {
		if (typeof k === "number") {
			if (!Array.isArray(v) && !isTyped(v)) return undefined
			v = v[k]
		} else {
			if (!isPojo(v) || !Object.hasOwn(v, k)) return undefined
			v = v[k]
		}
	}
	return v
}

function child(children: Entry<unknown> | undefined, name: string): Id | undefined {
	const v = children?.value
	if (!isPojo(v) || !Object.hasOwn(v, name)) return undefined
	const id = v[name]
	return isId(id) ? id : undefined
}

export function createPlaces(setup: Setup): Places {
	const { table, paths, scheduler } = setup

	const firsts = new Map<Key, { part: Key }>()
	function first(part: Key) {
		let p = firsts.get(part)
		if (p === undefined) firsts.set(part, p = { part })
		return p
	}

	const mine = {}
	let into: Set<unknown> | undefined
	let made: Set<unknown> | undefined
	let peeping = 0
	function tell(s: Spot<unknown>) {
		const known = s.owner === mine
		s.owner = mine
		if (into === undefined) scheduler.track(s)
		else {
			into.add(s)
			if (!known) made?.add(s)
		}
	}

	function record<T>(f: () => T, reads: Set<unknown>, fresh?: Set<unknown>): T {
		const was = into, wasMade = made, wasPeeping = peeping
		into = reads
		made = fresh
		peeping = 0
		try {
			return f()
		} finally {
			into = was
			made = wasMade
			peeping = wasPeeping
		}
	}

	function peep<T>(f: () => T): T {
		peeping++
		try {
			return f()
		} finally {
			peeping--
		}
	}

	const held = (key: unknown): key is Spot<unknown> =>
		typeof key === "object" && key !== null && (key as Spot<unknown>).owner === mine

	const holds = new Map<unknown, number>()

	function hold(key: unknown, n: number): number {
		if (!held(key)) return 0
		const left = (holds.get(key) ?? 0) + n
		if (left > 0) holds.set(key, left)
		else holds.delete(key)
		return Math.max(left, 0)
	}

	function release(key: unknown) {
		if (!held(key) || (holds.size && holds.has(key))) return
		paths.release(key)
		key.owner = undefined
	}

	function describe(key: unknown): Where | undefined {
		if (!held(key)) return undefined
		const { part } = key.source as { part: Key }
		return key.keys
			? { part, id: key.id as Id, path: key.path, keys: true }
			: { part, id: key.id as Id, path: key.path }
	}

	function say(spots: readonly unknown[]) {
		if (spots.length) scheduler.mark(spots, scheduler.getRun())
	}

	const indexed = new Map<Id, Map<string, Id>>()
	const named = new Map<Id, Slot[]>()
	function unindex(folder: Id, name: string) {
		const k = indexed.get(folder)
		const id = k?.get(name)
		if (id === undefined) return
		k!.delete(name)
		if (k!.size === 0) indexed.delete(folder)
		const list = named.get(id)!
		list.splice(list.findIndex((n) => n.folder === folder && n.name === name), 1)
		if (list.length === 0) named.delete(id)
	}
	function index(folder: Id, name: string, entry: Entry<unknown> | undefined) {
		const now = child(entry, name)
		if (indexed.get(folder)?.get(name) === now) return
		unindex(folder, name)
		if (now === undefined) return
		let k = indexed.get(folder)
		if (k === undefined) indexed.set(folder, k = new Map())
		k.set(name, now)
		let list = named.get(now)
		if (list === undefined) named.set(now, list = [])
		list.push({ folder, name })
	}
	function reindex(folder: Id, names?: Iterable<string>) {
		const entry = table.get("children", folder) as Entry<unknown> | undefined
		if (names !== undefined) {
			for (const name of names) index(folder, name, entry)
			return
		}
		const v = entry?.value
		const all = new Set([
			...indexed.get(folder)?.keys() ?? [],
			...isPojo(v) ? Object.keys(v) : [],
		])
		for (const name of all) index(folder, name, entry)
	}
	function touched(patches: readonly Patch[]): string[] | undefined {
		const out: string[] = []
		for (const p of patches) {
			if (p.path.length === 0 || (p.move !== undefined && p.move.path.length === 0)) {
				return undefined
			}
			if (typeof p.path[0] === "string") out.push(p.path[0])
			if (typeof p.move?.path[0] === "string") out.push(p.move.path[0])
		}
		return out
	}
	const namesOf = (id: Id): readonly Slot[] => named.get(id) ?? []

	function onTableChange(part: Key, id: Id) {
		if (part === "children") reindex(id)
		say(paths.event(first(part), id))
		if (alls.length === 0) return
		const entry = table.get(part, id)
		const patch: Patch = entry?.value === undefined
			? { path: [] }
			: { path: [], value: entry.value }
		const change = entry !== undefined ? entry.change : removal()
		const facts = [{ part, id, patches: [patch], change, entry }]
		tellAll(facts)
	}

	// an entry taken out leaves no change, so make one now from the frame open
	function removal(): ChangeHeader | undefined {
		if (scheduler.getCurrentFrame?.() === undefined) return undefined
		const s = {
			getCurrentFrame: () => scheduler.getCurrentFrame!(),
			getRun: () => scheduler.getRun(),
		}
		return createChangeHeader(s, { now: setup.now })
	}

	let alls: ((fact: Fact) => void)[] = []
	function watchAll(fn: (fact: Fact) => void): () => void {
		alls = [...alls, fn]
		return () => void (alls = alls.filter((g) => g !== fn))
	}
	function tellAll(facts: readonly Fact[]) {
		if (alls.length === 0) return
		const told = alls
		for (const f of facts) for (const fn of told) fn(f)
	}

	function* eachEntryChange(changed: readonly Entry<unknown>[]): Generator<Fact> {
		for (const entry of changed) {
			const op = entry.change.op
			if (op === undefined) continue
			for (const [part, id] of table.who(entry)) {
				yield { part: part as Key, id, patches: op.patches, change: entry.change, entry }
			}
		}
	}

	function commit(changed: readonly Entry<unknown>[]) {
		const facts = [...eachEntryChange(changed)]
		for (const f of facts) if (f.part === "children") reindex(f.id, touched(f.patches))
		const out: unknown[] = []
		for (const f of facts) out.push(...paths.mark(first(f.part), f.id, f.patches))
		say(out)
		tellAll(facts)
	}

	function readValue(part: Key, id: Id, path: readonly Step[] = []): unknown {
		if (!peeping) tell(paths.spot(first(part), id, path))
		return at(table.get(part, id)?.value, path)
	}

	function readChange(part: Key, id: Id): ChangeHeader | undefined {
		if (!peeping) tell(paths.change(first(part), id))
		return table.get(part, id)?.change
	}

	function readKeys(part: Key, id: Id, path: readonly Step[] = [], ids = false): string[] {
		if (!peeping) tell(paths.spot(first(part), id, path, true))
		const v = at(table.get(part, id)?.value, path)
		if (!isPojo(v)) return []
		return ids ? Object.keys(v).filter((k) => isId(v[k])) : Object.keys(v)
	}

	function readHere(part: Key, id: Id, path: readonly Step[] = []): unknown {
		if (!peeping) tell(paths.spot(first(part), id, path, false, true))
		const v = at(table.get(part, id)?.value, path)
		return isPojo(v) ? map : v
	}

	const reads: Reads = {
		read: readValue,
		keys: readKeys,
		here: readHere,
		track: (key) =>
			peeping ? undefined : into === undefined ? scheduler.track(key) : void into.add(key),
	}

	function view(root: Id, given?: readonly Contributor[]): Places {
		const asked = given ?? [children]

		let said = 0

		function go(here: Here, name: string): Member | undefined {
			const gone = here.gone ?? 0
			let under = gone
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const id = asked[i].step(here, name, reads)
				if (id === none) under |= b
				else if (id !== undefined) {
					said = under
					return { name, id, from: asked[i].from }
				}
			}
			// No id anywhere, but a contributor has a level there: walk on through it as a folder.
			for (let i = 0; i < asked.length; i++) {
				if (under & bit(i)) continue
				const c = asked[i]
				if (c.level?.(here, name, reads)) {
					said = under
					return { name, id: level, from: c.from }
				}
			}
			said = under
		}

		function* walk(path: Path, from: Id | Here = root): Generator<Member, Here | undefined> {
			if (given === undefined) {
				let at = typeof from === "object" ? from.id : from
				for (const name of path) {
					if (!peeping) tell(paths.spot(first("children"), at, [name]))
					const id = child(table.get("children", at), name)
					if (id === undefined) return undefined
					yield { name, id }
					at = id
				}
				const base = typeof from === "object" ? from.path : from === root ? [] : undefined
				return { id: at, path: base && (path.length ? [...base, ...path] : base) }
			}
			let here: Here = typeof from === "object"
				? from
				: from === root
				? { id: root, path: [] }
				: { id: from }
			for (const name of path) {
				const m = go(here, name)
				if (m === undefined) return undefined
				const gone = said
				yield m
				here = { id: m.id, path: here.path && [...here.path, name], gone }
			}
			return here
		}

		function answers(here: Here, name: string): Answers {
			const gone = here.gone ?? 0
			let out: Answer[] = [], under = gone
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const id = asked[i].step(here, name, reads)
				if (id === none) under |= b
				else if (id !== undefined) out.push({ id, from: asked[i].from })
			}
			if (out.length === 0) {
				for (let i = 0; i < asked.length; i++) {
					if (under & bit(i)) continue
					const c = asked[i]
					if (c.level?.(here, name, reads)) {
						out = [{ id: level, from: c.from }]
						break
					}
				}
			}
			return Object.assign(out, { gone: under })
		}

		// With several contributors, in canonical CBOR key order.
		function names(here: Here): Names {
			const gone = here.gone ?? 0
			let under = gone
			const out: Named[] = []
			const seen = new Set<string>()
			for (let i = 0; i < asked.length; i++) {
				const b = bit(i)
				if (gone & b) continue
				const c = asked[i]
				const got = c.names(here, reads)
				if (got === none) {
					under |= b
					continue
				}
				for (const name of got) {
					if (seen.has(name)) continue
					seen.add(name)
					out.push({ name, from: c.from })
				}
			}
			if (asked.length > 1) out.sort((a, b) => keyorder(a.name, b.name))
			return Object.assign(out, { gone: under })
		}

		return {
			root,
			contributors: given,
			view,
			onTableChange,
			release,
			describe,
			commit,
			eachEntryChange,
			watchAll,
			readValue,
			readKeys,
			readChange,
			namesOf,
			walk,
			answers,
			names,
			record,
			peep,
			hold,
		}
	}

	return view(setup.root, setup.contributors)
}

export type Places = {
	readonly root: Id

	onTableChange: (part: Key, id: Id) => void
	release: (key: unknown) => void
	describe: (key: unknown) => Where | undefined

	commit: (changed: readonly Entry<unknown>[]) => void
	eachEntryChange: (changed: readonly Entry<unknown>[]) => Generator<Fact>
	watchAll: (fn: (fact: Fact) => void) => () => void

	readonly contributors: readonly Contributor[] | undefined
	view: (root: Id, contributors?: readonly Contributor[]) => Places

	readValue: (part: Key, id: Id, path?: readonly Step[]) => unknown
	readKeys: (part: Key, id: Id, path?: readonly Step[], ids?: boolean) => string[]
	readChange: (part: Key, id: Id) => ChangeHeader | undefined
	namesOf: (id: Id) => readonly Slot[]
	walk: (path: Path, from?: Id | Here) => Generator<Member, Here | undefined>
	answers: (here: Here, name: string) => Answers
	names: (here: Here) => Names

	record: <T>(f: () => T, reads: Set<unknown>, fresh?: Set<unknown>) => T
	peep: <T>(f: () => T) => T
	hold: (key: unknown, n: number) => number
}

// Every children entry is written through this crow, so a place into n names costs one step
// (10k names: 12.6 s copying, 8 ms in place). A host should wire crowify(scheduler, crow,
// subtreeOf), or a folder held past a run changes under its holder.
export const crow: Crow = /* @__PURE__ */ createCrow()

const bad = (name: string) => name === "" || name === "." || name === ".." || name === "/"

const taken = (children: Entry<unknown> | undefined, name: string) =>
	isPojo(children?.value) && Object.hasOwn(children!.value as object, name)

const base = (children: Entry<unknown> | undefined): Patch[] =>
	isPojo(children?.value) ? [] : [{ path: [], value: {} }]

function write(children: Entry<unknown>, patches: Patch[], header: ChangeHeader) {
	updateEntry(crow, children, patches, header)
	return [children]
}

export type Writer = (part: Key, id: Id, patches: readonly Patch[], header: ChangeHeader) => void

export function placing(children: Entry<unknown> | undefined, name: string, id: Id): Patch[] {
	if (bad(name)) throw new PlacesError("not-a-name", name)
	if (taken(children, name)) throw new PlacesError("already-there", name)
	return [...base(children), { path: [name], value: id }]
}

export function unplacing(children: Entry<unknown> | undefined, name: string): Patch[] {
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	return [{ path: [name] }]
}

export function moving(
	[from, name]: readonly [Entry<unknown>, string],
	[into, to]: readonly [Entry<unknown> | undefined, string],
): { entry: "from" | "into"; patches: Patch[] }[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	const id = child(from, name)
	if (id === undefined) throw new PlacesError("nothing-there", name)
	if (from === into) {
		if (name === to) return []
		if (taken(from, to)) throw new PlacesError("already-there", to)
		return [{ entry: "from", patches: [{ path: [to], move: { path: [name] } }] }]
	}
	return [
		{ entry: "into", patches: placing(into, to, id) },
		{ entry: "from", patches: unplacing(from, name) },
	]
}

export function place(
	children: Entry<unknown>,
	name: string,
	id: Id,
	header: ChangeHeader,
): Entry<unknown>[] {
	return write(children, placing(children, name, id), header)
}

export function unplace(
	children: Entry<unknown>,
	name: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	return write(children, unplacing(children, name), header)
}

export function rename(
	children: Entry<unknown>,
	name: string,
	to: string,
	header: ChangeHeader,
): Entry<unknown>[] {
	if (bad(to)) throw new PlacesError("not-a-name", to)
	if (child(children, name) === undefined) throw new PlacesError("nothing-there", name)
	if (to === name) return []
	if (taken(children, to)) throw new PlacesError("already-there", to)
	return write(children, [{ path: [to], move: { path: [name] } }], header)
}

export function move(
	[from, name]: readonly [Entry<unknown>, string],
	[into, to]: readonly [Entry<unknown>, string],
	header: ChangeHeader,
): Entry<unknown>[] {
	return moving([from, name], [into, to]).flatMap((m) =>
		write(m.entry === "from" ? from : into, m.patches, header)
	)
}
