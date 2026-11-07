// places: walks names from a root through its contributors and ties reads to the scheduler.
// A whole entry goes in with tables.add, tables.sub or tables.del, which write the table and tell. A change in place is a
// plain function on the entry, announced with commit.
//
//   const places = createPlaces({ root, table, paths, scheduler, contributors: [one, other] })
//   places.commit(changed)
//
// A name is any string except "", ".", ".." and "/".
import type { ChangeHeader, Entry } from "@ermine/graph/entry"
import { ApplyError, type Key as Step, type Patch, type Span } from "@ermine/changeable/apply"
import { walk } from "@ermine/changeable/walk-string"
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
	table: Table
	paths: Paths
	scheduler:
		& Pick<Scheduler, "track" | "mark" | "getRun">
		& Partial<Pick<Scheduler, "getCurrentFrame">>
	contributors: readonly Contributor[]
	now?: () => number
}

export const map: unique symbol = /* @__PURE__ */ Symbol("map")

export const level: Id = /* @__PURE__ */ Symbol("level")

export const none: unique symbol = /* @__PURE__ */ Symbol("none")

export type Place = { readonly id: Id; readonly path?: Path; readonly gone?: number }

const bit = (i: number) => i < 32 ? 1 << i : 0

export type Reads = {
	read(part: Key, id: Id, path?: readonly Step[]): unknown
	keys(part: Key, id: Id, path?: readonly Step[], ids?: boolean): string[]
	here(part: Key, id: Id, path?: readonly Step[]): unknown
	track(key: unknown): void
}

export type Contributor = {
	readonly from: string
	step(here: Place, name: string, reads: Reads): Id | undefined | typeof none
	names(here: Place, reads: Reads): string[] | typeof none
	level?(here: Place, name: string, reads: Reads): boolean
}

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

const whole = (n: unknown) => Number.isInteger(n) && (n as number) >= 0

// What the delete patch { path, range } would take out of what is at path, as the same kind and a
// copy of its own (never a view): a string, a list, a typed array. The path walks as at does, so
// nothing there is undefined; the range fails as that patch would, in apply's codes.
export function sliceAt(v: unknown, path: readonly Step[], range: Span): unknown {
	const fail = (code: "not-a-patch" | "range" | "wrong-kind"): never => {
		throw new ApplyError(code)
	}
	if (!Array.isArray(range) || range.length !== 2 || !range.every(whole)) fail("not-a-patch")
	const [a, b] = range
	v = at(v, path)
	if (v === undefined) return undefined
	if (a > b) fail("range")
	if (typeof v === "string") {
		const at = walk(v, a, b)
		return at ? v.slice(at[0], at[1]) : fail("range")
	}
	if (!Array.isArray(v) && !isTyped(v)) fail("wrong-kind")
	if (b > (v as ArrayLike<unknown>).length) fail("range")
	return (v as unknown[]).slice(a, b)
}

export function createPlaces(setup: Setup): Places {
	const { paths, scheduler } = setup
	const table = setup.table

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

	function add(part: Key, id: Id, entry: Entry<unknown>) {
		if (table.get(part, id) === entry) return
		table.add(part, id, entry)
		landed(part, id)
	}

	function sub(part: Key, id: Id, entry: Entry<unknown>) {
		if (table.get(part, id) === entry) return
		table.sub(part, id, entry)
		landed(part, id)
	}

	function del(part: Key, id: Id) {
		table.del(part, id)
		landed(part, id)
	}

	function landed(part: Key, id: Id) {
		say(paths.event(first(part), id))
		if (alls.length > 0) {
			const entry = table.get(part, id)
			const patch: Patch = entry?.value === undefined
				? { path: [] }
				: { path: [], value: entry.value }
			const change = entry !== undefined ? entry.change : removal()
			tellAll([{ part, id, patches: [patch], change, entry }])
		}
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
		const out: unknown[] = []
		for (const f of facts) out.push(...paths.mark(first(f.part), f.id, f.patches))
		say(out)
		tellAll(facts)
	}

	function readValue(part: Key, id: Id, path: readonly Step[] = [], range?: Span): unknown {
		if (!peeping) tell(paths.spot(first(part), id, path))
		const v = table.get(part, id)?.value
		return range === undefined ? at(v, path) : sliceAt(v, path, range)
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

	const root = setup.root
	const asked = setup.contributors

	let said = 0

	function go(here: Place, name: string): Member | undefined {
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

	function* walk(path: Path, from: Id | Place = root): Generator<Member, Place | undefined> {
		let here: Place = typeof from === "object"
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

	function answers(here: Place, name: string): Answers {
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
	function names(here: Place): Names {
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
		contributors: asked,
		tables: { add, sub, del },
		release,
		describe,
		commit,
		eachEntryChange,
		watchAll,
		readValue,
		readKeys,
		readChange,
		walk,
		answers,
		names,
		record,
		peep,
		hold,
	}
}

export type Places = {
	readonly root: Id

	tables: {
		add: (part: Key, id: Id, entry: Entry<unknown>) => void
		sub: (part: Key, id: Id, entry: Entry<unknown>) => void
		del: (part: Key, id: Id) => void
	}
	release: (key: unknown) => void
	describe: (key: unknown) => Where | undefined

	commit: (changed: readonly Entry<unknown>[]) => void
	eachEntryChange: (changed: readonly Entry<unknown>[]) => Generator<Fact>
	watchAll: (fn: (fact: Fact) => void) => () => void

	readonly contributors: readonly Contributor[]

	readValue: (part: Key, id: Id, path?: readonly Step[], range?: Span) => unknown
	readKeys: (part: Key, id: Id, path?: readonly Step[], ids?: boolean) => string[]
	readChange: (part: Key, id: Id) => ChangeHeader | undefined
	walk: (path: Path, from?: Id | Place) => Generator<Member, Place | undefined>
	answers: (here: Place, name: string) => Answers
	names: (here: Place) => Names

	record: <T>(f: () => T, reads: Set<unknown>, fresh?: Set<unknown>) => T
	peep: <T>(f: () => T) => T
	hold: (key: unknown, n: number) => number
}
