// build: the cached compile step, generic. chee 10-15: "this is also where build a la carte comes
// in"; her lean: "each compile step a computer, cached by (step, input hash) at /cache/<hash>
// (build systems a la carte)". what finds the compiler for a program (C to wasm, say) is open: this
// is only the step, given a compiler node and an input
//
//   const builds = createBuilds({ scheduler, table, places, cache: CACHE })   // in a scope
//   createComputer(() => builds.compile(CLANG, places.readValue("value", CAT)), go)
//   // the output; PENDING; an Error (a BuildError: refused)
//
// a compiler: a node whose value is a live function from the host, never saved:
// (input, ctx) => Value | Promise<Value>. what it is: its attribute ermine.programs.compiler, a
// plain value ({ name: "clang", version: "19.1.0", target: "wasm32", flags: [...] }); none: its id
//
// the key: hex of hash([identity, input]) (@ermine/encoding's). so two compiler nodes saying one
// identity (a server's clang, a clang built as wasm) share every entry, and a cache folder shared
// between devices hits on one for what was built on another. the result: a node placed in the
// cache folder at <key>. a key there is never compiled again: for another input node, a compile
// after a stop, a fresh createBuilds over the same table. a name there whose node has no value
// yet: pending, not compiled (mine, open)
//
// a miss: a computer of its own, one per key, shared by every compile wanting it, calling the
// function. the function is read untracked, only on a miss: a host replacing one changes the
// identity (its version), so the key changes; a compiler with no identity keeps its key (mine,
// open). its node's value not a function: refused not-a-compiler. while the step is pending its
// status (filesystem/places' status.ts) is PENDING; failed, the Error. a value canonical CBOR can't
// encode (the input, the identity, the result) is refused uncacheable. errors and refusals are
// never cached: a failed step goes once no run reads it, so compiling that key again calls the
// function again (mine, open). one done goes as its result lands
//
// compile(compiler, input): a read, tracked in a run. its reads: the compiler's identity, the cache
// folder's name for the key and the value there, and the step's status while it is not cached. so
// a run reading it reruns when the identity changes or the step lands, and on nothing else (the
// input is the caller's own read)
//
// writes: the cache's (a value entry and a name in the cache folder) by the step's computer, with
// its scope open; status's. committed to the places given, and only to it: a host with boxes hands
// a places whose commit tells them too, as for status. setup has no paths: nothing here needs them
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import createEntry from "@ermine/node/entry"
import { asId, type Id, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createStatus, status } from "@ermine/places/status"
import { upsert } from "@ermine/places/upsert"
import { type Computer, type Ended, PENDING, type Scheduler } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Table } from "@ermine/table"

// the attribute: what a compiler is
export const COMPILER = "ermine.programs.compiler"

// what a compiler is handed beside its input: its key, its node, its identity (none: its id)
export type Context = { readonly key: string; readonly id: Id; readonly identity: unknown }

export type Compiler = (input: Value, ctx: Context) => Value | PromiseLike<Value> | typeof PENDING

// refused, never cached: the compiler's node holds no function (on a miss); a value with no
// encoding (the input, the identity, the result)
export class BuildError extends Error {
	constructor(
		readonly code: "not-a-compiler" | "uncacheable",
		readonly compiler: Id,
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
		| "onTrackingStart"
		| "onTrackingEnd"
	>
	table: Pick<Table, "get" | "add" | "del">
	// where compilers' identities and the cache folder are read, and every write here committed
	places: Pick<Places, "readValue" | "commit">
	// the cache folder: each result a node in it at its key
	cache: Id
}

export type Builds = {
	// the compiler's output for the input: cached, or PENDING, or an Error (the compiler's own, or a
	// BuildError). tracked in a run
	compile: (compiler: Id, input: unknown) => unknown
	// its steps torn down, its listeners gone
	stop: () => void
}

// one compile of a key: its computer (made once the run wanting it has ended), its status node,
// how its last run ended, whether a run reads it
type Task = {
	readonly key: string
	readonly node: Id
	readonly fn: Compiler
	readonly input: Value
	readonly ctx: Context
	c?: Computer
	ended?: Ended
	held: boolean
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// why canonical CBOR does not encode it; it does: undefined. another throw is thrown
function unencodable(v: unknown): string | undefined {
	try {
		encode(v as Value)
	} catch (e) {
		if (e instanceof CborError) return e.message
		throw e
	}
}

const failed = (e: Ended | undefined) => e === "failed" || e === "looping"

export function createBuilds(setup: Setup): Builds {
	const { scheduler: s, table, places, cache } = setup
	// the steps' owner, under the scope open
	const scope = s.createScope()
	const statuses = createStatus({ places, table, scheduler: s })
	// by key: the steps not done yet
	const tasks = new Map<string, Task>()
	const all = new WeakSet<object>()
	const of = new WeakMap<Computer, Task>()
	// steps wanted in a run, made as it ends
	const wanted: Task[] = []

	// the result kept: a value entry, named in the cache folder. one there already (another
	// createBuilds's): nothing
	function keep(key: string, out: unknown, compiler: Id) {
		const there = table.get("children", cache)?.value
		if (isMap(there) && Object.hasOwn(there, key)) return
		const id: Id = `cache:${crypto.randomUUID()}`
		table.add("value", id, createEntry(out, createChangeHeader(s)))
		// its type: what the compiler gives (ermine.programs.gives), if it says; not in the key
		const gives =
			(table.get("attributes", compiler)?.value as Record<string, unknown> | undefined)
				?.["ermine.programs.gives"]
		if (typeof gives === "string") {
			table.add("attributes", id, createEntry({ "ermine.type": gives }, createChangeHeader(s)))
		}
		places.commit(upsert(table, "children", cache, [key], id, createChangeHeader(s)))
	}

	// a step's computer, under the steps' scope. wanted in a run, made as the run ends, not in it:
	// made in a run, it would carry that run's cause, and its result landing would be a loop through
	// the run that reads it
	// core candidate (scheduler): a computer made for a run, not by it (its cause not carried)
	function start(t: Task) {
		if (scope.state !== "alive") return
		const c = s.runWithScope(scope, () =>
			s.createComputer(
				() => {
					const out = t.fn(t.input, t.ctx)
					return isPromise(out) ? out.then((v) => checked(t, v)) : checked(t, out)
				},
				(out) => keep(t.key, out, t.ctx.id),
			))
		t.c = c
		of.set(c, t)
		statuses.give(c, t.node)
	}

	// a result as it is kept: one with no encoding thrown, refused; PENDING passes
	function checked(t: Task, v: unknown): unknown {
		if (v === PENDING) return v
		const why = unencodable(v)
		if (why !== undefined) throw new BuildError("uncacheable", t.ctx.id, `the result: ${why}`)
		return v
	}

	// a step gone: its computer torn down, its status taken out
	function retire(t: Task) {
		if (tasks.get(t.key) === t) tasks.delete(t.key)
		if (t.c !== undefined && t.c.state === "alive") s.teardown(t.c)
		if (table.get("attributes", t.node) !== undefined) table.del("attributes", t.node)
	}

	const drain = () => {
		while (wanted.length) start(wanted.shift()!)
	}

	// a step done (its result landed) goes; failed, once no run reads it
	// core candidate (scheduler): a computer that goes as the last reader of its key stops, as
	// per-path computers do
	const offs = [
		s.onRunEnd((c, _n, ended) => {
			const t = of.get(c)
			if (t !== undefined) {
				t.ended = ended
				if (ended === "done" || (failed(ended) && !t.held)) retire(t)
			}
			drain()
		}),
		s.onEffect(drain),
		s.onTrackingStart((k) => {
			if (all.has(k as object)) (k as Task).held = true
		}),
		s.onTrackingEnd((k) => {
			if (!all.has(k as object)) return
			const t = k as Task
			t.held = false
			if (failed(t.ended)) retire(t)
		}),
	]

	function compile(compiler: Id, input: unknown): unknown {
		const identity = places.readValue("attributes", compiler, [COMPILER]) ?? compiler
		let key: string
		try {
			key = hex(hash([identity, input] as Value))
		} catch (e) {
			if (!(e instanceof CborError)) throw e
			const why = unencodable(input)
			return new BuildError(
				"uncacheable",
				compiler,
				why === undefined ? `its identity: ${e.message}` : `the input: ${why}`,
			)
		}
		const id = asId(places.readValue("children", cache, [key]))
		if (id !== undefined) {
			const v = places.readValue("value", id)
			return v === undefined ? PENDING : v
		}
		let t = tasks.get(key)
		if (t === undefined) {
			const fn = table.get("value", compiler)?.value
			if (typeof fn !== "function") return new BuildError("not-a-compiler", compiler)
			t = {
				key,
				node: `step:${crypto.randomUUID()}`,
				fn: fn as Compiler,
				input: input as Value,
				ctx: { key, id: compiler, identity },
				held: false,
			}
			tasks.set(key, t)
			all.add(t)
			// outside a run, at once
			if (s.getRun() === undefined) start(t)
			else wanted.push(t)
		}
		s.track(t)
		return status(places, t.node) ?? PENDING
	}

	function stop() {
		for (const off of offs) off()
		statuses.stop()
		wanted.length = 0
		for (const t of [...tasks.values()]) retire(t)
		if (scope.state === "alive") s.teardown(scope)
	}

	return { compile, stop }
}
