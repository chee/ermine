// keyed: one onMark and one onTrackingEnd listener per scheduler, however many holders there are,
// each told only the marks (and ends) of the keys it holds. a holder that listened to the scheduler
// itself would hear every mark; here a mark costs the keys it names, not the holders there are.
// createSelector is the shape one level down: the keys are the values a source can take, and a
// reader tracks one of them.
//
//   const isSelected = createSelector(scheduler, () => current())   // in a scope
//   createComputer(() => isSelected("a") ? "on" : "off", paint)      // reruns only as "a" is gained or lost
//
// when the source moves from a to b, only the readers of a and of b rerun; a reader of c does not.
import type { Computer, Run, Scheduler } from "./scheduler.ts"

// what a holder is told, of the keys it holds. marked: the keys of a mark that it holds (in the
// mark's order), and the mark; ended: a held key that nobody tracks any more (the holder lets go of
// it, or not: dropping is its own)
export type Holder = {
	marked?: (
		keys: readonly unknown[],
		run: Run | undefined,
		due: Computer[],
		tick: number,
	) => void
	ended?: (key: unknown) => void
}

export type Keyed = {
	// h hears the marks and ends of key from now (a second hold of the same pair: nothing)
	hold: (key: unknown, h: Holder) => void
	// h hears them no more
	drop: (key: unknown, h: Holder) => void
	// how many times a holder has been told a mark, all together
	deliveries: () => number
}

const indexes = /* @__PURE__ */ new WeakMap<object, Keyed>()

// the index of a scheduler, made once
export function keyed(s: Pick<Scheduler, "onMark" | "onTrackingEnd">): Keyed {
	let index = indexes.get(s)
	if (index !== undefined) return index
	const held = new Map<unknown, Set<Holder>>()
	let told = 0
	// what one mark's telling uses, kept between marks: the holders it names, each with its keys.
	// the few are found by a scan, the many by idx. a marked that marks again is told in scratch of
	// its own
	const hs: Holder[] = []
	const ls: unknown[][] = []
	const idx = new Map<Holder, number>()
	let busy = false
	s.onMark((keys, run, due, tick) => {
		if (held.size === 0) return
		const own = busy
		const H = own ? [] : hs, L = own ? [] : ls, I = own ? new Map<Holder, number>() : idx
		let n = 0
		for (const k of keys) {
			const set = held.get(k)
			if (set === undefined) continue
			for (const h of set) {
				let at = -1
				if (n <= 8) {
					for (let i = 0; i < n; i++) {
						if (H[i] === h) {
							at = i
							break
						}
					}
				} else {
					at = I.get(h) ?? -1
				}
				if (at >= 0) {
					L[at].push(k)
					continue
				}
				H[n] = h
				L[n] = [k]
				if (n === 8) { for (let i = 0; i <= 8; i++) I.set(H[i], i) }
				else if (n > 8) I.set(h, n)
				n++
			}
		}
		if (n === 0) return
		if (!own) busy = true
		try {
			for (let i = 0; i < n; i++) {
				told++
				H[i].marked?.(L[i], run, due, tick)
			}
		} finally {
			if (!own) {
				busy = false
				H.length = 0
				L.length = 0
				if (n > 8) I.clear()
			}
		}
	})
	s.onTrackingEnd((key) => {
		const set = held.get(key)
		if (set === undefined) return
		if (set.size === 1) {
			set.values().next().value!.ended?.(key)
			return
		}
		for (const h of [...set]) h.ended?.(key)
	})
	index = {
		hold(key, h) {
			let set = held.get(key)
			if (set === undefined) held.set(key, set = new Set())
			set.add(h)
		},
		drop(key, h) {
			const set = held.get(key)
			if (set === undefined) return
			set.delete(h)
			if (set.size === 0) held.delete(key)
		},
		deliveries: () => told,
	}
	indexes.set(s, index)
	return index
}

// the one key object of a selected value
type Pick1<K> = { readonly value: K }

// track(key) of a key nobody tracks yet: whether the run open took it (outside a run, in a set or
// an act: no). one onTrackingStart listener per scheduler
const firsts = /* @__PURE__ */ new WeakMap<object, (key: unknown) => boolean>()
function tracksFirst(s: Pick<Scheduler, "track" | "onTrackingStart">): (key: unknown) => boolean {
	let first = firsts.get(s)
	if (first !== undefined) return first
	let fresh: unknown, took = false
	s.onTrackingStart((key) => {
		if (key === fresh) took = true
	})
	first = (key) => {
		fresh = key
		took = false
		try {
			s.track(key)
		} finally {
			fresh = undefined
		}
		return took
	}
	firsts.set(s, first)
	return first
}

// Solid's createSelector: isSelected(key) is a tracked read of whether key is what source gives now.
// made in a scope (the computer reading source is under it, and goes with it). source moves from a
// to b: the readers of a and of b rerun, nobody else. a key is held while some run tracks it, and
// dropped at its tracking end. a read outside a run (in a set or an act too) tracks nothing and
// holds nothing. equal(key, value): whether key is selected by value; none: ===, and a move marks
// two keys; given, every key held is asked, since what it matches is not known to be one
export function createSelector<K>(
	s: Pick<
		Scheduler,
		| "createComputer"
		| "track"
		| "mark"
		| "getRun"
		| "onMark"
		| "onTrackingEnd"
		| "onTrackingStart"
	>,
	source: () => K,
	equal?: (key: K, value: K) => boolean,
): (key: K) => boolean {
	const index = keyed(s)
	const first = tracksFirst(s)
	// a key let go stays as undefined (a Map losing and gaining the same key slows as it grows, in
	// V8): keys is made again once they are half
	let keys = new Map<K, Pick1<K> | undefined>()
	let gone = 0
	const me: Holder = {
		ended: (o) => {
			const p = o as Pick1<K>
			if (keys.get(p.value) === p) {
				keys.set(p.value, undefined)
				if (++gone > keys.size >> 1 && keys.size > 64) {
					const kept = new Map<K, Pick1<K> | undefined>()
					for (const [k, x] of keys) if (x !== undefined) kept.set(k, x)
					keys = kept
					gone = 0
				}
			}
			index.drop(p, me)
		},
	}
	let value: K | undefined
	let has = false
	const selects = (key: K, v: K) => equal === undefined ? key === v : equal(key, v)

	s.createComputer(source, (v) => {
		const was = value as K, had = has
		value = v
		has = true
		const marked: Pick1<K>[] = []
		if (equal === undefined) {
			const a = had ? keys.get(was) : undefined
			const b = keys.get(v)
			if (a !== undefined) marked.push(a)
			if (b !== undefined && b !== a) marked.push(b)
		} else {
			for (const [k, o] of keys) {
				if (o !== undefined && (had && equal(k, was)) !== equal(k, v)) marked.push(o)
			}
		}
		if (marked.length) s.mark(marked, s.getRun())
	})

	return (key) => {
		if (s.getRun() !== undefined) {
			const o = keys.get(key)
			if (o !== undefined) s.track(o)
			else {
				const p = { value: key }
				if (first(p)) {
					if (keys.has(key)) gone--
					keys.set(key, p)
					index.hold(p, me)
				}
			}
		}
		return has && selects(key, value as K)
	}
}
