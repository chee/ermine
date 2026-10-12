// Runs the history scenarios (sync/conformance/history/*.json, written by fixtures.ts) against a
// history harness. HISTORY_HARNESS: the command for another implementation (default: the reference).
// A scenario: {title, steps: [{request, expect}]}, one session begun by its create; each answer
// compared whole (harness.ts has the protocol). Every scenario runs in one harness process.
// Then the order fuzz: small random sets of blops for one node (two objects; some for another
// node, some with a bad lamport, bad patches, a parent in the other history or a parent never
// added), added in several shuffled orders, each with a few added again at the end: heads,
// get, waiting and refused the same for every order (HISTORY.tex: the same blops, the same
// answers), and every blop added exactly one of taken in, waiting, refused or stuck.
import { assertEquals } from "@std/assert"
import { encode, name } from "@ermine/encoding/blop"
import { toJson } from "../pack/form.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`
const subject = (Deno.env.get("HISTORY_HARNESS") ?? reference).split(" ")
const scenarios = `${here}../../extensions/subduction/conformance/history/`

type Request = Record<string, unknown> & { op: string }
type Step = { request: Request; expect: unknown }
type Scenario = { title: string; steps: Step[] }

async function ask(command: string[], requests: Request[]): Promise<unknown[]> {
	if (requests.length === 0) return []
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		// a harness that loops fails, not hangs
		signal: AbortSignal.timeout(60_000),
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

const files: { name: string; s: Scenario }[] = []
for await (const f of Deno.readDir(scenarios)) {
	if (!f.name.endsWith(".json")) continue
	files.push({ name: f.name, s: JSON.parse(await Deno.readTextFile(scenarios + f.name)) })
}
files.sort((a, b) => a.name.localeCompare(b.name))

// ---- the order fuzz
// mulberry32: the same blops for a seed everywhere
function random(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const OBJECTS: unknown[] = ["value", ["info", "t"]]
type F = { form: unknown; name: string; bytes: Uint8Array; lamport: number; object: number }

function blops(seed: number): { added: F[]; all: F[] } {
	const r = random(seed)
	const all: F[] = []
	const added: F[] = []
	const n = 6 + Math.floor(r() * 9)
	for (let i = 0; i < n; i++) {
		const object = r() < 0.75 ? 0 : 1
		const mine = all.filter((b) => b.object === object)
		// now and then a parent from the other history
		const pool = r() < 0.08 ? all : mine
		const k = pool.length === 0 ? 0 : r() < 0.3 ? 0 : r() < 0.7 ? 1 : 2
		const parents: F[] = []
		while (parents.length < Math.min(k, pool.length)) {
			const p = pool[Math.floor(r() * pool.length)]
			if (!parents.includes(p)) parents.push(p)
		}
		parents.sort((a, b) => a.name < b.name ? -1 : 1)
		let lamport = parents.length ? Math.max(...parents.map((p) => p.lamport)) + 1 : 1
		if (r() < 0.08) lamport++
		const x = r()
		const patches = x < 0.1
			? [{ path: ["x"], value: 1 }]
			: x < 0.4
			? [{ path: [], value: i }]
			: []
		const blop: Record<string, unknown> = {
			node: r() < 0.05 ? "other" : "n",
			object: OBJECTS[object],
			actor: "a",
			signer: new Uint8Array(32).fill(1),
			nonce: Uint8Array.from({ length: 8 }, (_, j) => (seed * 64 + i) >> (8 * j) & 0xff),
			parents: parents.map((p) => p.bytes),
			lamport,
			patches,
		}
		if (parents.length >= 2) blop.base = parents[Math.floor(r() * parents.length)].bytes
		const bytes = name(encode(blop as never))
		const form = toJson(blop)
		const f = { form, name: hex(bytes), bytes, lamport, object }
		all.push(f)
		// now and then one never added: what waits on it waits for good
		if (r() >= 0.1) added.push(f)
	}
	return { added, all }
}

function shuffle<T>(xs: T[], r: () => number): T[] {
	const a = [...xs]
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1))
		;[a[i], a[j]] = [a[j], a[i]]
	}
	return a
}

const SEEDS = 30
const ORDERS = 4
const fuzz: { seed: number; added: F[]; at: number; asks: number }[] = []
const fuzzNames: Record<number, string[]> = {}
const requests: Request[] = files.flatMap(({ s }) => s.steps.map((t) => t.request))
const scenarioCount = requests.length
for (let seed = 1; seed <= SEEDS; seed++) {
	const { added, all } = blops(seed)
	const r = random(seed ^ 0x5eed)
	const at = requests.length
	fuzzNames[seed] = all.map((b) => b.name)
	for (let o = 0; o < ORDERS; o++) {
		const order = o === 0 ? added : shuffle(added, r)
		requests.push({ op: "create", node: "n" })
		for (const b of order) requests.push({ op: "add", blop: b.form, name: b.name })
		for (const b of shuffle(added, r).slice(0, 3)) {
			requests.push({ op: "add", blop: b.form, name: b.name })
		}
		for (const object of OBJECTS) requests.push({ op: "heads", object })
		for (const b of all) requests.push({ op: "get", name: b.name })
		requests.push({ op: "waiting" }, { op: "refused" })
	}
	fuzz.push({ seed, added, at, asks: (requests.length - at) / ORDERS })
}

// every request in one run; a harness that dies fails each test with why
let answers: unknown[] = []
let died: unknown
try {
	answers = await ask(subject, requests)
} catch (e) {
	died = e
}

let at = 0
for (const { name, s } of files) {
	const mine = answers.slice(at, at += s.steps.length)
	Deno.test(`${name}: ${s.title}`, () => {
		if (died) throw died
		s.steps.forEach((t, i) => assertEquals(mine[i], t.expect, `${name} #${i}: ${t.request.op}`))
	})
}
if (at !== scenarioCount) throw new Error("scenario answers miscounted")

Deno.test(`order fuzz: ${SEEDS} seeds, ${ORDERS} orders each`, () => {
	if (died) throw died
	for (const { seed, added, at, asks } of fuzz) {
		// what each order answers after its adds: the queries, its last requests
		const queries = asks - (1 + added.length + Math.min(3, added.length))
		const of = (o: number) => answers.slice(at + (o + 1) * asks - queries, at + (o + 1) * asks)
		const first = of(0)
		for (let o = 1; o < ORDERS; o++) assertEquals(of(o), first, `seed ${seed}, order ${o}`)
		// every blop added: in exactly one of get, waiting(), refused()
		const gets = first.slice(OBJECTS.length, -2) as { blop?: unknown }[]
		const waiting = first.at(-2) as { name: string }[]
		const refused = first.at(-1) as { name: string }[]
		const places = [
			...gets.flatMap((g, i) => g.blop === undefined ? [] : [fuzzNames[seed][i]]),
			...waiting.map((w) => w.name),
			...refused.map((x) => x.name),
		].sort()
		assertEquals(places, added.map((b) => b.name).sort(), `seed ${seed}: each added, one place`)
	}
})
