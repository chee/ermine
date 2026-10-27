// lazy's host: the world (@ermine/slaygrounds/world) with the pully feature (extensions/pully),
// /dev/clock and /provider seeded, and the clock's provider: a process of the host's own, an action
// that pully sends "wake" when a run first reads the clock's time and "sleep" when the last one
// stops. the clock is awake only while it is read. the provider is the host's: a program only reads
// the time
import { createWorld } from "@ermine/slaygrounds/world"
import { createAction, ensureNode, patch, peep, read } from "@ermine/system"
import pully, { provide } from "@ermine/pully"
import { render } from "ermine-h"

// ---- the demo ----
const world = createWorld({ render, processes: [{ name: "lazy" }], features: [pully] })
const e = world.ermine

type Said = { starts: number; stops: number; log: unknown[] }

world.seed(() => {
	ensureNode("/dev/clock", { time: "--:--:--", ticks: 0 })
	ensureNode("/provider", { awake: false, ticks: 0, starts: 0, stops: 0, log: [] })
})

let ticks = 0
const hhmmss = () => new Date().toTimeString().slice(0, 8)

// the clock's provider, a process of its own: its setup names the handler (provide), and pully
// sends it wake and sleep
const started = e.start(() => {
	const clock = ensureNode("/dev/clock")
	const said = ensureNode("/provider")
	// the provider says what happened: awake or not, and a line in its log (the last six)
	function say(what: string, awake: boolean) {
		const was = peep(() => read(said)) as Said
		patch(said, [
			{ path: ["awake"], value: awake },
			{ path: [awake ? "starts" : "stops"], value: (awake ? was.starts : was.stops) + 1 },
			{ path: ["log"], value: [{ at: hhmmss(), what, awake }, ...was.log].slice(0, 6) },
		])
	}
	let timer: ReturnType<typeof setInterval> | undefined
	provide(
		clock,
		createAction("on/clock", (what: string) => {
			if (what === "wake") {
				say("a reader came: ticking", true)
				const tick = () => {
					ticks++
					// from a timer, nothing is open: the host writes, as it does the beat
					e.within(() => {
						patch("/dev/clock", [
							{ path: ["time"], value: hhmmss() },
							{ path: ["ticks"], value: ticks },
						])
						patch("/provider", [{ path: ["ticks"], value: ticks }])
					})
				}
				tick()
				timer = setInterval(tick, 1000)
			} else if (what === "sleep") {
				clearInterval(timer)
				timer = undefined
				say("the last reader left: stopped", false)
			}
		}),
	)
}, ["dev", "clockd"])
if ("refused" in started) console.error(`clock provider: refused ${started.refused}`)

export const reload = world.reload
