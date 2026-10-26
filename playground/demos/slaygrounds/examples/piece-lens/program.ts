/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import { bind, handler } from "ermine-h"
import apply from "@ermine/core/op/apply"
import { count, unit } from "@ermine/core/util/walk-string"

// piece-lens: one text in three kinds of place, kept in step by opstreams. a file or a folder on
// your computer (the File System Access API), a patchwork doc (automerge, by its url), and inner
// nodes that live only in this graph. the opstream on a text is ermine's splice, a patch:
// { path: [], range: [a, b], value }: positions a to b (code points) become value. one editor
// (CodeMirror) edits whichever node you pick.
//   the disk   has no ops, only texts: what it has now is diffed against what it had (lines matched,
//              then trimmed to the characters) into splices. the splices the node took meanwhile
//              are rebased over them, so neither side's edit is lost; the node's text is then
//              written back, whole (a file is written whole)
//   automerge  says its own splices, in UTF-16 units, as the editor does: turned into code points
//              coming in, and back going out
//   a pipe     joins two nodes through lenses: a get, a put and a complement (what the view
//              leaves out, kept so the source can be made again). a change on the left is got
//              through the lenses and diffed into the right; a change on the right is put back
//              through them, then got again: the right shows what the left makes of it
// every write says who made it (its change's actor): a pipe or an adapter never answers its own

// ---- the opstream on a text: splices ----
// a splice: code points a to b become value (none: taken out). a list of them is in order, each
// in the text the ones before it made
type Splice = { path: []; range: [number, number]; value?: string }
// a change in UTF-16 units, as the editor and automerge say them (cm.js)
type Change = { from: number; to: number; insert: string }

const splice = (a: number, b: number, value?: string): Splice =>
	value ? { path: [], range: [a, b], value } : { path: [], range: [a, b] }
const high = (c: number) => (c & 0xfc00) === 0xd800
const low = (c: number) => (c & 0xfc00) === 0xdc00

// ---- diff: two texts as splices ----
// lines matched first (myers), then each run of changed lines trimmed to the characters that
// differ: a splice a run. this is the whole adapter for anything that has only texts (the disk)
function diff(a: string, b: string): Splice[] {
	if (a === b) return []
	const x = lines(a), y = lines(b)
	const out: Splice[] = []
	let at = 0, i = 0, j = 0
	for (const [mi, mj] of matched(x, y)) {
		if (mi > i || mj > j) at = trimmed(out, at, x.slice(i, mi).join(""), y.slice(j, mj).join(""))
		if (mi < x.length) at += count(x[mi])
		i = mi + 1
		j = mj + 1
	}
	return out
}
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? []

// old made now, at position at: one splice, trimmed to what differs (never inside a surrogate
// pair). gives the position after it
function trimmed(out: Splice[], at: number, old: string, now: string): number {
	const n = Math.min(old.length, now.length)
	let p = 0
	while (p < n && old.charCodeAt(p) === now.charCodeAt(p)) p++
	if (p > 0 && high(old.charCodeAt(p - 1))) p--
	let s = 0
	while (s < n - p && old.charCodeAt(old.length - 1 - s) === now.charCodeAt(now.length - 1 - s)) {
		s++
	}
	if (s > 0 && low(old.charCodeAt(old.length - s))) s--
	const start = at + count(old.slice(0, p))
	const gone = old.slice(p, old.length - s), put = now.slice(p, now.length - s)
	if (gone || put) out.push(splice(start, start + count(gone), put))
	return at + count(now)
}

// the lines of x matched with lines of y, in order, then [x.length, y.length]
function matched(x: string[], y: string[]): [number, number][] {
	let pre = 0
	while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++
	let suf = 0
	while (
		suf < x.length - pre && suf < y.length - pre &&
		x[x.length - 1 - suf] === y[y.length - 1 - suf]
	) suf++
	const out: [number, number][] = []
	for (let k = 0; k < pre; k++) out.push([k, k])
	for (const [i, j] of myers(x.slice(pre, x.length - suf), y.slice(pre, y.length - suf))) {
		out.push([i + pre, j + pre])
	}
	for (let k = suf; k > 0; k--) out.push([x.length - k, y.length - k])
	out.push([x.length, y.length])
	return out
}

// myers' O(ND): the furthest point on each diagonal, round by round; then back along the rounds.
// more than 1000 rounds: nothing matched (one run)
function myers(a: string[], b: string[]): [number, number][] {
	const n = a.length, m = b.length
	if (n === 0 || m === 0) return []
	const max = Math.min(n + m, 1000), off = max + 1
	const v = new Int32Array(2 * max + 3)
	const trace: Int32Array[] = []
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice(off - d - 1, off + d + 2))
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
				? v[off + k + 1]
				: v[off + k - 1] + 1
			let y = x - k
			while (x < n && y < m && a[x] === b[y]) x++, y++
			v[off + k] = x
			if (x >= n && y >= m) return trail(trace, n, m, d)
		}
	}
	return []
}
function trail(trace: Int32Array[], x: number, y: number, rounds: number): [number, number][] {
	const out: [number, number][] = []
	for (let d = rounds; d > 0; d--) {
		const at = (k: number) => trace[d][k + d + 1]
		const k = x - y
		const was = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
		const px = at(was), py = px - was
		while (x > px && y > py) out.push([--x, --y])
		x = px
		y = py
	}
	while (x > 0 && y > 0) out.push([--x, --y])
	return out.reverse()
}

// ---- rebase: two lists of splices made on one text, each moved past the other ----
// p moved past q (both made on one text): where it lands once q has. left: at one spot, p goes
// first. what both took out is gone once; p taking out a span holding q's insert takes it too
function past(p: Splice, q: Splice, left: boolean): Splice {
	const [s, e] = p.range, [qs, qe] = q.range
	const qn = q.value ? count(q.value) : 0
	const d = qn - (qe - qs)
	const start = (x: number) =>
		x < qs || (x === qs && left) ? x : x < qe || (x === qs && !left) ? qs + qn : x + d
	const end = (x: number) => (x <= qs ? x : x < qe ? qs : x + d)
	const a = start(s)
	return splice(a, s === e ? a : Math.max(a, end(e)), p.value)
}
// theirs and ours, made on one text: theirs moved past ours (to go after them), and ours moved
// past theirs (to go after those). theirs go first at one spot
function rebase(theirs: Splice[], ours: Splice[]): [Splice[], Splice[]] {
	const mine = [...ours]
	const out: Splice[] = []
	for (let p of theirs) {
		for (let i = 0; i < mine.length; i++) {
			const q = mine[i]
			mine[i] = past(q, p, false)
			p = past(p, q, true)
		}
		out.push(p)
	}
	return [out, mine]
}

// ---- the outside's units and ermine's code points ----
function points(before: string, changes: readonly Change[]): Splice[] {
	let s = before
	return changes.map((c) => {
		const a = count(s.slice(0, c.from))
		const p = splice(a, a + count(s.slice(c.from, c.to)), c.insert)
		s = s.slice(0, c.from) + c.insert + s.slice(c.to)
		return p
	})
}
function units(before: string, splices: readonly Splice[]): Change[] {
	let s = before
	return splices.map((p) => {
		const from = unit(s, p.range[0]), to = unit(s, p.range[1])
		const insert = p.value ?? ""
		s = s.slice(0, from) + insert + s.slice(to)
		return { from, to, insert }
	})
}

// the splices that took seen to now: the fact's own patches when they say exactly that, else one
// diff (facts told out of order: a write made while another was being told)
// deno-lint-ignore no-explicit-any
function step(seen: unknown, patches: readonly any[], now: unknown): Splice[] {
	if (typeof seen !== "string" || typeof now !== "string") return []
	let s = seen
	const out: Splice[] = []
	try {
		for (const p of patches) {
			if (p.path.length !== 0 || (p.range === undefined && typeof p.value !== "string")) throw p
			out.push(p.range ? p : splice(0, count(s), p.value))
			s = apply(s, [p]) as string
		}
		if (s === now) return out
	} catch { /* not splices on the text: diffed */ }
	return diff(seen, now)
}

const run = (s: string, ps: readonly Splice[]) => apply(s, ps) as string

// ---- lenses: a view of a text, and the way back ----
// a complement is what the view leaves out, kept to make the source again. get makes the view
// from the source and is the only thing that refreshes the complement; put makes a new source
// from a view written, the source it came from and the complement
// deno-lint-ignore no-explicit-any
type Params = Record<string, any>
type Lens = {
	says: string
	params?: Params
	// deno-lint-ignore no-explicit-any
	complement?: (s: string, p: Params) => any
	// deno-lint-ignore no-explicit-any
	get(s: string, c: any, p: Params): string
	// deno-lint-ignore no-explicit-any
	put(v: string, s: string, c: any, p: Params): string
	// the complement, short, for the page
	// deno-lint-ignore no-explicit-any
	show?(c: any): string
}

// -- case: the case of each word, by the word and by where it was --
// a word: letters, digits, _ ' -. words[i] sits between seps[i] and seps[i+1]
const WORD = /[\p{L}\p{N}_'-]/u
function words(s: string) {
	const words: string[] = [], seps: string[] = []
	let cur = "", inWord = false
	for (const c of s) {
		if (WORD.test(c) !== inWord) {
			;(inWord ? words : seps).push(cur)
			cur = ""
			inWord = !inWord
		}
		cur += c
	}
	;(inWord ? words : seps).push(cur)
	if (inWord) seps.push("")
	return { words, seps }
}
// words back between the seps they had; a word more: a space before it
function rebuild(ws: string[], seps: string[]) {
	if (ws.length === 0) return seps[0] ?? ""
	let out = seps[0] ?? ""
	for (let i = 0; i < ws.length; i++) {
		out += ws[i]
		out += i < ws.length - 1
			? (i + 1 < seps.length - 1 ? seps[i + 1] : " ")
			: seps.length > 1
			? seps[seps.length - 1]
			: ""
	}
	return out
}
// U upper, L lower, · neither, a letter at a time (any script, not only a–z)
const maskOf = (w: string) =>
	[...w].map((c) => c !== c.toLowerCase() ? "U" : c !== c.toUpperCase() ? "L" : "·").join("")
function byMask(w: string, mask: string) {
	const cs = [...w], ms = [...mask]
	return cs.map((c, i) => ms[i] === "U" ? c.toUpperCase() : ms[i] === "L" ? c.toLowerCase() : c)
		.join("")
}
// all upper, all lower, Title, else letter by letter
function cased(w: string, mask: string) {
	const ls = [...mask].filter((m) => m !== "·")
	if (!w || ls.length === 0) return w
	if (ls.every((m) => m === "U")) return w.toUpperCase()
	if (ls.every((m) => m === "L")) return w.toLowerCase()
	if (ls[0] === "U" && ls.slice(1).every((m) => m === "L")) {
		let first = true
		return [...w].map((c) => {
			if (c.toLowerCase() === c.toUpperCase()) return c
			const out = first ? c.toUpperCase() : c.toLowerCase()
			first = false
			return out
		}).join("")
	}
	return byMask(w, mask)
}
// the complement: the source's words, in order
type Case = { words: string[] }
const refreshCase = (s: string, c: Case) => ((c.words = words(s).words), c)
// the view's words lined up with the source's (myers, as the diff, on the words as the view shows
// them): a word still there is the source's own word, case and all. a word new in a gap takes the
// case of the word the gap lost in its place; one put in where nothing went is a word moved (found
// by the word), else spelt as the source spells it, else as typed
function recase(v: string, c: Case, fold: (s: string) => string) {
	const { words: ws, seps } = words(v)
	const src = c.words
	const out = [...ws]
	const used = new Set<number>()
	const loose: number[] = []
	let i = 0, j = 0
	for (const [mi, mj] of matched(src.map(fold), ws.map(fold))) {
		const lost = [] as number[]
		for (let k = i; k < mi; k++) lost.push(k)
		for (let k = j; k < mj; k++) {
			const same = lost.findIndex((x) => fold(src[x]) === fold(ws[k]))
			const x = same >= 0 ? lost.splice(same, 1)[0] : lost.shift()
			if (x === undefined) loose.push(k)
			else (used.add(x), out[k] = same >= 0 ? src[x] : cased(ws[k], maskOf(src[x])))
		}
		if (mi < src.length) (used.add(mi), out[mj] = src[mi])
		i = mi + 1
		j = mj + 1
	}
	// a word put in where nothing went: one moved here, else the spelling the source has for it,
	// else, typed as the view shows words (saying nothing of its case), lowercase beside lowercase
	const lower = (w?: string) => !!w && w === w.toLowerCase() && w !== w.toUpperCase()
	for (const k of loose) {
		const x = src.findIndex((w, n) => !used.has(n) && fold(w) === fold(ws[k]))
		if (x >= 0) (used.add(x), out[k] = src[x])
		else {
			out[k] = src.find((w) => fold(w) === fold(ws[k])) ??
				(ws[k] === fold(ws[k]) && (lower(out[k - 1]) || lower(out[k + 1]))
					? ws[k].toLowerCase()
					: ws[k])
		}
	}
	return rebuild(out, seps)
}
const fold = (upper: boolean): Lens => {
	const f = upper ? (s: string) => s.toUpperCase() : (s: string) => s.toLowerCase()
	return {
		says: upper
			? "UPPERCASE. write in it: each word gets its case back: its own, else the one it replaced"
			: "lowercase. the case of each word kept aside, as in UPPERCASE",
		complement: (s) => refreshCase(s, { words: [] }),
		get: (s, c) => (refreshCase(s, c), f(s)),
		put: (v, _s, c) => recase(v, c, f),
		show: (c: Case) => {
			const odd = c.words.filter((w) => w !== w.toLowerCase())
			const seen = [...new Set(odd)]
			return seen.length
				? seen.slice(0, 10).join(" ") + (seen.length > 10 ? ` +${seen.length - 10}` : "")
				: "all lowercase"
		},
	}
}

const LENSES: Record<string, Lens> = {
	upper: fold(true),
	lower: fold(false),

	// -- a window of lines: the rest kept aside. new lines typed in it grow it --
	lines: {
		says: "lines from a, n of them. the lines above and below are the complement",
		params: { a: 1, n: 4 },
		complement: (_s, p) => ({ above: [], below: [], n: Math.max(0, p.n | 0), none: true }),
		get(s, c, p) {
			const all = s.split("\n")
			const a = Math.max(0, Math.min(all.length, (p.a | 0) - 1))
			const mid = all.slice(a, a + c.n)
			c.above = all.slice(0, a)
			c.below = all.slice(a + c.n)
			c.none = mid.length === 0
			return mid.join("\n")
		},
		put(v, s, c) {
			if (c.none && v === "") return s
			const mid = v.split("\n")
			c.n = mid.length
			return [...c.above, ...mid, ...c.below].join("\n")
		},
		show: (c) => `${c.above.length} lines above, ${c.below.length} below`,
	},

	// -- lines hidden: kept aside with the line they came after --
	hide: {
		says: "lines starting with the prefix are hidden; each goes back after the line it followed",
		params: { prefix: "//" },
		complement: () => ({ hidden: [], none: false }),
		get(s, c, p) {
			const shown: string[] = []
			const hidden: { after: number; anchor?: string; next?: string; line: string }[] = []
			for (const line of s.split("\n")) {
				if (p.prefix && line.trimStart().startsWith(p.prefix)) {
					hidden.push({ after: shown.length - 1, anchor: shown[shown.length - 1], line })
				} else {
					for (let k = hidden.length - 1; k >= 0 && hidden[k].next === undefined; k--) {
						hidden[k].next = line
					}
					shown.push(line)
				}
			}
			c.hidden = hidden
			c.none = shown.length === 0
			return shown.join("\n")
		},
		put(v, _s, c) {
			const shown = v === "" && c.none ? [] : v.split("\n")
			// the line each hidden one follows: the line it followed, found by its text (not before
			// the last one found), else the line before the one it came before, else where it was
			const at = new Map<number, string[]>()
			let last = -1
			for (const h of c.hidden) {
				let i = -1
				if (h.after >= 0) {
					i = shown.findIndex((l, k) => k >= last && l === h.anchor)
					if (i < 0 && h.next !== undefined) {
						const n = shown.findIndex((l, k) => k > last && l === h.next)
						if (n >= 0) i = n - 1
					}
					if (i < 0) i = Math.max(last, Math.min(h.after, shown.length - 1))
				}
				last = Math.max(last, i)
				at.set(i, [...(at.get(i) ?? []), h.line])
			}
			const out = [...(at.get(-1) ?? [])]
			shown.forEach((l, k) => out.push(l, ...(at.get(k) ?? [])))
			return out.join("\n")
		},
		show: (c) =>
			c.hidden.length
				? `${c.hidden.length} hidden: ` +
					c.hidden.slice(0, 3).map((h: { line: string }) =>
						JSON.stringify(h.line.slice(0, 24))
					).join(", ")
				: "nothing hidden",
	},

	// -- secrets shown as █: the complement holds them --
	redact: {
		says:
			"emails and long numbers show as █. a run of █ gets its secret back: one its length first",
		complement: () => ({ secrets: [] }),
		get(s, c) {
			c.secrets = s.match(SECRET) ?? []
			return s.replace(SECRET, (m) => "█".repeat([...m].length))
		},
		put(v, _s, c) {
			const runs = [...v.matchAll(/█+/g)].map((m) => ({ m, n: [...m[0]].length, got: -1 }))
			const used = new Set<number>()
			let last = -1
			// by length, in order
			for (const r of runs) {
				const i = c.secrets.findIndex((x: string, k: number) =>
					k > last && !used.has(k) && [...x].length === r.n
				)
				if (i >= 0) (r.got = i, used.add(i), last = i)
			}
			// the rest: the next one left
			for (const r of runs) {
				if (r.got >= 0) continue
				const i = c.secrets.findIndex((_: string, k: number) => !used.has(k))
				if (i >= 0) (r.got = i, used.add(i))
			}
			let out = "", from = 0
			for (const r of runs) {
				out += v.slice(from, r.m.index) + (r.got >= 0 ? c.secrets[r.got] : r.m[0])
				from = r.m.index! + r.m[0].length
			}
			return out + v.slice(from)
		},
		show: (c) =>
			c.secrets.length
				? `${c.secrets.length} kept: ${
					c.secrets.map((x: string) => "█".repeat(Math.min(6, [...x].length))).join(" ")
				}`
				: "nothing to hide",
	},

	// -- no complement: each is its own way back --
	reverse: {
		says: "the text backwards, a code point at a time. its own way back: no complement",
		get: (s) => [...s].reverse().join(""),
		put: (v) => [...v].reverse().join(""),
	},
	rot13: {
		says: "a–z turned 13 places. its own way back: no complement",
		get: (s) => rot13(s),
		put: (v) => rot13(v),
	},
}
const SECRET = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b\d{6,}\b/g
const rot13 = (s: string) =>
	s.replace(/[a-z]/gi, (c) => {
		const a = c <= "Z" ? 65 : 97
		return String.fromCharCode((c.charCodeAt(0) - a + 13) % 26 + a)
	})

// ---- a chain of lenses ----
type Using = { kind: string; params: Params; c?: unknown }
// the text after each lens, the source first. what each complement is made from is what it gets
function forward(chain: Using[], s: string): string[] {
	const out = [s]
	for (const u of chain) {
		const l = LENSES[u.kind]
		u.c ??= l.complement?.(s, u.params)
		s = l.get(s, u.c, u.params)
		out.push(s)
	}
	return out
}
// a view written at the end, put back through each lens to a new source. the complements are got
// from the source as it is first
function back(chain: Using[], v: string, source: string): string {
	const steps = forward(chain, source)
	for (let i = chain.length - 1; i >= 0; i--) {
		const u = chain[i]
		v = LENSES[u.kind].put(v, steps[i], u.c, u.params)
	}
	return v
}

// ---- the program ----
// what the host's extend adds (host.ts): as, f run as an actor of its own (every write says who made
// it); the editor (CodeMirror) and automerge, bundled apart (cm.ts)
type Host = {
	as: <T>(actor: string, f: () => T) => T
	editor: () => import("./cm.ts").TextEditor
	automerge: () => Promise<import("./cm.ts").Automerge>
}
type Spec = {
	id: string
	a: string[] // the source: under the program's node
	b: string[] // the view: what the lenses make of a
	lenses: { kind: string; params?: Params }[]
	on: boolean
	// who wins when it is joined: a (b takes what the lenses make of a), or b (a takes b, put back)
	start: "a" | "b"
}
type Flow = { n: number; who: string; at: string; what: string; note: string }
type Row = {
	path: string[]
	name: string
	depth: number
	kind: "group" | "folder" | "text" | "bytes" | "empty"
	size: number
	first: string
	state: string
	editing: boolean
	top: boolean
}

// the disk's side of a file node
type Disk = {
	handle: FileSystemFileHandle
	path: string[]
	single: boolean // opened alone (not in a folder)
	known: string | Uint8Array // what the disk had, as last read or written
	seen: unknown // the node's value, as last told
	ours: Splice[] // what the node took since known, by anyone but the disk
	writing: boolean
	again: boolean
	mtime: number
	timer?: number
}
// an automerge doc's side of a doc node
type Linked = { doc: import("./cm.ts").Doc; path: string[]; seen: string }

const DRAFT = `Hello! This is draft, an inner node: it lives only in this graph.
Shout, below it, is draft through the UPPERCASE lens. Write in either one.
In shout the case you meant is kept aside: iPhone, McDonald's, NASA, ermine.
// a line for the hide lens
mail ermine@example.com or call 0123456789, for the redact lens
`
const PIPES: Spec[] = [
	{
		id: "p1",
		a: ["inner", "draft"],
		b: ["inner", "shout"],
		lenses: [{ kind: "upper" }],
		on: true,
		start: "a",
	},
]

const strict = new TextDecoder("utf-8", { fatal: true })
// what not every browser has: the pickers, FileSystemObserver
// deno-lint-ignore no-explicit-any
const browser = globalThis as any

export default function program(
	{
		open,
		read,
		edit,
		entries,
		list,
		memo,
		effect,
		method,
		watch,
		remove,
		teardown,
		ref,
		as,
		editor: makeEditor,
		automerge: loadAutomerge,
	}:
		& API
		& Host,
) {
	// the text nodes live in the working folder (saved, so a reload finds them): ./text/inner, files,
	// docs. a node here is its path under it, names; tree says where. pipes and what is picked are
	// there too. what each outside side says, and the log, are the process's own
	const tree = (path: readonly string[]) => ["/", "text", ...path]
	const pipes = open("./text/pipes", PIPES)
	const editing = open("./text/editing", ["inner", "draft"])
	const log = open("log", [] as Flow[])
	// what each outside side says: synced, writing, read only, online…, by path
	const state = open("state", {} as Record<string, string>)
	// what each pipe's lenses keep aside, and how much went through
	const looks = open("looks", {} as Record<string, unknown>)
	open(tree(["inner", "draft"]), DRAFT)
	open(tree(["inner", "shout"]), "")
	const put = (x: ReturnType<typeof open>, value: unknown) => edit(x, [{ path: [], value }])

	// kept across reloads: the outside's handles, and the editor (live values, ref'd in ./)
	const disks = read(ref("./text-kept/disks", () => new Map<string, Disk>())) as Map<string, Disk>
	const folders = read(
		ref(
			"./text-kept/folders",
			() => new Map<string, { handle: FileSystemDirectoryHandle; path: string[] }>(),
		),
	) as Map<string, { handle: FileSystemDirectoryHandle; path: string[] }>
	const linked = read(ref("./text-kept/linked", () => new Map<string, Linked>())) as Map<
		string,
		Linked
	>
	const editor = read(ref("./text-kept/editor", () => makeEditor())) as ReturnType<
		typeof makeEditor
	>

	// ---- reading and writing ----
	// a node's path if there is a node there
	const node = (path: string[]): string[] | undefined =>
		entries(tree(path)).length ? path : undefined
	const val = (x?: string[]) => x && read(tree(x))
	const text = (x?: string[]) => {
		const v = val(x)
		return typeof v === "string" ? v : undefined
	}
	const rel = (x: string[]) => x.join("/")
	// splices on a node, as who; told to the flow
	function write(who: string, x: string[], ps: readonly unknown[], note = "") {
		if (ps.length === 0) return
		// told first: what this write makes happen is told after it
		as(who, () => {
			told(who, rel(x), ps, note)
			edit(tree(x), ps as never)
		})
	}
	function told(who: string, at: string, ps: readonly unknown[], note = "") {
		as(who, () => {
			const was = read(log) as Flow[]
			const n = (was[0]?.n ?? 0) + 1
			put(log, [{ n, who, at, what: summary(ps), note }, ...was].slice(0, 14))
		})
	}
	function say(key: string, words: string) {
		const was = read(state) as Record<string, string>
		if (was[key] !== words) as("lens", () => put(state, { ...was, [key]: words }))
	}
	const unique = (parent: string[], name: string) => {
		const taken = new Set(list(tree(parent)))
		let out = name, n = 1
		while (taken.has(out)) out = `${name} ${++n}`
		return out
	}

	// ---- the disk: a file node and its file ----
	async function readFile(h: FileSystemFileHandle) {
		const f = await h.getFile()
		const bytes = new Uint8Array(await f.arrayBuffer())
		let value: string | Uint8Array = bytes
		try {
			value = strict.decode(bytes)
		} catch { /* not UTF-8: bytes */ }
		return { value, mtime: f.lastModified }
	}
	const same = (a: unknown, b: unknown) =>
		a === b ||
		a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length &&
			a.every((x, i) => x === b[i])
	// deno-lint-ignore no-explicit-any
	const writable = async (d: Disk) =>
		(await (d.handle as any).queryPermission?.({ mode: "readwrite" }).catch(() => "denied")) ===
			"granted"

	// the node told a change: what it took goes on ours, and the file is written
	function attachDisk(d: Disk) {
		const x = node(d.path)
		if (!x) return
		watch(tree(x), (fact) => {
			if (fact.change?.actor === "disk") return
			const now = fact.value
			if (typeof now === "string" && typeof d.seen === "string") {
				d.ours.push(...step(d.seen, fact.patches, now))
			}
			d.seen = now
			// written a moment later: keys typed together go out together, and a write the disk is in
			// the middle of lands first, to be read and rebased past (a file can't be asked to change
			// only if it is still what was read)
			clearTimeout(d.timer)
			d.timer = setTimeout(() => flush(d), 200)
		})
	}

	// the disk and the node made one: what the disk has now goes in first (rebased past what the
	// node took), then the node's text is written if the disk has not got it. one at a time: a
	// call while one is going makes it go round again
	async function flush(d: Disk) {
		const key = d.path.join("/")
		if (d.writing) return void (d.again = true)
		d.writing = true
		try {
			do {
				d.again = false
				const disk = await readFile(d.handle).catch(() => undefined)
				if (!disk) return gone(d)
				d.mtime = disk.mtime
				if (!same(disk.value, d.known)) ingest(d, disk.value)
				const x = node(d.path)
				const now = val(x)
				if (now === undefined || same(now, d.known)) {
					d.ours = []
					say(key, typeof d.known === "string" ? "synced" : "bytes")
					continue
				}
				if (!(await writable(d))) return say(key, "read only")
				say(key, "writing…")
				const n = d.ours.length
				const w = await d.handle.createWritable()
				await w.write(now as string | BufferSource)
				await w.close()
				d.known = now as string | Uint8Array
				d.ours.splice(0, n)
				told("disk", key, [], `wrote ${size(now)}`)
				say(key, "synced")
			} while (d.again)
		} catch (e) {
			say(key, "error: " + (e as Error).message)
		} finally {
			d.writing = false
		}
	}
	// what the disk has, which is not what it had: its splices, rebased past ours, into the node
	function ingest(d: Disk, disk: string | Uint8Array) {
		const x = node(d.path)
		if (!x) return
		const now = val(x)
		if (typeof disk !== "string" || typeof now !== "string" || typeof d.known !== "string") {
			d.known = disk
			d.ours = []
			if (!same(now, disk)) write("disk", x, [{ path: [], value: disk }], "whole")
			d.seen = val(x)
			return
		}
		const theirs = diff(d.known, disk)
		let [mine, ours] = rebase(theirs, d.ours)
		let note = d.ours.length ? `rebased past ${d.ours.length}` : ""
		try {
			if (run(now, mine) !== run(disk, ours)) throw 0
		} catch {
			// the two did not agree: the disk wins
			;[mine, ours, note] = [diff(now, disk), [], "the disk won"]
		}
		d.known = disk
		d.ours = ours
		write("disk", x, mine, note)
		d.seen = val(x)
	}
	// gone from the disk: asked again in a moment (an editor saving can take a file away and put
	// it back), then the node goes too
	function gone(d: Disk) {
		const key = d.path.join("/")
		say(key, "gone?")
		setTimeout(async () => {
			if (await d.handle.getFile().then(() => true, () => false)) return flush(d)
			disks.delete(key)
			const x = node(d.path)
			if (x) as("disk", () => prune(x))
			told("disk", key, [], "gone from the disk")
		}, 500)
	}

	// a file made a node (opened, or in a folder): the disk wins when they differ
	async function addFile(
		h: FileSystemFileHandle,
		parent: string[],
		name: string,
		single: boolean,
	) {
		const r = await readFile(h)
		const path = [...parent, name]
		const x = path
		as("disk", () => open(tree(path), r.value))
		const d: Disk = {
			handle: h,
			path,
			single,
			known: r.value,
			seen: val(x),
			ours: [],
			writing: false,
			again: false,
			mtime: r.mtime,
		}
		disks.set(path.join("/"), d)
		if (!same(d.seen, r.value)) {
			d.known = d.seen as string // what the node has: the disk's is a change to it
			ingest(d, r.value)
		}
		say(path.join("/"), typeof r.value === "string" ? "synced" : "bytes")
		attachDisk(d)
		return d
	}
	// a folder: its files and folders as nodes, hidden ones and node_modules left out, 400 files
	// at most, none over 1MB
	async function addFolder(dir: FileSystemDirectoryHandle, at: string[], budget: { n: number }) {
		const all: [string, FileSystemHandle][] = []
		// deno-lint-ignore no-explicit-any
		for await (const e of (dir as any).entries()) all.push(e)
		all.sort(([a, x], [b, y]) =>
			x.kind === y.kind ? a.localeCompare(b) : x.kind === "directory" ? -1 : 1
		)
		for (const [name, h] of all) {
			if (skip(name) || budget.n <= 0) continue
			if (h.kind === "directory") {
				const sub = [...at, name]
				as("disk", () => open(tree(sub), null))
				await addFolder(h as FileSystemDirectoryHandle, sub, budget)
			} else if ((await (h as FileSystemFileHandle).getFile()).size <= 1_000_000) {
				budget.n--
				await addFile(h as FileSystemFileHandle, at, name, false)
			}
		}
	}
	const skip = (name: string) =>
		name.startsWith(".") || name === "node_modules" || name.endsWith(".crswap")

	// the disk heard: FileSystemObserver where there is one (records as files change), else each
	// file asked every second
	const Observer = browser.FileSystemObserver
	const observers: { disconnect(): void }[] = []
	function observe(handle: FileSystemHandle, base: string[], recursive: boolean) {
		if (!Observer) return
		// deno-lint-ignore no-explicit-any
		const o = new Observer((records: any[]) => heard(records, base))
		o.observe(handle, recursive ? { recursive: true } : {}).catch((e: Error) =>
			say(base.join("/"), "not watched: " + e.message)
		)
		observers.push(o)
	}
	// deno-lint-ignore no-explicit-any
	function heard(records: any[], base: string[]) {
		for (const r of records) {
			const parts: string[] = r.relativePathComponents ?? []
			const key = [...base, ...parts].join("/")
			const from: string[] | undefined = r.relativePathMovedFrom
			if (parts.some(skip) && r.type !== "moved") continue
			const d = disks.get(key)
			if (r.type === "modified" || (r.type === "moved" && from?.at(-1)?.endsWith(".crswap"))) {
				if (d) flush(d)
			} else if (r.type === "appeared" && r.changedHandle?.kind === "file" && !d) {
				appeared(base, parts, r.changedHandle)
			} else if (r.type === "disappeared" && d) gone(d)
			else if (r.type === "moved" && from) {
				const was = disks.get([...base, ...from].join("/"))
				if (was) gone(was)
				if (!parts.some(skip)) appeared(base, parts, r.changedHandle)
			} else if (r.type === "unknown" || r.type === "errored") {
				for (const d of disks.values()) {
					if (d.path.join("/").startsWith(base.join("/"))) flush(d)
				}
			}
		}
	}
	// a file new in an open folder
	async function appeared(base: string[], parts: string[], h: FileSystemFileHandle) {
		if (!folders.has(base.join("/")) || h?.kind !== "file") return
		let at = node(base)
		for (const name of parts.slice(0, -1)) {
			if (!at) break
			const sub = [...at, name]
			as("disk", () => open(tree(sub), null))
			at = sub
		}
		if (!at) return
		await addFile(h, at, parts[parts.length - 1], false)
		told("disk", [...base, ...parts].join("/"), [], "new on the disk")
	}

	for (const f of folders.values()) observe(f.handle, f.path, true)
	for (const d of disks.values()) {
		if (d.single) observe(d.handle, d.path, false)
		attachDisk(d)
		flush(d)
	}
	teardown(() => observers.forEach((o) => o.disconnect()))
	if (!Observer) {
		const timer = setInterval(async () => {
			for (const d of disks.values()) {
				const f = await d.handle.getFile().catch(() => undefined)
				if (!f || f.lastModified !== d.mtime) flush(d)
			}
		}, 1000)
		teardown(() => clearInterval(timer))
	}

	// ---- automerge: a doc node and its patchwork doc ----
	function attachDoc(l: Linked) {
		const key = l.path.join("/")
		const x = node(l.path)
		if (!x) return
		// the doc changed: here, our own coming back (the node has it already); else its splices,
		// when the node is what the doc was, or a diff
		teardown(l.doc.on(({ before, after, changes }) => {
			const y = node(l.path)
			const now = text(y)
			if (!y || now === undefined) return
			if (now !== after) {
				write(
					"automerge",
					y,
					now === before && changes ? points(before, changes) : diff(now, after),
				)
			}
			l.seen = after
		}))
		// the node changed: its splices, in units, into the doc
		watch(tree(x), (fact) => {
			if (fact.change?.actor === "automerge") return
			const now = fact.value
			if (typeof now !== "string") return
			const ps = step(l.seen, fact.patches, now)
			const before = l.seen
			l.seen = now
			if (ps.length === 0) return
			l.doc.change(units(before, ps), before, now)
			told("automerge", key, ps, "sent")
		})
		// what the doc has now, if it changed while this was away
		const now = text(x), there = l.doc.text()
		if (now !== undefined && now !== there) write("automerge", x, diff(now, there))
		l.seen = there
		say(key, l.doc.kind() === "text" ? "linked" : `${l.doc.kind()}: an edit makes it text`)
	}
	for (const l of linked.values()) attachDoc(l)
	async function link(doc: import("./cm.ts").Doc) {
		const there = [...linked.values()].find((l) => l.doc.url === doc.url)
		if (there) return as("lens", () => put(editing, there.path))
		const name = unique(["docs"], doc.name)
		as("automerge", () => open(tree(["docs", name]), doc.text()))
		const l: Linked = { doc, path: ["docs", name], seen: doc.text() }
		linked.set(l.path.join("/"), l)
		attachDoc(l)
		told("automerge", l.path.join("/"), [], "opened " + doc.url.slice(0, 22) + "…")
		as("lens", () => put(editing, l.path))
	}
	// automerge, loaded the first time it is needed; whether it is online, heard once a run
	let loading: Promise<import("./cm.ts").Automerge> | undefined
	function automerge() {
		return loading ??= (async () => {
			if (!(read(state) as Record<string, string>).docs) say("docs", "loading automerge…")
			const am = await loadAutomerge()
			const online = (yes: boolean) => say("docs", yes ? "online" : "connecting…")
			online(am.online())
			teardown(am.onstatus(online))
			return am
		})().catch((e) => {
			loading = undefined
			throw e
		})
	}
	if (linked.size) automerge()

	// ---- the editor: one CodeMirror over the node in editing ----
	// the person types: their changes, as splices on the node. a change told while the editor is
	// out of step with the node: the node's text made the editor's, by a diff
	let at: string[] | undefined
	editor.onedit = (changes, before) => {
		const x = at && node(at)
		const now = text(x)
		if (!x || now === undefined) return
		write("editor", x, now === before ? points(before, changes) : diff(now, editor.text()))
	}
	// the node changed by anyone else: the editor made the same, after this write is done (an
	// editor changes no text while it is telling its own change). the splices told, when they take
	// what it shows to what the node has; else a diff
	let base: string | undefined, told2: unknown[] = [], queued = false
	function sync() {
		queued = false
		const ps = told2, was = base
		;[told2, base] = [[], undefined]
		const now = text(at), shown = editor.text()
		if (now === undefined || now === shown) return
		editor.apply(units(shown, shown === was ? step(was, ps, now) : diff(shown, now)))
	}
	let unwatch = () => {}
	teardown(() => unwatch())
	effect("follow", () => {
		const path = read(editing) as string[]
		return JSON.stringify([path, entries(tree(path))[0]?.id ?? null])
	}, (key: string) => {
		unwatch()
		const [path] = JSON.parse(key) as [string[]]
		const x = node(path)
		const v = val(x)
		at = x
		editor.load(
			typeof v === "string"
				? v
				: x
				? v instanceof Uint8Array
					? `(${size(v)} of bytes: not text)`
					: "(a folder: pick a file in it)"
				: `(nothing at ${path.join("/")})`,
			{ readonly: typeof v !== "string", name: path[path.length - 1] },
		)
		if (!x) return
		unwatch = watch(tree(x), (fact) => {
			if (fact.change?.actor === "editor") return
			base ??= editor.text()
			told2.push(...fact.patches)
			if (!queued) (queued = true, queueMicrotask(sync))
		})
	})

	// ---- pipes ----
	// each pipe on: a watch on each end. a pipe's own write is heard back (an echo) and dropped
	function connect(spec: Spec, fresh: boolean) {
		const actor = "pipe " + spec.id
		const chain: Using[] = spec.lenses
			.filter((l) => LENSES[l.kind])
			.map((l) => ({ kind: l.kind, params: { ...LENSES[l.kind].params, ...l.params } }))
		const tally = { crossed: 0, echoes: 0 }
		let busy = false
		const ends = () => {
			const x = node(spec.a), y = node(spec.b)
			const sx = text(x), sy = text(y)
			return x && y && sx !== undefined && sy !== undefined ? { x, y, sx, sy } : undefined
		}
		function show(note = "") {
			const was = read(looks) as Record<string, unknown>
			as(actor, () =>
				put(looks, {
					...was,
					[spec.id]: {
						...tally,
						note,
						keeps: chain.map((u) =>
							`${u.kind}: ${LENSES[u.kind].show?.(u.c) ?? "nothing (its own way back)"}`
						),
					},
				}))
		}
		// a → b: got through the lenses, diffed into b
		function down() {
			const e = ends()
			if (!e) return show("an end is not text")
			const v = forward(chain, e.sx).at(-1)!
			const ps = diff(e.sy, v)
			if (ps.length) (tally.crossed++, write(actor, e.y, ps, "got"))
			show()
		}
		// b → a: put back through the lenses; then got again, so b shows what a made of it
		function up() {
			const e = ends()
			if (!e) return show("an end is not text")
			const ps = diff(e.sx, back(chain, e.sy, e.sx))
			if (ps.length) (tally.crossed++, write(actor, e.x, ps, "put back"))
			down()
		}
		// one at a time: an end changed again while this pipe is still writing (another pipe's lens
		// correcting what this one wrote) goes through once this write is done, from the text then.
		// a ring of pipes would go round for ever: join refuses one, and 20 rounds stop it here
		let next: (() => void) | undefined
		const guarded = (f: () => void) => () => {
			if (busy) return void (next = f)
			busy = true
			try {
				f()
				for (let n = 0; next && n < 20; n++) {
					const g = next
					next = undefined
					g()
				}
			} finally {
				busy = false
				next = undefined
			}
		}
		const [goDown, goUp] = [guarded(down), guarded(up)]
		const echo = () => (tally.echoes++, show())
		const x = node(spec.a)!, y = node(spec.b)!
		const stops = [
			watch(tree(spec.a), (f) => f.change?.actor === actor ? echo() : goDown()),
			watch(tree(spec.b), (f) => f.change?.actor === actor ? echo() : goUp()),
		]
		// joined: not in the middle of this effect
		queueMicrotask(() => as(actor, fresh && spec.start === "b" ? goUp : goDown))
		return () => stops.forEach((s) => s())
	}
	// the pipes node says what is joined: a pipe is (re)made when what it says or what its ends
	// are changes; one turned on is joined from its start, one changed while on goes from a
	const joined = new Map<string, { key: string; on: boolean; stop: () => void }>()
	teardown(() => joined.forEach((j) => j.stop()))
	effect("wire", () =>
		JSON.stringify(
			(read(pipes) as Spec[]).map((p) => [
				p,
				entries(tree(p.a))[0]?.id,
				entries(tree(p.b))[0]?.id,
			]),
		), (key: string) => {
		const now = JSON.parse(key) as [Spec, string?, string?][]
		const ids = new Set(now.map(([p]) => p.id))
		for (const [id, j] of joined) if (!ids.has(id)) (j.stop(), joined.delete(id))
		for (const [p, ida, idb] of now) {
			const k = JSON.stringify([p, ida, idb])
			const was = joined.get(p.id)
			if (was?.key === k) continue
			was?.stop()
			const on = p.on && !!ida && !!idb
			joined.set(p.id, { key: k, on, stop: on ? connect(p, !was?.on) : () => {} })
		}
	})

	// ---- what the page shows ----
	// every node under inner, files and docs, a row each
	const rows = memo("rows", () => {
		const out: Row[] = []
		const st = read(state) as Record<string, string>
		const ed = (read(editing) as string[]).join("/")
		const walk = (path: string[], depth: number) => {
			for (const name of list(tree(path))) {
				const p = [...path, name]
				const v = val(p)
				const kids = list(tree(p))
				const kind = typeof v === "string"
					? "text"
					: v instanceof Uint8Array
					? "bytes"
					: kids.length
					? "folder"
					: "empty"
				out.push({
					path: p,
					name,
					depth,
					kind,
					size: typeof v === "string" ? count(v) : v instanceof Uint8Array ? v.length : 0,
					first: typeof v === "string"
						? (v.slice(0, 300).split("\n").find((l) => l.trim()) ?? "").slice(0, 60)
						: "",
					state: st[p.join("/")] ?? "",
					editing: p.join("/") === ed,
					top: depth === 0,
				})
				if (kids.length) walk(p, depth + 1)
			}
		}
		const group = (name: string, says: string) => {
			out.push({
				path: [name],
				name,
				depth: -1,
				kind: "group",
				size: 0,
				first: says,
				state: st[name] ?? "",
				editing: false,
				top: false,
			})
			const n = out.length
			walk([name], 0)
			if (out.length === n) {
				out.push({
					path: [name, ""],
					name: "",
					depth: 0,
					kind: "empty",
					size: 0,
					first: "",
					state: "",
					editing: false,
					top: false,
				})
			}
		}
		group("inner", "only here")
		group("files", "your computer")
		group("docs", "patchwork")
		return out
	})
	// the pipes, the text nodes they can join, and what each keeps aside
	const wires = memo("wires", () => ({
		specs: read(pipes) as Spec[],
		texts: (read(rows) as Row[] ?? []).filter((r) => r.kind === "text").map((r) =>
			r.path.join("/")
		),
		looks: read(looks) as Record<
			string,
			{ crossed: number; echoes: number; note: string; keeps: string[] }
		>,
	}))

	// ---- what a person does ----
	const respec = (f: (specs: Spec[]) => Spec[]) => put(pipes, f(read(pipes) as Spec[]))
	const change = (id: string, f: (p: Spec) => Spec) =>
		respec((ps) => ps.map((p) => p.id === id ? f(p) : p))
	const quiet = (e: unknown) =>
		(e as Error)?.name === "AbortError" || say("oops", (e as Error).message)
	method("on/file", () => {
		if (!browser.showOpenFilePicker) {
			return say("oops", "no File System Access API here (Chrome has it)")
		}
		return browser.showOpenFilePicker({ id: "piece-lens" }).then(
			async ([h]: FileSystemFileHandle[]) => {
				// writing asked for now, while the click still counts; refused: read only until allowed
				await (h as any).requestPermission?.({ mode: "readwrite" }).catch(() => {})
				const d = await addFile(h, ["files"], unique(["files"], h.name), true)
				observe(h, d.path, false)
				flush(d)
				told("disk", d.path.join("/"), [], "opened")
				as("lens", () => put(editing, d.path))
			},
		).catch(quiet)
	})
	method("on/folder", () => {
		if (!browser.showDirectoryPicker) {
			return say("oops", "no File System Access API here (Chrome has it)")
		}
		return browser.showDirectoryPicker({ id: "piece-lens", mode: "readwrite" }).then(
			async (dir: FileSystemDirectoryHandle) => {
				const name = unique(["files"], dir.name)
				const path = ["files", name]
				const at = path
				as("disk", () => open(tree(path), null))
				folders.set(path.join("/"), { handle: dir, path })
				say(path.join("/"), "reading…")
				await addFolder(dir, at, { n: 400 })
				say(path.join("/"), "folder")
				observe(dir, path, true)
				told(
					"disk",
					path.join("/"),
					[],
					`opened, ${
						[...disks.keys()].filter((k) => k.startsWith(path.join("/") + "/")).length
					} files`,
				)
			},
		).catch(quiet)
	})
	method("on/allow", (path: string[]) => {
		const key = path.join("/")
		const top = folders.get(path.slice(0, 2).join("/"))
		// deno-lint-ignore no-explicit-any
		const ask = (top?.handle ?? disks.get(key)?.handle) as any
		return ask?.requestPermission?.({ mode: "readwrite" }).then(() => {
			for (const d of disks.values()) {
				if (d.path.join("/").startsWith(path.slice(0, 2).join("/"))) flush(d)
			}
		})
	})
	method("on/doc", async (url: string) => {
		try {
			say("oops", "")
			await link(await (await automerge()).open(url.trim()))
		} catch (e) {
			say("oops", "couldn't open it: " + (e as Error).message)
		}
	})
	method("on/newdoc", async () => {
		try {
			await link(await (await automerge()).create("from ermine"))
		} catch (e) {
			say("oops", "couldn't make one: " + (e as Error).message)
		}
	})
	method("on/inner", () => {
		const name = unique(["inner"], "note")
		as("lens", () => open(tree(["inner", name]), ""))
		put(editing, ["inner", name])
	})
	method("on/edit", (path: string[]) => put(editing, path))
	// a top node taken out: its nodes, and what kept it in step
	method("on/close", (path: string[]) => {
		const key = path.join("/")
		for (const k of [...disks.keys()]) if (k === key || k.startsWith(key + "/")) disks.delete(k)
		folders.delete(key)
		linked.delete(key)
		const x = node(path)
		if (x) prune(x)
		if ((read(editing) as string[]).join("/").startsWith(key)) put(editing, ["inner", "draft"])
	})
	method("on/copy", (path: string[]) => {
		const l = linked.get(path.join("/"))
		if (l) navigator.clipboard?.writeText(l.doc.url).then(() => say(path.join("/"), "url copied"))
	})
	method("on/addpipe", () => {
		const texts = (read(rows) as Row[]).filter((r) => r.kind === "text").map((r) => r.path)
		const a = read(editing) as string[]
		const b = texts.find((p) => p.join("/") !== a.join("/")) ?? a
		const n = Math.max(0, ...(read(pipes) as Spec[]).map((p) => Number(p.id.slice(1)) || 0)) + 1
		respec((ps) => [...ps, { id: "p" + n, a, b, lenses: [], on: false, start: "a" }])
	})
	// an end changed: the pipe stops until it is joined again (someone says who wins)
	method(
		"on/end",
		(id: string, side: "a" | "b", path: string) =>
			change(id, (p) => ({ ...p, [side]: path.split("/"), on: false })),
	)
	method("on/swap", (id: string) => change(id, (p) => ({ ...p, a: p.b, b: p.a, on: false })))
	method("on/join", (id: string, start: "a" | "b") => {
		const specs = read(pipes) as Spec[]
		const p = specs.find((p) => p.id === id)!
		if (loops([...specs.filter((q) => q.on && q.id !== id), p])) {
			return say("pipes", `${id} would close a loop: a change would go round for ever`)
		}
		say("pipes", "")
		change(id, (p) => ({ ...p, on: true, start }))
	})
	method("on/pause", (id: string) => change(id, (p) => ({ ...p, on: false })))
	method("on/unpipe", (id: string) => respec((ps) => ps.filter((p) => p.id !== id)))
	method("on/lens", (id: string, kind: string) => {
		if (LENSES[kind]) {
			change(
				id,
				(p) => ({ ...p, lenses: [...p.lenses, { kind, params: { ...LENSES[kind].params } }] }),
			)
		}
	})
	method(
		"on/unlens",
		(id: string, i: number) =>
			change(id, (p) => ({ ...p, lenses: p.lenses.filter((_, k) => k !== i) })),
	)
	method("on/param", (id: string, i: number, name: string, value: string) =>
		change(id, (p) => ({
			...p,
			lenses: p.lenses.map((l, k) =>
				k === i
					? {
						...l,
						params: {
							...l.params,
							[name]: typeof LENSES[l.kind].params?.[name] === "number"
								? Number(value) || 0
								: value,
						},
					}
					: l
			),
		})))

	// a node and all under it, taken out
	function prune(x: string[]) {
		for (const name of list(tree(x))) prune([...x, name])
		remove(tree(x))
	}

	// ---- the page ----
	const value = (e: Event) => (e.target as HTMLInputElement).value
	const icon = (r: Row) =>
		r.kind === "folder" ? "▸" : r.path[0] === "files" ? "💾" : r.path[0] === "docs" ? "🍑" : "○"
	return (
		<div class="pl">
			<style>{css}</style>
			<h1>
				lens<span>a file, a patchwork doc, inner nodes: one text, splices between</span>
			</h1>
			<div class="bar">
				<button onClick={handler("on/file")}>💾 open a file</button>
				<button onClick={handler("on/folder")}>📁 open a folder</button>
				<span class="am">
					<input placeholder="automerge:… a patchwork doc" spellcheck={false} />
					<button
						onClick={handler(
							"on/doc",
							(
								e,
							) => [
								(e.target.closest(".am").querySelector("input") as HTMLInputElement).value,
							],
						)}
					>
						🍑 open
					</button>
					<button onClick={handler("on/newdoc")}>new doc</button>
				</span>
				<button onClick={handler("on/inner")}>○ new inner node</button>
				{bind("state", (st: Record<string, string>) =>
					st?.oops ? <em class="warn">{st.oops}</em> : null)}
			</div>
			<div class="main">
				<aside class="tree">
					{bind("rows", (rs: Row[]) =>
						(rs ?? []).map((r) =>
							r.kind === "group"
								? (
									<div key={r.name} class="group">
										<b>{r.name}</b> <span>{r.first}</span>
										{r.state ? <em class={tone(r.state)}>{r.state}</em> : null}
									</div>
								)
								: r.name === ""
								? <div key={r.path.join("/")} class="row none">nothing yet</div>
								: (
									<div
										key={r.path.join("/")}
										class={`row ${r.kind}${r.editing ? " on" : ""}`}
										style={`padding-left:${6 + r.depth * 12}px`}
										onClick={r.kind === "text" || r.kind === "bytes"
											? handler("on/edit", [r.path])
											: undefined}
										title={r.path.join("/")}
									>
										<span class="name">
											<i>{icon(r)}</i>
											<span class="label">{r.name}</span>
											{r.state ? <em class={tone(r.state)}>{r.state}</em> : null}
											<span class="acts">
												{r.state === "read only"
													? (
														<button
															class="tiny"
															onClick={handler("on/allow", [r.path])}
														>
															allow writing
														</button>
													)
													: null}
												{r.top && r.path[0] === "docs"
													? (
														<button
															class="tiny"
															onClick={handler("on/copy", [r.path])}
														>
															copy url
														</button>
													)
													: null}
												{r.top && r.path.join("/") !== "inner/draft"
													? (
														<button
															class="tiny x"
															title="close"
															onClick={handler("on/close", [r.path])}
														>
															×
														</button>
													)
													: null}
											</span>
										</span>
										{r.kind === "text"
											? <span class="first">{r.first || "(empty)"}</span>
											: null}
									</div>
								)
						))}
				</aside>
				<section class="ed">
					<div class="edhead">
						{bind("rows", (rs: Row[]) => {
							const r = (rs ?? []).find((r) =>
								r.editing
							)
							return r
								? (
									<span>
										✎ <b>{r.path.join("/")}</b>{" "}
										{r.kind === "text" ? `${r.size} code points` : r.kind}{" "}
										{r.state ? `· ${r.state}` : ""}
									</span>
								)
								: <span>✎ nothing picked</span>
						})}
					</div>
					{editor.dom}
				</section>
			</div>
			{bind(
				"wires",
				(w: { specs: Spec[]; texts: string[]; looks: Record<string, any> }) => (
					<section class="pipes">
						<h2>
							pipes<em>
								left ▸ lenses ▸ right: a change on either side goes through, the lenses keep
								what the right leaves out
							</em>
						</h2>
						{(w?.specs ?? []).map((p) => {
							const look = w.looks?.[p.id]
							const gone = [p.a, p.b].map((x) =>
								x.join("/")
							).find((x) => !w.texts.includes(x))
							const ends = (side: "a" | "b") => (
								<select onChange={handler("on/end", (e) => [p.id, side, value(e)])}>
									{[...new Set([...w.texts, p[side].join("/")])].map((path) => (
										<option value={path} selected={path === p[side].join("/")}>
											{path}
										</option>
									))}
								</select>
							)
							return (
								<div key={p.id} class={`pipe${p.on ? " live" : ""}`}>
									<div class="line">
										<b class="id">{p.id}</b>
										{ends("a")}
										<span class="arrow">▸</span>
										{p.lenses.map((l, i) => (
											<span class="chip" title={LENSES[l.kind]?.says ?? "no such lens"}>
												{l.kind}
												{Object.entries(l.params ?? {}).map(([k, v]) => (
													<label>
														{k}
														<input
															class={typeof v === "number" ? "num" : "word"}
															value={String(v)}
															onChange={handler(
																"on/param",
																(e) => [p.id, i, k, value(e)],
															)}
														/>
													</label>
												))}
												<button
													class="tiny x"
													onClick={handler("on/unlens", [p.id, i])}
												>
													×
												</button>
											</span>
										))}
										<select
											class="add"
											onChange={handler("on/lens", (e) => {
												const kind = value(e)
												;(e.target as HTMLSelectElement).value = ""
												return [p.id, kind]
											})}
										>
											<option value="" selected>+ lens</option>
											{Object.keys(LENSES).map((k) => (
												<option value={k} title={LENSES[k].says}>{k}</option>
											))}
										</select>
										<span class="arrow">▸</span>
										{ends("b")}
										<button
											class="tiny"
											title="swap the ends"
											onClick={handler("on/swap", [p.id])}
										>
											⇄
										</button>
										<span class="fill" />
										{p.on
											? (
												<button class="tiny" onClick={handler("on/pause", [p.id])}>
													pause
												</button>
											)
											: (
												<span class="join">
													join:
													<button
														class="tiny go"
														title="the right takes what the lenses make of the left"
														onClick={handler("on/join", [p.id, "a"])}
													>
														left wins ▸
													</button>
													<button
														class="tiny go"
														title="the left takes the right, put back through the lenses"
														onClick={handler("on/join", [p.id, "b"])}
													>
														◂ right wins
													</button>
												</span>
											)}
										<button
											class="tiny x"
											title="take the pipe out"
											onClick={handler("on/unpipe", [p.id])}
										>
											×
										</button>
									</div>
									{p.on && gone
										? (
											<div class="keeps">
												<span class="tally">
													waiting: {gone} is not here, or is not text
												</span>
											</div>
										)
										: p.on && look
										? (
											<div class="keeps">
												{look.keeps.map((k: string) => <code>{k}</code>)}
												<span class="tally">
													{look.crossed} crossed · {look.echoes}{" "}
													echoes dropped{look.note ? ` · ${look.note}` : ""}
												</span>
											</div>
										)
										: (
											<div class="keeps">
												<span class="tally">
													{p.on ? "joining…" : "not joined: say who wins"}
												</span>
											</div>
										)}
								</div>
							)
						})}
						<div class="line">
							<button onClick={handler("on/addpipe")}>+ pipe</button>
							{bind(
								"state",
								(st: Record<string, string>) =>
									st?.pipes ? <em class="warn">{st.pipes}</em> : null,
							)}
						</div>
					</section>
				),
			)}
			<section class="flow">
				<h2>
					splices<em>the opstream: each write, who made it, and what it was</em>
				</h2>
				<ol>
					{bind("log", (rows: Flow[]) =>
						(rows ?? []).length === 0
							? <li class="empty">type in the editor…</li>
							: rows.map((f) => (
								<li key={String(f.n)} class={"by-" + f.who.split(" ")[0]}>
									<b>#{f.n}</b>
									<span class="who">{f.who}</span>
									<span class="at">{f.at}</span>
									<code>{f.what}</code>
									{f.note ? <em>{f.note}</em> : null}
								</li>
							)))}
				</ol>
			</section>
		</div>
	)
}

// how a state looks: fine, busy, or wants you
const tone = (state: string) =>
	/^(synced|linked|online|folder|bytes|url copied)/.test(state)
		? "fine"
		: /…$|^gone\?|makes it text/.test(state)
		? "busy"
		: "bad"

// a few splices, short
function summary(ps: readonly unknown[]) {
	const q = (s: string) => JSON.stringify(s.length > 24 ? s.slice(0, 24) + "…" : s)
	return (ps as { path: unknown[]; range?: [number, number]; value?: unknown }[]).slice(0, 3).map(
		(p) => {
			if (!p.range) {
				return p.value instanceof Uint8Array
					? `whole: ${size(p.value)}`
					: `whole ${q(String(p.value ?? ""))}`
			}
			const [a, b] = p.range
			if (a === b) return `@${a} +${q(String(p.value))}`
			return p.value === undefined ? `@${a}–${b} −` : `@${a}–${b} ${q(String(p.value))}`
		},
	).join("  ") + (ps.length > 3 ? `  +${ps.length - 3} more` : "")
}
const size = (v: unknown) => {
	const n = typeof v === "string"
		? new TextEncoder().encode(v).length
		: v instanceof Uint8Array
		? v.length
		: 0
	return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`
}
// pipes as edges between paths: a loop if two ends already meet
function loops(specs: Spec[]) {
	const up = new Map<string, string>()
	const root = (k: string): string => (up.has(k) ? root(up.get(k)!) : k)
	for (const p of specs) {
		const [a, b] = [root(p.a.join("/")), root(p.b.join("/"))]
		if (a === b) return true
		up.set(a, b)
	}
	return false
}

const css = `
.pl{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:10px 12px 14px;min-height:calc(100vh - 18px);box-sizing:border-box;display:flex;flex-direction:column;gap:6px}
.pl *{box-sizing:border-box}
.pl h1{font-size:20px;margin:0;font-weight:600}
.pl h1 span,.pl h2 em{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:12.5px;font-weight:500;vertical-align:3px;margin-left:8px;font-style:normal}
.pl h2{font-size:13px;font-weight:600;margin:4px 0 2px}
.pl h2 em{background:#fff;font-size:11.5px}
.pl code,.pl .first,.pl input.num,.pl input.word{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.pl button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 9px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.pl button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.pl button:active{transform:translate(1px,1px);box-shadow:none}
.pl button.tiny{font-size:11px;padding:0 5px;box-shadow:none;margin-left:3px}
.pl button.x{border-color:transparent;background:none;color:#ff2284;font-weight:700}
.pl button.go{background:#ffff88}
.pl input,.pl select{font:inherit;font-size:12px;border:1px solid #000;border-radius:0;padding:1px 4px;background:#fff;color:#000}
.pl input:focus,.pl select:focus{outline:none;background:#ffff88}
.pl .bar{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.pl .am{display:flex;gap:4px;align-items:center;flex:1 1 280px}
.pl .am input{flex:1;min-width:120px;font-family:Monaco,ui-monospace,monospace;font-size:11px}
.pl .main{display:grid;grid-template-columns:minmax(170px,250px) minmax(0,1fr);gap:6px;height:300px}
.pl .tree{overflow:auto;background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000;font-size:12.5px}
.pl .group{padding:4px 6px 2px;border-bottom:1px solid #000;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 50%/100% 6px no-repeat,#fff;position:sticky;top:0}
.pl .group b,.pl .group span{background:#fff;padding:0 4px}
.pl .group span{font-size:11px;opacity:.7}
.pl .row{padding:2px 6px;cursor:pointer;border-bottom:1px solid #f1f1f1}
.pl .row:hover{background:#fffde0}
.pl .row.on{background:#ffff88}
.pl .row.folder{cursor:default;font-weight:500}
.pl .row.none{cursor:default;opacity:.5;font-size:11.5px}
.pl .row i{font-style:normal}
.pl .row .name{display:flex;align-items:center;gap:4px;min-width:0}
.pl .row .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl .row .acts{margin-left:auto;display:inline-flex;flex:none}
.pl .row em,.pl .group em{font-style:normal;font-size:10.5px;border:1px solid #000;padding:0 4px;background:#fff;white-space:nowrap;flex:none}
.pl em.fine{background:#40dcba}
.pl em.busy{background:#ffff88}
.pl em.bad{background:#ff2284;color:#fff}
.pl .first{display:block;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl .ed{display:flex;flex-direction:column;background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000;min-width:0;min-height:0}
.pl .edhead{border-bottom:1px solid #000;padding:2px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl .ed>.cm-editor{flex:1 1 0;min-height:0}
.pl .pipes .line{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.pl .pipe{background:#fff;border:1px solid #000;padding:4px 6px;margin:0 0 5px;box-shadow:2px 2px 0 #000}
.pl .pipe.live{box-shadow:2px 2px 0 #ff2284}
.pl .pipe select{max-width:170px}
.pl .pipe .id{font-size:12px;background:#000;color:#fff;padding:0 5px}
.pl .arrow{font-weight:700;color:#ff2284}
.pl .chip{display:inline-flex;gap:4px;align-items:center;background:#ffff88;border:1px solid #000;padding:0 0 0 6px;font-size:12px;font-weight:500}
.pl .chip label{display:inline-flex;gap:2px;align-items:center;font-weight:400;font-size:11px}
.pl .chip input.num{width:3.2em;padding:0 3px}
.pl .chip input.word{width:4em;padding:0 3px}
.pl .fill{flex:1}
.pl .join{font-size:12px;display:inline-flex;align-items:center;gap:2px}
.pl .keeps{display:flex;flex-wrap:wrap;gap:4px 6px;margin-top:4px;align-items:center}
.pl .keeps code{background:#fbfbfb;border:1px dashed #000;padding:0 4px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl .tally{font-size:11.5px;opacity:.75}
.pl .warn{font-style:normal;font-size:12px;background:#ff2284;color:#fff;padding:0 6px}
.pl .flow ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.pl .flow li{display:flex;gap:6px;align-items:baseline;background:#fff;border:1px solid #000;border-left-width:5px;padding:1px 6px;font-size:12px;animation:plin .3s ease-out;min-width:0}
.pl .flow li.by-editor{border-left-color:#ff2284}
.pl .flow li.by-disk{border-left-color:#3a6dff}
.pl .flow li.by-automerge{border-left-color:#40dcba}
.pl .flow li.by-pipe{border-left-color:#e8d800}
.pl .flow li.empty{opacity:.6;border-left-width:1px}
.pl .flow .who{font-weight:600;min-width:62px}
.pl .flow .at{min-width:90px}
.pl .flow code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl .flow em{font-style:normal;font-size:11px;opacity:.7;white-space:nowrap}
@keyframes plin{from{background:#ffff88}to{background:#fff}}
`
