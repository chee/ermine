/// <reference lib="dom" />
// the page's store, and its records of who wrote what. the scheduler says, for every write, which
// run made it (none: from outside), and, at each run's end, what that run read. this file keeps
// those as records: each key's latest write (its value, the run that wrote it or the site of the
// outside call, the time), and each run's reads (the very writes it got). a trail is walked from
// those records back to the outside writes. none of the keeping or walking is ermine's: it is the
// page's, built on the scheduler's listeners and @ermine/core/util/stacktrace's capture.
import type { Computer, Scheduler } from "@ermine/core/scheduler"
import { capture, type FileLocation } from "@ermine/core/util/stacktrace"

// one write: by a run, or from outside (with the site of the code that called write)
export type Written = {
	key: string
	value: unknown
	at: number
	run?: RunRecord
	site?: FileLocation
	// from outside: what the page says it came by (a button), and whether a person did it
	via?: string
	you?: boolean
}

// one run of a computer: the writes it read, in the order it first read them
export type RunRecord = {
	name: string
	n: number
	reads: Written[]
	// the scheduler's own list of the keys it read, told at its end
	tracked?: readonly unknown[]
}

const ours = new Set([import.meta.url])

export function createStore(s: Scheduler, nameOf: (c: Computer) => string) {
	const values = new Map<string, unknown>()
	const last = new Map<string, Written>()
	const runs = new Map<Computer, Map<number, RunRecord>>()
	const runOf = (c: Computer, n: number) => {
		let m = runs.get(c)
		if (!m) runs.set(c, m = new Map())
		let r = m.get(n)
		if (!r) m.set(n, r = { name: nameOf(c), n, reads: [] })
		return r
	}
	s.onRunEnd((c, n, _ended, reads) => void (runOf(c, n).tracked = reads))

	// a read: tell the scheduler, note which write it got, give the value
	function read(key: string) {
		s.track(key)
		const run = s.getRun()
		const w = last.get(key)
		if (run && w) {
			const r = runOf(run.computer, run.n)
			if (!r.reads.includes(w)) r.reads.push(w)
		}
		return values.get(key)
	}

	// a write: in a program's set, its own run; else from outside, with the caller's file and line
	function write(key: string, value: unknown, from?: { via: string; event?: Event }) {
		const run = s.getRun()
		const w: Written = { key, value, at: Date.now() }
		if (run) w.run = runOf(run.computer, run.n)
		else {
			w.site = capture(ours, write)
			if (from) (w.via = from.via, w.you = from.event?.isTrusted === true)
		}
		values.set(key, value)
		last.set(key, w)
		s.mark([key], run)
		// from outside, nothing else will run what it made due: pulse
		if (!run) s.pulse()
		return w
	}

	return {
		read,
		write,
		get: (key: string) => values.get(key),
		last: (key: string) => last.get(key),
		run: (c: Computer) => {
			const m = runs.get(c)
			return m ? [...m.values()].at(-1) : undefined
		},
	}
}

// the trail back from one write: it, then the writes its run read, and theirs, until each branch
// ends outside. each hop says who read it (the run it was read by). a write met twice is one hop
export type Hop = { w: Written; by: RunRecord }
export function trail(start: Written, by: RunRecord): Hop[] {
	const hops: Hop[] = [{ w: start, by }]
	const seen = new Set([start])
	for (let i = 0; i < hops.length; i++) {
		const r = hops[i].w.run
		if (!r) continue
		for (const w of r.reads) {
			if (seen.has(w)) continue
			seen.add(w)
			hops.push({ w, by: r })
		}
	}
	return hops
}

// where a stack frame is in the source: vite serves a .ts file compiled, with its source map
// inlined, so the frame's line is the compiled one. the map gives the line as written
const maps = new Map<string, Promise<{ sources: string[]; lines: number[][][] } | undefined>>()
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
function vlq(seg: string): number[] {
	const out: number[] = []
	let v = 0, shift = 0
	for (const ch of seg) {
		const d = B64.indexOf(ch)
		v += (d & 31) << shift
		if (d & 32) shift += 5
		else {
			out.push(v & 1 ? -(v >> 1) : v >> 1)
			v = 0, shift = 0
		}
	}
	return out
}
function loadMap(file: string) {
	if (!maps.has(file)) {
		maps.set(
			file,
			fetch(file).then((r) => r.text()).then((js) => {
				const m = /sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,(\S+)/
					.exec(js)
				if (!m) return undefined
				const map = JSON.parse(atob(m[1]))
				// [genColumn, source, line, column] per segment, absolute, per generated line
				const lines: number[][][] = []
				let src = 0, line = 0, col = 0
				for (const l of (map.mappings as string).split(";")) {
					let gen = 0
					const segs: number[][] = []
					for (const s of l.split(",")) {
						if (!s) continue
						const d = vlq(s)
						gen += d[0]
						if (d.length >= 4) {
							src += d[1], line += d[2], col += d[3]
							segs.push([gen, src, line, col])
						}
					}
					lines.push(segs)
				}
				return { sources: map.sources as string[], lines }
			}).catch(() => undefined),
		)
	}
	return maps.get(file)!
}

// a site as a path from the repo's root and the line as written; no map: the served file's line
export async function written(site: FileLocation): Promise<{ path: string; line: number }> {
	const url = new URL(site.file, location.href)
	const path = url.pathname.startsWith("/@fs/")
		? url.pathname.replace(/^.*?\/ermine\//, "")
		: `playground/demos${url.pathname}`
	const map = await loadMap(site.file)
	const segs = map?.lines[site.line - 1]
	if (!segs?.length) return { path, line: site.line }
	const col = (site.column ?? 1) - 1
	let best = segs[0]
	for (const s of segs) if (s[0] <= col) best = s
	return { path, line: best[2] + 1 }
}
