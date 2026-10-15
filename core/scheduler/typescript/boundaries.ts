// boundaries: scopes that catch what goes wrong under them, over the scheduler's hooks (the
// scheduler knows nothing of them). two kinds: a loading boundary catches the computations under it
// whose latest run ended pending; an errored boundary catches the ones whose latest run, or act,
// failed. only the nearest boundary of a kind above a computation catches it: a loading boundary
// passes failures up, an errored one passes pending up. what no boundary catches is as it was:
// told through onRunEnd and onEffect, nothing more.
//
// a computation leaves a boundary's list when a later run of it ends any other way (done,
// looping; a stopped run says nothing yet), or when it goes. a boundary's list changing tells its
// listeners, in the run's end or the act; what they show is theirs to put in the graph.
//
// listening to onRunEnd keeps every run's reads (as a trace does)
import type { Computer, Scheduler, Scope } from "./scheduler.ts"

export type Kind = "loading" | "errored"

// a computation caught, the run it was caught at, and for an errored boundary what was thrown
export type Caught = { computer: Computer; run: number; error?: unknown }

export type Boundary = {
	readonly kind: Kind
	readonly scope: Scope
	// what it holds now, in the order caught: a new list at each change, this one left as it is
	caught: () => readonly Caught[]
	// f told when what it holds changes; gives back the remove
	on: (f: () => void) => () => void
	// no longer a boundary: what it held goes up to the next one of its kind, at its next end
	remove: () => void
}

export function createBoundaries(
	s: Pick<Scheduler, "onRunEnd" | "onEffect" | "registerTeardown">,
): {
	loading: (scope: Scope) => Boundary
	errored: (scope: Scope) => Boundary
} {
	type B = Boundary & { list: Caught[]; fs: (() => void)[] }
	const boundaries = { loading: new Map<Scope, B>(), errored: new Map<Scope, B>() }
	// each computation caught, and where
	const held = new Map<Computer, B>()

	// the nearest boundary of a kind above c, not c itself
	function nearest(kind: Kind, c: Computer): B | undefined {
		const of = boundaries[kind]
		for (let o = c.parent; o; o = o.parent) {
			const b = of.get(o)
			if (b) return b
		}
	}

	function tell(b: B) {
		for (const f of b.fs) f()
	}

	function release(c: Computer) {
		const b = held.get(c)
		if (b === undefined) return
		held.delete(c)
		b.list = b.list.filter((x) => x.computer !== c)
		tell(b)
	}

	// c caught by the nearest boundary of a kind, or by none: then only let go of
	function catches(kind: Kind, c: Computer, run: number, error?: unknown) {
		const b = nearest(kind, c)
		const was = held.get(c)
		if (was !== undefined && was !== b) release(c)
		if (b === undefined) return
		const item: Caught = kind === "errored" ? { computer: c, run, error } : { computer: c, run }
		if (was === b) b.list = b.list.map((x) => x.computer === c ? item : x)
		else {
			held.set(c, b)
			b.list = [...b.list, item]
		}
		// a teardown of c runs at its next run's start, too: there it is still alive, and that run's
		// end says what it is
		s.registerTeardown(c, () => {
			if (c.state !== "alive") release(c)
		})
		tell(b)
	}

	s.onRunEnd((c, n, ended, _reads, more) => {
		if (ended === "stopped") return
		if (ended === "pending") catches("loading", c, n)
		else if (ended === "failed") catches("errored", c, n, more.error)
		else release(c)
	})
	s.onEffect((c, n, more) => {
		if ("error" in more) catches("errored", c, n, more.error)
	})

	function make(kind: Kind, scope: Scope): Boundary {
		if (boundaries[kind].has(scope)) throw new Error(`already a ${kind} boundary`)
		const b: B = {
			kind,
			scope,
			list: [],
			fs: [],
			caught: () => b.list,
			on: (f) => {
				b.fs = [...b.fs, f]
				return () => void (b.fs = b.fs.filter((g) => g !== f))
			},
			remove: () => {
				if (boundaries[kind].get(scope) !== b) return
				boundaries[kind].delete(scope)
				for (const x of b.list) held.delete(x.computer)
				b.list = []
				tell(b)
			},
		}
		boundaries[kind].set(scope, b)
		// it goes with its scope (a computation's teardowns also run before each run of it)
		const gone = () => (scope.state !== "alive" ? b.remove() : s.registerTeardown(scope, gone))
		s.registerTeardown(scope, gone)
		return b
	}

	return {
		loading: (scope) => make("loading", scope),
		errored: (scope) => make("errored", scope),
	}
}
