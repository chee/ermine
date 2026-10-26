// design K, Solid 2.0's api on ermine's nodes: the names and signatures of solid-js 2.0.0-rc.18
// (createSignal, createMemo, createEffect(compute, effect), createStore with a draft setter,
// isPending, latest, untrack, flush, onCleanup, action, refresh), as globals (as you'd import them
// from solid-js; the trial has no imports) and on api. what ermine needs that Solid has not,
// as little as can be, marked "ermine's" on the sheet:
//   name (Solid's own options field, a debug name there) is the node's path, the real api's paths
//     ("./x" the cwd, "/x" the root, a bare "x" in the program's own node). no name: a hidden node
//     of its own (.signal-N, .memo-N, .effect-N, .store-N in the program's own node)
//   createMethod(path, fn) and send(path, ...args): the real method and send (Solid has no word for
//     a handler at a path). a send to no handler throws the real PENDING: not ready, as an async read
// mapped: a getter is read (peep inside untrack); a setter replaces (an updater gets the previous
// value, as Solid's); a write to a node not there makes it (open); setStore is edit with a recipe
// by immer's rule (a changed draft wins, else what came back); createMemo is memo; createEffect is
// effect, never comparing (Solid's effects run their apply each time compute runs: equal () =>
// false), defer skips the first apply, apply's returned cleanup runs before the next and at stop;
// isPending(fn) is ermine's status: fn threw PENDING, or a memo it read is pending; onCleanup is
// teardown; flush is pulse.
// departures (README): reads see a write at once (Solid: after a flush); latest(fn) is fn() (no
// transitions); action runs its generator, its writes not held; isPending is also true while a
// read has no value yet (Solid: that is loading, not pending); NotInApi: refresh, createSignal(fn),
// createStore(fn), an effect's error arm
import type { NodeData as Node } from "@ermine/ermine"
import type { DataAPI } from "../../lib/compat.ts"
import type { Adapter } from "../../lib/trial.ts"
import { NODE, unwrap, whole } from "../../lib/handles.ts"
import { abs, isThen, missing, notInApi, TrialError } from "../../lib/contexts.ts"

let hidden = 0
type Opts = { name?: string; equals?: false | ((a: unknown, b: unknown) => boolean) }

const immer = (fn: (d: unknown) => unknown) => (d: unknown) => {
	const before = JSON.stringify(d)
	const r = fn(d)
	return JSON.stringify(d) !== before ? undefined : r
}

const adapter: Adapter = (api: DataAPI, extras) => {
	let untracking = 0
	// the getters read while isPending's fn runs
	let probing: Node[] | undefined
	const read = (n: Node, path?: (string | number)[]) =>
		untracking ? api.peep(n as never, path as never) : api.read(n as never, path as never)
	const named = (o: Opts | undefined, kind: string) => o?.name ?? `.${kind}-${++hidden}`
	// the parent folder of a computer's path, made when missing (the real memo and effect throw)
	const folder = (p: string) => {
		const path = api.open(p).path!
		const up = path.slice(0, -1)
		if (up.length && missing(api, { path: up, part: "value" })) api.make(abs(up))
	}
	const getter = (n: Node) =>
		Object.assign(() => {
			probing?.push(n)
			return read(n)
		}, { [NODE]: n })
	// a whole write: a node not there is made
	const put = (n: Node, v: unknown) => {
		if (missing(api, n)) api.open(abs(n.path!), v)
		else api.edit(n as never, whole(v) as never)
	}

	// a store: a node's value seen through a proxy, read by property (tracked at that path)
	const store = (n: Node, path: (string | number)[]): unknown => {
		const now = api.peep(n as never, path as never)
		return new Proxy(Array.isArray(now) ? [] : {}, {
			get(_, key) {
				if (key === NODE) return n
				const v = api.peep(n as never, path as never) as Record<PropertyKey, unknown>
				if (v === undefined || v === null) return read(n, path)
				const step = Array.isArray(v) && typeof key === "string" && /^\d+$/.test(key)
					? Number(key)
					: key
				const r = v[key]
				// a method, a symbol, or a list's length: the whole value at path
				if (
					typeof r === "function" || typeof key === "symbol" ||
					(Array.isArray(v) && step === key)
				) {
					const whole = read(n, path) as Record<PropertyKey, unknown>
					const f = whole?.[key]
					return typeof f === "function" ? f.bind(whole) : f
				}
				if (typeof r === "object" && r !== null) return store(n, [...path, step as string])
				return read(n, [...path, step as string])
			},
			has: (_, key) => key in Object(read(n, path)),
			ownKeys: () => Reflect.ownKeys(Object(read(n, path))),
			getOwnPropertyDescriptor(_, key) {
				const v = Object(read(n, path))
				const d = Reflect.getOwnPropertyDescriptor(v, key)
				if (d === undefined) return undefined
				return key === "length" && Array.isArray(v) ? d : { ...d, configurable: true }
			},
			set() {
				throw new TrialError("StoreWrite", "a store is changed through its setter")
			},
			deleteProperty() {
				throw new TrialError("StoreWrite", "a store is changed through its setter")
			},
		})
	}

	const words: Record<string, unknown> = {
		createSignal(value?: unknown, o?: Opts) {
			if (typeof value === "function") throw notInApi("createSignal(fn), a writable memo")
			const n = api.open(named(o, "signal"), value)
			const set = (v: unknown) => {
				const next = typeof v === "function" ? (v as (p: unknown) => unknown)(api.peep(n)) : v
				put(n, next)
				return next
			}
			return [getter(n), set]
		},
		createMemo(compute: (prev: unknown) => unknown, o?: Opts) {
			const p = named(o, "memo")
			folder(p)
			const equal = o?.equals === false ? () => false : o?.equals
			return getter(api.memo(p, (prev: unknown) => compute(prev) as never, { equal }))
		},
		createEffect(
			compute: (prev: unknown) => unknown,
			effect:
				| ((v: unknown, prev?: unknown) => unknown)
				| { effect: (v: unknown, prev?: unknown) => unknown; error?: unknown },
			o?: Opts & { defer?: boolean },
		) {
			if (typeof effect !== "function" && effect.error !== undefined) {
				throw notInApi("an effect's error arm")
			}
			const apply = typeof effect === "function" ? effect : effect.effect
			const p = named(o, "effect")
			folder(p)
			let cleanup: (() => void) | undefined
			let first = true
			api.effect(p, (prev: unknown) => compute(prev) as never, (v: unknown, before: unknown) => {
				if (first && o?.defer) return void (first = false)
				first = false
				cleanup?.()
				const r = apply(v, before)
				cleanup = typeof r === "function" ? r as () => void : undefined
			}, { equal: () => false })
			api.teardown(() => cleanup?.())
		},
		createStore(value: unknown, o?: Opts) {
			if (typeof value === "function") throw notInApi("createStore(fn), a projection")
			const n = api.open(named(o, "store"), value)
			const set = (fn: (d: unknown) => unknown) => {
				if (typeof fn !== "function") {
					throw new TrialError("BadSetter", "setStore takes a function of the draft")
				}
				if (missing(api, n)) {
					const made = fn(undefined)
					if (made !== undefined) api.open(abs(n.path!), made)
				} else api.edit(n as never, immer(fn) as never)
			}
			return [store(n, []), set]
		},
		isPending(fn: () => unknown) {
			const was = probing
			const seen: Node[] = []
			probing = seen
			let threw = false
			try {
				fn()
			} catch (e) {
				if (e !== api.PENDING) throw e
				threw = true
			} finally {
				probing = was
			}
			return threw || seen.some((n) => api.status(n as never)?.state === "pending")
		},
		latest: (fn: () => unknown) => fn(),
		untrack(fn: () => unknown) {
			untracking++
			try {
				return fn()
			} finally {
				untracking--
			}
		},
		flush(fn?: () => unknown) {
			const r = fn?.()
			api.pulse()
			return r
		},
		onCleanup(fn: () => void) {
			api.teardown(() => fn())
			return fn
		},
		action(gen: (...args: unknown[]) => Iterator<unknown> | AsyncIterator<unknown>) {
			return async (...args: unknown[]) => {
				const it = gen(...args)
				let r = await it.next()
				while (!r.done) {
					try {
						const v = isThen(r.value) ? await r.value : r.value
						r = await it.next(v)
					} catch (e) {
						if (it.throw === undefined) throw e
						r = await it.throw(e)
					}
				}
				return r.value
			}
		},
		refresh() {
			throw notInApi("refresh: a memo can't be asked to run again")
		},
		// ermine's
		createMethod: (p: string, fn: never) => getter(api.method(p, fn)),
		send: (p: unknown, ...args: unknown[]) => api.send(unwrap(p) as never, ...args),
		...extras,
	}
	for (const [k, v] of Object.entries(words)) {
		Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
	}
	return words
}
export default adapter
