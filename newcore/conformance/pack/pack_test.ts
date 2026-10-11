// Runs the scenarios and the fuzzer against a pack harness. PACK_HARNESS: the command for another
// implementation (default: the reference). Bytes are never compared: each graph is walked, packed
// by the harness and read back by the reference and the harness, and packed by the reference and
// read back by the harness; every way gives the same graph.
// A scenario: {title, root, nodes, expect: {nodes: [ids], missing}} or {expect: {code, id?}},
// which pack gives, and walk too unless it is cannot-carry; or {title, bytes, expect: {code}}
import { assertEquals } from "@std/assert"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`.split(" ")
const subject = (Deno.env.get("PACK_HARNESS") ?? reference.join(" ")).split(" ")

type Version = { content: unknown; change: unknown; because?: unknown }
type Shown = {
	id: string
	value: Version[]
	info: [string, Version[]][]
	children: [string, Version[]][]
	header: Record<string, unknown>
}
type Request = Record<string, unknown> & { op: string }
type Answer = {
	graph?: { root: string; nodes: Shown[]; missing: string[] }
	bytes?: string
	code?: string
	id?: string
	error?: string
}
type Expect = { nodes?: string[]; missing?: string[]; code?: string; id?: string }
type Scenario = { title: string; root?: string; nodes?: Shown[]; bytes?: string; expect: Expect }

async function ask(command: string[], requests: Request[]): Promise<Answer[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

// the graph expected: the given nodes, by id, in the order expected
function expected(s: Scenario) {
	const by = new Map(s.nodes!.map((n) => [n.id, n]))
	return { root: s.root!, nodes: s.expect.nodes!.map((id) => by.get(id)!), missing: s.expect.missing! }
}
const error = (e: Expect) => e.id === undefined ? { code: e.code } : { code: e.code, id: e.id }
const failed = (a: Answer) => a.id === undefined ? { code: a.code } : { code: a.code, id: a.id }

// every graph scenario, each way, in four runs
async function check(scenarios: Scenario[], name: (i: number) => string) {
	const graphs = scenarios.map((s, i) => ({ s, i })).filter(({ s }) => s.expect.code === undefined)
	const given = (s: Scenario) => ({ root: s.root, nodes: s.nodes })
	const first = await ask(subject, graphs.flatMap(({ s }) => [
		{ op: "walk", ...given(s) },
		{ op: "pack", ...given(s) },
	]))
	const theirs = await ask(reference, graphs.map(({ s }) => ({ op: "pack", ...given(s) })))
	graphs.forEach(({ i }, k) => {
		assertEquals(first[2 * k].error, undefined, `${name(i)}: walk`)
		assertEquals(first[2 * k + 1].bytes !== undefined, true, `${name(i)}: pack gives bytes`)
		assertEquals(theirs[k].bytes !== undefined, true, `${name(i)}: the reference packs`)
	})
	const read = await ask(reference, graphs.map((_, k) => ({ op: "unpack", bytes: first[2 * k + 1].bytes })))
	const back = await ask(subject, graphs.flatMap((_, k) => [
		{ op: "unpack", bytes: first[2 * k + 1].bytes },
		{ op: "unpack", bytes: theirs[k].bytes },
	]))
	graphs.forEach(({ s, i }, k) => {
		const want = expected(s)
		assertEquals(first[2 * k].graph, want, `${name(i)}: walk`)
		assertEquals(read[k].graph, want, `${name(i)}: packed, read by the reference`)
		assertEquals(back[2 * k].graph, want, `${name(i)}: packed, read back`)
		assertEquals(back[2 * k + 1].graph, want, `${name(i)}: packed by the reference, read`)
	})
}

for await (const f of Deno.readDir(`${here}scenarios`)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(`${here}scenarios/${f.name}`)) as Scenario
	Deno.test(`${f.name}: ${s.title}`, async () => {
		if (s.bytes !== undefined) {
			const [a] = await ask(subject, [{ op: "unpack", bytes: s.bytes }])
			assertEquals(failed(a), error(s.expect))
			return
		}
		if (s.expect.code !== undefined) {
			const given = { root: s.root, nodes: s.nodes }
			const [walked, packed] = await ask(subject, [{ op: "walk", ...given }, { op: "pack", ...given }])
			assertEquals(failed(packed), error(s.expect), "pack")
			if (s.expect.code === "cannot-carry") assertEquals(walked.error, undefined, "walk")
			else assertEquals(failed(walked), error(s.expect), "walk")
			return
		}
		await check([s], () => f.name)
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const NAMES = ["a", "b", "c", "d"]

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// PACK.tex's walk read plainly: the root, then each id in each version of each list, once
function model(root: string, nodes: Shown[]): Expect {
	const by = new Map(nodes.map((n) => [n.id, n]))
	const order = [root], missing: string[] = [], seen = new Set([root])
	for (let i = 0; i < order.length; i++) {
		for (const [, vs] of by.get(order[i])!.children) {
			for (const v of vs) {
				for (const id of v.content as unknown[]) {
					if (typeof id !== "string" || seen.has(id)) continue
					seen.add(id)
					if (by.has(id)) order.push(id)
					else missing.push(id)
				}
			}
		}
	}
	return { nodes: order, missing }
}

Deno.test(`fuzz: ${SEEDS} seeds, every way`, async () => {
	const scenarios: Scenario[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const pick = rand(seed)
		const ids = Array.from({ length: 1 + pick(7) }, (_, i) => `n${i}`)
		const anyId = () => pick(5) ? ids[pick(ids.length)] : `gone${pick(3)}`
		const json = (depth: number): unknown => {
			switch (pick(depth > 1 ? 6 : 8)) {
				case 0: return null
				case 1: return pick(2) === 0
				case 2: return pick(1 << 20) - (1 << 19)
				case 3: return pick(100) + 0.5
				case 4: return ["", "x", "é", "日本", "a\"b\\c\n"][pick(5)]
				case 5: return 2 ** 40 + pick(9)
				case 6: return Array.from({ length: pick(3) }, () => json(depth + 1))
				default: return Object.fromEntries(NAMES.slice(0, pick(3)).map((k) => [k, json(depth + 1)]))
			}
		}
		const version = (list: boolean): Version => {
			const v: Version = {
				content: list ? Array.from({ length: pick(4) }, anyId) : json(0),
				change: { time: pick(1000), actor: NAMES[pick(4)], node: "n" },
			}
			if (pick(3) === 0) v.because = json(1)
			return v
		}
		const versions = (list: boolean) => Array.from({ length: pick(3) }, () => version(list))
		const named = (list: boolean) =>
			NAMES.filter(() => pick(2)).map((name) => [name, versions(list)] as [string, Version[]])
		const nodes = ids.map((id): Shown => {
			const header: Record<string, unknown> = {}
			if (pick(2)) header.time = pick(2) ? pick(1 << 30) : 1760000000000 + pick(1000)
			if (pick(2)) header.actor = json(1)
			if (pick(3) === 0) header.reader = NAMES[pick(4)]
			if (pick(3) === 0) {
				header.site = { file: "file:///a.ts", line: 1 + pick(99) }
				if (pick(2)) (header.site as Record<string, unknown>).column = 1 + pick(80)
				if (pick(2)) (header.site as Record<string, unknown>).function = "f"
			}
			if (pick(4) === 0) header.cause = json(1)
			return { id, value: versions(false), info: named(false), children: named(true), header }
		})
		scenarios.push({ title: `seed ${seed}`, root: "n0", nodes, expect: model("n0", nodes) })
	}
	await check(scenarios, (i) => `seed ${i + 1}`)
})
