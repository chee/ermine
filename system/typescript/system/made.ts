import { type Id, type Path, PlacesError } from "@ermine/places"
import type { Computer, Equal, Scope } from "@ermine/reactivity"
import { isPromise } from "@ermine/reactivity/helpers"
import type { Inner } from "../context.ts"
import { keyOf, up } from "./addressing.ts"
import type { Base } from "./base.ts"
import { nodeAbove } from "./scopes.ts"
import { here } from "./setting.ts"
import { SCOPE } from "./shapes.ts"
import { childrenOf, folderOf, namesIn, nodeGone, placeUnder, takeOut, under } from "./tree.ts"

export type Code = {
	// deno-lint-ignore no-explicit-any
	f: (previous: any) => unknown
	// deno-lint-ignore no-explicit-any
	act?: (value: any, before: any) => unknown
	// deno-lint-ignore no-explicit-any
	equal?: Equal<any>
}
// What an owner's run made: a memo or effect (Computed) or a placed action handler (Placed).
// The owner's next run makes it again, or it is let go.
type Computed = {
	readonly kind: "computer"
	readonly id: Id
	readonly inner: Inner
	readonly own: Scope
	readonly path: Path
	c?: Computer
	code: Code
	readonly memo: boolean
	awaiting: boolean
	gave?: unknown
}
type Placed = {
	readonly kind: "action"
	readonly id: Id
	readonly inner: Inner
	readonly own: Scope
}
export type Made = Computed

export const computerAt = (made: Base["made"], id: Id) => {
	const m = made.get(id)
	return m?.kind === "computer" ? m : undefined
}

// What an owner made and has not let go. One teardown on the owner checks the bin after each run
// ends and when the owner goes.
type Bin = { armed: boolean; members: Set<Computed | Placed> }
type Computers = Bin & { at: Map<string, Set<Computed>> }
const bins = new WeakMap<Scope, Computers>()
const placers = new WeakMap<Scope, Map<Id, Bin>>()
function binOf(own: Scope): Computers {
	let bin = bins.get(own)
	if (bin === undefined) bins.set(own, bin = { armed: false, members: new Set(), at: new Map() })
	return bin
}
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
					calls.drop(m.id)
				}
			} else if (f === "gone") forget(m)
		}
		if (alive && bin.members.size > 0) arm(inner, own, bin)
	})
}
function fate(m: Computed | Placed, alive: boolean): "keep" | "taken" | "gone" {
	if (m.kind === "computer") return m.c?.state === "alive" ? alive ? "keep" : "taken" : "gone"
	return here(m.inner).base.methods.get(m.id)?.scope !== m.own ? "taken" : alive ? "keep" : "gone"
}

// The computer made at path under own, claimed by its next run and given new code. Two of a name in
// one run are refused. Code is compared by function source text, so a bound or native function
// counts only as itself.
const text = (f: unknown) => {
	if (typeof f !== "function") return f
	const t = f.toString()
	return t.endsWith("{ [native code] }") ? f : t
}
export const sameSource = (a: Code, b: Code) =>
	text(a.f) === text(b.f) && text(a.act) === text(b.act) && text(a.equal) === text(b.equal)

export function again(inner: Inner, own: Scope, path: Path, code: Code): Computed | undefined {
	const { s } = here(inner)
	const bin = bins.get(own)
	for (const m of bin?.at.get(keyOf(path)) ?? []) {
		if (m.c === undefined || m.c.state !== "alive") continue
		// A computer made again with the same source is due only when what it read changes, so a closure
		// over values it does not read can go stale.
		if (!s.claim(m.c, undefined, !sameSource(m.code, code))) {
			throw new PlacesError("already-there", path.join("/"))
		}
		m.code = code
		hold(inner, bin!, m)
		return m
	}
}

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
	for (const { folder, name } of [...places.namesOf(id)]) takeOut(inner, folder, name, id)
	nodeGone(inner, id, { runs: true, held: true })
}

export function keepAction(inner: Inner, own: Scope, id: Id) {
	let mine = placers.get(own)
	if (mine === undefined) placers.set(own, mine = new Map())
	if (mine.has(id)) return
	const bin: Bin = { armed: false, members: new Set() }
	mine.set(id, bin)
	hold(inner, bin, { kind: "action", id, inner, own })
}

export function unplaced(inner: Inner, folder: Id, name: string) {
	const was = namesIn(childrenOf(inner, folder))?.[name]
	const below = was === undefined ? [] : under(inner, was)
	takeOut(inner, folder, name)
	stopMade(inner, below)
}

// Stops what was made below that no name reaches from the root now. A call already going
// finishes.
export function stopMade(inner: Inner, below: readonly Id[], always?: Id) {
	const { base, s, places, calls } = here(inner)
	const ids = below.filter((i) => i === always || up(base, places, places.root, i) === undefined)
	for (const id of ids) {
		const m = base.made.get(id)
		if (m !== undefined) {
			if (m.c?.state === "alive") {
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

// A generator compute's generator, awaiting a yielded promise. `mine` tells whether it is still the
// latest run's.
function* watched(m: Computed, gen: Generator<unknown, unknown, unknown>, mine: () => boolean) {
	let input: unknown
	let threw = false
	try {
		for (;;) {
			const step = threw ? gen.throw(input) : gen.next(input)
			if (step.done) return step.value
			if (!isPromise(step.value)) {
				input = step.value
				threw = false
				continue
			}
			if (mine()) m.awaiting = true
			try {
				input = yield step.value
				threw = false
			} catch (e) {
				input = e
				threw = true
			} finally {
				if (mine()) m.awaiting = false
			}
		}
	} finally {
		gen.return(undefined)
	}
}
const isGen = (v: unknown): v is Generator<unknown, unknown, unknown> =>
	Object.prototype.toString.call(v) === "[object Generator]"

export const ran = (m: Computed, previous: unknown) => {
	let r = m.code.f(previous)
	if (isGen(r)) {
		const w: Generator<unknown, unknown, unknown> = watched(m, r, () => m.gave === w)
		r = w
	}
	m.gave = r
	if (isPromise(r)) {
		m.awaiting = true
		const done = () => void (m.gave === r && (m.awaiting = false))
		r.then(done, done)
	} else m.awaiting = false
	return r
}
