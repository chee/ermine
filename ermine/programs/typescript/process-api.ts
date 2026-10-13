// the process api: everything a process's code is given, in one place. each part is called with
// one map, and which map depends on the part:
//
//   compute   { api, peep, start, by, pending, self, name }
//   setup     { api, start, call, onCleanup, self, name }
//   effect    the setup's, and { value, previous? }
//   handler   { api, start, call, self, name, args? }
//   cleanup   { killed, api }
//   code      the host's finder is given view: api, tracked, read only
//
// api: the graph's operations at the process's place, acting as the process. a compute's api is
// tracked and read only; peep reads untracked. by: the changes that marked this run. pending: what
// a compute returns while what it needs is not here. each map works until its part returns: alive
// says so, and after, its functions throw stopped.
import type { Api, By, Graph, Read, ReadArgs } from "@ermine/graph"
import type { Address, Depend } from "@ermine/places"
import {
	type Cleanup,
	type Ctx,
	PENDING,
	type Proc,
	type StartOp,
} from "@ermine/scheduler/types"

type Alive = () => boolean

// what the process api takes besides the graph: the scheduler's hooks around reads and changes,
// and start, call and onCleanup as the programs side makes them
export type Tools = {
	// the scheduler's: each read as the process, and each change as a request
	reading(op: string, f: Read, depend: Depend | undefined, ctx: Ctx, args: ReadArgs): unknown
	request<T>(f: () => T): T
	// start, call and onCleanup as a part is given them (processes.ts, handlers.ts)
	starter(ctx: Ctx, alive: Alive): (op: StartOp) => unknown
	callerOf(ctx: Ctx): (address: Address, args?: unknown) => unknown
	cleaner(p: Proc, alive: Alive): (f: Cleanup) => void
}

export function createProcessApi(graph: Graph<Proc>, o: Tools) {
	// the graph's operations, at the process's place, as the process
	function api(ctx: Ctx, a: { tracked?: boolean; writes: boolean; alive: Alive }): Api {
		const p = ctx.p
		const depend = a.tracked ? p.track.depend : undefined
		return graph.bound({
			place: p.place,
			agent: ctx.agent,
			reader: p.id,
			cause: ctx.cause,
			depend,
			writes: a.writes,
			alive: a.alive,
			owner: p,
			tag: ctx.causes,
			wrote: ctx.run?.wrote,
			reading: (op, f, args) => o.reading(op, f, depend, ctx, args),
			around: o.request,
		})
	}

	// a setup's or an effect part's: it may write, start, call and clean up
	function setup(ctx: Ctx, alive: Alive): Record<string, unknown> {
		return {
			api: api(ctx, { writes: true, alive }),
			start: o.starter(ctx, alive),
			call: o.callerOf(ctx),
			onCleanup: o.cleaner(ctx.p, alive),
			self: ctx.p.id,
			name: ctx.p.name,
		}
	}

	return {
		// what the host's code finder reads through
		view: (ctx: Ctx, alive: Alive) => api(ctx, { tracked: true, writes: false, alive }),

		compute: (ctx: Ctx, by: By[], alive: Alive): Record<string, unknown> => ({
			api: api(ctx, { tracked: true, writes: false, alive }),
			peep: api(ctx, { writes: false, alive }),
			start: o.starter(ctx, alive),
			by,
			pending: PENDING,
			self: ctx.p.id,
			name: ctx.p.name,
		}),

		setup,

		effect(ctx: Ctx, alive: Alive, value: unknown, previous?: { value: unknown }) {
			const given = setup(ctx, alive)
			given.value = value
			if (previous) given.previous = previous.value
			return given
		},

		handler(ctx: Ctx, alive: Alive, args: unknown): Record<string, unknown> {
			const given: Record<string, unknown> = {
				api: api(ctx, { writes: true, alive }),
				start: o.starter(ctx, alive),
				call: o.callerOf(ctx),
				self: ctx.p.id,
				name: ctx.p.name,
			}
			if (args !== undefined) given.args = args
			return given
		},

		cleanup: (ctx: Ctx, alive: Alive, killed: boolean) => ({
			killed,
			api: api(ctx, { writes: true, alive }),
		}),
	}
}

export type ProcessApi = ReturnType<typeof createProcessApi>
