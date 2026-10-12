// Runs the scenarios and the fuzzer against a harness. TRACKGRAPH_HARNESS: the command for
// another implementation (default: the reference). Lists compare with duplicates removed,
// each at its first place (TRACKGRAPH.tex: duplicates mean the same as the first).
import { assertEquals } from "@std/assert"
import { createModel } from "./model.ts"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("TRACKGRAPH_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(
	" ",
)

type Request = { op: string; from?: string; to?: string; of?: string }
type Step = Request & { expect?: string[] }

async function ask(requests: Request[]): Promise<{ names?: string[]; error?: string }[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	return new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
}

const once = (names: string[]) => [...new Set(names)]

for await (const f of Deno.readDir(`${here}../../core/graph/conformance`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(
		await Deno.readTextFile(`${here}../../core/graph/conformance/${f.name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		steps.forEach((s, i) => {
			assertEquals(answers[i].error, undefined, `step ${i}`)
			if (s.expect !== undefined) {
				assertEquals(once(answers[i].names!), s.expect, `step ${i}: ${JSON.stringify(s)}`)
			}
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 300
const READERS = ["p", "q", "r", "s"]
const TARGETS = ["a", "b", "c", "d", "e", "p", "q"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

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
				reads: once(model.reads(r.from!)),
				readers: once(model.readers(of)),
				of,
				after: i,
			})
		}
		const answers = await ask(requests)
		for (let i = 0; i < expected.length; i++) {
			const e = expected[i]
			const at = `seed ${seed}, step ${e.after}: ${JSON.stringify(seq[e.after])}`
			assertEquals(
				once(answers[i * 3 + 1].names!),
				e.reads,
				`${at}: reads of ${seq[e.after].from}`,
			)
			assertEquals(once(answers[i * 3 + 2].names!), e.readers, `${at}: readers of ${e.of}`)
		}
	}
})
