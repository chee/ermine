// tracker's streams: runs begun and ended (nested, interleaved), tracks mostly in the innermost,
// adds, untracks, ends outside a run (tracker_harness_test.ts's mix, copied), with the reads of
// the from and the readers of the to asked after every step.
// wild: begin in a run, add in a run, odd names (NUL, lone surrogates, "__proto__", ""), requests
// missing from, to or of
import { type Generator, picker, type Request } from "./kit.ts"

const READERS = ["p", "q", "r", "s"]
const TARGETS = ["a", "b", "c", "d", "e", "p", "q"]
const ODD = ["", "\u0000", "\uDC00", "__proto__"]

const generator: Generator = {
	streams(seed, o) {
		const { pick, one } = picker(seed)
		const targets = o.wild ? [...TARGETS, ...ODD] : TARGETS
		const open: string[] = []
		const out: Request[] = []
		for (let i = 0; i < 80; i++) {
			const k = pick(20)
			let r: Request | undefined
			if (k < 3 && open.length < READERS.length) {
				const x = one(READERS.filter((x) => !open.includes(x)))
				open.push(x)
				r = { op: "begin", from: x }
			} else if (k < 11 && open.length > 0) {
				const x = pick(4) === 0 ? one(open) : open[open.length - 1]
				r = { op: "track", from: x, to: one(targets) }
			} else if (k < 14 && open.length > 0) {
				const x = pick(3) === 0 ? one(open) : open[open.length - 1]
				open.splice(open.indexOf(x), 1)
				r = { op: "end", from: x }
			} else if (k < 16) {
				const x = one(READERS)
				if (!open.includes(x)) r = { op: "add", from: x, to: one(targets) }
			} else if (k < 17) r = { op: "untrack", from: one(READERS), to: one(targets) }
			else if (k < 18) r = { op: "untrack", from: one(READERS) }
			else {
				const idle = READERS.filter((x) => !open.includes(x))
				if (idle.length > 0) r = { op: "end", from: one(idle) }
			}
			if (o.wild && pick(10) === 0) {
				r = one<Request>([
					...(open.length
						? [{ op: "begin", from: one(open) }, {
							op: "add",
							from: one(open),
							to: one(targets),
						}]
						: []),
					{ op: "track", from: one(READERS) },
					{ op: "reads" },
					{ op: "untrack" },
					{ op: "Track", from: "p", to: "a" },
				])
			}
			if (!r) continue
			out.push(r)
			if (r.from !== undefined) out.push({ op: "reads", of: r.from })
			out.push({ op: "readers", of: r.to ?? r.from ?? one(targets) })
		}
		return [out]
	},
}
export default generator
