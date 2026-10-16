// cursors' host: the world (@ermine/slaygrounds/world) with presence, and a second device, the
// phone: a world of its own (its table, places, scheduler), joined to the laptop's by a pair of
// channels (and a BroadcastChannel, so this example open in another tab shows up here). a program
// gets present/absent/presence from the api for the laptop; the phone is this host's, handed
// over by extend: a program cannot make a world
import createEntry from "@ermine/node/entry"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable } from "@ermine/table"
import { createWorld } from "@ermine/slaygrounds/world"
import { clear, connect, readPresence, renew, setPresence, startSweeper } from "@ermine/presence"
import { type Channel, createBroadcast, createPair } from "@ermine/presence/channel"
import { render } from "ermine-h"

const TOPIC = "pad:7f3a" // what the channels call the pad: each world's own id for it differs
const TTL = 3000 // ms a row lives unless renewed

const world = createWorld({
	render,
	processes: [{ name: "cursors" }],
	presence: { who: "laptop", sweep: 300 },
	extend: (api) => ({
		crossed,
		phone: {
			...phone,
			effect: (read: () => unknown, act: (v: any) => void) =>
				phone.effect(read, act, api.teardown),
		},
	}),
})
world.seed((host) => void host.open("/pad", "a pad to point at"))
const { s, presence: laptop } = world.world
const pad = world.hostAPI.entries("/pad")[0].id

// the phone: its own world, the pad at its own /pad (an id of its own)
function device(actor: string) {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places = createPlaces({ root: "root", table, paths: createPaths(), scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const scope = scheduler.createRootScope([["actor", actor]])
	scheduler.runWithScope(scope, () => {
		table.add("value", "root", createEntry(undefined, createChangeHeader(scheduler)))
		table.add("children", "root", createEntry({ pad: "pad" }, createChangeHeader(scheduler)))
		table.add("value", "pad", createEntry("a pad to point at", createChangeHeader(scheduler)))
	})
	return { table, places, scheduler, scope }
}
const far = device("chee@phone") // the phone's world

const pair = createPair("laptop", "phone")
connect(laptop!, pair.a, { topic: TOPIC, anchor: pad })
connect(far, pair.b, { topic: TOPIC, anchor: "pad" })
const tab = "tab-" + crypto.randomUUID().slice(0, 4)
const bc = createBroadcast(tab, "ermine-slaygrounds-cursors")
let heard = 0
// what arrives over the broadcast lands from outside: a pulse after it
const tabs: Channel = {
	name: bc.name,
	send: bc.send,
	on: (topic, fn) => bc.on(topic, (from, bytes) => (heard++, fn(from, bytes), s.pulse())),
}
connect(laptop!, tabs, { topic: TOPIC, anchor: pad })
startSweeper(far, 300)

// the phone as a program holds it: its rows at the pad (tracked in its own world), its row set,
// renewed and cleared, and an effect in its own scheduler that goes with the process (api.teardown)
const phone = {
	who: "phone",
	rows: () => readPresence(far, "pad"),
	set(value: unknown) {
		setPresence(far, "pad", "phone", value, TTL)
		far.scheduler.pulse()
	},
	renew() {
		if (renew(far, "pad", "phone", TTL)) far.scheduler.pulse()
	},
	clear() {
		clear(far, "pad", "phone")
		far.scheduler.pulse()
	},
	effect<T>(read: () => T, act: (v: T) => void, teardown: (f: () => void) => void) {
		const scope = far.scheduler.createScope([["role", "phone effect"]], far.scope)
		teardown(() => far.scheduler.teardown(scope))
		far.scheduler.runWithScope(scope, () => far.scheduler.createEffect(read, act))
		far.scheduler.pulse()
	},
}
// not the graph's: messages sent over the pair, heard from other tabs, and this tab's name
const crossed = () => ({ pair: pair.sent.length, tabs: heard, tab, ttl: TTL, topic: TOPIC })

export const reload = world.reload
