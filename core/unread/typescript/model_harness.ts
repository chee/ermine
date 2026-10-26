// unread against a model, for its fuzzers: a run is a list of steps (writes, reads, keeps,
// unwrites, a write again where the last one was), each done to one entry under unread and to a
// plain copy-on-write apply (the oracle) side by side. after each step:
// - nothing handed out has changed: what a read gave, what was kept, a write's patches (as given,
//   refused or not) and its undo, each as it was when handed (key order too)
// - the entry's value is the oracle's, the undo the oracle's undo, a refusal the oracle's, and a
//   refused write leaves the root and its content as they were (values by content: a map's key
//   order is not part of its value, op's apply.ts)
// - copies stay bounded: a write makes at most a few containers per patch (the paths it walks), and
//   a write again where the last one wrote, with nothing read or kept since, makes none
// a failing run shrinks to its fewest steps (and fewest patches in each). steps are data: a value
// put is content (cloned as it is put) or a reference to something handed earlier (aliasing)
import apply, { ApplyError, type Key, type Patch } from "@ermine/core/op/apply"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import { createUnread, type Unread } from "./unread.ts"

// a value put: content, something handed earlier (at a path in it), or the value the j-th patch
// of the same write puts (the same object twice)
export type Given = { data: unknown } | { ref: number; at: Key[] } | { same: number }
export type Spec = { path?: unknown; range?: unknown; move?: unknown; value?: Given; raw?: unknown }
export type Step =
	| { k: "write"; ps: Spec[] }
	| { k: "read" }
	| { k: "kept"; path: Key[]; wrap: number; handed: Key[][] }
	| { k: "unwrite" }
	| { k: "again"; value: number }

export type Failure = { at: number; property: string; why: string }

const isList = Array.isArray
export const isMap = (v: unknown): v is Record<string, unknown> => {
	if (v === null || typeof v !== "object" || isList(v) || ArrayBuffer.isView(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}
const typed = (v: unknown): v is Int16Array =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)
export const container = (v: unknown): v is object => isList(v) || isMap(v) || typed(v)

// content as a string: key order, -0, typed arrays' kinds, undefined and loops all shown
export function show(v: unknown, seen: object[] = []): string {
	if (v === undefined) return "~"
	if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v)
	if (typeof v === "bigint") return `${v}n`
	if (v === null || typeof v !== "object") return JSON.stringify(v)
	if (seen.includes(v)) return "<loop>"
	seen.push(v)
	let out: string
	if (ArrayBuffer.isView(v)) {
		out = `${v.constructor.name}[${[...(v as unknown as Iterable<unknown>)].map(String)}]`
	} else if (isList(v)) out = `[${v.map((x) => show(x, seen)).join(",")}]`
	else {
		out = `{${
			Object.keys(v).map((k) =>
				`${JSON.stringify(k)}:${show((v as Record<string, unknown>)[k], seen)}`
			)
				.join(",")
		}}`
	}
	seen.pop()
	return out
}
// the same, maps' keys sorted: what differs only in key order shows the same
export function sorted(v: unknown, seen: object[] = []): string {
	if (!isMap(v)) {
		if (isList(v)) {
			if (seen.includes(v)) return "<loop>"
			seen.push(v)
			const s = `[${v.map((x) => sorted(x, seen)).join(",")}]`
			seen.pop()
			return s
		}
		return show(v)
	}
	if (seen.includes(v)) return "<loop>"
	seen.push(v)
	const s = `{${
		Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted(v[k], seen)}`).join(",")
	}}`
	seen.pop()
	return s
}

// every container in v
export function containers(v: unknown, out = new Set<object>()): Set<object> {
	if (!container(v) || out.has(v)) return out
	out.add(v)
	if (typed(v)) return out
	for (const x of isList(v) ? v : Object.values(v)) containers(x, out)
	return out
}

export function at(v: unknown, path: readonly unknown[]): unknown {
	for (const k of path) {
		if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return undefined
		if (!Object.hasOwn(v, k as PropertyKey)) return undefined
		v = (v as Record<string, unknown>)[k as string]
	}
	return v
}

// a deep copy keeping key order, typed arrays' kinds, -0; loops as they are
export function clone(v: unknown, seen = new Map<object, unknown>()): unknown {
	if (v === null || typeof v !== "object") return v
	if (seen.has(v)) return seen.get(v)
	if (ArrayBuffer.isView(v)) return (v as unknown as Int16Array).slice()
	if (isList(v)) {
		const o: unknown[] = []
		seen.set(v, o)
		for (const x of v) o.push(clone(x, seen))
		return o
	}
	const o: Record<string, unknown> = {}
	seen.set(v, o)
	for (const k of Object.keys(v)) {
		Object.defineProperty(o, k, {
			value: clone((v as Record<string, unknown>)[k], seen),
			writable: true,
			enumerable: true,
			configurable: true,
		})
	}
	return o
}

export type Options = {
	// check what was handed every n steps (big values), and at the end
	every?: number
	// leave out: the property names below, checked but not counted as failing (known ones)
	known?: (f: Failure, s: State) => boolean
	// no copy bound checks
	nocopies?: boolean
	// known failures met, by property
	seen?: Map<string, number>
}

export type State = {
	u: Unread
	e: Entry<unknown>
	oracle: unknown
	handed: { thing: unknown; was: string; what: string; loop?: boolean }[]
	// the last write landed, one plain put, with nothing read, kept or refused since
	last?: Patch
	steps: Step[]
}

const h = () => ({ time: 1, actor: "test" })
const TRACE = Deno.env.get("TRACE")

// a value given in a spec, made now
function give(s: State, g: Given, made: unknown[]): unknown {
	if ("data" in g) return clone(g.data)
	if ("same" in g) return made[g.same] ?? null
	const x = s.handed[g.ref]?.loop ? undefined : s.handed[g.ref]
	if (x === undefined) return null
	const v = at(x.thing, g.at)
	return v === undefined ? null : v
}
export function patches(s: State, specs: Spec[]): Patch[] {
	const made: unknown[] = []
	return specs.map((sp) => {
		if ("raw" in sp) return sp.raw as Patch
		const p: Record<string, unknown> = { path: sp.path }
		if (sp.range !== undefined) p.range = sp.range
		if (sp.move !== undefined) p.move = sp.move
		if (sp.value !== undefined) {
			p.value = give(s, sp.value, made)
			made.push(p.value)
		} else made.push(undefined)
		return p as Patch
	})
}

// what makes the unread under test (a mutant, to see the checks catch it)
let make: () => Unread = createUnread
export const use = (f: () => Unread) => void (make = f)

export function start(value: unknown): State {
	const u = make()
	return {
		u,
		e: createEntry<unknown>(clone(value), h()),
		oracle: clone(value),
		handed: [],
		steps: [],
	}
}

function hand(s: State, thing: unknown, what: string, loop = false) {
	s.handed.push({ thing, was: show(thing), what, loop })
}

// one step done to s, checked; a failure or undefined
export function step(s: State, st: Step, i: number, o: Options = {}): Failure | undefined {
	const no = (property: string, why: string): Failure => ({ at: i, property, why })
	s.steps.push(st)
	if (st.k === "read") {
		s.u.read(s.e)
		hand(s, s.e.value, `read at ${i}`)
		s.last = undefined
	} else if (st.k === "kept") {
		const v = at(s.e.value, st.path)
		let k: unknown = v
		if (st.wrap === 1) k = [v]
		else if (st.wrap === 2) {
			// a run made a map holding it twice, and itself
			const m: Record<string, unknown> = { x: v, y: [v, at(s.e.value, st.handed[0] ?? [])] }
			m.self = m
			k = m
		}
		const handed = st.handed.length
			? new Set(st.handed.map((p) => at(s.e.value, p)).filter(container))
			: undefined
		s.u.kept(k, handed)
		hand(s, k, `kept at ${i}`, st.wrap === 2)
		s.last = undefined
	} else {
		let ps: Patch[]
		if (st.k === "write") ps = patches(s, st.ps)
		else if (st.k === "unwrite") {
			const undo = s.e.change.op?.undo
			if (undo === undefined) return
			ps = undo as Patch[]
			s.last = undefined
		} else {
			// a plain put again where the last write put, nothing read since: no copy
			if (s.last === undefined) return
			ps = [{ path: s.last.path, value: st.value }]
		}
		const fail = write(s, ps, i, st.k, no, o)
		if (fail) return fail
	}
	const every = o.every ?? 1
	if (i % every === 0) return check(s, i)
}

export function check(s: State, i: number): Failure | undefined {
	for (const x of s.handed) {
		const now = show(x.thing)
		if (now !== x.was) {
			return {
				at: i,
				property: "handed-changed",
				why: `${x.what}: was ${cut(x.was)}, now ${cut(now)}`,
			}
		}
	}
}
const cut = (s: string) => s.length > 300 ? s.slice(0, 300) + "…" : s

function write(
	s: State,
	ps: Patch[],
	i: number,
	kind: string,
	no: (p: string, w: string) => Failure,
	o: Options,
): Failure | undefined {
	hand(s, ps, `${kind} at ${i}, its patches`)
	const ou: Patch[] = []
	let next: unknown, want: ApplyError | undefined
	try {
		next = apply(s.oracle, ps, { undo: ou })
	} catch (e) {
		if (!(e instanceof ApplyError)) throw e
		want = e
	}
	const root = s.e.value, before = sorted(root), was = containers(root)
	let got: unknown
	try {
		s.u.update(s.e, ps, h())
	} catch (e) {
		got = e
	}
	if (want) {
		s.last = undefined
		if (!(got instanceof ApplyError)) {
			return no("oracle", `oracle refuses ${want.code} at ${want.patch}, unread: ${got}`)
		}
		if (got.code !== want.code || got.patch !== want.patch) {
			return no(
				"oracle",
				`refused ${got.code} at ${got.patch}, oracle ${want.code} at ${want.patch}`,
			)
		}
		if (s.e.value !== root) return no("refused-changes", "a refused write moved the root")
		const now = sorted(s.e.value)
		if (now !== before) {
			return no("refused-changes", `before ${cut(before)}, after ${cut(now)}`)
		}
		return
	}
	if (got !== undefined) return no("oracle", `oracle takes it, unread throws ${got}`)
	s.oracle = next
	const v = sorted(s.e.value), want2 = sorted(s.oracle)
	if (v !== want2) return no("value", `unread ${cut(v)}, oracle ${cut(want2)}`)
	const undo = s.e.change.op!.undo
	if (sorted(undo) !== sorted(ou)) {
		return no("undo", `unread ${cut(show(undo))}, oracle ${cut(show(ou))}`)
	}
	hand(s, undo, `${kind} at ${i}, its undo`)
	if (!o.nocopies) {
		const theirs = new Set<object>()
		for (const p of ps) {
			if (p && typeof p === "object" && "value" in p) containers(p.value, theirs)
		}
		let fresh = 0
		for (const c of containers(s.e.value)) if (!was.has(c) && !theirs.has(c)) fresh++
		let bound = 0
		for (const p of ps) {
			bound += p.path.length + 1 + (p.range ? 2 : 0) + (p.move ? p.move.path.length + 2 : 0)
		}
		if (fresh > bound) return no("copies", `${fresh} new containers, bound ${bound}`)
		if (kind === "again" && fresh > 0) {
			return no("copies", `a put again where the last write put made ${fresh} containers`)
		}
		if (kind === "again" && s.e.value !== root) {
			return no("copies", "a put again where the last write put made a new root")
		}
	}
	const p = ps.length === 1 ? ps[0] : undefined
	// again only where the walk is through maps and lists
	const through = p && p.path.length > 0 && !p.move && !p.range &&
		p.path.slice(0, -1).every((_, j) => {
			const c = at(s.e.value, p.path.slice(0, j + 1))
			return isMap(c) || isList(c)
		}) &&
		(isMap(at(s.e.value, p.path.slice(0, -1))) || isList(at(s.e.value, p.path.slice(0, -1))))
	s.last = through ? p : undefined
}

// a whole run of steps from a start; the first failure (known ones passed by), or undefined
export function run(value: unknown, steps: Step[], o: Options = {}): Failure | undefined {
	const s = start(value)
	for (const [i, st] of steps.entries()) {
		const f = step(s, st, i, o)
		// a known one: what was handed checked, then the oracle takes the value from there
		if (f && o.known?.(f, s)) {
			const c = check(s, i)
			if (c) return c
			s.oracle = clone(s.e.value)
			continue
		}
		if (f) return f
	}
	return check(s, steps.length)
}

// fewest steps that still fail with the same property, then fewest patches in each write
export function shrink(value: unknown, steps: Step[], f: Failure, o: Options = {}): Step[] {
	const fails = (ss: Step[]) => run(value, ss, o)?.property === f.property
	let cur = steps.slice(0, f.at + 1)
	for (let n = Math.max(1, cur.length >> 1); n >= 1; n = n === 1 ? 0 : n >> 1) {
		for (let i = 0; i + n <= cur.length;) {
			const t = [...cur.slice(0, i), ...cur.slice(i + n)]
			if (t.length && fails(t)) cur = t
			else i += n
		}
	}
	for (let j = 0; j < cur.length; j++) {
		if (cur[j].k !== "write") continue
		for (let q = 0;;) {
			const st = cur[j] as Extract<Step, { k: "write" }>
			if (q >= st.ps.length || st.ps.length < 2) break
			const ps = st.ps.filter((_, x) => x !== q)
			// a later value naming an earlier patch's: renumbered, or content
			const t = [
				...cur.slice(0, j),
				{ k: "write" as const, ps: renumber(ps, q) },
				...cur.slice(j + 1),
			]
			if (fails(t)) cur = t
			else q++
		}
	}
	return cur
}
function renumber(ps: Spec[], gone: number): Spec[] {
	return ps.map((p) => {
		const v = p.value
		if (!v || !("same" in v)) return p
		if (v.same === gone) return { ...p, value: { data: null } }
		return v.same > gone ? { ...p, value: { same: v.same - 1 } } : p
	})
}

// a run made step by step: next gives the next step from the state; fails, shrunk
export function fuzz(
	value: unknown,
	n: number,
	next: (s: State, i: number) => Step,
	o: Options = {},
): { failure: Failure; steps: Step[]; shrunk: Step[] } | undefined {
	const s = start(value)
	for (let i = 0; i < n; i++) {
		const st = next(s, i)
		if (TRACE) console.error(i, says(st))
		let f = step(s, st, i, o)
		if (f && o.known?.(f, s)) {
			o.seen?.set(f.property, (o.seen.get(f.property) ?? 0) + 1)
			f = check(s, i)
			if (!f) s.oracle = clone(s.e.value)
		}
		if (f) {
			const steps = s.steps.slice()
			const shrunk = shrink(value, steps, f, o)
			return { failure: run(value, shrunk, o) ?? f, steps, shrunk }
		}
	}
	const f = check(s, n)
	if (f) {
		const steps = s.steps.slice()
		return { failure: f, steps, shrunk: shrink(value, steps, f, o) }
	}
}

// a step as JSON, for a report
export function says(st: Step): string {
	return JSON.stringify(
		st,
		(_k, v) =>
			ArrayBuffer.isView(v)
				? `${v.constructor.name}(${[...(v as unknown as Iterable<unknown>)]})`
				: typeof v === "bigint"
				? `${v}n`
				: v,
	)
}
