// The model the fuzzer checks against: TRACKGRAPH.tex read plainly, with arrays and
// indexOf, and the exact "already read in this run": a reader never links a spot twice in one
// run. A node read out of order is a new link, the old one left until the run ends, or until
// the run meets it in order: a second link to a spot read already, it goes then.
type Link = { from: string; to: string }

export function createModel() {
	const lists = new Map<string, Link[]>()
	const readerLists = new Map<string, Link[]>()
	const runs = new Map<string, { at: number; read: Set<string> }>()
	const list = (r: string) => lists.get(r) ?? (lists.set(r, []), lists.get(r)!)
	const readersOf = (a: string) =>
		readerLists.get(a) ?? (readerLists.set(a, []), readerLists.get(a)!)
	const make = (from: string, to: string) => {
		const l = { from, to }
		readersOf(to).push(l)
		return l
	}
	const drop = (l: Link) => {
		const rs = readersOf(l.to)
		rs.splice(rs.indexOf(l), 1)
	}
	return {
		begin(r: string) {
			runs.set(r, { at: 0, read: new Set() })
		},
		track(r: string, a: string) {
			const run = runs.get(r)!
			const ls = list(r)
			if (run.read.has(a)) {
				if (ls[run.at]?.to === a) drop(ls.splice(run.at, 1)[0])
				return
			}
			if (ls[run.at]?.to === a) run.at++
			else ls.splice(run.at++, 0, make(r, a))
			run.read.add(a)
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
			if (run !== undefined && a !== undefined) run.read.delete(a)
			if (run !== undefined && a === undefined) run.read.clear()
		},
		reads: (r: string) => list(r).map((l) => l.to),
		readers: (a: string) => readersOf(a).map((l) => l.from),
	}
}
