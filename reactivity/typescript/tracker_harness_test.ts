// the tracker against the model (tracker_model.ts), on whichever harness HARNESS names (default:
// tracker_harness.ts). The scenarios are run by conformance/run.ts. Lists compare exactly.
import { assertEquals } from "@std/assert"
import { ask, command } from "../../conformance/typescript/ask.ts"
import { rand } from "../../conformance/typescript/rand.ts"
import { createModel } from "./tracker_model.ts"

type Request = { op: string; from?: string; to?: string; of?: string }

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 300
// names: ASCII, BMP, a pair, a pair and a modifier, lone halves, NUL; some both readers and targets
const READERS = ["p", "中", "\uD83D", "a\u0000"]
const TARGETS = ["a", "é", "😀", "👍🏽", "\uDE00", "p", "\uD83D", "a\u0000"]

function sequence(seed: number): Request[] {
	const pick = rand(seed)
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const open: string[] = []
	const out: Request[] = []
	for (let i = 0; i < STEPS; i++) {
		const k = pick(20)
		if (k < 3 && open.length < READERS.length) {
			const r = one(READERS.filter((x) => !open.includes(x)))
			open.push(r)
			out.push({ op: "begin", from: r })
		} else if (k < 11 && open.length > 0) {
			// most tracks go to the innermost run, as nested code would
			const r = pick(4) === 0 ? one(open) : open[open.length - 1]
			out.push({ op: "track", from: r, to: one(TARGETS) })
		} else if (k < 14 && open.length > 0) {
			out.push({ op: "end", from: open.pop()! })
		} else if (k < 16) {
			const r = one(READERS)
			if (!open.includes(r)) out.push({ op: "add", from: r, to: one(TARGETS) })
		} else if (k < 17) {
			out.push({ op: "untrack", from: one(READERS), to: one(TARGETS) })
		} else if (k < 18) {
			out.push({ op: "untrack", from: one(READERS) })
		} else {
			// end outside a run: nothing
			const idle = READERS.filter((x) => !open.includes(x))
			if (idle.length > 0) out.push({ op: "end", from: one(idle) })
		}
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} steps against the model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const seq = sequence(seed)
		const requests: Request[] = []
		const model = createModel()
		const expected: { reads: string[]; readers: string[]; of: string; after: number }[] = []
		for (let i = 0; i < seq.length; i++) {
			const r = seq[i]
			requests.push(r)
			const m = model as unknown as Record<string, (a: string, b?: string) => void>
			m[r.op](r.from!, r.to)
			const of = r.to ?? r.from!
			requests.push({ op: "reads", of: r.from! }, { op: "readers", of })
			expected.push({
				reads: model.reads(r.from!),
				readers: model.readers(of),
				of,
				after: i,
			})
		}
		const answers = await ask(command("tracker"), requests)
		for (let i = 0; i < expected.length; i++) {
			const e = expected[i]
			const at = `seed ${seed}, step ${e.after}: ${JSON.stringify(seq[e.after])}`
			assertEquals(
				answers[i * 3 + 1].names,
				e.reads,
				`${at}: reads of ${seq[e.after].from}`,
			)
			assertEquals(answers[i * 3 + 2].names, e.readers, `${at}: readers of ${e.of}`)
		}
	}
})
