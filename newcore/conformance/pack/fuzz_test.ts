// The reference against a pack harness, on what the scenarios never write. PACK_HARNESS: the other
// implementation (default: the reference, against itself). Values of every kind (form.ts): bytes,
// typed arrays of each kind, NaN, the infinities, -0, floats of each width, strings around each
// head's size, astral and escaped, maps of many keys, "/" and "__proto__" as keys.
// - across: each packs and encodes to the same bytes; each reads the other's back as the graph
//   the reference walked
// - mutated: bytes cut, grown and flipped; both say the same of each: the same graph or node, or
//   the same code
// a few dozen seeds (memory: fuzz runs small)
import { assertEquals } from "@std/assert"
import { line, toJson } from "./form.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`.split(" ")
const subject = (Deno.env.get("PACK_HARNESS") ?? reference.join(" ")).split(" ")

const SEEDS = 40, MUTATIONS = 20

type Request = Record<string, unknown> & { op: string }
type Answer = { graph?: unknown; node?: unknown; bytes?: string; code?: string; error?: string }

async function ask(command: string[], requests: Request[]): Promise<Answer[]> {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		signal: AbortSignal.timeout(60_000),
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => line(r)).join("\n") + "\n"))
	await w.close()
	const { stdout, success } = await output
	const answers = new TextDecoder().decode(stdout).trim().split("\n").filter((l) => l)
		.map((l) => JSON.parse(l))
	assertEquals(success, true, "the harness ends well")
	assertEquals(answers.length, requests.length, "an answer per request")
	return answers
}

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const STRINGS = [
	"",
	"a",
	"x".repeat(23),
	"x".repeat(24),
	"y".repeat(255),
	"z".repeat(256),
	"é",
	"水",
	"😀",
	'a"b\\c\n\t',
	"\u0000",
	"é".repeat(12),
	"mixed ascii and 😀 and 水".repeat(3),
]
const NUMBERS = [
	0,
	-0,
	1,
	-1,
	1.5,
	65504,
	65505,
	2 ** -24,
	2 ** -25,
	100000,
	0.1,
	-4.1,
	1e300,
	5e-324,
	2 ** 53,
	2 ** 53 + 2,
	2 ** 60,
	NaN,
	Infinity,
	-Infinity,
	3.4028234663852886e38,
	1760000000000,
]
const TYPED = [
	Int8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	BigInt64Array,
	BigUint64Array,
	Float32Array,
	Float64Array,
]

function values(pick: (n: number) => number) {
	const typed = () => {
		const T = TYPED[pick(TYPED.length)]
		const n = pick(6)
		if (T === BigInt64Array) {
			return BigInt64Array.from({ length: n }, () => BigInt(pick(1 << 30)) * -12345n)
		}
		if (T === BigUint64Array) {
			return BigUint64Array.from({ length: n }, () => BigInt(pick(1 << 30)) << 30n)
		}
		const t = new T(n)
		for (let i = 0; i < n; i++) {
			t[i] = T === Float32Array || T === Float64Array
				? NUMBERS[pick(NUMBERS.length)]
				: pick(1 << 16) - (1 << 15)
		}
		return t
	}
	const value = (depth: number): unknown => {
		switch (pick(depth > 2 ? 6 : 10)) {
			case 0:
				return [null, true, false][pick(3)]
			case 1:
			case 2:
				return NUMBERS[pick(NUMBERS.length)]
			case 3:
				return STRINGS[pick(STRINGS.length)]
			case 4:
				return Uint8Array.from({ length: pick(30) }, () => pick(256))
			case 5:
				return typed()
			case 6:
			case 7:
				return Array.from({ length: pick(pick(2) ? 4 : 30) }, () => value(depth + 1))
			default: {
				const n = pick(5) === 0 ? 30 : pick(5)
				const keys = pick(6) === 0
					? ["/"]
					: Array.from({ length: n }, () =>
						pick(8) === 0 ? "__proto__" : STRINGS[pick(STRINGS.length)] + pick(40))
				const out: Record<string, unknown> = {}
				for (const k of keys) {
					Object.defineProperty(out, k, {
						value: value(depth + 1),
						enumerable: true,
						writable: true,
						configurable: true,
					})
				}
				return out
			}
		}
	}
	return value
}

// a graph of a few nodes, some ids not loaded
function graph(seed: number) {
	const pick = rand(seed)
	const value = values(pick)
	const ids = Array.from({ length: 1 + pick(6) }, (_, i) => `n${i}`)
	const any = () => pick(5) ? ids[pick(ids.length)] : `gone${pick(3)}`
	const version = (list: boolean) => {
		const v: Record<string, unknown> = {
			content: list ? Array.from({ length: pick(4) }, any) : toJson(value(0)),
			change: toJson(value(1)),
		}
		if (pick(3) === 0) v.because = toJson(value(1))
		return v
	}
	const versions = (list: boolean) => Array.from({ length: pick(3) }, () => version(list))
	const named = (list: boolean) =>
		["a", "b", "c", "type", "é"].filter(() => pick(2)).map((name) => [name, versions(list)])
	const nodes = ids.map((id) => {
		const header: Record<string, unknown> = {}
		if (pick(2)) header.time = 1760000000000 + pick(1000)
		if (pick(2)) header.actor = toJson(value(1))
		if (pick(3) === 0) header.reader = STRINGS[pick(STRINGS.length)]
		if (pick(3) === 0) {
			const site: Record<string, unknown> = { file: "file:///a.ts", line: 1 + pick(99) }
			if (pick(2)) site.column = 1 + pick(80)
			if (pick(2)) site.function = "f"
			header.site = site
		}
		if (pick(4) === 0) header.cause = toJson(value(1))
		return { id, value: versions(false), info: named(false), children: named(true), header }
	})
	return { root: "n0", nodes }
}

// a map's keys in any order are the same map
const stable = (x: unknown): string =>
	line(
		x,
		(v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as never)[k]]))
				: v,
	)

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

function mutate(seed: number, bytes: string): string[] {
	const pick = rand(seed * 7919 + 1)
	return Array.from({ length: MUTATIONS }, () => {
		const b = Array.from(unhex(bytes))
		for (let k = 1 + pick(3); k > 0 && b.length; k--) {
			const at = pick(b.length)
			switch (pick(7)) {
				case 0:
					b[at] ^= 1 << pick(8)
					break
				case 1:
					b[at] = pick(256)
					break
				case 2:
					b.splice(at, 0, pick(256))
					break
				case 3:
					b.splice(at, 1)
					break
				case 4:
					b.length = at
					break
				case 5: {
					const to = pick(b.length)
					;[b[at], b[to]] = [b[to], b[at]]
					break
				}
				default:
					b.splice(at, 0, ...b.slice(at, at + 1 + pick(8)))
			}
		}
		return hex(Uint8Array.from(b))
	})
}

const graphs = Array.from({ length: SEEDS }, (_, i) => graph(i + 1))

Deno.test(`fuzz: ${SEEDS} graphs across, each reads the other's bytes`, async () => {
	const asks = (g: ReturnType<typeof graph>) => [
		{ op: "walk", ...g },
		{ op: "pack", ...g },
		...g.nodes.map((node) => ({ op: "encode", node })),
	]
	const [ours, theirs] = await Promise.all([
		ask(subject, graphs.flatMap(asks)),
		ask(reference, graphs.flatMap(asks)),
	])
	assertEquals(ours, theirs, "walk, pack and encode: the same answers, the same bytes")
	// the bytes each made, read by the other
	const reads = (a: Answer[]) => {
		const out: Request[] = []
		let at = 0
		for (const g of graphs) {
			at++
			out.push({ op: "unpack", bytes: a[at++].bytes })
			for (const _ of g.nodes) out.push({ op: "decode", bytes: a[at++].bytes })
		}
		return out
	}
	const [cross, back] = await Promise.all([
		ask(reference, reads(ours)),
		ask(subject, reads(theirs)),
	])
	let at = 0, k = 0
	for (const [i, g] of graphs.entries()) {
		const walked = theirs[at].graph
		at += 2 + g.nodes.length
		assertEquals(cross[k].graph, walked, `seed ${i + 1}: theirs read by the reference`)
		assertEquals(back[k].graph, walked, `seed ${i + 1}: the reference's read by theirs`)
		k++
		for (const n of g.nodes) {
			assertEquals(cross[k].node, back[k].node, `seed ${i + 1}: ${n.id} decoded`)
			k++
		}
	}
})

Deno.test(`fuzz: ${SEEDS} × ${MUTATIONS} mutated bytes, both say the same`, async () => {
	const packed = await ask(
		reference,
		graphs.flatMap((g) => [
			{ op: "pack", ...g },
			{ op: "encode", node: g.nodes[g.nodes.length - 1] },
		]),
	)
	const requests: Request[] = []
	for (let i = 0; i < SEEDS; i++) {
		for (const bytes of mutate(i + 1, packed[2 * i].bytes!)) {
			requests.push({ op: "unpack", bytes })
		}
		for (const bytes of mutate(i + 1000, packed[2 * i + 1].bytes!)) {
			requests.push({ op: "decode", bytes })
		}
	}
	const [ours, theirs] = await Promise.all([ask(subject, requests), ask(reference, requests)])
	const wrong = requests.map((r, i) => ({ r, a: ours[i], b: theirs[i] }))
		.filter(({ a, b }) => stable(a) !== stable(b))
	const kept = theirs.filter((a) => a.graph || a.node).length
	console.log(`${requests.length} mutated, ${kept} still read`)
	// where they differ: the first path, and what each says there
	const where = (a: unknown, b: unknown, path: string): string | undefined => {
		if (stable(a) === stable(b)) return
		if (a && b && typeof a === "object" && typeof b === "object") {
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
				const d = where((a as never)[k], (b as never)[k], `${path}.${k}`)
				if (d) return d
			}
		}
		return `${path}: ${line(a)?.slice(0, 80)} / ${line(b)?.slice(0, 80)}`
	}
	if (wrong.length) console.log(`first: ${wrong[0].r.op} ${wrong[0].r.bytes}`)
	assertEquals(wrong.slice(0, 5).map(({ r, a, b }) => `${r.op}: ${where(a, b, "")}`), [])
})
