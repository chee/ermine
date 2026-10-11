// records: what the scheduler writes about a process into the graph, as that process. its status,
// a version in front of its value; its value; its latest run, the value of a node named run inside
// it. and who those changes are by: the process's agent, a step added to its starter's.
//
import createBecause from "../nodes/because.ts"
import createChange, { type Change } from "../nodes/change.ts"
import { type Graph, GraphError } from "../graph/graph.ts"
import mutate from "../opstreams/mutate.ts"
import type { Version } from "../nodes/node.ts"

type V = Version<unknown, Change>

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

// two statuses are the same when their fields are; errors when their messages are
export function sameStatus(a: Status, b: Status): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	for (const k of keys) {
		const x = (a as Record<string, unknown>)[k]
		const y = (b as Record<string, unknown>)[k]
		if (x === undefined || y === undefined) return false
		if (JSON.stringify(x) !== JSON.stringify(y)) return false
	}
	return true
}

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

export function createRecords<P extends Recorded>(g: Graph<P>) {
	// the process's agent: its starter's, with its own step last
	function agentOf(p: P, step: Record<string, unknown>): Agent {
		const own: Record<string, unknown> = { process: p.id }
		if (p.program) own.program = p.program
		return { ...p.base, code: [...p.prefix, { ...own, ...step }] } as Agent
	}
	const runAgent = (p: P, n: number) => agentOf(p, n > 0 ? { run: n } : {})

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
		const had = Object.keys(p.status).length > 0
		const has = Object.keys(status).length > 0
		if (!force && !had && !has) return
		const agent = agentOf(p, { ...(n > 0 ? { run: n } : {}), status })
		g.changing(
			{ actor: agent, reader: p.id },
			{ own: p, tag, snap: [[p.id, "value"]] },
			() => {
				const change = createChange(p.id, g.by())
				const version: V = {
					content: status,
					change,
					because: createBecause("scheduler", "status"),
				}
				if (!had && has) node.value = [version, ...node.value]
				else if (had && has) node.value = [version, ...node.value.slice(1)]
				else if (had && !has) node.value = node.value.slice(1)
				else node.value = node.value.map((v) => ({ ...v, change }))
			},
		)
		p.status = status
	}

	// its value, behind its status; then the status, if not the same
	function value(p: P, value: unknown, st: Status, n: number, tag?: unknown) {
		const node = g.get(p.id)
		if (p.state !== "running" || !node) return
		p.last = { value }
		const had = Object.keys(p.status).length > 0
		const agent = agentOf(p, { run: n, status: st })
		const at = had ? 1 : 0
		g.changing(
			{ actor: agent, reader: p.id },
			{
				own: p,
				tag,
				snap: [[p.id, "value"]],
			},
			() => {
				const change = createChange(p.id, g.by())
				const vs = node.value.slice()
				vs[at] = { content: value, change }
				node.value = vs
			},
		)
		if (!sameStatus(st, p.status)) status(p, st, n, tag)
	}

	// the latest run: the value of a node named run inside the process, made the first time.
	// answers the node's id when it made one
	function run(
		p: P,
		n: number,
		value: Record<string, unknown>,
		tag?: unknown,
	): string | undefined {
		if (p.state !== "running" || !g.get(p.id)) return
		const agent = agentOf(p, { run: n, status: p.status })
		const who = { actor: agent, reader: p.id }
		const how = { own: p, tag }
		const there = p.run === undefined ? undefined : g.get(p.run)
		if (there) {
			g.changing(who, how, () => mutate(there, "value", [{ path: [], value }], g.by()))
			return
		}
		const id = g.make(undefined, value, who)
		g.own(id, p)
		p.run = id
		g.changing(who, how, () => g.places.insert(p.id, "run", id))
		return id
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

	return { agentOf, runAgent, status, value, run, times }
}

export type Records<P extends Recorded> = ReturnType<typeof createRecords<P>>
