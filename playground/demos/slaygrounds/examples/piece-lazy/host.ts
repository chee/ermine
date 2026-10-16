// lazy's host: the world (@ermine/slaygrounds/world), /dev/clock and /provider seeded, and the
// clock's provider: awake only while a run tracks the clock's time. the scheduler tells it
// (onTrackingStart: a key gained its first tracker; onTrackingEnd: it lost its last), places'
// describe says where a key reads. the provider is the host's: a program only reads the time
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "lazy" }] })
const { s, places, host } = world.world
const api = world.hostAPI

type Said = { starts: number; stops: number; log: unknown[] }

world.seed((h) => {
	h.open("/dev/clock", { time: "--:--:--", ticks: 0 })
	h.open("/provider", { awake: false, ticks: 0, starts: 0, stops: 0, log: [] })
})

// the clock's own writes are the clock's actor's
const ticker = s.createRootScope([["actor", "/dev/clock"]])
const reading = new Set<unknown>()
let timer: ReturnType<typeof setInterval> | undefined
let ticks = 0

const hhmmss = () => new Date().toTimeString().slice(0, 8)
function tick() {
	ticks++
	s.runWithScope(
		ticker,
		() =>
			api.edit("/dev/clock", [{ path: ["time"], value: hhmmss() }, {
				path: ["ticks"],
				value: ticks,
			}]),
	)
	api.edit("/provider", [{ path: ["ticks"], value: ticks }])
}
// the provider says what happened: awake or not, and a line in its log (the last six)
function say(what: string, awake: boolean) {
	s.runWithScope(host, () => {
		const was = api.read("/provider") as Said
		api.edit("/provider", [
			{ path: ["awake"], value: awake },
			{ path: [awake ? "starts" : "stops"], value: (awake ? was.starts : was.stops) + 1 },
			{ path: ["log"], value: [{ at: hhmmss(), what, awake }, ...was.log].slice(0, 6) },
		])
	})
}

const clock = api.entries("/dev/clock")[0].id
s.onTrackingStart((key) => {
	const w = places.describe(key)
	if (w?.part !== "value" || w.id !== clock || w.path?.length !== 1 || w.path[0] !== "time") return
	reading.add(key)
	if (timer !== undefined) return
	timer = setInterval(tick, 1000)
	// told inside the reading run: what the provider writes waits for it to end
	queueMicrotask(() => (say("onTrackingStart: a reader came, ticking", true), tick()))
})
s.onTrackingEnd((key) => {
	if (!reading.delete(key) || reading.size > 0 || timer === undefined) return
	clearInterval(timer)
	timer = undefined
	queueMicrotask(() => say("onTrackingEnd: the last reader left, stopped", false))
})

export const reload = world.reload
