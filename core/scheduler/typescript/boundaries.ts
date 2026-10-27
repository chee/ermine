// boundaries: scopes that catch what goes wrong under them, over the scheduler's hooks (the
// scheduler knows nothing of them). two kinds: a loading boundary catches the computations under it
// whose latest run ended pending; an errored boundary catches the ones whose latest run, or act,
// failed. only the nearest boundary of a kind above a computation catches it: a loading boundary
// passes failures up, an errored one passes pending up. what no boundary catches is as it was:
// told through onRunEnd and onEffect, nothing more.
//
// a computation leaves a boundary's list when a later run of it ends any other way (done,
// looping; a stopped run says nothing yet), or when it goes. what a boundary holds changes at once;
// its listeners are told once, after the pulse it changed in (a change between pulses: after the
// next). what they show is theirs to put in the graph.
//
// listening to onRunEnd keeps every run's reads (as a trace does)
import type { Computer, Scheduler, Scope } from "./scheduler.ts"

export type Kind = "loading" | "errored"

// a computation caught, the run it was caught at, and for an errored boundary what was thrown
export type Caught = { computer: Computer; run: number; error?: unknown }

export type Boundary = {
	readonly kind: Kind
	readonly scope: Scope
	// what it holds now, in the order caught: a new list after each change (made when asked), this
	// one left as it is
	caught: () => readonly Caught[]
	// f told after a pulse in which what it holds changed; gives back the remove
	on: (f: () => void) => () => void
	// no longer a boundary: what it held goes up to the next one of its kind, at its next end
	remove: () => void
}

export function createBoundaries(
	s: Pick<Scheduler, "onRunEnd" | "onEffect" | "onAfterPulse" | "registerTeardown">,
): {
	loading: (scope: Scope) => Boundary
	errored: (scope: Scope) => Boundary
} {
	// items: what it holds, with holes where one was let go (closed up once they are half); list:
	// the copy caught() gives, made when asked after a change
	type B = Boundary & {
		items: (Caught | undefined)[]
		holes: number
		list: readonly Caught[] | undefined
		fs: (() => void)[]
		changed: boolean
	}
	const boundaries = { loading: new Map<Scope, B>(), errored: new Map<Scope, B>() }
	// each computation ever caught: the boundary holding it now, if any, and where in its items. one
	// slot each, never deleted (a Map losing and gaining the same key slows as it grows, in V8)
	type Slot = { b: B | undefined; i: number }
	const held = new WeakMap<Computer, Slot>()

	// the nearest boundary of a kind above c, not c itself
	function nearest(kind: Kind, c: Computer): B | undefined {
		const of = boundaries[kind]
		for (let o = c.parent; o; o = o.parent) {
			const b = of.get(o)
			if (b) return b
		}
	}

	// the boundaries changed since the last pulse, told after the next
	let changed: B[] = []
	function tell(b: B) {
		if (b.changed) return
		b.changed = true
		changed.push(b)
	}
	// every listener told; what the first threw comes out after ("finish, then rethrow")
	s.onAfterPulse(() => {
		const bs = changed
		changed = []
		let failed: { error: unknown } | undefined
		for (const b of bs) {
			b.changed = false
			for (const f of b.fs) {
				try {
					f()
				} catch (error) {
					failed ??= { error }
				}
			}
		}
		if (failed) throw failed.error
	})

	function release(c: Computer) {
		const slot = held.get(c)
		const b = slot?.b
		if (b === undefined) return
		b.items[slot!.i] = undefined
		slot!.b = undefined
		b.list = undefined
		if (++b.holes > b.items.length >> 1) {
			b.items = b.items.filter((x) => x !== undefined)
			b.items.forEach((x, i) => held.get(x!.computer)!.i = i)
			b.holes = 0
		}
		tell(b)
	}

	// c caught by the nearest boundary of a kind, or by none: then only let go of
	function catches(kind: Kind, c: Computer, run: number, error?: unknown) {
		const b = nearest(kind, c)
		let slot = held.get(c)
		if (slot?.b !== undefined && slot.b !== b) release(c)
		if (b === undefined) return
		const item: Caught = kind === "errored" ? { computer: c, run, error } : { computer: c, run }
		if (slot === undefined) held.set(c, slot = { b: undefined, i: 0 })
		if (slot.b === b) b.items[slot.i] = item
		else {
			slot.b = b
			slot.i = b.items.length
			b.items.push(item)
		}
		b.list = undefined
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
			items: [],
			holes: 0,
			list: [],
			fs: [],
			changed: false,
			caught: () => b.list ??= b.items.filter((x) => x !== undefined),
			on: (f) => {
				b.fs = [...b.fs, f]
				return () => void (b.fs = b.fs.filter((g) => g !== f))
			},
			remove: () => {
				if (boundaries[kind].get(scope) !== b) return
				boundaries[kind].delete(scope)
				for (const x of b.items) if (x) held.get(x.computer)!.b = undefined
				b.items = []
				b.holes = 0
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
