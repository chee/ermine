// lab-pyramid's host: the world (@ermine/slaygrounds/world), one process, pyramid, running
// program.ts, and one extra, stats: what the readout measures, which the api does not say
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

// what the page measures. writes: commits landed (each a write of a node's value); acts: effects
// that acted; runs: computations that ran; pulses: pulses ended, pulseMs the time in them, maxMs
// the longest one. counted by wrapping the scheduler's pulse and the places' commit, once
export type Stats = {
	writes: number
	acts: number
	runs: number
	pulses: number
	pulseMs: number
	maxMs: number
}
export type Tools = { stats: Stats }

const stats: Stats = { writes: 0, acts: 0, runs: 0, pulses: 0, pulseMs: 0, maxMs: 0 }
let counted = false

const world = createWorld({
	render,
	processes: [{ name: "pyramid" }],
	extend: (_api, ctx): Tools => {
		if (!counted) {
			counted = true
			const { scheduler: s, places } = ctx
			s.onEffect(() => void stats.acts++)
			s.onRunStart(() => void stats.runs++)
			const pulse = s.pulse
			s.pulse = () => {
				const t0 = performance.now()
				pulse()
				const ms = performance.now() - t0
				stats.pulses++
				stats.pulseMs += ms
				stats.maxMs = Math.max(stats.maxMs, ms)
			}
			const commit = places.commit
			places.commit = (changed) => (stats.writes++, commit(changed))
		}
		return { stats }
	},
})

export const reload = world.reload
