// lazy's host: the world (@ermine/slaygrounds/world), /dev/clock and /provider seeded, and the
// clock's provider (@ermine/pullynode): awake only while a run reads the clock. pullynode hears the
// scheduler (onTrackingStart: a key gained its first tracker; onTrackingEnd: it lost its last) and
// starts or stops the provider once no run is open. the provider is the host's: a program only
// reads the time
import { createWorld } from "@ermine/slaygrounds/world"
import { createProviders } from "@ermine/pullynode"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "lazy" }] })
const { s, places, table, host } = world.world
const api = world.hostAPI

type Said = { starts: number; stops: number; log: unknown[] }

world.seed((h) => {
	h.open("/dev/clock", { time: "--:--:--", ticks: 0 })
	h.open("/provider", { awake: false, ticks: 0, starts: 0, stops: 0, log: [] })
})

let ticks = 0
const hhmmss = () => new Date().toTimeString().slice(0, 8)

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

// the clock's own writes are under its own scope (actor /dev/clock): pullynode's
const providers = createProviders({ scheduler: s, places, table })
providers.provide(api.entries("/dev/clock")[0].id, {
	start(write) {
		say("a reader came: ticking", true)
		const tick = () => {
			ticks++
			write([{ path: ["time"], value: hhmmss() }, { path: ["ticks"], value: ticks }])
			s.runWithScope(host, () => api.edit("/provider", [{ path: ["ticks"], value: ticks }]))
		}
		tick()
		const timer = setInterval(tick, 1000)
		return () => {
			clearInterval(timer)
			say("the last reader left: stopped", false)
		}
	},
}, { actor: "/dev/clock" })

export const reload = world.reload
