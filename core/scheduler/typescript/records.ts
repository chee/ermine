// records: what the scheduler writes about a process into the graph, as that process. its status,
// a version in front of its value; its value; its latest run, the value of a node named run inside
// it. and who those changes are by: the process's agent, a step added to its starter's.
//
import createBecause from "@ermine/graph/because"
import createChange, { type Change, type Header } from "@ermine/graph/change"
import { type Graph, GraphError } from "@ermine/graph"
import type { Which } from "@ermine/op/mutate"
import type { Side } from "@ermine/graph/node"

type V = Side<unknown, Change>

export type Status = {
	pending?: number
	error?: unknown
	new?: unknown
	loop?: { through: string[]; value?: unknown }
}

export type Agent = {
	actor: unknown
	code: Record<string, unknown>[]
	[field: string]: unknown
}

// what records reads and keeps of a process
export type Recorded = {
	id: string
	state: string
	// its actor, but for its own step
	base: Record<string, unknown>
	prefix: Record<string, unknown>[]
	program?: { node: string; time: number }
	runs: number
	status: Status
	last?: { value: unknown }
	// its latest run's node
	run?: string
}

const isAgent = (a: unknown): a is Agent =>
	a !== null &&
	typeof a === "object" &&
	"actor" in a &&
	Array.isArray((a as Agent).code)

export const normal = (a: unknown): Agent => isAgent(a) ? a : { actor: a, code: [] }

export function stepped(a: unknown, add: Record<string, unknown>): Agent {
	const agent = normal(a)
	const last = agent.code[agent.code.length - 1]
	const code = last ? [...agent.code.slice(0, -1), { ...last, ...add }] : [add]
	return { ...agent, code }
}

export const isLive = (v: unknown) => typeof v === "function" || typeof v === "symbol"

// two values are the same when their members are: bytes and typed arrays by their elements, a
// typed array only as one of its own kind; a live value only as itself (an ArrayBuffer is one)
export function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
	if (a instanceof ArrayBuffer) return false
	if (ArrayBuffer.isView(a)) {
		const x = a as unknown as ArrayLike<unknown>, y = b as unknown as ArrayLike<unknown>
		if (x.length !== y.length) return false
		for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false
		return true
	}
	if (Array.isArray(a)) {
		const y = b as unknown[]
		if (a.length !== y.length) return false
		for (let i = 0; i < a.length; i++) if (!same(a[i], y[i])) return false
		return true
	}
	const x = a as Record<string, unknown>, y = b as Record<string, unknown>
	const keys = Object.keys(x)
	if (keys.length !== Object.keys(y).length) return false
	for (const k of keys) if (!Object.hasOwn(y, k) || !same(x[k], y[k])) return false
	return true
}

export const sameStatus = (a: Status, b: Status): boolean => same(a, b)

// an error as a status holds it
export function errorOf(e: unknown): unknown {
	if (e instanceof GraphError) return { code: e.code, message: e.message }
	if (e instanceof Error) {
		const out: Record<string, unknown> = { name: e.name, message: e.message }
		const code = (e as { code?: unknown }).code
		if (code !== undefined) out.code = code
		return out
	}
	return e
}

// what a run tells of itself in the latest run
export type Ran = {
	n: number
	given: readonly { by: { time?: number } }[]
	reads: unknown[]
	wrote: number[]
	rank: number
	stopped?: { id: string }
	equal?: boolean
	causes?: unknown
}

export function createRecords<P extends Recorded>(g: Graph<P>) {
	// the process's agent: its starter's, with its own step last
	function agentOf(p: P, step: Record<string, unknown>): Agent {
		const own: Record<string, unknown> = { process: p.id }
		if (p.program) own.program = p.program
		return { ...p.base, code: [...p.prefix, { ...own, ...step }] } as Agent
	}
	const runAgent = (p: P, n: number) => agentOf(p, n > 0 ? { run: n } : {})

	// a run's agent with its status: the last made again while the process, run and status are
	let kept: { p: P; n: number; status: Status; agent: Agent } | undefined
	function agentAt(p: P, n: number, status: Status): Agent {
		if (kept && kept.p === p && kept.n === n && sameStatus(kept.status, status)) return kept.agent
		const agent = agentOf(p, { ...(n > 0 ? { run: n } : {}), status })
		kept = { p, n, status, agent }
		return agent
	}

	// a change by the operation now, at id's which: told to the graph as what touched it, so its
	// telling whole is by this change; stored without the graph's hook
	function changeAt(id: string, which: Which): Change {
		const { patched, ...header } = g.by() as Header & {
			patched?: (p: unknown, f: unknown, id: string, which: Which) => void
		}
		patched?.(undefined, undefined, id, which)
		return createChange(id, header)
	}

	// the status a process's node shows, as a version in front of its value. tag: what the
	// change is made with (graph.ts)
	function status(
		p: P,
		status: Status,
		n = p.runs,
		tag?: unknown,
		force = false,
	) {
		if (p.state !== "running") return
		const node = g.get(p.id)
		if (!node) return
		if (!force && !shows(p.status) && !shows(status)) return
		g.changing(
			{ actor: agentAt(p, n, status), reader: p.id },
			{ own: p, tag, snap: [[p.id, "value"]] },
			() => putStatus(p, node, status),
		)
		p.status = status
	}
	const shows = (s: Status) => Object.keys(s).length > 0
	// the status's version, in front of the value, put, replaced or taken away
	function putStatus(p: P, node: { value: V[] }, status: Status) {
		const had = shows(p.status), has = shows(status)
		const change = changeAt(p.id, "value")
		const version: V = { content: status, change, because: createBecause("scheduler", "status") }
		if (!had && has) node.value = [version, ...node.value]
		else if (had && has) node.value = [version, ...node.value.slice(1)]
		else if (had && !has) node.value = node.value.slice(1)
		else node.value = node.value.map((v) => ({ ...v, change }))
	}

	// its value, behind its status; then the status, if not the same
	function value(p: P, value: unknown, st: Status, n: number, tag?: unknown) {
		const node = g.get(p.id)
		if (p.state !== "running" || !node) return
		p.last = { value }
		const agent = agentAt(p, n, st)
		const at = shows(p.status) ? 1 : 0
		g.changing(
			{ actor: agent, reader: p.id },
			{
				own: p,
				tag,
				snap: [[p.id, "value"]],
			},
			() => {
				const vs = node.value.slice()
				vs[at] = { content: value, change: changeAt(p.id, "value") }
				node.value = vs
			},
		)
		if (!sameStatus(st, p.status)) status(p, st, n, tag)
	}

	// the latest run: the value of a node named run inside the process, made the first time. what
	// it holds: the run's number, program, the times of the changes that marked it, its reads and
	// writes, rank, how it ended, the processes it is after. status: the process's new status, if it
	// changed, written in the same operation. answers the node's id when it made one
	function run(
		p: P,
		r: Ran,
		ended: string,
		error: unknown,
		after: string[],
		status?: Status,
	): string | undefined {
		if (p.state !== "running") return
		const node = g.get(p.id)
		if (!node) return
		const n = r.n
		const tag = r.causes
		const value: Record<string, unknown> = {
			run: n,
			program: p.program ?? null,
			by: r.given.map((k) => k.by.time),
			reads: r.reads,
			wrote: r.wrote,
			rank: r.rank,
			ended,
			after,
		}
		if (ended === "stopped" && r.stopped) value.waits = r.stopped.id
		if (r.equal !== undefined) value.equal = r.equal
		if (error !== undefined) value.error = error
		const there = p.run === undefined ? undefined : g.get(p.run)
		if (!there) {
			if (status) records.status(p, status, n, tag)
			const who = { actor: agentAt(p, n, p.status), reader: p.id }
			const id = g.make(undefined, value, who, true, p)
			p.run = id
			g.changing(who, { own: p, tag }, () => g.places.insert(p.id, "run", id))
			return id
		}
		const st = status ?? p.status
		const snap: [string, Which][] = status
			? [[p.id, "value"], [there.id, "value"]]
			: [[there.id, "value"]]
		g.changing({ actor: agentAt(p, n, st), reader: p.id }, { own: p, tag, snap }, () => {
			if (status) putStatus(p, node, status)
			const vs = there.value.slice()
			vs[0] = { content: value, change: changeAt(there.id, "value") }
			there.value = vs
		})
		if (status) p.status = status
	}

	// the times of the changes that set what a read got
	function times(items: readonly unknown[]): number[] {
		const out: number[] = []
		const add = (t: unknown) => {
			if (typeof t === "number" && !out.includes(t)) out.push(t)
		}
		for (const it of items) {
			if (typeof it !== "object" || it === null) continue
			const i = it as { route?: { node: string; name: string }[]; versions?: V[] }
			if (i.versions) {
				for (const v of i.versions) add(v.change?.time)
			}
			const step = i.route?.[i.route.length - 1]
			if (step) {
				add(g.get(step.node)?.children.get(step.name)?.[0]?.change?.time)
			}
		}
		return out
	}

	const records = { agentOf, runAgent, status, value, run, times }
	return records
}

export type Records<P extends Recorded> = ReturnType<typeof createRecords<P>>
