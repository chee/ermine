// Runs the scenarios and the fuzzer against a pack harness. PACK_HARNESS: the command for another
// implementation (default: the reference). The encoding is canonical (ENCODING.tex), so bytes are
// compared: each graph is walked, and packed to the reference's bytes, which read back as it; each
// of its nodes encoded alone to the reference's bytes, which decode back as it.
// A scenario: {title, root, nodes, expect: {nodes: [ids], missing}} or {expect: {code, id?}},
// which pack gives, and walk too unless it is cannot-carry; or {title, bytes, expect: {code}},
// unpacked, or decoded as one node with "node": true
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
	node?: Shown
	bytes?: string
	code?: string
	id?: string
	error?: string
}
type Expect = { nodes?: string[]; missing?: string[]; code?: string; id?: string }
type Scenario = {
	title: string
	root?: string
	nodes?: Shown[]
	bytes?: string
	node?: boolean
	expect: Expect
}

async function ask(command: string[], requests: Request[]): Promise<Answer[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(30_000),
	}).spawn()
	// answers read while requests are written: a full pipe either way never stops both
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

// the graph expected: the given nodes, by id, in the order expected
function expected(s: Scenario) {
	const by = new Map(s.nodes!.map((n) => [n.id, n]))
	return {
		root: s.root!,
		nodes: s.expect.nodes!.map((id) => by.get(id)!),
		missing: s.expect.missing!,
	}
}
const error = (e: Expect) => e.id === undefined ? { code: e.code } : { code: e.code, id: e.id }
const failed = (a: Answer) => a.id === undefined ? { code: a.code } : { code: a.code, id: a.id }

// every graph scenario, each way, in three runs
async function check(scenarios: Scenario[], name: (i: number) => string) {
	const graphs = scenarios.map((s, i) => ({ s, i })).filter(({ s }) => s.expect.code === undefined)
	const given = (s: Scenario) => ({ root: s.root, nodes: s.nodes })
	const asks = (s: Scenario) => [
		{ op: "pack", ...given(s) },
		...s.nodes!.map((node) => ({ op: "encode", node })),
	]
	const ours = await ask(
		subject,
		graphs.flatMap(({ s }) => [{ op: "walk", ...given(s) }, ...asks(s)]),
	)
	const theirs = await ask(reference, graphs.flatMap(({ s }) => asks(s)))
	const reads: Request[] = []
	let at = 0, from = 0
	graphs.forEach(({ s, i }) => {
		const walked = ours[at++]
		assertEquals(walked.graph, expected(s), `${name(i)}: walk`)
		const bytes = [ours[at++], ...s.nodes!.map(() => ours[at++])]
		const want = [theirs[from++], ...s.nodes!.map(() => theirs[from++])]
		assertEquals(bytes[0].bytes, want[0].bytes, `${name(i)}: pack, the reference's bytes`)
		s.nodes!.forEach((n, k) =>
			assertEquals(bytes[k + 1].bytes, want[k + 1].bytes, `${name(i)}: encode ${n.id}`)
		)
		reads.push({ op: "unpack", bytes: want[0].bytes })
		for (const b of want.slice(1)) reads.push({ op: "decode", bytes: b.bytes })
	})
	const back = await ask(subject, reads)
	at = 0
	graphs.forEach(({ s, i }) => {
		assertEquals(back[at++].graph, expected(s), `${name(i)}: unpack`)
		for (const n of s.nodes!) assertEquals(back[at++].node, n, `${name(i)}: decode ${n.id}`)
	})
}

for await (const f of Deno.readDir(`${here}scenarios`)) {
	if (!f.name.endsWith(".json")) continue
	const s = JSON.parse(await Deno.readTextFile(`${here}scenarios/${f.name}`)) as Scenario
	Deno.test(`${f.name}: ${s.title}`, async () => {
		if (s.bytes !== undefined) {
			const [a] = await ask(subject, [{ op: s.node ? "decode" : "unpack", bytes: s.bytes }])
			assertEquals(failed(a), error(s.expect))
			return
		}
		if (s.expect.code !== undefined) {
			const given = { root: s.root, nodes: s.nodes }
			const [walked, packed] = await ask(subject, [{ op: "walk", ...given }, {
				op: "pack",
				...given,
			}])
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
				case 0:
					return null
				case 1:
					return pick(2) === 0
				case 2:
					return pick(1 << 20) - (1 << 19)
				case 3:
					return pick(100) + 0.5
				case 4:
					return ["", "x", "é", "日本", 'a"b\\c\n'][pick(5)]
				case 5:
					return 2 ** 40 + pick(9)
				case 6:
					return Array.from({ length: pick(3) }, () => json(depth + 1))
				default:
					return Object.fromEntries(NAMES.slice(0, pick(3)).map((k) => [k, json(depth + 1)]))
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
