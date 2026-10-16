// the scheduler's on… hooks as one list, in order: what happened, for a recorder, an inspector or
// a test. due: a computer made due, by the run of the mark (by: its computer). a run's reads are
// kept while this listens
import type { Computer, Ended, Scheduler } from "./scheduler.ts"

export type Told =
	| { due: Computer; tick: number; by?: Computer }
	| { starts: Computer; run: number; rank: number }
	| {
		ends: Computer
		run: number
		ended: Ended
		// every key the run tracked, in order, again when tracked again
		reads: readonly unknown[]
		equal?: boolean
		error?: unknown
		waits?: Computer
		through?: Computer[]
	}
	// early: an early effect's act (its round's early queue)
	| { acts: Computer; run: number; early?: true; error?: unknown }

// f told each, in order; gives back the remove
export function trace(
	s: Pick<Scheduler, "onMark" | "onRunStart" | "onRunEnd" | "onEffect">,
	f: (told: Told) => void,
): () => void {
	const offs = [
		s.onMark((_, run, due, tick) => {
			for (const c of due) f(run ? { due: c, tick, by: run.computer } : { due: c, tick })
		}),
		s.onRunStart((c, n, rank) => f({ starts: c, run: n, rank })),
		s.onRunEnd((c, n, ended, reads, more) => {
			const t: Told = { ends: c, run: n, ended, reads }
			if (more.equal !== undefined) t.equal = more.equal
			if ("error" in more) t.error = more.error
			if (more.waits) t.waits = more.waits
			if (more.through) t.through = more.through
			f(t)
		}),
		s.onEffect((c, n, more) => {
			const t: Told = { acts: c, run: n }
			if (c.early) t.early = true
			if ("error" in more) t.error = more.error
			f(t)
		}),
	]
	return () => {
		for (const off of offs) off()
	}
}
