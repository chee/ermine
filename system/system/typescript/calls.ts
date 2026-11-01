// Calls: each handler's latest send, kept by the handler's node id, and the sends waiting on a
// handler that is not there. Only the latest call per handler is kept.
//
//   n         the call's number, from 1
//   caller    the sending process's id, or the host node's id
//   context   the caller's context as a value (process, folder, at)
//   handler   { id, change }: the handler's node and its value's change as called
//   args      as given, by reference
//   frame     the call's frame, by reference
//   end       done | failed | pending (a promise is out, or it threw PENDING)
//   returned  what it returned, or what its promise settled with
//   error     what it threw
//   started   ms since 1970; ended is none while a promise is out
//   reads     { part, id, path, change } in first-read order, once each
//   writes    { part, id, change } in landing order
//   made      the memos, effects and earlies made in the call: { kind, id, path }
//
// A handler that goes takes its record with it. A wait is a send to a node holding nothing: one
// per caller and target, kept until it is answered or its scope goes.
import type { ChangeHeader, Frame } from "@ermine/graph/entry"
import type { Key as Step } from "@ermine/changeable/apply"
import type { Fact, Id, Path, Places } from "@ermine/places"
import type { Read, Write } from "@ermine/processes/runs"
import type { Scheduler, Scope } from "@ermine/reactivity"
import { isPromise } from "@ermine/reactivity/helpers"
import type { Key, Table } from "@ermine/graph/table"
import type { ProcessContext } from "./context.ts"

export type Made = {
	readonly kind: "memo" | "effect" | "early"
	readonly id: Id
	readonly path: Path
}

export type Call = {
	readonly n: number
	readonly caller: Id
	readonly context: ProcessContext
	readonly handler: { readonly id: Id; readonly change: ChangeHeader | undefined }
	readonly args: readonly unknown[]
	readonly frame: Frame
	readonly end: "done" | "failed" | "pending"
	readonly returned?: unknown
	readonly error?: unknown
	readonly started: number
	readonly ended?: number
	readonly reads: readonly Read[]
	readonly writes: readonly Write[]
	readonly made?: readonly Made[]
}

export type Wait = {
	readonly caller: Id
	readonly path?: Path
	readonly id?: Id
	readonly since: number
}

export type Setup = {
	scheduler: Pick<
		Scheduler,
		"getRun" | "track" | "mark" | "onRunEnd" | "registerTeardown"
	>
	places: Pick<Places, "watchAll">
	table: Pick<Table, "get">
	hold?: (id: Id, call: Call, keep: (call: Call) => void) => void
}

export type Going = {
	readonly n: number
	readonly run: { readonly computer: unknown; readonly n: number } | undefined
	readonly base: Omit<Call, "end" | "reads" | "writes" | "made" | "ended">
	readonly reads: Read[]
	readonly seen: Set<string>
	readonly writes: Write[]
	readonly made: Made[]
	gone?: true
}

export type Calls = {
	next: () => number
	begin: (
		n: number,
		frame: Frame,
		base: Omit<Going["base"], "n" | "started" | "frame">,
	) => Going
	end: (g: Going, out: { returned: unknown } | { error: unknown } | { pending: true }) => void
	// Runs f as call g's. Generator action steps after the first are not inside the call that began them.
	during: <T>(g: Going, f: () => T) => T
	calling: (frame: Frame | undefined) => Going["base"] | undefined
	open: () => Going | undefined
	read: (part: Key, id: Id, path: readonly Step[] | null, keys?: boolean) => void
	latest: (id: Id) => Call | undefined
	wait: (caller: Id, at: { path?: Path; id?: Id }, scope: Scope) => Wait
	answered: (caller: Id, at: { path?: Path; id?: Id }) => void
	waits: (caller?: Id) => Wait[]
	drop: (id: Id) => void
	stop: () => void
}

const now = () => performance.timeOrigin + performance.now()
export function createCalls(setup: Setup): Calls {
	const { scheduler: s, places, table } = setup
	let n = 0
	const stack: Going[] = []
	const frames = new WeakMap<Frame, Going>()
	const live = new Set<Going>()
	const pending = new WeakSet<Going>()
	const records = new Map<Id, { call: Call | undefined; key: object }>()
	const held = (id: Id) => {
		let h = records.get(id)
		if (h === undefined) records.set(id, h = { call: undefined, key: {} })
		return h
	}
	const waiting = new Map<Id, Map<string, { wait: Wait; run?: number }>>()
	const listKey = {}
	// A computer's waits are taken out as it goes, and also after its next run, once per run.
	const armed = new WeakMap<Scope, Set<string>>()
	function arm(scope: Scope, caller: Id, run: number | undefined) {
		const tag = `${String(caller)}\u0000${run ?? ""}`
		let set = armed.get(scope)
		if (set === undefined) armed.set(scope, set = new Set())
		if (set.has(tag)) return
		set.add(tag)
		const mine = set
		s.registerTeardown(scope, () => {
			mine.delete(tag)
			if (scope.state === "alive") return
			if (waiting.delete(caller)) s.mark([listKey])
		})
	}
	const targetKey = (at: { path?: Path; id?: Id }) =>
		at.path !== undefined ? JSON.stringify(at.path) : `#${String(at.id)}`

	function write(id: Id, call: Call, gone?: true) {
		const put = (c: Call) => {
			if (gone) return
			const h = held(id)
			// The latest call is the one begun last; an earlier call settling later is told, not held.
			if (h.call !== undefined && h.call.n > c.n) return
			h.call = c
			s.mark([h.key], s.getRun())
		}
		if (setup.hold) setup.hold(id, call, put)
		else put(call)
	}

	function record(g: Going, end: Call["end"], more: Partial<Call>) {
		if (end !== "pending" || "ended" in more) live.delete(g)
		const c = {
			...g.base,
			end,
			...more,
			reads: g.reads.slice(),
			writes: g.writes.slice(),
			...g.made.length ? { made: g.made.slice() } : {},
		}
		write(g.base.handler.id, c, g.gone)
	}

	const open = () => {
		const g = stack[stack.length - 1]
		if (g === undefined) return undefined
		const r = s.getRun()
		return r?.computer === g.run?.computer && r?.n === g.run?.n ? g : undefined
	}

	const offs = [
		places.watchAll((f: Fact) => {
			const g = open()
			if (g !== undefined) g.writes.push({ part: f.part, id: f.id, change: f.change })
		}),
		s.onRunEnd((c, rn) => {
			const id = c.info.node as Id | undefined
			const mine = id === undefined ? undefined : waiting.get(id)
			if (mine === undefined) return
			let gone = false
			for (const [k, w] of mine) if (w.run !== rn) mine.delete(k), gone = true
			if (mine.size === 0) waiting.delete(id!)
			if (gone) s.mark([listKey])
		}),
	]

	return {
		next: () => ++n,
		begin(k, frame, base) {
			const r = s.getRun()
			const g: Going = {
				n: k,
				run: r === undefined ? undefined : { computer: r.computer, n: r.n },
				base: { ...base, n: k, frame, started: now() } as Going["base"],
				reads: [],
				seen: new Set(),
				writes: [],
				made: [],
			}
			stack.push(g)
			frames.set(frame, g)
			live.add(g)
			return g
		},
		end(g, out) {
			const i = stack.lastIndexOf(g)
			if (i !== -1) stack.splice(i, 1)
			if ("pending" in out) return record(g, "pending", { ended: now() })
			if ("error" in out) return record(g, "failed", { error: out.error, ended: now() })
			const r = out.returned
			if (!isPromise(r)) return record(g, "done", { returned: r, ended: now() })
			record(g, "pending", {})
			pending.add(g)
			r.then(
				(v) => record(g, "done", { returned: v, ended: now() }),
				(e) => record(g, "failed", { error: e, ended: now() }),
			)
		},
		during(g, f) {
			stack.push(g)
			try {
				return f()
			} finally {
				const i = stack.lastIndexOf(g)
				if (i !== -1) stack.splice(i, 1)
				if (pending.has(g) && live.has(g)) record(g, "pending", {})
			}
		},
		calling(frame) {
			for (let o = frame; o !== undefined; o = o.parent) {
				const g = frames.get(o)
				if (g !== undefined) return g.base
			}
			return undefined
		},
		open,
		read(part, id, path, keys) {
			const g = open()
			if (g === undefined) return
			const k = `${String(part)}\u0000${String(id)}\u0000${JSON.stringify(path)}${
				keys ? "+" : ""
			}`
			if (g.seen.has(k)) return
			g.seen.add(k)
			const change = table.get(part, id)?.change
			g.reads.push(keys ? { part, id, path, keys: true, change } : { part, id, path, change })
		},
		latest(id) {
			const h = held(id)
			s.track(h.key)
			return h.call
		},
		wait(caller, at, scope) {
			let mine = waiting.get(caller)
			if (mine === undefined) waiting.set(caller, mine = new Map())
			const k = targetKey(at)
			const run = s.getRun()?.n
			arm(scope, caller, run)
			const had = mine.get(k)
			if (had !== undefined) {
				had.run = run
				return had.wait
			}
			const wait: Wait = {
				caller,
				...at.path !== undefined ? { path: at.path } : { id: at.id },
				since: now(),
			}
			mine.set(k, { wait, run })
			s.mark([listKey])
			return wait
		},
		answered(caller, at) {
			const mine = waiting.get(caller)
			if (mine === undefined || !mine.delete(targetKey(at))) return
			if (mine.size === 0) waiting.delete(caller)
			s.mark([listKey])
		},
		waits(caller) {
			s.track(listKey)
			if (caller !== undefined) {
				return [...waiting.get(caller)?.values() ?? []].map((w) => w.wait)
			}
			return [...waiting.values()].flatMap((m) => [...m.values()].map((w) => w.wait))
		},
		drop(id) {
			for (const g of live) if (g.base.handler.id === id) g.gone = true
			const h = records.get(id)
			if (h === undefined) return
			records.delete(id)
			s.mark([h.key])
		},
		stop: () => {
			for (const off of offs) off()
		},
	}
}
