// handlers: a handler is a node a process placed, ephemeral, whose value is a function. a call
// reaches it by address, asked of protect as the caller, and runs it as itself: the caller's agent
// with a step naming the process that placed it and the handler. a call made while a round or a
// part runs is checked now and run after; otherwise it is its own request.
import { type Graph, GraphError } from "@ermine/graph"
import type { Address, Place, Step } from "@ermine/graph/places"
import { type Agent, errorOf, normal } from "@ermine/scheduler/records"
import type { CallOp, Cause, Ctx, Moment, Proc } from "@ermine/scheduler/types"

export type From = { place: Place; agent: unknown; causes?: Cause }

export function createHandlers(o: {
	g: Graph<Proc>
	pass(m: Moment): void
	// protect, as the scheduler gives it: may actor call the handler at item. refused: throws
	mayCall(actor: unknown, item: { id: string; route: Step[] }): void
	// what a handler is given (process-api.ts)
	given(ctx: Ctx, alive: () => boolean, args: unknown): Record<string, unknown>
	// a part run as the process (processes.ts)
	part(p: Proc, fn: () => unknown): { value: unknown } | { error: unknown }
	// the scheduler's: a request, whether one may start now, and what runs after
	request<T>(f: () => T): T
	busy(): boolean
	queue(f: () => void): void
}) {
	// a call checked now, run later: what is wrong before it starts throws to the caller
	function prepare(op: CallOp, from: From): () => unknown {
		const items = o.g.places.look(from.place, op.address)
		const item = items.find((it) => it.node)
		if (!item) {
			throw new GraphError("nothing-there", "the address reaches nothing")
		}
		o.mayCall(from.agent, item)
		const definer = o.g.owner(item.id)
		const f = item.node!.value[0]?.content
		if (
			!o.g.ephemeral(item.id) ||
			!definer ||
			definer.state !== "running" ||
			typeof f !== "function"
		) {
			throw new GraphError(
				"not-a-handler",
				"the node is not a handler a process placed",
			)
		}
		const handler = op.address[op.address.length - 1] ?? ""
		const caller = normal(from.agent)
		const step: Record<string, unknown> = { process: definer.id }
		if (definer.program) step.program = definer.program
		step.handler = handler
		const agent: Agent = { ...caller, code: [...caller.code, step] }
		const ctx: Ctx = { p: definer, agent, base: { handler }, causes: from.causes }
		return () => {
			o.pass({ starts: definer.id, handler })
			let alive = true
			const given = o.given(ctx, () => alive, op.args)
			const done = o.part(definer, () => (f as (g: unknown) => unknown)(given))
			alive = false
			const ends: Moment = {
				ends: definer.id,
				handler,
				ended: "error" in done ? "failed" : "done",
			}
			if ("error" in done) ends.error = errorOf(done.error)
			o.pass(ends)
			if ("error" in done) throw done.error
			return done.value
		}
	}

	// a call: now, as its own request; or, while a round or a part runs, checked now and queued
	function call(op: CallOp, from: From): unknown {
		if (o.busy()) {
			const go = prepare(op, from)
			o.queue(() => {
				try {
					go()
				} catch {
					/* a queued call's error shows in its moments */
				}
			})
			return
		}
		return o.request(() => prepare(op, from)())
	}

	// the call a part is given: it lasts until the process is killed
	function callerOf(ctx: Ctx) {
		return (address: Address, args?: unknown) => {
			if (ctx.p.state === "gone") {
				throw new GraphError("stopped", "call: the process is gone")
			}
			const op: CallOp = { address }
			if (args !== undefined) op.args = args
			return call(op, {
				place: ctx.p.place,
				agent: ctx.agent,
				causes: ctx.causes,
			})
		}
	}

	return { call, callerOf }
}
