// processes: a process is an ephemeral node start makes, placed at an address, running a program
// (code, or a path the host's code finds). this file makes them, runs their parts, and kills them;
// when they run is the scheduler's, told through the hooks given.
//
// start: names checked, protect asked, the node made, its arguments nodes inside it, then placed.
// a part's start of a child named as one it started in the same part before gives that child
// again. killing: newest first, children, cleanups, its ephemeral nodes, then untracked; a process
// busy in a part is killed when the part ends.
import type { Change } from "../nodes/change.ts"
import {
	type Acting,
	type Api,
	type By,
	type Graph,
	GraphError,
	ours,
	type Reader,
} from "../graph/graph.ts"
import type { Address, Place, Step } from "../graph/places.ts"
import { normal, type Records, type Status, stepped } from "./records.ts"
import { capture, type Site } from "../nodes/stacktrace.ts"
import type {
	Cause,
	Child,
	Cleanup,
	Code,
	Ctx,
	Finder,
	Kept,
	PartCall,
	Proc,
	Run,
	StartOp,
} from "../scheduler/types.ts"

// the names from the root an address reaches from a place
function absolute(place: Place, address: Address): string[] {
	let i = 0
	const names = address[0] === "/" ? ((i = 1), []) : [...place]
	for (; address[i] === ".."; i++) names.pop()
	return [...names, ...address.slice(i)]
}

export function createProcesses(o: {
	g: Graph<Proc>
	clock: { time: number }
	actor: unknown
	site?: () => Site | undefined
	finder?: Finder
	procs: Map<string, Proc>
	records: Records<Proc>
	// protect, as the scheduler gives it: may actor start a process at item, named name, with
	// the id asked for. refused: throws
	mayStart(
		actor: unknown,
		item: { id: string; route: Step[] },
		name?: string,
		id?: string,
	): void
	// the interface a process's part is given (scheduler.ts)
	api(ctx: Ctx, o: { writes: boolean; alive: () => boolean }): Api
	// the scheduler's: a new process; due by the change that placed it; marked; being killed
	// (out of the order, its waiting run ended); gone
	started(p: Proc): void
	due(p: Proc, kept: Kept): void
	mark(p: Proc, by: By, causes?: Cause): void
	ending(p: Proc): void
	gone(p: Proc): void
}) {
	const { g, clock, procs, records } = o
	const deferred: { p: Proc; cause: By }[] = []
	// parts running now, of any process
	let active = 0

	// starting

	function start(op: StartOp, ctx?: Ctx): { id: string; change?: Change } {
		if (!Array.isArray(op.address)) {
			throw new GraphError("wrong-field", "address")
		}
		const program = op.program
		if (
			typeof program !== "function" &&
			!Array.isArray(program) &&
			!(
				program &&
				typeof (program as { compute?: unknown }).compute === "function"
			)
		) {
			throw new GraphError("wrong-field", "a program is a path or code")
		}
		if (Array.isArray(program) && o.finder === undefined) {
			throw new GraphError(
				"wrong-field",
				"a program by path needs the host's code",
			)
		}
		const caller = ctx?.p
		const call = ctx?.call
		if (call && op.name !== undefined) {
			const child = call.before.find(
				(c) =>
					c.name === op.name &&
					!call.matched.has(c) &&
					c.proc.state === "running" &&
					g.get(c.proc.id) !== undefined,
			)
			if (child) {
				call.matched.add(child)
				if (Array.isArray(program)) child.proc.path = program as Address
				else child.proc.code = program as Code
				if (call.replaced && child.replaced < caller!.replacements) {
					child.replaced = caller!.replacements
					replacing(
						child.proc,
						{ actor: ctx!.agent, reader: caller!.id },
						ctx!.causes,
					)
				}
				return { id: child.proc.id }
			}
		}
		const place = caller ? caller.place : [...(op.place ?? [])]
		const where = g.places.look(place, op.address).find((it) => it.node)
		if (!where) {
			throw new GraphError("nothing-there", "the address reaches nothing")
		}
		const who: Acting = ctx ? { actor: ctx.agent, reader: caller!.id } : (() => {
			const a: Acting = { actor: o.actor }
			const site = o.site ? o.site() : capture(ours)
			if (site) a.site = site
			return a
		})()
		if (ctx?.cause !== undefined) who.cause = ctx.cause
		// names: checked before anything is made
		for (
			const k of [
				...Object.keys(op.args ?? {}),
				...(op.name === undefined ? [] : [op.name]),
			]
		) {
			if (k === "." || k === ".." || k.includes("/")) {
				throw new GraphError("wrong-field", `start: ${k} is no name`)
			}
		}
		o.mayStart(who.actor, where, op.name, op.id)
		const pid = g.make(op.id, null, who)
		g.own(pid)
		const agent = normal(who.actor)
		const { person: _p, trusted: _t, code: _c, ...rest } = agent
		const p: Proc = {
			id: pid,
			name: op.name ?? pid,
			place: absolute(place, op.address),
			base: rest,
			prefix: [...agent.code],
			started: clock.time,
			children: [],
			owned: [],
			runs: 0,
			replaced: false,
			replacements: 0,
			setup: false,
			kept: new Map(),
			status: {},
			values: new Set(),
			cleanups: [],
			parked: false,
			state: "running",
			busy: 0,
			track: undefined as unknown as Reader,
		}
		p.track = g.reader(p)
		if (op.equal) p.equal = op.equal
		if (Array.isArray(program)) p.path = program as Address
		else {
			p.code = program as Code
			if (caller?.program) p.program = caller.program
		}
		procs.set(pid, p)
		o.started(p)
		if (caller && caller.state !== "gone") {
			p.parent = caller
			caller.children.push({
				proc: p,
				name: p.name,
				part: call?.part ?? "request",
				replaced: caller.replacements,
			})
			g.own(pid, caller)
		}
		// its arguments: nodes inside it, its own
		for (const [k, v] of Object.entries(op.args ?? {})) {
			const id = g.make(undefined, v, who)
			g.own(id, p)
			g.changing(who, { tag: ctx?.causes }, () => g.places.insert(pid, k, id))
		}
		const change = g.changing(
			who,
			{ tag: ctx?.causes, wrote: ctx?.run?.wrote },
			() => g.places.insert(where.id, p.name, pid),
		)
		o.due(p, {
			by: { ...change, which: ["children", p.name] },
			causes: ctx?.causes,
		})
		return { id: pid, change }
	}

	// start, as a part is given it: it stops when the part ends
	function starter(ctx: Ctx, alive: () => boolean) {
		return (op: StartOp) => {
			if (!alive()) {
				throw new GraphError("stopped", "start: this interface has stopped")
			}
			const { place: _, ...rest } = op ?? ({} as StartOp)
			return start(rest as StartOp, ctx)
		}
	}

	// replacing: an empty write at its pid, its status without new; due by it, run as replaced
	function replacing(p: Proc, who: Acting, causes?: Cause) {
		const { new: _n, ...status } = p.status as Status
		records.status(p, status, p.runs, causes, true)
		p.replaced = true
		p.replacements++
		o.mark(p, { ...who, time: clock.time, node: p.id, which: "value" }, causes)
	}

	// parts

	// a part run as the process: what it gave, or what it threw. a kill asked for while it ran
	// happens when it ends
	function part(
		p: Proc,
		fn: () => unknown,
	): { value: unknown } | { error: unknown } {
		p.busy++
		active++
		let out: { value: unknown } | { error: unknown }
		try {
			out = { value: fn() }
		} catch (e) {
			out = { error: e }
		} finally {
			p.busy--
			active--
		}
		unwind()
		return out
	}

	// a part's call: the children it started before, to be matched by name
	function partCall(p: Proc, name: string, replaced: boolean): PartCall {
		return {
			part: name,
			before: p.children.filter((c) => c.part === name),
			matched: new Set<Child>(),
			replaced,
		}
	}

	// when a part's call ends done, the children it started before and not again are released
	function settleChildren(ctx: Ctx) {
		const call = ctx.call!
		const cause: By = {
			actor: stepped(ctx.agent, { kill: ctx.p.id }),
			reader: ctx.p.id,
			time: 0,
			node: "",
		}
		for (const c of [...call.before].reverse()) {
			if (call.matched.has(c) || c.proc.state !== "running") continue
			g.release(c.proc.id, { ...cause, time: ++clock.time, node: c.proc.id })
			end(c.proc, cause)
		}
	}

	// cleanups

	function cleaner(p: Proc, alive: () => boolean) {
		return (f: Cleanup) => {
			if (!alive()) {
				throw new GraphError("stopped", "onCleanup: this interface has stopped")
			}
			if (typeof f !== "function") {
				throw new GraphError("wrong-field", "a cleanup is a function")
			}
			p.cleanups.push(f)
		}
	}

	// the cleanups, last first, each as the process; the first error
	function cleanups(p: Proc, killed: boolean, run?: Run): unknown {
		const list = p.cleanups.reverse()
		p.cleanups = []
		let first: unknown
		for (const f of list) {
			const agent = run ? records.runAgent(p, run.n) : records.agentOf(p, { cleanup: true })
			const ctx: Ctx = {
				p,
				agent,
				base: run ? { run: run.n } : { cleanup: true },
				run,
				causes: run?.causes,
			}
			let alive = true
			const api = o.api(ctx, { writes: true, alive: () => alive })
			const done = part(p, () => f({ killed, api }))
			alive = false
			if ("error" in done && first === undefined) first = done.error
		}
		return first
	}

	// killing

	function busy(p: Proc): boolean {
		if (p.busy > 0) return true
		return p.children.some((c) => c.proc.state === "running" && busy(c.proc))
	}

	function kill(killed: Proc[], cause: By) {
		const set = new Set(killed)
		const inside = (q: Proc) => {
			for (let x = q.parent; x; x = x.parent) if (set.has(x)) return true
			return false
		}
		const roots = killed
			.filter((q) => !inside(q))
			.sort((a, b) => b.started - a.started)
		for (const q of roots) end(q, cause)
	}

	// unwinding, newest first: not due; children; cleanups; its ephemeral nodes; untracked
	function end(p: Proc, cause: By) {
		if (p.state !== "running") return
		if (busy(p)) {
			deferred.push({ p, cause })
			return
		}
		p.state = "killing"
		o.ending(p)
		const killing = { ...cause, actor: stepped(cause.actor, { kill: p.id }) }
		for (const c of [...p.children].reverse()) {
			const q = c.proc
			if (q.state !== "running") continue
			g.release(q.id, { ...killing, time: ++clock.time, node: q.id })
			end(q, cause)
		}
		cleanups(p, true)
		for (const id of [...p.owned].reverse()) {
			if (g.get(id)) g.release(id, { ...killing, time: ++clock.time, node: id })
		}
		p.track.untrack()
		p.state = "gone"
		o.gone(p)
		procs.delete(p.id)
		if (p.parent) {
			p.parent.children = p.parent.children.filter((c) => c.proc !== p)
		}
	}

	function unwind() {
		for (let i = 0; i < deferred.length;) {
			const d = deferred[i]
			if (d.p.state !== "running") deferred.splice(i, 1)
			else if (busy(d.p)) i++
			else {
				deferred.splice(i, 1)
				end(d.p, d.cause)
				i = 0
			}
		}
	}

	return {
		start,
		starter,
		replacing,
		part,
		partCall,
		settleChildren,
		cleaner,
		cleanups,
		kill,
		active: () => active,
	}
}
