// cursors' host: the world (@ermine/slaygrounds/world) with presence, and a second device, the
// phone: a world of its own (its table, places, scheduler), joined to the laptop's by a pair of
// channels (and a BroadcastChannel, so this example open in another tab shows up here). both
// devices' rows are this host's, handed over by extend: a program cannot make a world
import createEntry from "@ermine/core/node/entry"
import { createPlaces } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { get } from "@ermine/core/places/lib"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable } from "@ermine/core/table"
import { createWorld } from "@ermine/slaygrounds/world"
import {
	clear,
	connect,
	readPresence,
	renew,
	setPresence,
	startSweeper,
} from "@ermine/together/presence"
import { type Channel, createBroadcast, createPair } from "@ermine/together/presence/channel"
import { render } from "ermine-h"

const TOPIC = "pad:7f3a" // what the channels call the pad: each world's own id for it differs
const TTL = 3000 // ms a row lives unless renewed

const world = createWorld({
	render,
	processes: [{ name: "cursors" }],
	presence: { sweep: 300 },
	extend: () => ({ crossed, laptop: here, phone }),
})
world.seed((host) => void host.ensureNode("/pad", "a pad to point at"))
const { s, places, presence: laptop } = world.world
// the pad's id: what the channels anchor the presence rows to
const padAt = world.ermine.dataOf(world.ermine.getNode("/pad"))!.node
const pad = padAt.id ?? get(places, padAt.path!)!

// the phone: its own world, the pad at its own /pad (an id of its own)
function device(actor: string) {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places = createPlaces({ root: "root", table, paths: createPaths(), scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const scope = scheduler.createRootScope({ actor: actor })
	scheduler.runWithScope(scope, () => {
		table.add("value", "root", createEntry(undefined, createChangeHeader(scheduler)))
		table.add("children", "root", createEntry({ pad: "pad" }, createChangeHeader(scheduler)))
		table.add("value", "pad", createEntry("a pad to point at", createChangeHeader(scheduler)))
	})
	return { table, places, scheduler, scope }
}
const far = device("chee@phone") // the phone's world

// what arrives over a channel lands from outside, in a world that is not told: a pulse after it
const pulsed = (c: Channel, pulse: () => void): Channel => ({
	name: c.name,
	send: c.send,
	on: (topic, fn) => c.on(topic, (from, bytes) => (fn(from, bytes), pulse())),
})
const pair = createPair("laptop", "phone")
connect(laptop!, pulsed(pair.a, () => s.pulse()), { topic: TOPIC, anchor: pad })
connect(far, pulsed(pair.b, () => far.scheduler.pulse()), { topic: TOPIC, anchor: "pad" })
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

// the laptop as a program holds it: its rows at the pad (tracked in the world the program runs in),
// its row set, renewed and cleared
const here = {
	rows: () => readPresence(laptop!, pad),
	set(value: unknown) {
		setPresence(laptop!, pad, "laptop", value, TTL)
		s.pulse()
	},
	renew() {
		if (renew(laptop!, pad, "laptop", TTL)) s.pulse()
	},
	clear() {
		clear(laptop!, pad, "laptop")
		s.pulse()
	},
}

// the phone as a program holds it: its rows at the pad (tracked in its own world), its row set,
// renewed and cleared, and an effect in its own scheduler that goes with the process (the program
// hands its addTeardown in)
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
		const scope = far.scheduler.createScope({ role: "phone effect" }, far.scope)
		teardown(() => far.scheduler.teardown(scope))
		far.scheduler.runWithScope(scope, () => far.scheduler.createEffect(read, act))
		far.scheduler.pulse()
	},
}
// not the graph's: messages sent over the pair, heard from other tabs, and this tab's name
const crossed = () => ({ pair: pair.sent.length, tabs: heard, tab, ttl: TTL, topic: TOPIC })

export const reload = world.reload
