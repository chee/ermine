// Runs the scenarios, and a seeded fuzzer, against a harness. TABLE_HARNESS: the command for
// another implementation (default: the reference). The protocol: harness.ts.
//
// The fuzzer runs random operations, and checks every answer against a plain model here: a list of
// [part, id, node] triples in the order made, and the order each node's parts were first taken.
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("TABLE_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../core/graph/conformance/table`

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
// deno-lint-ignore no-explicit-any
type Answer = Record<string, any>

async function ask(requests: Request[]): Promise<Answer[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
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

for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${scenarios}/${f.name}`)) as {
		title: string
		steps: Step[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		const answers = await ask(steps.map(({ expect: _, ...r }) => r))
		assertEquals(answers.length, steps.length, "one answer per request")
		steps.forEach((s, i) => {
			const { expect: _, ...r } = s
			assertEquals(answers[i], s.expect, `step ${i}: ${JSON.stringify(r)}`)
		})
	})
}

Deno.test("an unknown op, or a malformed request, is an error, and the harness goes on", async () => {
	const answers = await ask([
		{ op: "nope" },
		{ op: "add", part: 1, id: "a", node: "n" },
		{ op: "add", part: "p", id: "a" },
		{ op: "add", part: "p", id: "a", node: "n" },
		{ op: "get", part: "p", id: "a" },
	])
	assertEquals(answers.length, 5)
	for (const i of [0, 1, 2]) {
		assert(typeof answers[i].error === "string")
		assert(answers[i].error !== "already-there" && answers[i].error !== "nothing-there")
	}
	assertEquals(answers[3], {})
	assertEquals(answers[4], { node: "n" })
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 300
const PARTS: unknown[] = ["value", "children", "info", { symbol: "drag" }]
const IDS: unknown[] = ["a", "b", "c", "d", { symbol: "here" }]
const NODES = ["n1", "n2", "n3", "n4"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

type Triple = [unknown, unknown, string]
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// the table, plainly: triples in the order made; groups: a node's parts in the order each was first taken
class Model {
	triples: Triple[] = []
	groups: [string, unknown][] = []
	find(part: unknown, id: unknown) {
		return this.triples.findIndex((t) => same(t[0], part) && same(t[1], id))
	}
	put(part: unknown, id: unknown, node: string) {
		this.triples.push([part, id, node])
		if (!this.groups.some((g) => g[0] === node && same(g[1], part))) {
			this.groups.push([node, part])
		}
	}
	take(i: number) {
		const [part, , node] = this.triples.splice(i, 1)[0]
		if (!this.triples.some((t) => t[2] === node && same(t[0], part))) {
			this.groups = this.groups.filter((g) => !(g[0] === node && same(g[1], part)))
		}
	}
	add(part: unknown, id: unknown, node: string): Answer {
		const i = this.find(part, id)
		if (i >= 0) return this.triples[i][2] === node ? {} : { error: "already-there" }
		this.put(part, id, node)
		return {}
	}
	sub(part: unknown, id: unknown, node: string): Answer {
		const i = this.find(part, id)
		if (i >= 0) {
			if (this.triples[i][2] === node) return {}
			this.take(i)
		}
		this.put(part, id, node)
		return {}
	}
	get(part: unknown, id: unknown): Answer {
		const i = this.find(part, id)
		return i < 0 ? {} : { node: this.triples[i][2] }
	}
	ids(part: unknown, node: string): Answer {
		return { ids: this.triples.filter((t) => same(t[0], part) && t[2] === node).map((t) => t[1]) }
	}
	at(id: unknown): Answer {
		return { entries: this.triples.filter((t) => same(t[1], id)).map((t) => [t[0], t[2]]) }
	}
	who(node: string): Answer {
		const keys: unknown[] = []
		for (const [n, part] of this.groups) {
			if (n !== node) continue
			for (const t of this.triples) {
				if (t[2] === node && same(t[0], part)) keys.push([part, t[1]])
			}
		}
		return { keys }
	}
	delKey(part: unknown, id: unknown): Answer {
		const i = this.find(part, id)
		if (i < 0) return { error: "nothing-there" }
		this.take(i)
		return {}
	}
	delPart(part: unknown, node: string): Answer {
		let any = false
		for (let i = this.triples.length - 1; i >= 0; i--) {
			const t = this.triples[i]
			if (same(t[0], part) && t[2] === node) {
				this.take(i)
				any = true
			}
		}
		return any ? {} : { error: "nothing-there" }
	}
	delNode(node: string): Answer {
		let any = false
		for (let i = this.triples.length - 1; i >= 0; i--) {
			if (this.triples[i][2] === node) {
				this.take(i)
				any = true
			}
		}
		return any ? {} : { error: "nothing-there" }
	}
}

function sequence(seed: number): [Request, Answer][] {
	const pick = rand(seed)
	const one = <T>(xs: T[]) => xs[pick(xs.length)]
	const m = new Model()
	const out: [Request, Answer][] = []
	for (let i = 0; i < STEPS; i++) {
		const part = one(PARTS), id = one(IDS), node = one(NODES)
		const k = pick(20)
		let r: Request, a: Answer
		if (k < 6) {
			r = { op: "add", part, id, node }
			a = m.add(part, id, node)
		} else if (k < 8) {
			r = { op: "sub", part, id, node }
			a = m.sub(part, id, node)
		} else if (k < 10) {
			r = { op: "get", part, id }
			a = m.get(part, id)
		} else if (k < 12) {
			r = { op: "ids", part, node }
			a = m.ids(part, node)
		} else if (k < 13) {
			r = { op: "at", id }
			a = m.at(id)
		} else if (k < 15) {
			r = { op: "who", node }
			a = m.who(node)
		} else if (k < 17) {
			r = { op: "del", part, id }
			a = m.delKey(part, id)
		} else if (k < 19) {
			r = { op: "del", part, node }
			a = m.delPart(part, node)
		} else {
			r = { op: "del", node }
			a = m.delNode(node)
		}
		out.push([r, a])
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds of ${STEPS} operations, against a plain model`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const steps = sequence(seed)
		const answers = await ask(steps.map(([r]) => r))
		assertEquals(answers.length, steps.length, `seed ${seed}`)
		steps.forEach(([r, a], i) => {
			assertEquals(answers[i], a, `seed ${seed}, step ${i}: ${JSON.stringify(r)}`)
		})
	}
})
