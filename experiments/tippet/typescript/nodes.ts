// Process nodes: sync and history shown as a plain value a person can walk up to, like /proc.
// The host says where it goes, using a node "sync" whose writes are not kept so it never feeds
// itself.
import { type Failed, type History, keptByDefault } from "./history.ts"
import type { Log } from "./log.ts"
import type { Sync } from "./sync.ts"

export type Shown = {
	device: string | null
	have: Record<string, number>
	links: number
	failed: Failed[]
	unkept: number
}

export function notKept(
	ids: Iterable<string>,
	kept: (node: string, part: string) => boolean = keptByDefault,
): (node: string, part: string) => boolean {
	const not = new Set(ids)
	return (node: string, part: string) => !not.has(node) && kept(node, part)
}

export function show(o: {
	sync: Sync
	log: Log
	history: History
	write: (value: Shown) => void
}): () => void {
	const { sync, log, history } = o
	// Guards against a host that forgot notKept: it would make a step per write, but no loop.
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
