// a device for the tests and the example: its own table, places, scheduler, and a clock it owns
import { createPlaces, type Id } from "@ermine/places"
import { createPaths } from "@ermine/scheduler/paths"
import { createScheduler, type Scheduler } from "@ermine/scheduler"
import { createTable, type Key } from "@ermine/table"
import type { World } from "./presence.ts"

export type Device = World & { places: ReturnType<typeof createPlaces>; scheduler: Scheduler }

export function device(name: string, clock: { t: number }): Device {
	const scheduler = createScheduler()
	const paths = createPaths<unknown>()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths, scheduler })
	scheduler.onTrackingEnd((k) => places.release(k))
	const scope = scheduler.createRootScope([["actor", name]])
	return { table, places, scheduler, scope, now: () => clock.t }
}

export type { Id }
