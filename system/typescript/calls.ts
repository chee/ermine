// calls: each handler's latest send, on a table of the records' own (beside runs.ts' runs: not
// the graph's table, not places'), by the handler's node id; and the sends waiting on a handler
// that isn't there. the latest per handler; a history layer can keep every call, through onRecord
// (chee 10-24). nothing saves this table today.
//
//   n         the call's number, from 1, one ermine's
//   caller    the sending process's id; the host's node's for the host's sends
//   context    the caller's context, as a value: where and as whom it sent (process, folder, at):
//             what a service acting for its caller resolves paths in and asks protect as
//   handler   { id, change }: the handler's node, and its value's change as called (which code ran)
//   args      as given, by reference (a big value lives as long as its record)
//   frame     the call's frame, by reference: its info { caller, handler, call: n }, then the frames
//             above it (a handler's, a process's: where it was called from is a walk up to the
//             locations, from outside the graph)
//   end       done | failed | pending: pending, the handler returned a promise (ended when it
//             settles) or threw PENDING (ended then: it waits on what it read)
//   returned  done: what it returned (a promise's: what it settled with)
//   error     failed: what it threw, as thrown
//   started   and ended: ms since 1970, fractional; ended none while a promise is out
//   reads     first-read order, each once: { part, id, path, change } (runs.ts' Read), the read
//             functions called in the call (a call is not a run: the api records them), none in a run
//             begun inside it. a send from inside a run: the call's own, beside the run's
//   writes    landing order: { part, id, change } (runs.ts' Write), with the call open, none in a
//             run begun inside it
//   made      the memos, effects and earlies made in the call (made by it, owned by the scope above: they stay): { kind, id, path }
//
// written through hold (createErmine's: onRecord around it; a hook not calling next: not held),
// then held as the latest per handler. read(id) tracked: what reads it reruns when a newer one is held.
// a handler gone (drop(id): its placement's scope gone, or its node removed): its record goes with
// it, its args and its caller's context too, and a call of it still going holds none as it ends
// a wait: a send to a node holding nothing (none there, or no value): { caller, path or id,
// since }, one per caller and target, kept while it waits: a computer's till its next run ends
// not waiting there, or it goes; another's till a send from it there is answered, or its scope
// goes. waits() tracked.
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
	// a record on its way to being held: keep(call) holds it (not called: not held)
	hold?: (id: Id, call: Call, keep: (call: Call) => void) => void
}

// a call going: its record so far
export type Going = {
	readonly n: number
	// the run open as it began (a send from a memo or effect): what is done in it is the call's
	readonly run: { readonly computer: unknown; readonly n: number } | undefined
	readonly base: Omit<Call, "end" | "reads" | "writes" | "made" | "ended">
	readonly reads: Read[]
	readonly seen: Set<string>
	readonly writes: Write[]
	readonly made: Made[]
	// its handler gone while it went: told hold as it ends, never held
	gone?: true
}

export type Calls = {
	// the next call's number, for its scope's info
	next: () => number
	// call n begins, frame its call's frame (its info { caller, handler, call: n }), the record's
	begin: (
		n: number,
		frame: Frame,
		base: Omit<Going["base"], "n" | "started" | "frame">,
	) => Going
	// it returned (a thenable: pending till it settles), threw, or threw PENDING
	end: (g: Going, out: { returned: unknown } | { error: unknown } | { pending: true }) => void
	// f run as call g's: it is the open call while f runs (a generator action's steps after the first
	// are not inside the call that began it); a call already ended pending is held again after
	during: <T>(g: Going, f: () => T) => T
	// the call's frame at or nearest above frame: the call being answered there, its record so far
	calling: (frame: Frame | undefined) => Going["base"] | undefined
	// the call open now: the innermost, no run begun inside it
	open: () => Going | undefined
	// a read function called: the open call's read
	read: (part: Key, id: Id, path: readonly Step[] | null, keys?: boolean) => void
	// the handler's latest call, tracked
	latest: (id: Id) => Call | undefined
	// a send to nothing: waiting from caller (a computer's node: in its run) at the target, till
	// scope goes (the computer's own, in a run; else the caller's context's)
	wait: (caller: Id, at: { path?: Path; id?: Id }, scope: Scope) => Wait
	// a send from caller there answered: its wait gone
	answered: (caller: Id, at: { path?: Path; id?: Id }) => void
	// every wait, or caller's; tracked
	waits: (caller?: Id) => Wait[]
	// a handler gone: its record out, its readers marked
	drop: (id: Id) => void
	stop: () => void
}

const now = () => performance.timeOrigin + performance.now()
export function createCalls(setup: Setup): Calls {
	const { scheduler: s, places, table } = setup
	let n = 0
	const stack: Going[] = []
	const frames = new WeakMap<Frame, Going>()
	// the calls begun and not ended yet (a promise's till it settles)
	const live = new Set<Going>()
	// the calls ended pending (a promise out): their record is held again as their steps write
	const pending = new WeakSet<Going>()
	// the records' table: a handler → its latest, and its key
	const records = new Map<Id, { call: Call | undefined; key: object }>()
	const held = (id: Id) => {
		let h = records.get(id)
		if (h === undefined) records.set(id, h = { call: undefined, key: {} })
		return h
	}
	// waits: by caller, then target; the list's key; each wait's run (a computer's) when made
	const waiting = new Map<Id, Map<string, { wait: Wait; run?: number }>>()
	const listKey = {}
	// the scopes told to take a caller's waits out as they go: each (caller, run) once per scope.
	// a computer's teardown runs after its next run too (it still alive: the waits are onRunEnd's
	// then); one registered per run, so none piles up
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
			// the latest is the call begun last: an earlier call settling later is told, not held
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

	// the innermost call, when what runs now is its: no run begun inside it since
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
		// a computer's waits left from its earlier runs go as a run ends without them
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
