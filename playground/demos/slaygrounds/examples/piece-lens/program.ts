/** @jsxImportSource ermine-h */
import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	hasNode,
	list,
	patch,
	peep,
	pipe,
	read,
	ref,
	unplace,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, handler } from "ermine-h"
import apply from "@ermine/core/op/apply"
import { count, unit } from "@ermine/core/util/walk-string"

// piece-lens: one text in three kinds of place, kept in step by opstreams. a file or a folder on
// your computer (the File System Access API), a patchwork doc (automerge, by its url), and inner
// nodes that live only in this graph. this port has the inner nodes, the pipes and the editor; the
// disk and the docs are not in it (see the note in the view): each writes the graph from a picker's
// promise, a file's change or a doc's change, where nothing is open. the opstream on a text is ermine's splice, a patch:
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
// every write is told in the flow with who made it; a pipe is never told its own writes

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
// what the host's extend adds (host.ts): the editor (CodeMirror), bundled apart (cm.ts). its typing
// is the host's to tell: it runs this process's on/typed with each change
type Host = {
	editor: () => import("./cm.ts").TextEditor
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

export default function program() {
	const { editor: makeEditor } = host<Host>()
	// the text nodes live in the working folder (saved, so a reload finds them): ./text/inner. a node
	// here is its path under it, names; tree says where. pipes and what is picked are there too. what
	// each side says, and the log, are the process's own
	const tree = (path: readonly string[]) => "/text/" + path.join("/")
	const pipes = ensureNode("./text/pipes", PIPES)
	const editing = ensureNode("./text/editing", ["inner", "draft"])
	const log = ensureNode("log", [] as Flow[])
	// what each side says: by path
	const state = ensureNode("state", {} as Record<string, string>)
	// what each pipe's lenses keep aside, and how much went through
	const looks = ensureNode("looks", {} as Record<string, unknown>)
	ensureNode(tree(["inner", "draft"]), DRAFT)
	ensureNode(tree(["inner", "shout"]), "")
	const put = (x: ReturnType<typeof ensureNode>, value: unknown) => patch(x, [{ path: [], value }])

	// kept across reloads: the editor (a live value, ref'd in ./)
	const editor = read(ref("./text-kept/editor", () => makeEditor())) as ReturnType<
		typeof makeEditor
	>

	// ---- reading and writing ----
	// reads here are as things are now (peep), but where a memo or an effect says, tracked (look)
	const now = <T,>(f: () => T) => peep(f)
	// a node's path if there is a node there
	const node = (path: string[]): string[] | undefined =>
		now(() => hasNode(tree(path))) ? path : undefined
	const val = (x?: string[]) => (x ? now(() => read(tree(x))) : undefined)
	const text = (x?: string[]) => {
		const v = val(x)
		return typeof v === "string" ? v : undefined
	}
	const rel = (x: string[]) => x.join("/")
	// splices on a node, told to the flow
	function write(who: string, x: string[], ps: readonly unknown[], note = "") {
		if (ps.length === 0) return
		told(who, rel(x), ps, note)
		patch(tree(x), ps as never)
	}
	function told(who: string, at: string, ps: readonly unknown[], note = "") {
		const was = now(() => read(log)) as Flow[]
		const n = (was[0]?.n ?? 0) + 1
		put(log, [{ n, who, at, what: summary(ps), note }, ...was].slice(0, 14))
	}
	function say(key: string, words: string) {
		const was = now(() => read(state)) as Record<string, string>
		if (was[key] !== words) put(state, { ...was, [key]: words })
	}
	const unique = (parent: string[], name: string) => {
		const taken = new Set(now(() => list(tree(parent))))
		let out = name, n = 1
		while (taken.has(out)) out = `${name} ${++n}`
		return out
	}

	// ---- the editor: one CodeMirror over the node in editing ----
	// the person types: the host runs on/typed with their changes (an editor's listener has nothing
	// open to write in), as splices on the node. a change told while the editor is out of step with
	// the node: the node's text made the editor's, by a diff
	let at: string[] | undefined
	createAction("on/typed", (changes: Change[], before: string) => {
		const x = at && node(at)
		const was = text(x)
		if (!x || was === undefined) return
		write("editor", x, was === before ? points(before, changes) : diff(was, editor.text()))
	})
	// the editor follows the node: loaded with a node picked, and made the same when the node
	// changes by anyone else (a diff of what it shows against what the node has: an edit of its own
	// leaves them the same, and nothing is applied)
	createEffect("follow", () => {
		const path = read(editing) as string[]
		const here = hasNode(tree(path))
		return { key: rel(path), path, here, v: here ? read(tree(path)) : undefined }
	}, ({ key, path, here, v }, before) => {
		at = here ? path : undefined
		if (before?.key !== key || before.here !== here) {
			editor.load(
				typeof v === "string"
					? v
					: here
					? v instanceof Uint8Array
						? `(${size(v)} of bytes: not text)`
						: "(a folder: pick a file in it)"
					: `(nothing at ${path.join("/")})`,
				{ readonly: typeof v !== "string", name: path[path.length - 1] },
			)
			return
		}
		const shown = editor.text()
		if (typeof v === "string" && v !== shown) editor.apply(units(shown, diff(shown, v)))
	})

	// ---- pipes ----
	// each pipe on: one pipe between its ends (pipe(a, b, down, up)): it hears every patch on either
	// and writes what the lenses make of it on the other. it is never told its own writes, so an echo
	// cannot happen
	const tallies = new Map<string, { crossed: number }>()
	function connect(spec: Spec, chain: Using[], fresh: boolean) {
		const actor = "pipe " + spec.id
		const tally = tallies.get(spec.id) ?? { crossed: 0 }
		tallies.set(spec.id, tally)
		const ends = () => {
			const sx = text(node(spec.a)), sy = text(node(spec.b))
			return sx !== undefined && sy !== undefined ? { sx, sy } : undefined
		}
		function show(note = "") {
			patch(looks, [{
				path: [spec.id],
				value: {
					...tally,
					note,
					keeps: chain.map((u) =>
						`${u.kind}: ${LENSES[u.kind].show?.(u.c) ?? "nothing (its own way back)"}`
					),
				},
			}])
		}
		// a → b: got through the lenses, diffed into b: the splices for b
		function down(): Splice[] {
			const e = ends()
			if (!e) return show("an end is not text"), []
			const v = forward(chain, e.sx).at(-1)!
			const ps = diff(e.sy, v)
			if (ps.length) (tally.crossed++, told(actor, rel(spec.b), ps, "got"))
			show()
			return ps
		}
		// b → a: put back through the lenses: the splices for a. then got again, so b shows what a
		// made of it (written here: the pipe is not told its own writes)
		function up(): Splice[] {
			const e = ends()
			if (!e) return show("an end is not text"), []
			const ps = diff(e.sx, back(chain, e.sy, e.sx))
			if (ps.length) (tally.crossed++, told(actor, rel(spec.a), ps, "put back"))
			const v = forward(chain, ps.length ? run(e.sx, ps) : e.sx).at(-1)!
			const again = diff(e.sy, v)
			if (again.length) {
				tally.crossed++
				told(actor, rel(spec.b), again, "got")
				patch(tree(spec.b), again)
			}
			show()
			return ps
		}
		// joined: one side takes the other first (the effect's own writes, before the pipe is made)
		if (fresh && spec.start === "b") {
			const ps = up()
			if (ps.length) patch(tree(spec.a), ps)
		} else {
			const ps = down()
			if (ps.length) patch(tree(spec.b), ps)
		}
		pipe(tree(spec.a), tree(spec.b), down, up, { timing: "write", name: "lens-" + spec.id })
	}
	// the pipes node says what is joined: a pipe is (re)made when what it says or what its ends are
	// changes; one turned on is joined from its start, one changed while on goes from a
	const joined = new Map<string, { key: string; on: boolean; chain: Using[] }>()
	createEffect("wire", () =>
		JSON.stringify(
			(read(pipes) as Spec[]).map((p) => [p, hasNode(tree(p.a)), hasNode(tree(p.b))]),
		), (key: string) => {
		const was = new Map(joined)
		joined.clear()
		for (const [p, a, b] of JSON.parse(key) as [Spec, boolean, boolean][]) {
			const k = JSON.stringify([p, a, b])
			const before = was.get(p.id)
			const on = p.on && a && b
			// the lenses kept when the pipe is as it was (their complements go on)
			const chain = before?.key === k
				? before.chain
				: p.lenses.filter((l) => LENSES[l.kind]).map((l) => ({
					kind: l.kind,
					params: { ...LENSES[l.kind].params, ...l.params },
				}))
			joined.set(p.id, { key: k, on, chain })
			if (on) connect(p, chain, !before?.on)
		}
	})

	// ---- what the page shows ----
	// every node under inner, a row each
	const rows = createMemo("rows", () => {
		const out: Row[] = []
		const st = read(state) as Record<string, string>
		const ed = (read(editing) as string[]).join("/")
		const walk = (path: string[], depth: number) => {
			for (const name of list(tree(path))) {
				const p = [...path, name]
				const v = read(tree(p))
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
		return out
	})
	// the pipes, the text nodes they can join, and what each keeps aside
	const wires = createMemo("wires", () => ({
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
	const respec = (f: (specs: Spec[]) => Spec[]) => put(pipes, f(now(() => read(pipes)) as Spec[]))
	const change = (id: string, f: (p: Spec) => Spec) =>
		respec((ps) => ps.map((p) => p.id === id ? f(p) : p))
	createAction("on/inner", () => {
		const name = unique(["inner"], "note")
		ensureNode(tree(["inner", name]), "")
		put(editing, ["inner", name])
	})
	createAction("on/edit", (path: string[]) => put(editing, path))
	// a top node taken out: its nodes
	createAction("on/close", (path: string[]) => {
		const key = path.join("/")
		const x = node(path)
		if (x) prune(x)
		if ((now(() => read(editing)) as string[]).join("/").startsWith(key)) {
			put(editing, ["inner", "draft"])
		}
	})
	createAction("on/addpipe", () => {
		const texts = (now(() => read(rows)) as Row[]).filter((r) => r.kind === "text").map((r) =>
			r.path
		)
		const a = now(() => read(editing)) as string[]
		const b = texts.find((p) => p.join("/") !== a.join("/")) ?? a
		const n = Math.max(
			0,
			...(now(() => read(pipes)) as Spec[]).map((p) => Number(p.id.slice(1)) || 0),
		) + 1
		respec((ps) => [...ps, { id: "p" + n, a, b, lenses: [], on: false, start: "a" }])
	})
	// an end changed: the pipe stops until it is joined again (someone says who wins)
	createAction(
		"on/end",
		(id: string, side: "a" | "b", path: string) =>
			change(id, (p) => ({ ...p, [side]: path.split("/"), on: false })),
	)
	createAction("on/swap", (id: string) => change(id, (p) => ({ ...p, a: p.b, b: p.a, on: false })))
	createAction("on/join", (id: string, start: "a" | "b") => {
		const specs = now(() => read(pipes)) as Spec[]
		const p = specs.find((p) => p.id === id)!
		if (loops([...specs.filter((q) => q.on && q.id !== id), p])) {
			return say("pipes", `${id} would close a loop: a change would go round for ever`)
		}
		say("pipes", "")
		change(id, (p) => ({ ...p, on: true, start }))
	})
	createAction("on/pause", (id: string) => change(id, (p) => ({ ...p, on: false })))
	createAction("on/unpipe", (id: string) => respec((ps) => ps.filter((p) => p.id !== id)))
	createAction("on/lens", (id: string, kind: string) => {
		if (LENSES[kind]) {
			change(
				id,
				(p) => ({ ...p, lenses: [...p.lenses, { kind, params: { ...LENSES[kind].params } }] }),
			)
		}
	})
	createAction(
		"on/unlens",
		(id: string, i: number) =>
			change(id, (p) => ({ ...p, lenses: p.lenses.filter((_, k) => k !== i) })),
	)
	createAction(
		"on/param",
		(id: string, i: number, name: string, value: string) =>
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
			})),
	)

	// a node and all under it, taken out
	function prune(x: string[]) {
		for (const name of now(() => list(tree(x)))) prune([...x, name])
		unplace(tree(x))
	}

	// ---- the page ----
	const value = (e: Event) => (e.target as HTMLInputElement).value
	const icon = (r: Row) => (r.kind === "folder" ? "▸" : "○")
	return (
		<div class="pl">
			<style>{css}</style>
			<h1>
				lens<span>a file, a patchwork doc, inner nodes: one text, splices between</span>
			</h1>
			<div class="bar">
				<button onClick={handler("on/inner")}>○ new inner node</button>
				<span class="note">
					not in this port: a file or folder on your computer, a patchwork doc. each writes the
					graph from a picker's promise, a file's change or a doc's change, and nothing is open
					there
				</span>
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
								what the right leaves out; the pipe is never told its own writes
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
													{look.crossed} crossed{look.note ? ` · ${look.note}` : ""}
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
