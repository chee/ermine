// compilers: steps cached with verifying traces (build systems à la carte), and compile, a step
//
//   const builds = createBuilds({ scheduler, table, places, cache: CACHE })   // in a scope
//   createComputer(() => builds.step(cell, source, () => run(source)), go)
//   createComputer(() => builds.compile(CLANG, places.readValue("value", CAT)), go)
//   // the output; PENDING; an Error (a BuildError: refused)
//   fold({ builds, table, loaded }, compilers, value)       // a chain's compilers over a value
//
// a step: a name (stable: a cell, a compiler's identity) and its code (any value). key: hex of
// hash([name, code]). its trace: the places reads its run makes
//
// the cache folder, one node per step at its key:
//   cache/<key>          the step: value the output kept last (typed: ermine.type, not in the key)
//   cache/<key>/<n>      an entry, n from 1: value the output; attribute ermine.programs.trace the
//                        reads in order, each [part, id, path, hash] (hash: hex, or null: nothing)
//
// lookup, in the reader's run, tracked: entries newest first, each trace read again in order up to
// the first differing hash; all match: a hit, run not called. none: a miss
// miss: run in one computer per key, shared by its readers; reads recorded through onTrack (before
// its first await only). a read places' describe can't name, or a value with no encoding: refused
// uncacheable. a trace kept already: nothing new. an output equal by bytes to one kept is given as
// that same value (early cutoff). while out, readers get its status: PENDING or the Error. errors
// are never kept
// never: run in the reader's run, nothing looked up or kept (the notebook's // nocache)
// compile(compiler, input): the step (the compiler's identity, input); reads nothing, so its one
// entry always hits. a compiler: a node whose value is a live host function (input, ctx) =>
// Value | Promise<Value>, never saved, read untracked on a miss only. its identity: attribute
// ermine.programs.compiler, else its id. not a function: refused not-a-compiler. outputs typed by
// its ermine.programs.gives, if set
// onStep(f): told what each lookup found, in the reader's run
// fold(folding, compilers, input): the input through a chain's compilers in turn: a host's (by
// empty) by compile; a loaded one's by step, named by identityOf, its compile and value as loaded
// gives them. PENDING while one is; an Error thrown. identityOf(table, id, value): a loaded
// compiler's identity: its ermine.programs.compiler, else { id, hash } of its value, else its id
// writes: the cache's (a step's computer, scope open) and status's, committed only to the places
// given (a host with boxes hands one whose commit tells them). a step's computer is made with
// { [NODE]: its status node } (step:<uuid>, never saved): each header's metadata stops there
// open: the cache layout; when a step goes (once done, or unread: @ermine/clingy); how many entries
// to keep. to do: closer to the notebook's reading of build systems à la carte
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/formats/hash"
import { createClingy } from "@ermine/clingy"
import createEntry from "@ermine/node/entry"
import { asId, at, type Id, type Places } from "@ermine/places"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { createStatus, status } from "@ermine/places/status"
import { upsert } from "@ermine/places/upsert"
import { type Computer, type Ended, PENDING, type Scheduler } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Key, Table } from "@ermine/table"

// the attribute: what a compiler is
export const COMPILER = "ermine.programs.compiler"
// the attribute: an entry's reads
export const TRACE = "ermine.programs.trace"

// a read in a trace: where (as places reads it) and the hash of what was there (nothing: null)
export type Read = [part: Key, id: Id, path: (string | number)[], hash: string | null]

// what a compiler is handed beside its input: its key, its node, its identity (none: its id)
export type Context = { readonly key: string; readonly id: Id; readonly identity: unknown }

export type Compiler = (input: Value, ctx: Context) => Value | PromiseLike<Value> | typeof PENDING

// what a lookup found: a hit (entry: its name), a miss (the step is out, or failed), never.
// checked: the entries checked; entries: how many the step keeps
export type Found = {
	readonly name: unknown
	readonly key?: string
	readonly found: "hit" | "miss" | "never"
	readonly entry?: string
	readonly checked: number
	readonly entries: number
}

// refused, never kept: the compiler's node holds no function (on a miss); a value with no encoding
// (the name or code, a read, the output), a read builds can't name. step: the compiler's id, or
// the step's name
export class BuildError extends Error {
	constructor(
		readonly code: "not-a-compiler" | "uncacheable",
		readonly step: unknown,
		why?: string,
	) {
		super(why === undefined ? code : `${code} (${why})`)
		this.name = "BuildError"
	}
}

export type Setup = {
	scheduler: Pick<
		Scheduler,
		| "createScope"
		| "createComputer"
		| "runWithScope"
		| "teardown"
		| "track"
		| "mark"
		| "getRun"
		| "getCurrentScope"
		| "onRunEnd"
		| "onEffect"
		| "onTrack"
		| "onTrackingStart"
		| "onTrackingEnd"
	>
	table: Pick<Table, "get" | "add" | "del">
	// where lookups read, and every write here committed. no describe: a step whose run reads
	// anything is refused uncacheable (compile's reads nothing)
	places: Pick<Places, "readValue" | "commit"> & Partial<Pick<Places, "describe">>
	// the cache folder: each step a node in it at its key
	cache: Id
}

export type Builds = {
	// run's output for (name, code): a hit, or PENDING while it runs, or an Error (run's own, or a
	// BuildError). tracked in a run. never: run's result as it is, nothing kept. type: its outputs'
	step: (
		name: unknown,
		code: unknown,
		run: () => unknown,
		options?: { never?: boolean; type?: string },
	) => unknown
	// the compiler's output for the input: the step (its identity, the input)
	compile: (compiler: Id, input: unknown) => unknown
	onStep: (f: (found: Found) => void) => () => void
	// its steps torn down, its listeners gone
	stop: () => void
}

// one step out: its computer (made once the run wanting it has ended), its status node, how its
// last run ended, the reads of its run now
type Task = {
	readonly key: string
	readonly node: Id
	readonly name: unknown
	readonly run: (key: string) => unknown
	// its outputs' ermine.type
	readonly type?: string
	c?: Computer
	ended?: Ended
	keys: unknown[]
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "symbol"

// why canonical CBOR does not encode it; it does: undefined. another throw is thrown
function unencodable(v: unknown): string | undefined {
	try {
		encode(v as Value)
	} catch (e) {
		if (e instanceof CborError) return e.message
		throw e
	}
}

// a read's hash: hex of what was there; nothing: null. no encoding: CborError thrown
const hashOf = (v: unknown): string | null => v === undefined ? null : hex(hash(v as Value))

// a read's hash, or undefined when it has no encoding: matching nothing
function hashed(v: unknown): string | null | undefined {
	try {
		return hashOf(v)
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}

// an entry's name, as a number: newest first, names that are none last
const number = (name: string) => /^[1-9][0-9]*$/.test(name) ? Number(name) : 0

const failed = (e: Ended | undefined) => e === "failed" || e === "looping"

export function createBuilds(setup: Setup): Builds {
	const { scheduler: s, table, places, cache } = setup
	// the steps' owner, under the scope open
	const scope = s.createScope({ builds: "steps" })
	const of = new WeakMap<Computer, Task>()
	const statuses = createStatus({ places, table, scheduler: s })
	// by key: the steps out
	const tasks = new Map<string, Task>()
	// every step out: whether a run reads it; the last reader gone, it goes
	const clingy = createClingy<Task>(s, (t) => retire(t))
	// steps wanted in a run, made as it ends
	const wanted: Task[] = []
	// the step whose run is running now: its reads recorded
	let recording: Task | undefined
	const told: ((found: Found) => void)[] = []
	// an output's hash, once per object
	const hashes = new WeakMap<object, string>()

	const header = () => createChangeHeader(s)
	const tell = (found: Found) => {
		for (const f of told) f(found)
	}

	function outHash(v: unknown): string | undefined {
		if (typeof v !== "object" || v === null) return
		let h = hashes.get(v)
		if (h === undefined) {
			const got = hashed(v)
			if (typeof got !== "string") return
			hashes.set(v, h = got)
		}
		return h
	}

	// a step's entries, untracked: [name, id] with a trace, newest first
	function entriesOf(folder: Id | undefined): [string, Id][] {
		const kids = folder === undefined ? undefined : table.get("children", folder)?.value
		if (!isMap(kids)) return []
		return Object.entries(kids)
			.filter((e): e is [string, Id] => isId(e[1]))
			.sort((a, b) => number(b[0]) - number(a[0]))
	}
	const traceOf = (id: Id) =>
		(table.get("attributes", id)?.value as Record<string, unknown>)?.[TRACE]

	// the run's reads, named and hashed now: nothing it read has changed since, or it would be due
	// again and not land
	function traced(t: Task): Read[] {
		const out: Read[] = []
		const seen = new Set<unknown>()
		for (const k of t.keys) {
			if (seen.has(k)) continue
			seen.add(k)
			const w = places.describe?.(k)
			if (w === undefined || w.path === null) {
				throw new BuildError("uncacheable", t.name, "a read builds can't name")
			}
			const v = at(table.get(w.part, w.id)?.value, w.path)
			let h: string | null
			try {
				h = hashOf(v)
			} catch (e) {
				if (!(e instanceof CborError)) throw e
				throw new BuildError("uncacheable", t.name, `a read: ${e.message}`)
			}
			out.push([w.part, w.id, [...w.path], h])
		}
		const why = unencodable(out)
		if (why !== undefined) throw new BuildError("uncacheable", t.name, `its reads: ${why}`)
		return out
	}

	// a new entry: the output and the run's trace. the step's node made, named in the cache folder,
	// the first time; its value the output kept last
	function keep(t: Task, out: unknown) {
		const reads = traced(t)
		const there = table.get("children", cache)?.value
		let folder = isMap(there) ? asId(there[t.key]) : undefined
		const entries = entriesOf(folder)
		const shown = JSON.stringify(reads)
		if (entries.some(([, id]) => JSON.stringify(traceOf(id)) === shown)) return
		const h = outHash(out)
		const same = h === undefined
			? undefined
			: entries.map(([, id]) => table.get("value", id)?.value).find((v) => outHash(v) === h)
		const value = same ?? out
		const typed = t.type === undefined ? {} : { "ermine.type": t.type }
		const id: Id = `cache:${crypto.randomUUID()}`
		table.add("value", id, createEntry(value, header()))
		table.add("attributes", id, createEntry({ [TRACE]: reads, ...typed }, header()))
		const name = String(entries.reduce((n, [k]) => Math.max(n, number(k)), 0) + 1)
		if (folder === undefined) {
			folder = `cache:${crypto.randomUUID()}`
			table.add("value", folder, createEntry(value, header()))
			if (t.type !== undefined) table.add("attributes", folder, createEntry(typed, header()))
			table.add("children", folder, createEntry({ [name]: id }, header()))
			places.commit(upsert(table, "children", cache, [t.key], folder, header()))
			return
		}
		places.commit([
			...upsert(table, "children", folder, [name], id, header()),
			...upsert(table, "value", folder, [], value, header()),
		])
	}

	// an output as it is kept: one with no encoding thrown, refused; PENDING passes
	function checked(t: Task, v: unknown): unknown {
		if (v === PENDING) return v
		const why = unencodable(v)
		if (why !== undefined) throw new BuildError("uncacheable", t.name, `the output: ${why}`)
		return v
	}

	// a step's computer, under the steps' scope. wanted in a run, made as the run ends, not in it:
	// made in a run, it would carry that run's cause, and its output landing would be a loop
	// through the run that reads it
	// core candidate (scheduler): a computer made for a run, not by it (its cause not carried)
	function start(t: Task) {
		if (scope.state !== "alive") return
		const c = s.runWithScope(scope, () =>
			s.createComputer(
				() => {
					t.keys = []
					const was = recording
					recording = t
					let out: unknown
					try {
						out = t.run(t.key)
					} finally {
						recording = was
					}
					return isPromise(out) ? out.then((v) => checked(t, v)) : checked(t, out)
				},
				(out) => keep(t, out),
				undefined,
				undefined,
				{ [NODE]: t.node },
			))
		t.c = c
		of.set(c, t)
		statuses.give(c, t.node)
	}

	// a step gone: its computer torn down, its status taken out
	function retire(t: Task) {
		clingy.drop(t)
		if (tasks.get(t.key) === t) tasks.delete(t.key)
		if (t.c !== undefined && t.c.state === "alive") s.teardown(t.c)
		if (table.get("attributes", t.node) !== undefined) table.del("attributes", t.node)
	}

	const drain = () => {
		while (wanted.length) start(wanted.shift()!)
	}

	// a step done goes (its entry kept); failed, once no run reads it; out, once no run reads it
	// (clingy's go, above)
	const offs = [
		s.onTrack((key, run) => {
			if (recording !== undefined && run.computer === recording.c) recording.keys.push(key)
		}),
		s.onRunEnd((c, _n, ended) => {
			const t = of.get(c)
			if (t !== undefined) {
				t.ended = ended
				if (ended === "done" || (failed(ended) && !clingy.tracked(t))) retire(t)
			}
			drain()
		}),
		s.onEffect(drain),
	]

	// in the reader's run: the first entry whose reads all hash the same now, read again in order
	function lookup(name: unknown, key: string): Found & { value?: unknown } {
		const folder = asId(places.readValue("children", cache, [key]))
		if (folder === undefined) return { name, key, found: "miss", checked: 0, entries: 0 }
		const read = places.readValue("children", folder)
		const kids = isMap(read) ? read : {}
		const names = Object.keys(kids).filter((n) => isId(kids[n]))
			.sort((a, b) => number(b) - number(a))
		const entries: [string, Id, Read[]][] = []
		for (const n of names) {
			const id = kids[n] as Id
			const reads = places.readValue("attributes", id, [TRACE])
			if (Array.isArray(reads)) entries.push([n, id, reads as Read[]])
		}
		let checked = 0
		for (const [entry, id, reads] of entries) {
			checked++
			const hit = reads.every((r) =>
				Array.isArray(r) && Array.isArray(r[2]) &&
				hashed(places.readValue(r[0], r[1], r[2])) === r[3]
			)
			if (hit) {
				const value = places.readValue("value", id)
				return { name, key, found: "hit", entry, checked, entries: entries.length, value }
			}
		}
		return { name, key, found: "miss", checked, entries: entries.length }
	}

	function ask(
		name: unknown,
		code: unknown,
		run: (key: string) => unknown,
		type?: () => string | undefined,
	): unknown {
		let key: string
		try {
			key = hex(hash([name, code] as Value))
		} catch (e) {
			if (!(e instanceof CborError)) throw e
			const why = unencodable(code)
			return new BuildError(
				"uncacheable",
				name,
				why === undefined ? `the name: ${e.message}` : `the code: ${why}`,
			)
		}
		const { value, ...found } = lookup(name, key)
		tell(found)
		if (found.found === "hit") return value
		let t = tasks.get(key)
		if (t === undefined) {
			t = {
				key,
				node: `step:${crypto.randomUUID()}`,
				name,
				run,
				type: type?.(),
				keys: [],
			}
			tasks.set(key, t)
			clingy.add(t)
			// outside a run, at once
			if (s.getRun() === undefined) start(t)
			else wanted.push(t)
		}
		s.track(t)
		return status(places, t.node) ?? PENDING
	}

	function step(
		name: unknown,
		code: unknown,
		run: () => unknown,
		options: { never?: boolean; type?: string } = {},
	): unknown {
		if (options.never) {
			tell({ name, found: "never", checked: 0, entries: 0 })
			return run()
		}
		return ask(name, code, () => run(), () => options.type)
	}

	function compile(compiler: Id, input: unknown): unknown {
		const identity = places.readValue("attributes", compiler, [COMPILER]) ?? compiler
		return ask(identity, input, (key) => {
			const fn = table.get("value", compiler)?.value
			if (typeof fn !== "function") throw new BuildError("not-a-compiler", compiler)
			return (fn as Compiler)(input as Value, { key, id: compiler, identity })
		}, () => {
			// its type: what the compiler gives (ermine.programs.gives), if it says; not in the key
			const gives = (table.get("attributes", compiler)?.value as Record<string, unknown>)
				?.["ermine.programs.gives"]
			return typeof gives === "string" ? gives : undefined
		})
	}

	function stop() {
		for (const off of offs) off()
		clingy.stop()
		statuses.stop()
		told.length = 0
		wanted.length = 0
		for (const t of [...tasks.values()]) retire(t)
		if (scope.state === "alive") s.teardown(scope)
	}

	const onStep = (f: (found: Found) => void) => {
		told.push(f)
		return () => void told.splice(told.indexOf(f), 1)
	}

	return { step, compile, onStep, stop }
}

// a compiler of a chain, as fold reads it: its node, and what loads it (empty: a host's, its node's
// value a live function)
export type Link = { readonly id: Id; readonly by: readonly unknown[] }

// a loaded compiler, as fold uses it: its compile, and its value (what its identity hashes)
export type Live = { readonly compile: (input: unknown) => unknown; readonly value: unknown }

export type Folding<L extends Link = Link> = {
	// a loaded compiler's steps go through step (none: such a fold throws)
	builds: Pick<Builds, "compile"> & Partial<Pick<Builds, "step">>
	// where a loaded compiler's attributes are read, untracked
	table: Pick<Table, "get">
	// a loaded compiler, live: PENDING while it loads; its failure thrown
	loaded: (c: L) => Live | typeof PENDING
}

// a loaded compiler's identity, the name its steps are cached under: its ermine.programs.compiler;
// none, { id, hash } of its value; no value, or one with no encoding, its id
export function identityOf(table: Pick<Table, "get">, id: Id, value: unknown): unknown {
	const attrs = table.get("attributes", id)?.value
	const named = isMap(attrs) ? attrs[COMPILER] : undefined
	if (named !== undefined) return named
	const h = value === undefined ? undefined : hashed(value)
	return typeof h === "string" ? { id, hash: h } : id
}

// the input through the compilers in turn: a host's by builds.compile, a loaded one's by builds.step
// under its identity; PENDING while one is; an Error thrown
export function fold<L extends Link>(
	folding: Folding<L>,
	compilers: readonly L[],
	input: unknown,
): unknown {
	const { builds, table, loaded } = folding
	let v = input
	for (const c of compilers) {
		if (c.by.length === 0) v = builds.compile(c.id, v)
		else {
			const live = loaded(c)
			if (live === PENDING) return PENDING
			if (builds.step === undefined) {
				throw new Error(`a loaded compiler (${String(c.id)}) needs builds.step`)
			}
			const identity = identityOf(table, c.id, live.value)
			const given = v
			v = builds.step(identity, given, () => live.compile(given))
		}
		if (v === PENDING) return PENDING
		if (v instanceof Error) throw v
	}
	return v
}
