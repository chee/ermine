// programs: what runs a program, found by matching types, every way listed; and what opens a file.
// a compiler is a program too: what runs a node is found for that node, like #!. matched on the
// path from here to the root, never down. the attribute names are placeholders, in ATTRIBUTES
//
//   const [way] = satisfy(web.places, "catclock.c", ["clocks"])   // the first; the search stops
//   // { program: { id: CAT, at: ["clocks", "catclock.c"] },
//   //   chain: [server clang (by [page]), wasm runner (by [page])] }
//   const why: Whynot[] = []
//   const ways = [...satisfy(web.places, "catclock.c", ["clocks"], { onwhynot: (w) => why.push(w) })]
//   // every way: the same program, then [wasm clang (by [wasm runner (by [page])]), wasm runner]
//   const opens = [...openwith(web.places, CAT, ["clocks"])]
//   // [{ program: { id: TEXT, at: ["viewers", "text"] }, chain: [page] }]
//
// types: @ermine/types' typeOf, by the place the search met a node at (openwith's file: its place
// if given, else its attribute alone). a loader's attributes:
//   takes: UTIs it takes (a type fits when it conforms to one)
//   gives: a compiler's output UTI; none: a runner
//   needs: what it needs from what runs it ([javascript, fetch]); a program may say it too
//   provides: what a runner gives what it runs ([wasm32]). a fit: needs ⊆ provides
// host runner: a node with no ermine.type whose value is a live host function (never saved); every
// search ends at one. a live function named with an extension a type claims is typed by it
//
// satisfy and openwith are generators of { program, chain }, reading only as far as iterated
// (nothing before the first next()). satisfy(places, name, from, { onwhynot }): name looked up from
// from (./, ../ or / in front: no lookup); a chain: compilers in order, each giving the next's
// type, then a runner taking the last and providing the program's needs. each step's by: its own
// chain to a host runner
// candidates: each folder's members from the search's place up to the box's "/", nearest first,
// canonical key order within a folder; a folder with ermine.programs.loaders true: its children in
// its place. a node met again: passed over. chains whole only; no node twice in a chain or in the
// chains running it. ermine.programs.loader: a pin (a path, as #!), tried first at the first step
// order: the nearest level giving a way (a way's level: the farthest any step or by comes from),
// then fewest steps, then nearest, then name. no level read past the one that answers. found by
// iterative deepening
// onwhynot(why): each candidate not taken, once, in order: { id, at, for, type, why }
//   wrong-type    takes nothing the type conforms to
//   unknown-type  the same, the type not in the nearest ermine/types
//   needs         a runner not providing what is needed (missing: those names)
//   no-chain      fits, but its own run or the rest of its chain was not found
//   no-type       fits, but no type and no live function: nothing runs it
//   in-the-chain  fits, but is in the chain already, or runs it
// the search's own (no for; nothing yielded): nothing-there { path, from }; no-type { id, at? } (a
// program with none whose value is a live function: one way, chain empty); no-chain { id, at }
// openwith(places, file, from, { onwhynot }): file an id or { id, at }; every opener
// (ermine.programs.opens: UTIs the file's type conforms to) with each of its chains, as satisfy's.
// one with none: left out (no-chain); none opening it: nothing yielded, no refusal
// reads only, all through places: iterate inside a computer's run to be tracked
// open: the model; the search bound by iteration; pins on the program only, not on openers; a
// compiler's own needs; host runners unextended; onwhynot as a callback
import type { Id, Path, Places } from "@ermine/places"
import { level } from "@ermine/places"
import { get, lookup, members } from "@ermine/places/lib"
import { parse, plan as resolve } from "@ermine/places/path"
import { keyOrder } from "@ermine/encoding/cbor"
import {
	ATTRIBUTE,
	conformance,
	type Extensions,
	extensionsOf,
	type Folder,
	typeOf as typeAt,
	typesAt,
} from "@ermine/types"

// the attributes read: names are placeholders, said here once
export const ATTRIBUTES = {
	// a node's UTI
	type: ATTRIBUTE,
	// a loader's UTIs taken
	takes: "ermine.programs.takes",
	// a compiler's UTI given
	gives: "ermine.programs.gives",
	// names a node needs from what runs it
	needs: "ermine.programs.needs",
	// names a runner gives what it runs
	provides: "ermine.programs.provides",
	// an opener's UTIs opened
	opens: "ermine.programs.opens",
	// true: a folder holding loaders, its children candidates in its place
	loaders: "ermine.programs.loaders",
	// a path: the pin, tried first
	loader: "ermine.programs.loader",
} as const

// a node, and where it sits in the box
export type Place = { readonly id: Id; readonly at: Path }

// a step, and how it is itself run (none: the host runs it)
export type Step = Place & { readonly by: Chain }

// compilers in order, then a runner
export type Chain = readonly Step[]

// a program and one chain running it: what satisfy and openwith yield
export type Way = { readonly program: Place; readonly chain: Chain }

export type Reason =
	| "wrong-type"
	| "unknown-type"
	| "needs"
	| "no-chain"
	| "no-type"
	| "in-the-chain"

// a candidate not taken
export type Why = Place & {
	readonly for: Id
	readonly type: string
	readonly why: Reason
	readonly missing?: readonly string[]
}

// the search's own: nothing yielded. at: none for openwith's file
export type Refusal =
	| { readonly why: "nothing-there"; readonly path: string; readonly from: Path }
	| { readonly why: "no-type" | "no-chain"; readonly id: Id; readonly at?: Path }

// what onwhynot is told: a candidate's (with for), or the search's own (none)
export type Whynot = Why | Refusal

export type Options = { readonly onwhynot?: (why: Whynot) => void }

// what satisfy and openwith read through: a places (a box's), as lib's lookup takes it
export type Reads =
	& Pick<Places, "root" | "walk" | "readKeys" | "readValue">
	& Partial<Pick<Places, "contributors" | "names">>

// the path a path finds from a place, and the node there; nothing: undefined
// core candidate (places' lib.ts): lookup giving back the id it found with its path, so the found
// path is not walked again by get
function find(places: Reads, path: string, from: Path): Place | undefined {
	const steps = parse(path)
	const direct = steps[0] === "/" || steps[0] === "." || steps[0] === ".."
	let at: Path | undefined
	if (direct) at = resolve(["/", ...from, ...steps])
	else {
		const names = resolve(steps)
		at = names === undefined || names.length === 0 ? undefined : lookup(places, names, from)
	}
	const id = at === undefined ? undefined : get(places, at)
	return id === undefined || id === level ? undefined : { id, at: at! }
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []

// one search: what it reads, each read once, as far as it has gone, and what it tells
type Search = {
	readonly places: Reads
	readonly tell: ((why: Whynot) => void) | undefined
	readonly from: Path
	// the next level up to read, from.length down to 0; below 0: every one read
	next: number
	// the candidates read so far, nearest first, each node once; loaders: those saying takes, each
	// one's level (0: the nearest) in levels, and per level read, how many loaders there are then
	readonly list: Place[]
	readonly loaders: Place[]
	readonly levels: number[]
	readonly bounds: number[]
	readonly met: Set<Id>
	// the nearest ermine/types, looked up when first needed (null: not yet), and the extensions
	// its types claim, read when first needed
	types: Folder | undefined | null
	extensions: Extensions | undefined
	readonly noted: Set<string>
	readonly attrs: Map<Id, Map<string, unknown>>
	readonly takes: Map<Id, string[]>
	// per UTI, the loaders taking it (their places in loaders, rising)
	readonly takers: Map<string, number[]>
	// per node taken, a number of its own
	readonly serials: Map<Id, number>
	readonly conforms: Map<string, { known: boolean; all: string[] }>
	readonly runs: Map<string, Ran>
}

// a chain found, and its level
type Found = { readonly chain: Chain; readonly level: number }

// a node's own run, as far as looked for: found, its first chain; none, why there is none; else its
// search, paused before the first level past limit
type Ran = {
	found?: Found
	none?: "no-chain" | "no-type"
	readonly search?: Generator<Found | undefined, boolean>
	readonly limit: { k: number }
}

function searching(places: Reads, from: Path, tell: Search["tell"]): Search {
	return {
		places,
		tell,
		from,
		next: from.length,
		list: [],
		loaders: [],
		levels: [],
		bounds: [],
		met: new Set(),
		types: null,
		extensions: undefined,
		noted: new Set(),
		attrs: new Map(),
		takes: new Map(),
		takers: new Map(),
		serials: new Map(),
		conforms: new Map(),
		runs: new Map(),
	}
}

// an attribute of a node, read once a search
function attr(s: Search, id: Id, name: string): unknown {
	let of = s.attrs.get(id)
	if (of === undefined) s.attrs.set(id, of = new Map())
	if (!of.has(name)) of.set(name, s.places.readValue("attributes", id, [name]))
	return of.get(name)
}

// the UTIs a node takes, as strings, once a search
function takes(s: Search, id: Id): string[] {
	let t = s.takes.get(id)
	if (t === undefined) s.takes.set(id, t = strings(attr(s, id, ATTRIBUTES.takes)))
	return t
}

// a level's members as candidates, a loaders folder's children in its place
// core candidate (places' lib.ts): members along lookup's levels in one walk (each level here is
// walked again from "/")
function into(s: Search, at: Path) {
	const here = members(s.places, at).filter((m) => m.id !== level)
	here.sort((a, b) => keyOrder(a.name, b.name))
	for (const m of here) {
		if (s.met.has(m.id)) continue
		s.met.add(m.id)
		const path = [...at, m.name]
		if (attr(s, m.id, ATTRIBUTES.loaders) === true) into(s, path)
		else {
			const c = { id: m.id, at: path }
			s.list.push(c)
			const t = takes(s, m.id)
			if (t.length === 0) continue
			for (const u of t) {
				const of = s.takers.get(u)
				if (of === undefined) s.takers.set(u, [s.loaders.length])
				else if (of[of.length - 1] !== s.loaders.length) of.push(s.loaders.length)
			}
			s.loaders.push(c)
		}
	}
}

// the next level up read; none left: false
function more(s: Search): boolean {
	if (s.next < 0) return false
	into(s, s.from.slice(0, s.next--))
	const k = s.bounds.length
	while (s.levels.length < s.loaders.length) s.levels.push(k)
	s.bounds.push(s.loaders.length)
	return true
}

// the i-th of the candidates (s.list) or the loaders (s.loaders), levels read up to it; none:
// undefined
function nth(s: Search, of: readonly Place[], i: number): Place | undefined {
	while (i >= of.length) if (!more(s)) return undefined
	return of[i]
}

// the nearest ermine/types, looked up once a search
function folder(s: Search): Folder | undefined {
	if (s.types === null) s.types = typesAt(s.places, s.from)
	return s.types
}

// a node's type at the place the search met it: its attribute, else its name's (types' typeOf);
// the extensions read once a search, only for a node with no attribute
function typeOf(s: Search, at: Place): string | undefined {
	const t = attr(s, at.id, ATTRIBUTES.type)
	if (typeof t === "string") return t
	return typeAt(s.places, at, s.extensions ??= extensionsOf(s.places, folder(s)))
}

// a host runner's mark: its value a live function. read only for a node with no type
const hosted = (s: Search, id: Id) => typeof s.places.readValue("value", id) === "function"

// a type's conformance, once a search: it, then what it conforms to
function conforming(s: Search, uti: string): { known: boolean; all: string[] } {
	let c = s.conforms.get(uti)
	if (c === undefined) {
		s.conforms.set(uti, c = conformance(s.places, folder(s), uti))
	}
	return c
}

// whether a type fits a list of UTIs: one is it, or one it conforms to; no: why not
function fits(s: Search, uti: string, to: readonly string[]): true | "wrong-type" | "unknown-type" {
	if (to.includes(uti)) return true
	const c = conforming(s, uti)
	if (c.all.some((u) => to.includes(u))) return true
	return c.known ? "wrong-type" : "unknown-type"
}

// a candidate c not taken for x, told once; no onwhynot: nothing made. gives back undefined
function not(
	s: Search,
	c: Place,
	x: Id,
	type: string,
	why: Reason,
	missing?: string[],
): undefined {
	if (s.tell === undefined) return
	const key = JSON.stringify([String(c.id), c.at, String(x), type, why, missing])
	if (s.noted.has(key)) return
	s.noted.add(key)
	s.tell({ id: c.id, at: c.at, for: x, type, why, ...(missing && { missing }) })
}

// what runs one node x: above, x and the nodes it runs for; per type looked for, its candidates
type Run = {
	readonly x: Id
	readonly needs: readonly string[]
	readonly above: ReadonlySet<Id>
	readonly scans: Map<string, Scan>
}

// a candidate taken for a type: the type it gives (none: a runner), its own level, a number of its
// own; once its own run is found, its step and level (its own or its by's, the farther), or dead
// (none: told); the scan of what it gives once needed
type Taken = {
	readonly place: Place
	readonly gives: string | undefined
	readonly at: number
	readonly serial: number
	step?: Step
	level?: number
	dead?: boolean
	below?: Scan
}

// a type's candidates as far as looked at: those taken, in order; next, the next of the loaders to
// look at (-1: the pin, the program's first step only)
type Scan = {
	readonly uti: string
	readonly taken: Taken[]
	next: number
	readonly pin?: Place
}

const scanOf = (r: Run, uti: string): Scan => {
	let scan = r.scans.get(uti)
	if (scan === undefined) r.scans.set(uti, scan = { uti, taken: [], next: 0 })
	return scan
}

const running = (s: Search, x: Id, above: Iterable<Id>): Run => ({
	x,
	needs: strings(attr(s, x, ATTRIBUTES.needs)),
	above: new Set([...above, x]),
	scans: new Map(),
})

// a candidate at a level looked at for x and a type: it fits, is not above and meets the needs (a
// runner); else told why not, undefined. its own run is looked for when first stepped on (ready)
function look(s: Search, r: Run, c: Place, uti: string, at: number): Taken | undefined {
	const fit = fits(s, uti, takes(s, c.id))
	if (fit !== true) return not(s, c, r.x, uti, fit)
	if (r.above.has(c.id)) return not(s, c, r.x, uti, "in-the-chain")
	const gives = attr(s, c.id, ATTRIBUTES.gives)
	const compiler = typeof gives === "string"
	if (!compiler) {
		const provides = strings(attr(s, c.id, ATTRIBUTES.provides))
		const missing = r.needs.filter((n) => !provides.includes(n))
		if (missing.length) return not(s, c, r.x, uti, "needs", missing)
	}
	let serial = s.serials.get(c.id)
	if (serial === undefined) s.serials.set(c.id, serial = s.serials.size)
	return { place: c, gives: compiler ? gives : undefined, at, serial }
}

// whether a candidate taken for a type is a step at level k or nearer: its own run looked for up to
// level k (none at all: told, dead)
function ready(s: Search, r: Run, t: Taken, uti: string, k: number): boolean {
	if (t.step === undefined) {
		if (t.dead) return false
		const by = runOf(s, t.place, r.above, k)
		if (by === undefined) return false
		if (typeof by === "string") {
			t.dead = true
			not(s, t.place, r.x, uti, by)
			return false
		}
		t.step = { id: t.place.id, at: t.place.at, by: by.chain }
		t.level = Math.max(t.at, by.level)
	}
	return t.level! <= k
}

// with no onwhynot, the next of the loaders from q, below high, that may fit a scan's type, with
// the reads looking at each would make: one taking the type itself, at once; past one not taking
// it, its conformance known (as fits reads it), the loaders taking none of it passed over unlooked
function skip(s: Search, scan: Scan, q: number, high: number): number {
	if (q >= high || takes(s, s.loaders[q].id).includes(scan.uti)) return q
	let p = high
	for (const u of conforming(s, scan.uti).all) {
		const of = s.takers.get(u)
		if (of === undefined || of[of.length - 1] < q) continue
		let lo = 0, hi = of.length - 1
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (of[mid] < q) lo = mid + 1
			else hi = mid
		}
		if (of[lo] < p) p = of[lo]
	}
	return p
}

// the i-th taken of a scan, the loaders up to level k looked at up to it, that level read when
// first needed (the pin, first: none); none: undefined
function nthTaken(s: Search, r: Run, scan: Scan, i: number, k: number): Taken | undefined {
	while (i >= scan.taken.length) {
		let c: Place | undefined, at = 0
		if (scan.next < 0) c = scan.pin
		else {
			while (s.bounds.length <= k) more(s)
			const high = s.bounds[k]
			if (s.tell === undefined) scan.next = skip(s, scan, scan.next, high)
			if (scan.next >= high) return undefined
			c = s.loaders[scan.next]
			at = s.levels[scan.next]
			if (c.id === scan.pin?.id) c = undefined
		}
		scan.next++
		const t = c && look(s, r, c, scan.uti, at)
		if (t !== undefined) scan.taken.push(t)
	}
	return scan.taken[i]
}

// the chains running r.x, nearest, then shortest, from the scan of its type (the pin's, at the
// first step). per level k, nearest first: rounds L = 1, 2, …, depth first over the levels up to k,
// at most L steps, yielding the chains of L steps whose level is k. before a level past limit.k:
// undefined, paused until limit.k is raised. gives back whether it found any
function* chains(
	s: Search,
	r: Run,
	first: Scan,
	limit: { readonly k: number },
): Generator<Found | undefined, boolean> {
	let any = false
	// per depth: its scan, the next taken to try, whether a chain was found below it (of any length
	// up to the round's), whether a compiler was passed over at the round's last step, the farthest
	// level above it
	const scans: Scan[] = [], next: number[] = [], found: boolean[] = [], cut: boolean[] = []
	const far: number[] = []
	// the compilers so far, their steps, and by serial whether one is in the chain
	const taken: Taken[] = [], chain: Step[] = [], on: boolean[] = []
	const top = s.from.length
	for (let k = 0; k <= top; k++) {
		while (k > limit.k) yield undefined
		// no loaders added: no way of this level (the last walked for its whynots)
		if (k > 0) { while (s.bounds.length <= k) more(s) }
		if (k > 0 && s.bounds[k] === s.bounds[k - 1] && (k < top || s.tell === undefined)) continue
		for (let L = 1;; L++) {
			let d = 0
			scans[0] = first, next[0] = 0, found[0] = false, cut[0] = false, far[0] = 0
			for (;;) {
				const t = nthTaken(s, r, scans[d], next[d]++, k)
				if (t === undefined) {
					if (d === 0) break
					const up = taken.pop()!
					chain.pop()
					on[up.serial] = false
					d--
					found[d] ||= found[d + 1]
					// all below it walked, every level read, nothing found: told once
					if (cut[d + 1]) cut[d] = true
					else if (!found[d + 1] && k === top) not(s, up.place, r.x, scans[d].uti, "no-chain")
					continue
				}
				if (!ready(s, r, t, scans[d].uti, k)) continue
				if (on[t.serial]) {
					not(s, t.place, r.x, scans[d].uti, "in-the-chain")
					continue
				}
				const level = Math.max(far[d], t.level!)
				const last = d === L - 1
				if (t.gives === undefined) {
					found[d] = true
					if (last && level === k) {
						any = true
						yield { chain: [...chain, t.step!], level }
					}
				} else if (last) cut[d] = true
				else {
					taken.push(t)
					chain.push(t.step!)
					on[t.serial] = true
					d++
					scans[d] = t.below ??= scanOf(r, t.gives)
					next[d] = 0, found[d] = false, cut[d] = false, far[d] = level
				}
			}
			if (!cut[0]) break
		}
	}
	return any
}

// how a step c is itself run, the first chain in the same order, its level k or nearer looked
// for: found (the host runs one with no type and a live function: an empty chain); no-type (no type,
// no function); no-chain; none up to level k yet: undefined (its search paused, kept)
function runOf(
	s: Search,
	c: Place,
	above: ReadonlySet<Id>,
	k: number,
): Found | "no-chain" | "no-type" | undefined {
	const key = JSON.stringify([String(c.id), [...above].map(String)])
	let ran = s.runs.get(key)
	if (ran === undefined) {
		const uti = typeOf(s, c)
		const limit = { k }
		if (uti !== undefined) {
			const r = running(s, c.id, above)
			ran = { search: chains(s, r, scanOf(r, uti), limit), limit }
		} else if (hosted(s, c.id)) ran = { found: { chain: [], level: 0 }, limit }
		else ran = { none: "no-type", limit }
		s.runs.set(key, ran)
	}
	if (ran.found === undefined && ran.none === undefined) {
		if (ran.limit.k < k) ran.limit.k = k
		const next = ran.search!.next()
		if (next.done) ran.none = "no-chain"
		else ran.found = next.value
	}
	return ran.found ?? ran.none
}

// the ways to run a program p, its pin tried first: one, its chain empty, with no type and a live
// function (the host runs it). gives back what stopped it: nothing found, no type, or none
function* waysOf(s: Search, p: Place, pin?: Place): Generator<Way, "no-chain" | "no-type" | void> {
	const uti = typeOf(s, p)
	if (uti === undefined) {
		if (!hosted(s, p.id)) return "no-type"
		yield { program: p, chain: [] }
		return
	}
	const r = running(s, p.id, [])
	const first = pin === undefined ? scanOf(r, uti) : { uti, taken: [], next: -1, pin }
	let any = false
	for (const found of chains(s, r, first, { k: Infinity })) {
		any = true
		yield { program: p, chain: found!.chain }
	}
	if (!any) return "no-chain"
}

// the program named, looked up from the place from, and each way running it: nearest, then shortest.
// whynots to onwhynot; nothing yielded: its path or its pin's finding nothing, no type, no whole
// chain, each told
export function* satisfy(
	places: Reads,
	name: string,
	from: Path,
	options: Options = {},
): Generator<Way, void> {
	const tell = options.onwhynot
	const program = find(places, name, from)
	if (program === undefined) {
		tell?.({ why: "nothing-there", path: name, from })
		return
	}
	const folder = program.at.slice(0, -1)
	const s = searching(places, folder, tell)
	let pin: Place | undefined
	if (typeOf(s, program) !== undefined) {
		const pinned = attr(s, program.id, ATTRIBUTES.loader)
		if (pinned !== undefined) {
			pin = typeof pinned === "string" ? find(places, pinned, folder) : undefined
			if (pin === undefined) {
				tell?.({ why: "nothing-there", path: String(pinned), from: folder })
				return
			}
		}
	}
	const stopped = yield* waysOf(s, program, pin)
	if (stopped !== undefined) tell?.({ why: stopped, id: program.id, at: program.at })
}

// every way to open the file, looked for from the place from: each opener, nearest first, with each
// chain running it (nearest, then shortest). whynots to onwhynot; the file with no type: told, nothing yielded
export function* openwith(
	places: Reads,
	file: Id | Place,
	from: Path,
	options: Options = {},
): Generator<Way, void> {
	const s = searching(places, from, options.onwhynot)
	const at = typeof file === "object" ? file : { id: file, at: [] }
	const uti = typeOf(s, at)
	if (uti === undefined) {
		s.tell?.({ why: "no-type", id: at.id })
		return
	}
	for (let i = 0;; i++) {
		const o = nth(s, s.list, i)
		if (o === undefined) return
		const opens = strings(attr(s, o.id, ATTRIBUTES.opens))
		if (opens.length === 0) continue
		const fit = fits(s, uti, opens)
		if (fit !== true) {
			not(s, o, at.id, uti, fit)
			continue
		}
		const stopped = yield* waysOf(s, o)
		if (stopped !== undefined) not(s, o, at.id, uti, stopped)
	}
}
