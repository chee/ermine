// Runs the scenarios and the fuzzer against a harness. NOTIFY_HARNESS: the command for another
// implementation (default: the reference). The protocol: harness.ts.
//
// The fuzzer needs no second implementation: every element it makes is new and never reused, so
// what each read should hear is seen by comparing the content before and after a patch.
import { assertEquals } from "@std/assert"
import { apply, at, slice, type V } from "./apply.ts"
import type { Key, Patch, Place } from "../../notify.ts"

const here = new URL(".", import.meta.url).pathname
const command = (Deno.env.get("NOTIFY_HARNESS") ?? `deno run --quiet ${here}harness.ts`).split(" ")

type Request = Record<string, unknown> & { op: string }
type Answer = { error?: string; heard?: Record<string, string[]>; path?: V; value?: V; live?: boolean }

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

// one harness for a whole run: requests go in as they are made, answers read back in order
function session() {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const w = child.stdin.getWriter()
	const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
	let buffer = ""
	async function line(): Promise<string> {
		for (;;) {
			const i = buffer.indexOf("\n")
			if (i !== -1) {
				const l = buffer.slice(0, i)
				buffer = buffer.slice(i + 1)
				return l
			}
			const { value, done } = await lines.read()
			if (done) throw new Error("the harness stopped")
			buffer += value
		}
	}
	return {
		async send(requests: Request[]): Promise<Answer[]> {
			await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
			const out: Answer[] = []
			for (const _ of requests) out.push(JSON.parse(await line()))
			return out
		},
		async close() {
			await w.close()
			await lines.cancel()
			await child.status
		},
	}
}

const sorted = (h: Record<string, string[]> = {}) =>
	Object.fromEntries(Object.entries(h).map(([k, v]) => [k, [...v].sort()]).sort(([a], [b]) => a < b ? -1 : 1))

// scenarios: a patch step gives no content after; it is worked out here
for await (const f of Deno.readDir(`${here}scenarios`)) {
	if (!f.name.endsWith(".json")) continue
	const { title, start, steps } = JSON.parse(await Deno.readTextFile(`${here}scenarios/${f.name}`)) as {
		title: string
		start: V
		steps: (Request & { expect?: Answer & Record<string, unknown> })[]
	}
	Deno.test(`${f.name}: ${title}`, async () => {
		let content = start
		const requests: Request[] = [{ op: "start", value: start }]
		for (const { expect: _, ...s } of steps) {
			if (s.op === "patch") {
				content = apply(content, s.patch as Patch)
				requests.push({ ...s, value: content })
			} else requests.push(s)
		}
		const answers = await ask(requests)
		assertEquals(answers.length, requests.length, "one answer per request")
		steps.forEach((s, i) => {
			const a = answers[i + 1]
			const at = `step ${i}: ${JSON.stringify(s)}`
			assertEquals(a.error, undefined, at)
			if (s.expect === undefined) return
			if (s.op === "patch") assertEquals(sorted(a.heard), sorted(s.expect as Record<string, string[]>), at)
			else {
				for (const k of Object.keys(s.expect)) {
					assertEquals((a as Record<string, unknown>)[k], s.expect[k], `${at}: ${k}`)
				}
			}
		})
	})
}

// a few dozen seeds (memory: fuzz runs small)
const SEEDS = 40
const STEPS = 120

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

type Content = {
	title: string
	items: string[]
	text: string
	rows: { id: string; v: string; x?: string }[]
	meta: Record<string, string>
}

type Edge = "in" | "out"
type Watch = {
	name: string
	keys: Key[]
	span: [number, number] | null
	deep: boolean
	chase: boolean
	edges: [Edge, Edge]
	empty: "keep" | "gone"
	// a chase: the thing it holds, by its tag (an item, a row's id, a meta value); a span: its tags
	anchor: string | null
}

const same = (a: V, b: V) => a === b
const chars = (s: string) => Array.from(s)
const elems = (v: V): V[] => typeof v === "string" ? chars(v) : Array.isArray(v) ? v : []
const sameList = (a: V[], b: V[]) => a.length === b.length && a.every((x, i) => x === b[i])
const keyEq = (a: Key, b: Key) => a === b
const prefix = (p: readonly Key[], of: readonly Key[]) => p.length <= of.length && p.every((k, i) => keyEq(k, of[i]))
const places = (p: Patch): Place[] => p.move ? [p.move, p] : [p]

// every place of the patch inside the content at K: under it, or a span of the sequence at K
function within(p: Patch, K: readonly Key[]): boolean {
	return places(p).every((q) => prefix(K, q.path) && (q.path.length > K.length || q.range !== undefined))
}
// every place strictly under one element of the list at K
function underElements(p: Patch, K: readonly Key[]): boolean {
	return places(p).every((q) => prefix(K, q.path) && q.path.length > K.length + 1)
}
// a move inside one sequence: by position, everything from its lower end on may fire
function moveFloor(p: Patch): { seq: readonly Key[]; floor: number } | null {
	if (!p.move) return null
	const m = p.move
	const seq = m.range ? m.path : m.path.slice(0, -1)
	if (!p.range || !sameList(seq as V[], p.path as V[])) return null
	const from = m.range ? m.range[0] : m.path[m.path.length - 1] as number
	return { seq, floor: Math.min(from, p.range[0]) }
}

function anchorOf(c: V, keys: readonly Key[]): string | null {
	const [top, k] = keys
	if (top === "items" && keys.length === 2) return typeof at(c, keys) === "string" ? at(c, keys) as string : null
	if (top === "rows" && keys.length >= 2) {
		const row = at(c, ["rows", k]) as { id: string } | undefined
		return row ? row.id : null
	}
	if (top === "meta" && keys.length === 2) return (at(c, keys) as string) ?? null
	if (top === "title" && keys.length === 1) return at(c, keys) as string
	return null
}
function find(c: Content, keys: readonly Key[], anchor: string): Key[] | null {
	const [top, , ...rest] = keys
	if (top === "items") {
		const j = c.items.indexOf(anchor)
		return j === -1 ? null : ["items", j]
	}
	if (top === "rows") {
		const j = c.rows.findIndex((r) => r.id === anchor)
		return j === -1 ? null : ["rows", j, ...rest]
	}
	if (top === "meta") {
		const k = Object.keys(c.meta).find((k) => c.meta[k] === anchor)
		return k === undefined ? null : ["meta", k]
	}
	if (top === "title") return c.title === anchor ? ["title"] : null
	return null
}
function generate(seed: number) {
	const pick = rand(seed)
	let tag = 0
	const fresh = () => `e${tag++}`
	const char = () => String.fromCodePoint(tag++ % 2 ? 0x4e00 + tag : 0x1f300 + tag)
	const start = (): Content => ({
		title: fresh(),
		items: Array.from({ length: 6 }, fresh),
		text: Array.from({ length: 8 }, char).join(""),
		rows: Array.from({ length: 4 }, () => ({ id: fresh(), v: fresh() })),
		meta: { k0: fresh(), k1: fresh(), k2: fresh() },
	})
	// inside the sequence: a caret anywhere in [0, n], else at least one element
	const span = (n: number, empty: boolean): [number, number] => {
		if (empty) {
			const a = pick(n + 1)
			return [a, a]
		}
		const a = pick(n)
		return [a, a + 1 + pick(n - a)]
	}
	const edge = (): Edge => pick(2) ? "in" : "out"

	function patch(c: Content): Patch | null {
		const k = pick(100)
		const L = c.items.length, T = chars(c.text).length, R = c.rows.length
		const metaKeys = Object.keys(c.meta)
		const range = (n: number): [number, number] => {
			const a = pick(n + 1)
			return [a, a + pick(Math.min(3, n - a) + 1)]
		}
		if (k < 12) {
			const r = range(L)
			const v = Array.from({ length: pick(3) }, fresh)
			return r[0] === r[1] && v.length === 0 ? null : { path: ["items"], range: r, value: v }
		}
		if (k < 18) {
			const r = range(L)
			return r[0] === r[1] ? null : { path: ["items"], range: r }
		}
		if (k < 24) return L ? { path: ["items", pick(L)], value: fresh() } : null
		if (k < 30) return L ? { path: ["items", pick(L)] } : null
		if (k < 36) {
			if (!L) return null
			const g = pick(L)
			return { path: ["items"], range: [g, g], move: { path: ["items", pick(L)] } }
		}
		if (k < 42) {
			const r = range(L)
			if (r[0] === r[1]) return null
			const g = pick(L - (r[1] - r[0]) + 1)
			return { path: ["items"], range: [g, g], move: { path: ["items"], range: r } }
		}
		if (k < 52) {
			const r = range(T)
			const v = Array.from({ length: pick(3) }, char).join("")
			return r[0] === r[1] && v === "" ? null : { path: ["text"], range: r, value: v }
		}
		if (k < 56) {
			const r = range(T)
			if (r[0] === r[1]) return null
			const g = pick(T - (r[1] - r[0]) + 1)
			return { path: ["text"], range: [g, g], move: { path: ["text"], range: r } }
		}
		if (k < 60) {
			const g = pick(R + 1)
			return { path: ["rows"], range: [g, g], value: [{ id: fresh(), v: fresh() }] }
		}
		if (k < 63) return R ? { path: ["rows", pick(R)] } : null
		if (k < 68) return R ? { path: ["rows", pick(R), "v"], value: fresh() } : null
		if (k < 71) return R ? { path: ["rows", pick(R), "x"], value: fresh() } : null
		if (k < 73) {
			if (!R) return null
			const i = pick(R)
			return c.rows[i].x === undefined ? null : { path: ["rows", i, "x"] }
		}
		if (k < 75) return R ? { path: ["rows", pick(R)], value: { id: fresh(), v: fresh() } } : null
		if (k < 78) {
			if (!R) return null
			const g = pick(R)
			return { path: ["rows"], range: [g, g], move: { path: ["rows", pick(R)] } }
		}
		if (k < 82) return { path: ["meta", `k${pick(5)}`], value: fresh() }
		if (k < 85) return metaKeys.length ? { path: ["meta", metaKeys[pick(metaKeys.length)]] } : null
		if (k < 89) {
			if (!metaKeys.length) return null
			const from = metaKeys[pick(metaKeys.length)]
			const to = `k${pick(5)}`
			return from === to ? null : { path: ["meta", to], move: { path: ["meta", from] } }
		}
		if (k < 97) return { path: ["title"], value: fresh() }
		if (k < 98) return { path: [], value: start() }
		return null
	}

	let count = 0
	function watch(c: Content): Watch {
		const name = `r${count++}`
		const chase = pick(2) === 0
		const L = c.items.length, T = chars(c.text).length, R = c.rows.length
		const metaKeys = Object.keys(c.meta)
		const w: Watch = {
			name,
			keys: [],
			span: null,
			deep: !chase && pick(3) === 0,
			chase,
			edges: [edge(), edge()],
			empty: pick(2) ? "keep" : "gone",
			anchor: null,
		}
		const k = pick(chase ? 7 : 12)
		if (k === 0 && L) w.keys = ["items", pick(L)]
		else if (k === 1 && R) w.keys = ["rows", pick(R)]
		else if (k === 2 && R) w.keys = ["rows", pick(R), "v"]
		else if (k === 3 && metaKeys.length) w.keys = ["meta", metaKeys[pick(metaKeys.length)]]
		else if (k === 4 && L) (w.keys = ["items"], w.span = span(L, chase && pick(4) === 0))
		else if (k === 5 && T) (w.keys = ["text"], w.span = span(T, chase && pick(4) === 0))
		else if (k === 6) w.keys = ["title"]
		else if (k === 7) w.keys = ["items", pick(L + 2)]
		else if (k === 8) w.keys = [["items"], ["text"], ["rows"], ["meta"], []][pick(5)] as Key[]
		else if (k === 9) w.keys = ["meta", `k${pick(5)}`]
		else if (k === 10 && R) w.keys = ["rows", pick(R + 1), "v"]
		else w.keys = ["title"]
		if (chase) w.anchor = w.span ? null : anchorOf(c, w.keys)
		if (chase && !w.span && w.anchor === null) w.chase = false
		return w
	}
	return { start, patch, watch }
}

function request(w: Watch): Request {
	const q: Request = { op: "read", name: w.name, path: w.span ? [...w.keys, w.span] : w.keys }
	if (w.deep) q.deep = true
	if (w.chase) Object.assign(q, { chase: true, edges: w.edges, empty: w.empty })
	return q
}

// what a read should hear, and where it should be after, from the content alone
type Expect = {
	kinds: string[]
	allowed: string[]
	// where it is after; undefined: gone
	keys?: Key[]
	// a chased span: what is wrong with where it went, if anything
	check?: (where: Answer, heard: string[]) => string | null
}

const isMap = (v: V) => v !== null && typeof v === "object" && !Array.isArray(v)
const seqLike = (v: V) => typeof v === "string" || Array.isArray(v)

// a put (or a move landing with no range) at or above the chased place, or a span put over it
function keptByPut(p: Patch, K: readonly Key[]): boolean {
	if (!p.range) return ("value" in p || p.move !== undefined) && prefix(p.path, K)
	if (p.move || !("value" in p) || !sameList(p.path as V[], K.slice(0, 1) as V[])) return false
	const i = K[1] as number
	return i >= p.range[0] && i < p.range[1] && i - p.range[0] < elems(p.value).length
}

function expect(w: Watch, p: Patch, before: Content, after: Content): Expect {
	const K = w.keys
	const b = at(before, K), a = at(after, K)
	const kinds: string[] = []
	const allowed: string[] = []
	const fl = moveFloor(p)
	// a move inside one sequence fires by position from its lower end, changed or not
	const byMove = fl !== null && prefix(fl.seq, K) && (K.length === fl.seq.length ||
		(typeof K[fl.seq.length] === "number" && (K[fl.seq.length] as number) >= fl.floor))
	// put or removed whole at or above: every read under it hears value, even with nothing there
	const whole = places(p).some((q) => !q.range && prefix(q.path, K))

	if (!w.chase && !w.span) {
		const changed = !same(b, a)
		if (w.deep ? changed : changed && !(within(p, K) && typeof b !== "string")) kinds.push("value")
		else if (byMove || whole) allowed.push("value")
		if (seqLike(b) && seqLike(a) && within(p, K) && elems(b).length !== elems(a).length) kinds.push("length")
		if (isMap(b) && isMap(a) && within(p, K)) {
			if (!sameList(Object.keys(b as object).sort(), Object.keys(a as object).sort())) kinds.push("keys")
		}
		return { kinds, allowed, keys: K }
	}

	if (!w.chase && w.span) {
		const [s, e] = w.span
		const changed = !sameList(elems(slice(b, s, e)), elems(slice(a, s, e)))
		if (changed && (w.deep || !underElements(p, K))) kinds.push("value")
		else if (whole || fl !== null && sameList(fl.seq as V[], K as V[]) && e > fl.floor) allowed.push("value")
		return { kinds, allowed, keys: K }
	}

	if (!w.span) {
		const found = find(after, K, w.anchor!)
		if (found) {
			if (!sameList(found as V[], K as V[])) kinds.push("moved")
			const now = at(after, found)
			if (K.length > 2 && !same(now, b)) kinds.push("value")
			if (isMap(b) && isMap(now) && !p.move && within(p, found)) {
				if (!sameList(Object.keys(b as object).sort(), Object.keys(now as object).sort())) kinds.push("keys")
			}
			return { kinds, allowed, keys: found }
		}
		if (keptByPut(p, K)) return { kinds: ["value"], allowed, keys: K }
		return { kinds: ["gone"], allowed }
	}

	// a chased span: what it held, where those went, what came in
	const [s, e] = w.span
	const sb = elems(b), sa = elems(a)
	const held = sb.slice(s, e)
	const moving = new Set<V>()
	if (p.move) {
		const m = p.move
		if (sameList((m.range ? m.path : m.path.slice(0, -1)) as V[], K as V[])) {
			const f = m.range ? m.range[0] : m.path[m.path.length - 1] as number
			const t = m.range ? m.range[1] : f + 1
			for (const x of sb.slice(f, t)) moving.add(x)
		}
	}
	const carried = held.length > 0 && held.every((x) => moving.has(x))
	const old = new Set(sb)
	const survivors = held.filter((x) => sa.includes(x) && (carried || !moving.has(x)))
	const insertAt = !p.move && "value" in p && p.range && p.range[0] === p.range[1] &&
			sameList(p.path as V[], K as V[])
		? p.range[0]
		: null
	return {
		kinds: [],
		allowed: [],
		check(where, heard) {
			if (where.live === false) {
				if (!heard.includes("gone")) return "not live, but not gone"
				if (w.empty !== "gone" || held.length === 0) return "gone, but not empty: gone"
				if (survivors.length > 0) return `gone with ${survivors.length} still there`
				return null
			}
			if (heard.includes("gone")) return "gone, but live"
			const [s2, e2] = (where.path as V[])[K.length] as [number, number]
			if (!(s2 <= e2)) return `a span backwards: ${s2}, ${e2}`
			const now = sa.slice(s2, e2)
			for (const x of survivors) {
				const j = sa.indexOf(x)
				if (j < s2 || j >= e2) return `${String(x)} was held, now at ${j}, outside`
			}
			for (const x of now) {
				if (old.has(x) && !held.includes(x) && !moving.has(x)) return `${String(x)} came in from outside`
			}
			if (carried && !sameList(now, held)) return "carried, but not what it held"
			if (insertAt !== null && held.length > 0) {
				const added = elems(p.value)
				const inside = added.every((x) => now.includes(x))
				const outside = added.every((x) => !now.includes(x))
				if (insertAt === s && !(w.edges[0] === "in" ? inside : outside)) return "start edge"
				if (insertAt === e && !(w.edges[1] === "in" ? inside : outside)) return "end edge"
			}
			if (insertAt !== null && held.length === 0 && insertAt === s) {
				const n = elems(p.value).length
				const want = w.edges[0] === "in" ? [s, w.edges[1] === "in" ? s + n : s] : [s + n, s + n]
				if (s2 !== want[0] || e2 !== want[1]) return `caret at ${s2},${e2}, want ${want}`
			}
			const moved = s2 !== s || e2 !== e
			if (moved !== heard.includes("moved")) return `moved: ${moved}, heard ${heard}`
			const changed = !sameList(held, now)
			// a put at or above the sequence is heard by every read under it
			const above = !p.range && prefix(p.path, K) && p.path.length < K.length + 1
			// a move inside the sequence: what left and came back was heard leaving and coming
			const reached = fl !== null && sameList(fl.seq as V[], K as V[]) && e >= fl.floor
			if (changed ? !heard.includes("value") : heard.includes("value") && !above && !reached) {
				return `content changed: ${changed}, heard ${heard}`
			}
			return null
		},
	}
}

Deno.test(`fuzz: ${SEEDS} seeds × ${STEPS} patches, against the content`, async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const g = generate(seed)
		const h = session()
		let content = g.start()
		let watches: Watch[] = []
		let pending: Request[] = [{ op: "start", value: content }]
		const add = () => {
			const w = g.watch(content)
			watches.push(w)
			pending.push(request(w))
		}
		for (let i = 0; i < 14; i++) add()
		for (let step = 0; step < STEPS; step++) {
			const p = g.patch(content)
			if (p === null) continue
			const before = content
			const after = apply(content, p) as Content
			const requests = [...pending, { op: "patch", patch: p, value: after }, ...watches.map((w) => ({ op: "where", name: w.name }))]
			pending = []
			const answers = await h.send(requests)
			const said = `seed ${seed} step ${step}: ${JSON.stringify(p)}`
			for (const a of answers) assertEquals(a.error, undefined, said)
			const base = requests.length - watches.length - 1
			const heard = answers[base].heard ?? {}
			const keep: Watch[] = []
			watches.forEach((w, i) => {
				const where = answers[base + 1 + i]
				const hd = heard[w.name] ?? []
				const at_ = `${said}\n  read ${JSON.stringify(request(w))}\n  heard ${JSON.stringify(hd)}, where ${JSON.stringify(where)}`
				const e = expect(w, p, before, after)
				if (e.check) {
					assertEquals(e.check(where, hd), null, at_)
					if (where.live === false) return
					w.span = (where.path as V[])[w.keys.length] as [number, number]
					assertEquals(where.value, slice(at(after, w.keys), w.span[0], w.span[1]), at_)
					// kept by a put that left it past the end: let it go
					if (w.span[1] > elems(at(after, w.keys)).length) return void pending.push({ op: "stop", name: w.name })
					keep.push(w)
					return
				}
				const extra = hd.filter((k) => !e.kinds.includes(k) && !e.allowed.includes(k))
				const missing = e.kinds.filter((k) => !hd.includes(k))
				assertEquals({ extra, missing }, { extra: [], missing: [] }, at_)
				if (e.keys === undefined) {
					assertEquals(where.live, false, at_)
					return
				}
				assertEquals(where.live, true, at_)
				assertEquals(where.path, w.span ? [...e.keys, w.span] : e.keys, at_)
				const v = at(after, e.keys)
				assertEquals(where.value, w.span ? slice(v, w.span[0], w.span[1]) : v, at_)
				w.keys = e.keys
				if (w.chase) {
					w.anchor = anchorOf(after, w.keys)
					// held a put that left nothing there: let it go
					if (w.anchor === null) return void pending.push({ op: "stop", name: w.name })
				}
				keep.push(w)
			})
			watches = keep
			content = after
			if (step % 15 === 0) add()
		}
		await h.close()
	}
})
