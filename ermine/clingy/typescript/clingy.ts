// clingy: keys of the caller's, each known tracked or not, the caller told when its last tracker
// goes. chee 10-16, of clingy computers: "take it out of core, make it a library that can be used
// in the two places it was duplicated" (the path cache, filesystem/places cache.ts; build steps,
// ermine/programs build.ts). built on the scheduler's onTrackingStart and onTrackingEnd only
//
//   const clingy = createClingy(scheduler, (key) => settle(key))
//   clingy.add(key)       // a key made now: no run tracks it yet
//   scheduler.track(key)  // in a run: tracked
//   clingy.tracked(key)   // a run tracks it now
//   // its last tracker gone (onTrackingEnd): go(key), and it stays added
//   clingy.drop(key)      // never told of again
//
// go is only told: what goes then, and whether, is the caller's (something else may still hold
// it). a key added is untracked, whatever the scheduler knows: add a key before a run tracks it.
// a read outside a run tracks nothing, so tells nothing: a caller keeping nothing then checks
// tracked itself. every clingy hears every first track and untrack of its scheduler
import type { Scheduler } from "@ermine/scheduler"

export type Clingy<K> = {
	add: (key: K) => void
	// added, not dropped
	has: (key: K) => boolean
	tracked: (key: K) => boolean
	drop: (key: K) => void
	// its listeners gone; it is told nothing more
	stop: () => void
}

export function createClingy<K>(
	scheduler: Pick<Scheduler, "onTrackingStart" | "onTrackingEnd">,
	go: (key: K) => void,
): Clingy<K> {
	// each key added: whether a run tracks it now
	const keys = new Map<unknown, boolean>()
	const offs = [
		scheduler.onTrackingStart((k) => {
			if (keys.has(k)) keys.set(k, true)
		}),
		scheduler.onTrackingEnd((k) => {
			if (!keys.has(k)) return
			keys.set(k, false)
			go(k as K)
		}),
	]
	return {
		// added already: nothing
		add: (key) => {
			if (!keys.has(key)) keys.set(key, false)
		},
		has: (key) => keys.has(key),
		tracked: (key) => keys.get(key) === true,
		drop: (key) => void keys.delete(key),
		stop: () => {
			for (const off of offs) off()
			keys.clear()
		},
	}
}
