// Runs the scenarios, and a small fuzzer, against a harness. UPDATE_HARNESS: the command for
// another implementation (default: the reference). UPDATE_SKIP: scenario files it does not speak,
// by commas (typed arrays: 04-typed-arrays.json). The protocol: harness.ts.
//
// Every successful update is also checked here: the undo in the node's change, applied to the
// value after, gives the value before (maps by content), and a failed one leaves the node as it was.
//
// The fuzzer makes patches against content it follows with the reference library; each goes to
// the harness alone, then all that were valid in one change. Whatever answers must equal the
// reference's answers, and the one change must end where the reference's patches one by one did.
import { assert, assertEquals } from "@std/assert"
import createNode from "@ermine/node"
import update from "@ermine/node/update"
import apply, { ApplyError, type Patch } from "@ermine/op/apply"
import { dehydrate, revive } from "./form.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("UPDATE_HARNESS") ?? reference).split(" ")
const skip = new Set((Deno.env.get("UPDATE_SKIP") ?? "").split(",").filter((x) => x))

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

// keys in order, so maps compare by content
const canon = (v: unknown): unknown =>
	Array.isArray(v)
		? v.map(canon)
		: v !== null && typeof v === "object"
		? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Answer)[k])]))
		: v

// a node request before and after every update, and what they must say:
// asked: the requests to send; check: the answers to them (the scenario's own at its indexes)
function around(
	steps: Request[],
): { asked: Request[]; at: number[]; check: (a: Answer[]) => void } {
	const asked: Request[] = [], at: number[] = []
	for (const s of steps) {
		if (s.op === "update") asked.push({ op: "node" })
		at.push(asked.length)
		asked.push(s)
		if (s.op === "update") asked.push({ op: "node" })
	}
	const check = (a: Answer[]) => {
		steps.forEach((s, k) => {
			if (s.op !== "update") return
			const i = at[k]
			const before = a[i - 1].node, after = a[i + 1].node
			if (a[i].error) {
				assertEquals(after, before, `step ${k}: a failed update changes nothing`)
				return
			}
			const undo = (after.change.op.undo as Patch[]).map((p) => revive(p) as Patch)
			const back = apply(revive(after.value), undo, { list: s.list === true })
			assertEquals(
				canon(dehydrate(back)),
				canon(before.value),
				`step ${k}: the undo takes the value back`,
			)
		})
	}
	return { asked, at, check }
}

type Step = Request & { expect: Answer }

for await (const f of Deno.readDir(`${here}../../core/node/conformance/update`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(
		await Deno.readTextFile(`${here}../../core/node/conformance/update/${f.name}`),
	) as {
		title: string
		steps: Step[]
	}
	Deno.test({ name: `${f.name}: ${title}`, ignore: skip.has(f.name) }, async () => {
		const requests = steps.map(({ expect: _, ...r }) => r)
		const { asked, at, check } = around(requests)
		const answers = await ask(asked)
		assertEquals(answers.length, asked.length, "one answer per request")
		steps.forEach((s, i) => {
			assertEquals(answers[at[i]], s.expect, `step ${i}: ${JSON.stringify(requests[i])}`)
		})
		check(answers)
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
const content = () => ({ l: [1, 2, 3], s: "ab", m: { a: 1 } })
const start = { op: "start", value: content(), header: { time: 0, actor: "host" } }

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

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, as the reference`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const n = createNode<Record<string, unknown>>(content())
		const patches: Patch[] = [], good: Patch[] = []
		for (let k = 0; k < STEPS; k++) {
			const p = patch(pick, structuredClone(n.value!))
			patches.push(p)
			try {
				update(n, [p], { time: 1, actor: "me" })
				good.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		const steps: Request[] = [start]
		for (const p of patches) steps.push({ op: "update", patches: [p] })
		steps.push(start, { op: "update", patches: good }, { op: "node" })
		const { asked, check } = around(steps)
		const mine = await ask(asked)
		if (command.join(" ") !== reference) {
			assertEquals(mine, await ask(asked, reference.split(" ")), `seed ${seed}`)
		}
		check(mine)
		// the one change ends where the patches one by one did
		assertEquals(
			canon(mine[mine.length - 1].node.value),
			canon(dehydrate(n.value)),
			`seed ${seed}: the end`,
		)
	}
})
