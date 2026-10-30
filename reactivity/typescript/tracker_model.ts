// The model the tracker harness test checks against: tracker.ts read plainly, with arrays and
// indexOf: link's track (alien-signals, solid 2.0). Free when it is the same spot as the last
// read, the next link in order (confirmed), or the spot's newest reader link is this run's.
// Else a new link at the cursor. Duplicates are allowed where these miss.
type Link = { from: string; to: string; gen: number }

export function createModel() {
	const lists = new Map<string, Link[]>()
	const readerLists = new Map<string, Link[]>()
	const runs = new Map<string, { at: number; gen: number }>()
	let tick = 0
	const list = (r: string) => lists.get(r) ?? (lists.set(r, []), lists.get(r)!)
	const readersOf = (a: string) =>
		readerLists.get(a) ?? (readerLists.set(a, []), readerLists.get(a)!)
	const make = (from: string, to: string, gen = 0) => {
		const l = { from, to, gen }
		readersOf(to).push(l)
		return l
	}
	const drop = (l: Link) => {
		const rs = readersOf(l.to)
		rs.splice(rs.indexOf(l), 1)
	}
	return {
		begin(r: string) {
			if (runs.has(r)) throw new Error("begin in a run: end it first")
			runs.set(r, { at: 0, gen: ++tick })
		},
		track(r: string, a: string) {
			const run = runs.get(r)!
			const ls = list(r)
			if (ls[run.at - 1]?.to === a) return
			if (ls[run.at]?.to === a) {
				ls[run.at++].gen = run.gen
				return
			}
			const last = readersOf(a).at(-1)
			if (last !== undefined && last.from === r && last.gen === run.gen) return
			ls.splice(run.at++, 0, make(r, a, run.gen))
		},
		end(r: string) {
			const run = runs.get(r)
			if (run === undefined) return
			runs.delete(r)
			for (const l of list(r).splice(run.at)) drop(l)
		},
		add(r: string, a: string) {
			const ls = list(r)
			if (!ls.some((l) => l.to === a)) ls.push(make(r, a))
		},
		untrack(r: string, a?: string) {
			const ls = list(r)
			const run = runs.get(r)
			for (let i = ls.length - 1; i >= 0; i--) {
				if (a !== undefined && ls[i].to !== a) continue
				drop(ls[i])
				ls.splice(i, 1)
				if (run !== undefined && i < run.at) run.at--
			}
		},
		reads: (r: string) => list(r).map((l) => l.to),
		readers: (a: string) => readersOf(a).map((l) => l.from),
	}
}
