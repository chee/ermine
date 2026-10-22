// process nodes: sync and history, shown as a plain value a person can walk up to, like /proc. the
// host says where it goes (a node "sync" whose writes are not kept, say, so it never feeds itself)
//
//   const kept = notKept(["sync"])
//   const history = createHistory({ log, table, places, run, kept })
//   const write = (v) => run(() => table.sub("value", "sync", entry(v)))
//   const stop = show({ sync, log, history, write })
import { type Failed, type History, keptByDefault } from "./history.ts"
import type { Log } from "./log.ts"
import type { Sync } from "./sync.ts"

export type Shown = {
	// this device, or null: a log with no signer
	device: string | null
	have: Record<string, number>
	links: number
	// the last 20
	failed: Failed[]
	unkept: number
}

// a kept predicate that never keeps these nodes; kept: history's default when none
export function notKept(ids: Iterable<string>, kept = keptByDefault) {
	const not = new Set(ids)
	return (node: string, part: string) => !not.has(node) && kept(node, part)
}

// the value, to write(value) now and whenever it changes, at most once a microtask. stop()
export function show(o: {
	sync: Sync
	log: Log
	history: History
	write: (value: Shown) => void
}): () => void {
	const { sync, log, history } = o
	// writing: what the write itself makes happen is not a change to show (the guard against a
	// host that forgot notKept: a step for each write, but no loop)
	let queued = false, stopped = false, writing = false, last = ""

	function flush() {
		queued = false
		if (stopped) return
		const value: Shown = {
			device: log.device ?? null,
			have: log.have(),
			links: sync.links,
			failed: history.failed.slice(-20),
			unkept: history.unkept.length,
		}
		const now = JSON.stringify(value)
		if (now === last) return
		last = now
		writing = true
		try {
			o.write(value)
		} finally {
			writing = false
		}
	}
	function poke() {
		if (queued || stopped || writing) return
		queued = true
		queueMicrotask(flush)
	}

	const offs = [log.on(poke), history.onChange(poke), sync.onLinks(poke)]
	poke()
	return () => {
		stopped = true
		for (const off of offs) off()
	}
}
