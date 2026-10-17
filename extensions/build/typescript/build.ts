// build: steps cached with verifying traces (build systems à la carte), and compile, a step. chee
// 10-15: "this is also where build a la carte comes in"; "we probably need to change our
// createBuilds to be more like the notebook's interpretation of build-a-la-carte"
//
//   const builds = createBuilds({ scheduler, table, places, cache: CACHE })   // in a scope
//   createComputer(() => builds.step(cell, source, () => run(source)), go)
//   createComputer(() => builds.compile(CLANG, places.readValue("value", CAT)), go)
//   // the output; PENDING; an Error (a BuildError: refused)
//
// a step: a name (stable: a cell, a compiler's identity) and its code (any value: its source, its
// options). its key: hex of hash([name, code]) (@ermine/encoding's). a step learns what it depends
// on only by running: run's reads, as places reads them, are its trace
//
// the cache folder, one node per step at its key (mine, open):
//   cache/<key>          the step: its value the output kept last (its type: ermine.type)
//   cache/<key>/<n>      an entry, n counting up from 1: its value the output; its attribute
//                        ermine.programs.trace the reads run made, in order, each
//                        [part, id, path, hash] (hash: hex of what was there; nothing: null)
//
// a lookup, in the reader's run: the entries newest first, each checked by reading its trace again
// in order, stopping at the first read whose hash differs (a later read may hang on an earlier
// one). the first to match all through: a hit, its output given, run not called. every check read
// is the reader's, tracked: a change there reruns it. none: a miss
//
// a miss: run in a computer of its own, one per key, shared by every reader wanting it. its reads
// are recorded through the scheduler's onTrack, as the run makes them (only before its first
// await, as the scheduler tracks), each named by places' describe and hashed as the output is
// kept. a read builds can't name (none but places' value reads), or a value with no encoding (the
// output, a read, the name or code): refused uncacheable. its output and trace kept as a new entry
// (the same trace kept already: nothing new); an output equal by bytes to one this step keeps is
// kept as that same value, so a reader comparing by identity stops there (early cutoff). while out,
// the reader gets its status (status.ts): PENDING, or the Error. errors are never kept: a failed
// step goes once no run reads it. a step goes once done, or once no run reads it (mine, open;
// whether a run reads it: @ermine/clingy)
//
// never: run called in the reader's run, its result as it is, nothing looked up or kept (the
// notebook's // nocache). type: its outputs' ermine.type, not in the key. every entry is kept: how many to keep is open
//
// compile(compiler, input): the step (the compiler's identity, its input). its run reads nothing,
// so its one entry always hits. a compiler: a node whose value is a live function from the host,
// never saved: (input, ctx) => Value | Promise<Value>. what it is: its attribute
// ermine.programs.compiler, a plain value; none: its id. so two compiler nodes saying one identity
// share every entry. the function is read untracked, only on a miss: a host replacing one changes
// the identity (its version). its node's value not a function: refused not-a-compiler. an output
// is typed with the compiler's ermine.programs.gives, if it says
//
// onStep(f): told what each lookup found, in the reader's run (a host saying hits and misses)
//
// writes: the cache's, by a step's computer with its scope open; status's. committed to the places
// given, and only to it: a host with boxes hands a places whose commit tells them too
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import { createClingy } from "@ermine/clingy"
import createEntry from "@ermine/node/entry"
import { asId, at, type Id, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
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
		| "getInfo"
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
	const scope = s.createScope([["builds", "steps"]])
	const statuses = createStatus({ places, table, scheduler: s })
	// by key: the steps out
	const tasks = new Map<string, Task>()
	// every step out: whether a run reads it; the last reader gone, it goes
	const clingy = createClingy<Task>(s, (t) => retire(t))
	const of = new WeakMap<Computer, Task>()
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
	// (clingy's go, above; chee 10-16, not in core: "take it out of core, make it a library that
	// can be used in the two places it was duplicated")
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
