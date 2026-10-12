// Runs the scenarios, and a small fuzzer, against a harness. MUTATE_HARNESS: the command for
// another implementation (default: the reference). MUTATE_SKIP: scenario files it does not speak,
// by commas (the C harness has no typed arrays: 04-typed-arrays.json). The protocol: harness.ts.
//
// The fuzzer makes patches against content it follows with the reference library; each goes to
// the harness alone, then all that were valid in one change, with facts asked. Whatever answers
// must equal the reference's answers, and its facts must equal notify.ts's facts(patch, before).
import { assert, assertEquals } from "@std/assert"
import createChange, { type Change } from "@ermine/graph/change"
import createNode from "@ermine/graph/node"
import mutate, { MutateError } from "@ermine/op/mutate"
import { facts, type Patch } from "@ermine/scheduler/notify"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("MUTATE_HARNESS") ?? reference).split(" ")
const skip = new Set((Deno.env.get("MUTATE_SKIP") ?? "").split(",").filter((x) => x))

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[], cmd = command): Promise<Answer[]> {
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const lines = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l !== "")
	return lines.map((l) => JSON.parse(l))
}

type Step = Request & { expect: Answer }

for await (const f of Deno.readDir(`${here}../../core/op/conformance/mutate`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(
		await Deno.readTextFile(`${here}../../core/op/conformance/mutate/${f.name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test({ name: `${f.name}: ${title}`, ignore: skip.has(f.name) }, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, ...r } = s
			assertEquals(answers[i], s.expect, `step ${i}: ${JSON.stringify(r)}`)
		})
	})
}

Deno.test("an unknown op is an error, and the harness goes on", async () => {
	const [a, b] = await ask([{ op: "nope" }, { op: "start" }])
	assert(a.error)
	assertEquals(b, {})
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 30

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const KEYS = ["a", "b", "c"]
const start = {
	op: "start",
	value: [{ content: { l: [1, 2, 3], s: "ab", m: { a: 1 } }, change: { time: 0 } }],
}

// a patch against content v; some are not valid
function patch(pick: (n: number) => number, v: Record<string, unknown>): Patch {
	const l = v.l as unknown[], s = [...(v.s as string)]
	const i = pick(l.length + 1), j = i + pick(l.length - i + 1)
	const c = pick(s.length + 1), d = c + pick(s.length - c + 1)
	switch (pick(16)) {
		case 0:
			return { path: ["l"], range: [i, j], value: [pick(9)] }
		case 1:
			return { path: ["l"], range: [i, j] }
		case 2:
			return { path: ["s"], range: [c, c], value: pick(2) ? "x" : "😀" }
		case 3:
			return { path: ["s"], range: [c, d], value: pick(2) ? "é" : "" }
		case 4:
			return { path: ["m", KEYS[pick(3)]], value: pick(2) ? pick(9) : { n: [pick(9)] } }
		case 5:
			return { path: ["m", KEYS[pick(3)]] }
		case 6:
			return l.length
				? {
					path: ["l"],
					range: [i % l.length, i % l.length],
					move: { path: ["l", pick(l.length)] },
				}
				: { path: ["l"], range: [0, 0], value: [1, 2, 3] }
		case 7:
			return l.length > 1
				? {
					path: ["l"],
					range: [0, 0],
					move: { path: ["l"], range: [1, 1 + pick(l.length - 1)] },
				}
				: { path: ["l", 0], value: 0 }
		case 8:
			return l.length
				? { path: ["m", KEYS[pick(3)]], move: { path: ["l", pick(l.length)] } }
				: { path: ["s"], range: [0, 0], value: "y" }
		case 9:
			return l.length > 1
				? { path: ["l", pick(l.length - 1)], move: { path: ["l", pick(l.length)] } }
				: { path: ["l", pick(l.length + 1)], value: 7 }
		case 10:
			return { path: ["s"], range: [pick(2), 0 + pick(2)], move: { path: ["m", KEYS[pick(3)]] } }
		case 11:
			return pick(2)
				? { path: ["l", 9], value: 1 }
				: { path: ["s"], range: [c, c + 1 + pick(5)] }
		case 12:
			return pick(2)
				? { path: ["l"], range: [0, 0], value: "x" as unknown }
				: { path: ["m", "a", "z"], move: { path: ["m"] } } as Patch
		case 13:
			return { path: ["s"], range: [c, c], move: { path: ["s"], range: [c, d] } }
		default:
			return { path: ["l", pick(l.length + 1)], value: 7 }
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, as the reference, facts as notify's`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const n = createNode<unknown, Change>("a", {
			value: [{
				content: { l: [1, 2, 3], s: "ab", m: { a: 1 } },
				change: createChange("a", { time: 0, actor: "host" }),
			}],
		})
		const patches: Patch[] = [], good: Patch[] = []
		for (let k = 0; k < STEPS; k++) {
			const p = patch(pick, structuredClone(n.value[0].content) as Record<string, unknown>)
			patches.push(p)
			try {
				mutate(n, "value", [p], { time: 1, actor: "me" })
				good.push(p)
			} catch (e) {
				if (!(e instanceof MutateError)) throw e
			}
		}
		const requests: Request[] = [start]
		for (const p of patches) {
			requests.push({ op: "mutate", which: "value", patches: [p], patched: true }, {
				op: "node",
			})
		}
		requests.push(start, { op: "mutate", which: "value", patches: good, patched: true }, {
			op: "node",
		})
		const mine = await ask(requests)
		if (command.join(" ") !== reference) {
			assertEquals(mine, await ask(requests, reference.split(" ")), `seed ${seed}`)
		}
		// its facts are notify's, from the content before each patch
		let before = start.value[0].content as unknown
		patches.forEach((p, k) => {
			const a = mine[1 + 2 * k]
			if (a.fail) return
			assertEquals(a.facts, [facts(p, before)], `seed ${seed} patch ${k}`)
			before = mine[2 + 2 * k].node.value[0].content
		})
	}
})
