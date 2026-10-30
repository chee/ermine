// tracker's streams: runs begun and ended, tracks and untracks, checked against a model.
import {
	type Answer,
	differs,
	firsts,
	type Generator,
	picker,
	type Request,
	show,
	type Violation,
} from "./kit.ts"

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
generator.invariant = invariant
export default generator

type Link = { from: string; to: string; gen: number }

function invariant(stream: Request[], answers: (Answer | undefined)[]): Promise<Violation[]> {
	const out: Violation[] = []
	const reads = new Map<string, Link[]>()
	const readers = new Map<string, Link[]>()
	const runs = new Map<string, { at: number; gen: number }>()
	let gen = 0
	const of = <T>(m: Map<string, T[]>, k: string) => m.get(k) ?? (m.set(k, []), m.get(k)!)
	const link = (from: string, to: string, gen: number) => {
		const l = { from, to, gen }
		of(readers, to).push(l)
		return l
	}
	const drop = (l: Link) => {
		const rs = of(readers, l.to)
		rs.splice(rs.indexOf(l), 1)
	}
	const name = (x: unknown) => typeof x === "string"
	for (let at = 0; at < stream.length; at++) {
		const r = stream[at], a = answers[at]
		if (a === undefined) break
		let want: Answer | undefined = {}
		const run = name(r.from) ? runs.get(r.from) : undefined
		if ((r.op === "begin" || r.op === "end") && name(r.from)) {
			if (r.op === "begin" && run) want = undefined
			else if (r.op === "begin") runs.set(r.from, { at: 0, gen: ++gen })
			else if (run) {
				runs.delete(r.from)
				for (const l of of(reads, r.from).splice(run.at)) drop(l)
			}
		} else if (r.op === "track" && name(r.from) && name(r.to)) {
			if (!run) break
			const ls = of(reads, r.from)
			const last = of(readers, r.to).at(-1)
			if (ls[run.at - 1]?.to === r.to) { /* under the cursor */ }
			else if (ls[run.at]?.to === r.to) ls[run.at++].gen = run.gen
			else if (last?.from !== r.from || last.gen !== run.gen) {
				ls.splice(run.at++, 0, link(r.from, r.to, run.gen))
			}
		} else if (r.op === "add" && name(r.from) && name(r.to)) {
			const ls = of(reads, r.from)
			if (run) want = undefined
			else if (!ls.some((l) => l.to === r.to)) ls.push(link(r.from, r.to, 0))
		} else if (r.op === "untrack" && name(r.from) && (r.to === undefined || name(r.to))) {
			const ls = of(reads, r.from)
			for (let i = ls.length - 1; i >= 0; i--) {
				if (r.to !== undefined && ls[i].to !== r.to) continue
				drop(ls[i])
				ls.splice(i, 1)
				if (run && i < run.at) run.at--
			}
		} else if (r.op === "reads" && name(r.of)) {
			want = { names: of(reads, r.of).map((l) => l.to) }
		} else if (r.op === "readers" && name(r.of)) {
			want = { names: of(readers, r.of).map((l) => l.from) }
		} else if (["begin", "end", "track", "add", "untrack", "reads", "readers"].includes(r.op)) {
			const fields = [r.from, r.to, r.of].filter((x) => x !== undefined)
			if (!fields.every(name)) break
			want = undefined
		} else want = undefined
		const refused = typeof a.error === "string"
		if (want === undefined) {
			if (!refused) out.push({ kind: "refused", at, why: `${show(r)}: ${show(a)}, not refused` })
		} else if (refused || differs(a, want)) {
			const kind = refused ? "refused" : r.op === "reads" || r.op === "readers" ? r.op : "write"
			out.push({ kind, at, why: `${show(r)}: ${show(a)}, not ${show(want)}` })
		}
	}
	return Promise.resolve(firsts(out))
}
