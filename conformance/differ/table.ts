// table's streams: random add, sub, get, ids, at, who and the three dels over a few parts, ids
// (symbols too) and nodes (table_harness_test.ts's mix, copied), with the events asked now and
// then, plain or with every part at the id as it was when told (at: true).
// wild: odd keys (NUL, lone surrogates, "__proto__", "", a symbol and a string of one name, the
// tricky ones: "2", "01", "constructor", ...: kit.ts),
// and requests missing a field or with a key of the wrong kind
// the property, each implementation on its own: every answer is the model's (model, below), up to
// the first that is not
// deno-lint-ignore-file no-explicit-any
import { type Answer, differs, type Generator, picker, type Request, show, TRICKY } from "./kit.ts"

// strings: ASCII, BMP, a pair (😀: the two halves below), a pair and a modifier, lone halves, both
// halves the wrong way round (no pair), NUL
const PARTS: unknown[] = ["value", "children", "é", "\uD83D", "a\u0000", { symbol: "drag" }]
const IDS: unknown[] = [
	...["a", "a\u0000", "中", "😀", "👍🏽", "\uD83D", "\uDE00", "\uDE00\uD83D"],
	{ symbol: "here" },
]
const NODES = ["n1", "n2", "\u0000", "\uDE00", "👍"]
const ODD: unknown[] = [
	...new Set([
		"",
		"\u0000",
		"\uD800",
		"\uDC00",
		"\uDC00\uD800",
		"__proto__",
		"a\u0000",
		...TRICKY,
	]),
	{ symbol: "a" },
]

const generator: Generator = {
	streams(seed, o) {
		const { pick, one } = picker(seed)
		const parts = o.wild ? [...PARTS, ...ODD] : PARTS, ids = o.wild ? [...IDS, ...ODD] : IDS
		const out: Request[] = []
		for (let i = 0; i < 120; i++) {
			const part = one(parts), id = one(ids), node = one(NODES)
			const k = pick(23)
			if (k < 6) out.push({ op: "add", part, id, node })
			else if (k < 8) out.push({ op: "sub", part, id, node })
			else if (k < 10) out.push({ op: "get", part, id })
			else if (k < 12) out.push({ op: "ids", part, node })
			else if (k < 13) out.push({ op: "at", id })
			else if (k < 15) out.push({ op: "who", node })
			else if (k < 17) out.push({ op: "del", part, id })
			else if (k < 18) out.push({ op: "del", part, node })
			else if (k < 19) out.push({ op: "del", node })
			else if (k < 21) out.push({ op: "events", at: true })
			else out.push({ op: "events" })
			if (o.wild && pick(15) === 0) {
				out.push(
					one([
						{ op: "add", part: 1, id, node },
						{ op: "add", part, id },
						{ op: "get", part },
						{ op: "del" },
						{ op: "who", node: 3 },
						{ op: "add", part: { symbol: 1 }, id, node },
						{ op: "Add", part, id, node },
					]),
				)
			}
		}
		out.push({ op: "events", at: true })
		return [out]
	},
	invariant(stream, answers) {
		const m = model()
		for (let i = 0; i < stream.length; i++) {
			const want = m(stream[i]), got = answers[i]
			if (got === undefined) return Promise.resolve([])
			const d = typeof want.error === "boolean"
				? (got.error === undefined ? { kind: "no error", path: "" } : undefined)
				: differs(got, want)
			if (d) {
				return Promise.resolve([{
					kind: `${stream[i].op} unlike the model`,
					at: i,
					why: `${d.kind} at ${d.path}: ${show(got)}, model ${show(want)}`,
				}])
			}
		}
		return Promise.resolve([])
	},
}
export default generator

// the table as the protocol has it (table_harness.ts): an answer per request. an error that is a
// code is that code; any other is { error: true }: some error, its words free
function model(): (r: Request) => Answer {
	type Key = string | { symbol: string }
	const isKey = (k: unknown): k is Key =>
		typeof k === "string" ||
		(k !== null && typeof k === "object" && typeof (k as any).symbol === "string")
	const shown = (k: Key) => typeof k === "string" ? k : { symbol: k.symbol }
	const name = (k: Key) => show(shown(k))
	// id → part → [part, node]; node → part → id → id; events not yet asked
	const at = new Map<string, Map<string, [Key, string]>>()
	const where = new Map<string, Map<string, { part: Key; ids: Map<string, Key> }>>()
	const events: [Key, Key, [Key, string][]][] = []
	const entries = (id: Key): [Key, string][] => [...at.get(name(id))?.values() ?? []]
	const tell = (part: Key, id: Key) => events.push([part, id, entries(id)])
	const get = (part: Key, id: Key) => at.get(name(id))?.get(name(part))?.[1]
	const who = (node: string): [Key, Key][] =>
		[...where.get(node)?.values() ?? []].flatMap(({ part, ids }) =>
			[...ids.values()].map((id): [Key, Key] => [part, id])
		)
	function put(part: Key, id: Key, node: string) {
		if (!at.has(name(id))) at.set(name(id), new Map())
		at.get(name(id))!.set(name(part), [part, node])
		if (!where.has(node)) where.set(node, new Map())
		const parts = where.get(node)!
		if (!parts.has(name(part))) parts.set(name(part), { part, ids: new Map() })
		parts.get(name(part))!.ids.set(name(id), id)
	}
	function take(part: Key, id: Key, node: string) {
		const parts = at.get(name(id))!
		parts.delete(name(part))
		if (parts.size === 0) at.delete(name(id))
		const ps = where.get(node)!, ids = ps.get(name(part))!.ids
		ids.delete(name(id))
		if (ids.size === 0) ps.delete(name(part))
		if (ps.size === 0) where.delete(node)
	}
	const bad = { error: true }
	return (r) => {
		const { part, id, node } = r
		const keys = (...ks: unknown[]) => ks.every(isKey)
		switch (r.op) {
			case "add":
			case "sub": {
				if (!keys(part, id) || typeof node !== "string") return bad
				const there = get(part, id)
				if (there === node) return {}
				if (there !== undefined) {
					if (r.op === "add") return { error: "already-there" }
					take(part, id, there)
				}
				put(part, id, node)
				tell(part, id)
				return {}
			}
			case "get": {
				if (!keys(part, id)) return bad
				const n = get(part, id)
				return n === undefined ? {} : { node: n }
			}
			case "ids":
				if (!keys(part) || typeof node !== "string") return bad
				return { ids: [...where.get(node)?.get(name(part))?.ids.values() ?? []].map(shown) }
			case "at":
				if (!keys(id)) return bad
				return { entries: entries(id).map(([p, n]) => [shown(p), n]) }
			case "who":
				if (typeof node !== "string") return bad
				return { keys: who(node).map(([p, i]) => [shown(p), shown(i)]) }
			case "events":
				return {
					events: events.splice(0).map(([p, i, es]) =>
						r.at === true
							? [shown(p), shown(i), es.map(([q, n]) => [shown(q), n])]
							: [shown(p), shown(i)]
					),
				}
			case "del": {
				let gone: [Key, Key, string][]
				if (part === undefined) {
					if (typeof node !== "string") return bad
					gone = who(node).map(([p, i]) => [p, i, node])
				} else if (node !== undefined) {
					if (!keys(part) || typeof node !== "string") return bad
					gone = [...where.get(node)?.get(name(part))?.ids.values() ?? []].map((
						i,
					) => [part, i, node])
				} else {
					if (!keys(part, id)) return bad
					const there = get(part, id)
					gone = there === undefined ? [] : [[part, id, there]]
				}
				if (gone.length === 0) return { error: "nothing-there" }
				for (const [p, i, n] of gone) take(p, i, n)
				for (const [p, i] of gone) tell(p, i)
				return {}
			}
		}
		return bad
	}
}
