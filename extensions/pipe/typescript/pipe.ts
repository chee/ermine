// @ermine/pipe: pipes, as a feature (extensions/pipe), built on @ermine/system's functions. a pipe
// is told each write at a node (from) and may carry it to another (to) [chee: "so it can replace
// watch, and also can be mirror, and also can be transform, and also can be translate"]:
//
//   import pipes, { pipe } from "@ermine/pipe"
//   const ermine = createErmine({ features: [pipes] })
//   // in a program:
//   pipe("a", (w) => console.log(w.value))                   // watch: told each write at a
//   pipe("a", "b")                                           // mirror: a's writes land at b
//   pipe("a", "b", (w) => [{ path: [], value: w.value * 2 }])  // transform: a write at a → b's patches
//   pipe("a", "b", there, back)                              // translate: back carries b's writes to a
//   pipe(["a", "c"], "b", (w) => …)                          // fan-in: one pipe; w.from says which
//   pipe("a", "b", { timing: "write", name: "copy" })        // options: last, a plain object
//
// the forms: pipe(from, to?, a?, b?, options?). the second a function: a watch (from, a, options?);
// else it is to. from a list: every node in it (a path written as a list of names: getNode it);
// with a list, b is refused. options: name (none: pipe-<n>, the n-th pipe the scope open made, in
// a run its run's n-th, so its owner's next run makes it again by place), timing ("pulse", the
// default, or "write").
// what a function is told, w: patches (the write's), change (its view: explain(w.change) gives its
// writer, so a write from a pipe shows as one), from (which node was written, as given), value (the
// node's value now). it gives back patches, written at to (b's: at from); nothing: nothing written.
// a watch's are not written anywhere. a mirror has no function: the write's own patches land.
//
// a pipe is a memo (createMemo, at name): its node, its scope, its status and its being made again
// and stopped are a memo's, so remove, unplace and rename treat it as one (ermine/system's index.ts
// says the rule), and a pipe made again by its owner's next run takes its new functions, ends and
// timing at its run. its run looks up each end by its path, as its maker (readEntries on the end's
// attributes: the path walked, a refusal asked, the value not read, so a write there runs nothing):
// an end not there, the pipe pending (waiting on it) and deaf; there again, it hears again. refused:
// failed, with the refusal. it tells its function nothing while pending. a later run, its ends
// paths from the ermine's root (no box), only walks them, and looks up again when one leads to
// another node (or none).
// telling: each in a scope of its own under the pipe's memo, its info { node: the pipe's node,
// feature: "pipe" } (explain: the pipe, written as itself), lasting till the next telling begins or
// the pipe goes, as a memo run's (a teardown added in a function: told replaced, or ended). as its
// maker: its writes asked by protect as that process.
// untracked. what the function throws (PENDING too) is the pipe's: its status says the latest
// telling's (failed, pending; done again once one goes through), never the writer's.
// a pipe never hears its own writes (a write whose change names its node).
// timing: "write", told as the write lands, inside the writer's write (a cycle of such pipes
// recurses as far as its functions carry it); "pulse", told in its memo's run at the first pulse
// that begins after the write: a write made outside every run and act is told in the pulse it asks
// for, one made in a run or act (a pipe's own telling's) in the next. a cycle of pulse pipes turns
// once a pulse, as long as its functions write: nothing stops it.
// sites: told in its run (pulse), its writes have the memo's site, the line that made the pipe;
// told as a write lands outside a run, the line that made the pipe too (its stack held at the make,
// read once at the first such write, then given as a build site: nothing captured a write); inside
// a run, the running computer's (the base's rule).
import {
	createMemo,
	getNode,
	type Node,
	type Patch,
	patch,
	peep,
	read,
	readEntries,
	type Target,
} from "@ermine/system"
import type { ChangeView, Feature, FeatureAPI } from "@ermine/system"
import { at, site } from "@ermine/system/site"
import { NODE } from "@ermine/core/places/header"
import { type Computer, PENDING, type Scope } from "@ermine/core/scheduler"
import type { ChangeHeader } from "@ermine/core/node/entry"
import type { Id, Key } from "@ermine/core/table"
import type { Path } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"

// what a pipe's function is told
export type Told = {
	readonly patches: readonly Patch[]
	readonly change: ChangeView
	readonly from: Target
	readonly value: unknown
}
export type Fn = (w: Told) => readonly Patch[] | undefined | void
export type Options = { readonly name?: string; readonly timing?: "pulse" | "write" }

const NAME = "pipe"

// what a make gave: the ends (value handles; then each end's attributes, which its run looks up),
// the functions and the timing. a pipe takes a new one as it is made again
type Spec = {
	readonly given: readonly Target[]
	readonly ends: readonly Node[]
	readonly looks: readonly Node[]
	// each end's path from the ermine's root, when every end has one and the maker's root is the
	// ermine's (no box): its run walks them, and looks up only when one leads somewhere else
	readonly paths?: readonly Path[]
	readonly parts: readonly Key[]
	// how many of ends are from (to, when there is one, last)
	readonly n: number
	readonly a?: Fn
	readonly b?: Fn
	readonly write: boolean
}
// where a pipe hears: an end of its, and the part
type Ear = { readonly p: Pipe; readonly end: number; readonly part: Key }
type Queued = {
	readonly end: number
	readonly part: Key
	readonly patches: readonly Patch[]
	readonly change: ChangeHeader
	readonly id: Id
}
type Pipe = {
	readonly c: Computer
	readonly key: object
	readonly info: Record<string, unknown>
	readonly gone: () => void
	spec: Spec
	// the ids its ends had when last looked up, the spec it heard them for, and its ears
	ids: readonly Id[]
	for?: Spec
	ears: [Id, Ear][]
	queue: Queued[]
	failed?: { e: unknown }
	write?: typeof patch
	// the latest telling's scope, and how many tellings are going on (one inside another)
	sc?: Scope
	depth: number
	stopped?: true
}

// one ermine's pipe feature: what pipe asks of it around its createMemo. making: the spec of the memo
// createMemo makes now (onCreateFunction takes it: a new pipe); made: that pipe. held by its hook
type Made = {
	readonly f: FeatureAPI
	making?: Spec
	made?: Pipe
	// the run a pipe's memo runs
	readonly run: (spec: Spec) => unknown
	// the new pipe made, heard at once; made again (none new): nothing
	readonly end: () => void
	readonly name: () => string
}
// every pipe feature set up, one per ermine, held weakly; one closed or let go dropped as it is met
const installed = new Set<WeakRef<Made>>()

const pipes: Feature = {
	name: NAME,
	files: [import.meta.url],
	setup(f) {
		const s = f.scheduler
		const live = new Map<Computer, Pipe>()
		const heard = new Map<Id, Ear[]>()
		// pipes to wake once the pulse going on ends
		const later = new Set<Pipe>()
		let host: ReturnType<FeatureAPI["getProcessContext"]> | undefined
		const counts = new WeakMap<Scope, { n: number; run?: number }>()

		// a pipe's memo run again: now, or (a run or act open: in a pulse) at the next pulse
		function wake(p: Pipe) {
			if (s.getRun() !== undefined) later.add(p)
			else s.mark([p.key])
			;(host ??= f.getProcessContext()).queuePulse()
		}

		function deaf(p: Pipe) {
			for (const [id, ear] of p.ears) {
				const at = heard.get(id)!
				at.splice(at.indexOf(ear), 1)
				if (at.length === 0) heard.delete(id)
			}
			p.ears = []
			p.ids = []
			p.for = undefined
		}
		function listen(p: Pipe, ids: readonly Id[]) {
			const { spec } = p
			if (p.for === spec && ids.every((id, i) => id === p.ids[i])) return
			deaf(p)
			p.ids = ids
			p.for = spec
			const { n, b, parts } = spec
			ids.forEach((id, i) => {
				// to is heard only when translating; a node twice, once
				if (i >= n && b === undefined) return
				const end = i < n ? i : -1
				if (p.ears.some(([x, e]) => x === id && (e.end < 0) === (end < 0))) return
				const ear: Ear = { p, end, part: parts[i] }
				const at = heard.get(id)
				if (at === undefined) heard.set(id, [ear])
				else at.push(ear)
				p.ears.push([id, ear])
			})
		}
		const stop = (p: Pipe) => {
			if (p.stopped || p.c.state === "alive") return
			p.stopped = true
			deaf(p)
			p.queue = []
			live.delete(p.c)
			later.delete(p)
		}

		// the id an end's lookup finds, as the maker; not there: PENDING (the read records the wait),
		// refused: the refusal
		const look = (x: Node): Id => {
			const it = readEntries(x)[0]
			if (it === undefined || it.refused) {
				read(x)
				throw PENDING
			}
			return f.dataOf(it.node)!.node.id!
		}

		// its writes: given its memo's site as a build site (the line that made the pipe, or its
		// setup's), read once at the first; in a run the base takes the running computer's, the same
		const writer = (p: Pipe) => {
			if (p.write !== undefined) return p.write
			const w = f.siteOf(p.c)
			return p.write = w === undefined
				? patch
				: at(site(w.file, w.line, w.column ?? 0, w.function), patch)
		}

		// a write at id told to p at its end (-1: to, translating): the function's patches written at
		// the other end
		function tell(p: Pipe, q: Queued) {
			const { spec } = p
			const { end, change } = q
			const back = end < 0
			const fn = back ? spec.b : spec.a
			const to = back ? spec.ends[0] : spec.ends[spec.n]
			// a telling's scope lasts till the next begins (its teardowns told replaced) or the pipe goes
			// (ended), as a memo run's does; one a telling still going is in stays
			const was = p.sc
			const sc = p.sc = s.createScope(p.info, p.c)
			if (was !== undefined && p.depth === 0) s.teardown(was)
			p.depth++
			try {
				s.runWithScope(sc, () => {
					const out = fn === undefined ? q.patches : fn({
						patches: q.patches,
						change: f.viewOf(change),
						from: spec.given[back ? spec.n : end],
						get value() {
							return f.places.peep(() => f.places.readValue(q.part, q.id))
						},
					})
					if (to !== undefined && out != null) writer(p)(to, out)
				})
				if (p.failed !== undefined) {
					p.failed = undefined
					if (spec.write) wake(p)
				}
			} catch (e) {
				p.failed = { e }
				if (spec.write) wake(p)
			} finally {
				p.depth--
			}
		}

		// a pipe's memo's run: its spec taken (made again: the new one), its ends looked up and heard,
		// what was queued told; the latest telling's throw, its own
		const run = (spec: Spec) => {
			const p = live.get(s.getRun()!.computer)
			if (p === undefined) return
			if (p.spec !== spec) {
				p.spec = spec
				p.write = undefined
			}
			s.registerTeardown(p.c, p.gone)
			s.track(p.key)
			let ids: Id[]
			try {
				const walked = p.for === spec ? spec.paths?.map((x) => get(f.places, x)) : undefined
				ids = walked?.every((id, i) => id === p.ids[i]) ? p.ids as Id[] : spec.looks.map(look)
			} catch (e) {
				deaf(p)
				p.queue = []
				throw e
			}
			listen(p, ids)
			// what was queued, told (made again with fewer ends: what came at one gone, not)
			for (const q of p.queue.splice(0)) {
				if (q.end < 0 ? spec.b !== undefined : q.end < spec.n) tell(p, q)
			}
			if (p.failed !== undefined) throw p.failed.e
		}

		f.onCreateFunction((m, next) => {
			const spec = me.making
			if (spec !== undefined && m.computer !== undefined) {
				me.making = undefined
				const c = m.computer
				const p: Pipe = {
					c,
					key: {},
					info: { [NODE]: m.id, feature: NAME },
					gone: () => stop(p),
					spec,
					ids: [],
					ears: [],
					queue: [],
					depth: 0,
				}
				live.set(c, p)
				s.registerTeardown(c, p.gone)
				me.made = p
			}
			next(m)
		})

		f.onWrite((o, w, next) => {
			const at = heard.get(w.id)
			if (at === undefined || w.gone) return next(o, w)
			const before = f.table.get(w.part, w.id)?.change
			next(o, w)
			const change = f.table.get(w.part, w.id)?.change
			// held back, or nothing landed
			if (change === undefined || change === before) return
			const by = change.metadata
			for (const ear of at.slice()) {
				const p = ear.p
				if (ear.part !== w.part || p.stopped || by?.[NODE] === p.info[NODE]) continue
				const q: Queued = { end: ear.end, part: w.part, patches: w.patches, change, id: w.id }
				if (p.spec.write) tell(p, q)
				else if (p.queue.push(q) === 1) wake(p)
			}
		})

		s.onAfterPulse(() => {
			if (later.size === 0) return
			for (const p of later) if (!p.stopped) s.mark([p.key])
			later.clear()
			;(host ??= f.getProcessContext()).queuePulse()
		})

		// pipe-<n>: the n-th the scope open made (in a run: its run's n-th)
		function nameOf() {
			const r = s.getRun()
			const key = r?.computer ?? s.getCurrentScope()!
			let c = counts.get(key)
			if (c === undefined || c.run !== r?.n) counts.set(key, c = { n: 0, run: r?.n })
			return `pipe-${++c.n}`
		}

		const me: Made = {
			f,
			run,
			end() {
				const p = me.made
				me.making = me.made = undefined
				// new: heard at once (its ends as they are now), not only from its first run
				if (p === undefined) return
				try {
					const ids = peep(() => p.spec.looks.map(look))
					if (ids !== undefined) listen(p, ids)
				} catch {
					// refused: its run says so
				}
			},
			name: nameOf,
		}
		installed.add(new WeakRef(me))
	},
}
export default pipes

const isOptions = (x: unknown): x is Options =>
	x !== null && typeof x === "object" && !Array.isArray(x) &&
	Object.getPrototypeOf(x) === Object.prototype

// a pipe made as the process calling (in a setup, a run or an action): its node
export function pipe(from: Target | readonly Target[], ...rest: unknown[]): Node {
	const o = isOptions(rest[rest.length - 1]) ? rest.pop() as Options : {}
	const [to, a, b] = typeof rest[0] === "function"
		? [undefined, rest[0] as Fn]
		: rest as [Target?, Fn?, Fn?]
	const froms = Array.isArray(from) ? from as readonly Target[] : [from as Target]
	if (froms.length === 0 || (b !== undefined && froms.length > 1)) {
		throw new Error("pipe: from is one node or more; translating, one")
	}
	const given = to === undefined ? froms : [...froms, to]
	const ends = given.map((x) => typeof x === "string" || Array.isArray(x) ? getNode(x) : x as Node)
	const m = featureOf(ends[0])
	const nodes = ends.map((x) => m.f.dataOf(x)!.node)
	const looks = nodes.map((d) => m.f.handleOf({ ...d, part: "attributes" }))
	const root = peep(() => readEntries("/"))[0]?.node
	const paths = nodes.every((d) => d.path !== undefined) &&
			root !== undefined && m.f.dataOf(root)!.node.id === m.f.places.root
		? nodes.map((d) => d.path!)
		: undefined
	const spec: Spec = {
		given,
		ends,
		looks,
		...paths !== undefined && { paths },
		parts: nodes.map((d) => d.part),
		n: froms.length,
		...a !== undefined && { a },
		...b !== undefined && { b },
		write: o.timing === "write",
	}
	const name = o.name ?? m.name()
	const { run } = m
	m.making = spec
	try {
		// its site the base's: in a setup the setup's, else the line that made it (held, read once)
		return createMemo(name, () => run(spec))
	} finally {
		m.end()
	}
}

// the pipe feature of the ermine that gave x
function featureOf(x: Node): Made {
	for (const r of installed) {
		const m = r.deref()
		try {
			if (m !== undefined && m.f.dataOf(x) !== undefined) return m
			if (m !== undefined) continue
		} catch {
			// closed
		}
		installed.delete(r)
	}
	throw new Error("pipe: no ermine with the pipe feature gave this node")
}
