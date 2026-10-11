// Runs the scenarios, and a small fuzzer, against a harness. PLACES_HARNESS: the command for
// another implementation (default: the reference). PLACES_SKIP: scenario files it does not
// speak yet, by commas (a C harness without a C mutate: 13-write.json). The protocol: harness.ts.
//
// The fuzzer makes random graphs and reads them at random places; with PLACES_HARNESS set, the
// reference answers too and must give the same. Either way, a here made by cd answers as its
// names do, on a graph that holds still, whose walk did not stop part way, for reads that walk
// no names of their own: a here's . is its trail's, names walk afresh (PLACES.tex, cd).
import { assert, assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet ${here}harness.ts`
const command = (Deno.env.get("PLACES_HARNESS") ?? reference).split(" ")
const skip = new Set((Deno.env.get("PLACES_SKIP") ?? "").split(",").filter((x) => x))

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

for await (const f of Deno.readDir(`${here}../../graph/conformance/places`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, steps } = JSON.parse(await Deno.readTextFile(`${here}../../graph/conformance/places/${f.name}`)) as {
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
	const [a, b] = await ask([{ op: "nope" }, { op: "graph", root: "r", nodes: [] }])
	assert(a.error)
	assertEquals(b, {})
})

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const READS = 30

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const NAMES = ["a", "b", "c", "theme"]

// ids n0..n11, some not loaded; each loaded node has a few names, each a list of a few ids
function graph(pick: (n: number) => number) {
	const count = 12
	const nodes = []
	for (let i = 0; i < count; i++) {
		if (i > 0 && pick(6) === 0) continue
		const children = []
		for (const name of NAMES) {
			if (pick(3) === 0) continue
			const ids = Array.from({ length: 1 + pick(3) }, () => `n${1 + pick(count - 1)}`)
			if (pick(8) === 0) ids.splice(pick(ids.length + 1), 0, { $symbol: "s" } as never)
			children.push([name, [{ content: ids, change: { time: 0 } }]])
		}
		const value = pick(2) ? [{ content: i, change: { time: 0 } }] : []
		const info = pick(3) === 0 ? [["title", [{ content: `t${i}`, change: { time: 0 } }]]] : []
		nodes.push({ id: `n${i}`, value, info, children })
	}
	return { op: "graph", root: "n0", nodes }
}

const names = (pick: (n: number) => number, n: number) =>
	Array.from({ length: n }, () => NAMES[pick(NAMES.length)])

function reads(pick: (n: number) => number): Request[] {
	const out: Request[] = []
	for (let i = 0; i < READS; i++) {
		const place = names(pick, pick(4))
		const k = pick(7)
		const depend = pick(2) === 0
		const address = [
			...(pick(5) === 0 ? ["/"] : []),
			...Array.from(
				{ length: pick(3) === 0 ? pick(Math.min(place.length, 2) + 1) : 0 },
				() => "..",
			),
			...names(pick, pick(3)),
		]
		if (k === 0) out.push({ op: "look", place, address, depend })
		else if (k === 1) out.push({ op: "lookup", place, path: names(pick, 1 + pick(2)), depend })
		else if (k === 2) out.push({ op: "lookups", place, path: names(pick, 1 + pick(2)), depend })
		else if (k === 3) out.push({ op: "children", place, address, depend })
		else if (k === 4) out.push({ op: "children", place, address, name: NAMES[pick(4)], depend })
		else if (k === 5) out.push({ op: "content", place, address, depend })
		else out.push({ op: "info", place, address, name: "title", depend })
	}
	return out
}

Deno.test(`fuzz: ${SEEDS} seeds × ${READS} reads, as the reference`, async () => {
	if (command.join(" ") === reference) return
	for (let s = 1; s <= SEEDS; s++) {
		const pick = rand(s)
		const requests = [graph(pick), ...reads(pick)]
		const [mine, theirs] = await Promise.all([ask(requests), ask(requests, reference.split(" "))])
		assertEquals(mine, theirs, `seed ${s}`)
	}
})

Deno.test(`fuzz: ${SEEDS} seeds, a here answers as its names`, async () => {
	let compared = 0
	for (let s = 1; s <= SEEDS; s++) {
		const pick = rand(s + 1000)
		const requests: Request[] = [graph(pick)]
		const checks: [number, number][] = []
		for (let i = 0; i < READS; i++) {
			const place = names(pick, pick(4))
			requests.push({ op: "cd", address: place, as: "h" })
			const cd = requests.length - 1
			const kind = pick(3)
			const address = Array.from({ length: pick(Math.min(place.length, 2) + 1) }, () => "..")
			const path = names(pick, 1 + pick(2))
			const read = kind === 0
				? { op: "look", address }
				: kind === 1
				? { op: "lookup", path }
				: { op: "content", address }
			requests.push({ ...read, here: "h" }, { ...read, place })
			checks.push([cd, requests.length - 2])
		}
		const answers = await ask(requests)
		for (const [cd, i] of checks) {
			// a walk stopped part way: a here and names may differ (PLACES.tex, cd)
			const { names: n, trail } = answers[cd]
			if (trail.length !== n.length + 1) continue
			compared++
			assertEquals(answers[i], answers[i + 1], `seed ${s}: ${JSON.stringify(requests[i])}`)
		}
	}
	assert(compared > SEEDS * READS / 4, `only ${compared} compared`)
})
