import { type Id, type Path, PlacesError } from "@ermine/core/places"
import type { Computer, Equal, Scope } from "@ermine/core/scheduler"
import { isPromise } from "@ermine/core/scheduler/helpers"
import type { Inner } from "../context.ts"
import { keyOf, up } from "./addressing.ts"
import type { Base } from "./base.ts"
import { nodeAbove } from "./scopes.ts"
import { here } from "./setting.ts"
import { SCOPE } from "./shapes.ts"
import { childrenOf, folderOf, namesIn, nodeGone, placeUnder, takeOut, under } from "./tree.ts"

// a memo's or effect's code, in place: a run of its owner making it again gives it new code
export type Code = {
	// deno-lint-ignore no-explicit-any
	f: (previous: any) => unknown
	// deno-lint-ignore no-explicit-any
	act?: (value: any, before: any) => unknown
	// deno-lint-ignore no-explicit-any
	equal?: Equal<any>
}
// what an owner's run made: a memo or effect at its node (Computed), an action's handler placed at a
// node (Placed). a computer is in Base's made, by node. the owner's next run makes it again, or it
// is let go
type Computed = {
	readonly kind: "computer"
	readonly id: Id
	// the context that made it, the scope that did (its next run claims it), and where
	readonly inner: Inner
	readonly own: Scope
	readonly path: Path
	c?: Computer
	code: Code
	readonly memo: boolean
	// its latest run gave a promise not settled yet
	awaiting: boolean
	// what its code last gave
	gave?: unknown
}
type Placed = {
	readonly kind: "action"
	readonly id: Id
	readonly inner: Inner
	readonly own: Scope
}
export type Made = Computed

// the memo or effect at id; none: it is none
export const computerAt = (made: Base["made"], id: Id) => {
	const m = made.get(id)
	return m?.kind === "computer" ? m : undefined
}

// what an owner made and has not let go: one teardown on the owner asks after them all, again as it
// runs (a cleanup of that run, run once the next run is done: it finds a computer claimed, alive,
// and leaves it) and as it goes (what is under it first). one stopped is out of its bin at once.
// an owner has a bin for its computers (at: by name, for its next run to claim), and one for each
// action it placed (one teardown each)
type Bin = { armed: boolean; members: Set<Computed | Placed> }
type Computers = Bin & { at: Map<string, Set<Computed>> }
const bins = new WeakMap<Scope, Computers>()
const placers = new WeakMap<Scope, Map<Id, Bin>>()
function binOf(own: Scope): Computers {
	let bin = bins.get(own)
	if (bin === undefined) bins.set(own, bin = { armed: false, members: new Set(), at: new Map() })
	return bin
}
// m kept in its owner's bin, asked after as the owner's runs end and it goes
function hold(inner: Inner, bin: Bin, m: Computed | Placed) {
	bin.members.add(m)
	arm(inner, m.own, bin)
}
function arm(inner: Inner, own: Scope, bin: Bin) {
	if (bin.armed) return
	bin.armed = true
	here(inner).s.registerTeardown(own, () => {
		bin.armed = false
		const alive = own.state === "alive"
		for (const m of [...bin.members].reverse()) {
			const f = fate(m, alive)
			if (f === "keep") continue
			bin.members.delete(m)
			if (m.kind === "action") {
				placers.get(own)?.delete(m.id)
				if (f === "gone") {
					const { base, calls } = here(m.inner)
					base.methods.delete(m.id)
					// its record goes with it (calls.ts)
					calls.drop(m.id)
				}
			} else if (f === "gone") forget(m)
		}
		if (alive && bin.members.size > 0) arm(inner, own, bin)
	})
}
// what an owner's run ending (alive: it runs again) or its going makes of a member of its bin: kept
// for the next, let be (its computer alive while its owner is gone; an action another placement took
// over), or let go (a computer not alive; an action, its owner gone)
function fate(m: Computed | Placed, alive: boolean): "keep" | "taken" | "gone" {
	if (m.kind === "computer") return m.c?.state === "alive" ? alive ? "keep" : "taken" : "gone"
	return here(m.inner).base.methods.get(m.id)?.scope !== m.own ? "taken" : alive ? "keep" : "gone"
}

// the one made at path under own: claimed, given new code (a parent's rerun does not destroy
// its children; two of a name in one run are refused). as own's run starts, what its earlier
// runs made is old (the scheduler's): one old is claimed; one not old was made in this run (or
// own has had no run since): already-there. none: a new one is to be made
export function again(inner: Inner, own: Scope, path: Path, code: Code): Computed | undefined {
	const { s } = here(inner)
	const bin = bins.get(own)
	for (const m of bin?.at.get(keyOf(path)) ?? []) {
		if (m.c === undefined || m.c.state !== "alive") continue
		if (!s.claim(m.c)) throw new PlacesError("already-there", path.join("/"))
		m.code = code
		hold(inner, bin!, m)
		return m
	}
}

// a computer's node: a new id, placed at path, its scope written (own's NODE key, or the
// nearest above with one; none: not written); in own's bin, its node and name gone with it.
// made in a call: the call's record says so
export function computerNode(
	inner: Inner,
	own: Scope,
	path: Path,
	code: Code,
	kind: "memo" | "effect" | "early",
) {
	const { base, calls, newId, inside } = here(inner)
	const id = newId()
	const above = nodeAbove(own)
	inside(() => {
		const parent = folderOf(inner, path)
		placeUnder(inner, parent, path[path.length - 1], id, path)
		if (above !== undefined) {
			inner.put({ part: "attributes", id, patches: [{ path: [SCOPE], value: above }] })
		}
	})
	const m: Computed = {
		kind: "computer",
		id,
		inner,
		own,
		path,
		code,
		memo: kind === "memo",
		awaiting: false,
	}
	const bin = binOf(own)
	const at = keyOf(path)
	bin.at.set(at, (bin.at.get(at) ?? new Set()).add(m))
	hold(inner, bin, m)
	base.made.set(id, m)
	calls.open()?.made.push({ kind, id, path })
	return m
}

// m's node and name taken out now: its computer is not alive
function forget(m: Computed) {
	const { inner, id } = m
	const { base, places } = here(inner)
	base.made.delete(id)
	const bin = bins.get(m.own)
	if (bin !== undefined) {
		bin.members.delete(m)
		const at = keyOf(m.path)
		const there = bin.at.get(at)
		if (there?.delete(m) && there.size === 0) bin.at.delete(at)
	}
	base.missing.delete(id)
	// every name holding it, as its folder is now (not by a path: a folder removed above it no longer
	// gives one)
	for (const { folder, name } of [...places.namesOf(id)]) takeOut(inner, folder, name, id)
	nodeGone(inner, id, { runs: true, held: true })
}

// the action at id placed by own, kept while own is: a later placement, its own or another's, takes
// it over. one bin for each (owner, node), however often it is placed
export function keepAction(inner: Inner, own: Scope, id: Id) {
	let mine = placers.get(own)
	if (mine === undefined) placers.set(own, mine = new Map())
	if (mine.has(id)) return
	const bin: Bin = { armed: false, members: new Set() }
	mine.set(id, bin)
	hold(inner, bin, { kind: "action", id, inner, own })
}

// the name in the folder taken out, and what was made at its node and under it stopped (stopMade)
export function unplaced(inner: Inner, folder: Id, name: string) {
	const was = namesIn(childrenOf(inner, folder))?.[name]
	const below = was === undefined ? [] : under(inner, was)
	takeOut(inner, folder, name)
	stopMade(inner, below)
}

// what was made at the nodes below that no name reaches from the root now (and at always, a node
// remove took out) stopped, as unplace and remove stop it (index.ts has the rule). a call already
// going finishes (its record is let go, calls.drop)
export function stopMade(inner: Inner, below: readonly Id[], always?: Id) {
	const { base, s, places, calls } = here(inner)
	const ids = below.filter((i) => i === always || up(base, places, places.root, i) === undefined)
	for (const id of ids) {
		const m = base.made.get(id)
		if (m !== undefined) {
			if (m.c?.state === "alive") {
				// the maker's process lives on: its teardowns are told ended, not replaced
				const key = m.inner.node
				const had = base.whys.get(key)
				base.whys.set(key, "ended")
				try {
					s.teardown(m.c)
				} finally {
					if (had === undefined) base.whys.delete(key)
					else base.whys.set(key, had)
				}
			}
			forget(m)
		}
		if (base.methods.delete(id)) {
			calls.drop(id)
			nodeGone(inner, id)
		}
	}
}

export const same = (m: Computed) => (a: unknown, b: unknown) =>
	m.code.equal ? m.code.equal(a, b) : Object.is(a, b)

// m's code run: a promise given marks its node awaiting till it settles
export const ran = (m: Computed, previous: unknown) => {
	const r = m.code.f(previous)
	m.gave = r
	if (isPromise(r)) {
		m.awaiting = true
		// an earlier run's promise settling late leaves the node awaiting the latest's
		const done = () => void (m.gave === r && (m.awaiting = false))
		r.then(done, done)
	} else m.awaiting = false
	return r
}
