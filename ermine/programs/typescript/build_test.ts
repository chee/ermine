// build's compile on a real scheduler, table, paths and places (root R): catclock.c (CAT, "hi"),
// compilers as nodes holding live functions, the cache folder R/cache (CACHE)
import { assertEquals, assertInstanceOf, assertStrictEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { createScheduler, PENDING } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { upsert } from "@ermine/places/upsert"
import type { Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import {
	BuildError,
	type Builds,
	COMPILER,
	type Compiler,
	type Context,
	createBuilds,
} from "./build.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const CLANG = { name: "clang", version: "19.1.0", target: "wasm32", flags: ["-O2"] }

function world() {
	const s = createScheduler()
	// every id an attributes entry came or went at
	const seen = new Set<Id>()
	const table = createTable((part, id) => {
		if (part === "attributes") seen.add(id)
		places.onTableChange(part as Key, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const host = s.createRootScope([["actor", "host"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header()) as never))
	const value = (id: Id, v: unknown) => put("value", id, v)
	const attrs = (id: Id, v: Record<string, unknown>) => put("attributes", id, v)
	const patch = (id: Id, path: string[], v: unknown) =>
		hosted(() => places.commit(upsert(table, "attributes", id, path, v, header())))
	const builds = () => hosted(() => createBuilds({ scheduler: s, table, places, cache: "CACHE" }))
	// a computer, in a scope of its own: each run, f's result kept
	function watch(f: () => unknown) {
		const w = { runs: 0, last: undefined as unknown, o: s.createScope([], host) }
		s.runWithScope(
			w.o,
			() => s.createComputer(() => (w.runs++, { v: f() }), ({ v }) => void (w.last = v)),
		)
		return w
	}
	// the cache folder: each key and its node's value
	function cached(): Record<string, unknown> {
		const v = table.get("children", "CACHE")?.value as Record<string, Id> | undefined
		return Object.fromEntries(
			Object.entries(v ?? {}).map(([k, id]) => [k, table.get("value", id)?.value]),
		)
	}
	// the status on each node with an id so prefixed and an attributes entry
	const statuses = (prefix: string) =>
		[...seen].filter((id) =>
			typeof id === "string" && id.startsWith(prefix) &&
			table.get("attributes", id) !== undefined
		).map((id) => (table.get("attributes", id)!.value as Record<string, unknown>)[STATUS])
	put("children", "R", { cache: "CACHE", "catclock.c": "CAT" })
	value("CAT", "hi")
	return { s, table, places, hosted, value, attrs, patch, builds, watch, cached, statuses }
}

// a compiler counting its calls, and what it was handed
function counted(f: Compiler) {
	const c = Object.assign((input: Value, ctx: Context) => {
		c.calls++
		c.handed.push([input, ctx])
		return f(input, ctx)
	}, { calls: 0, handed: [] as [Value, Context][] })
	return c
}
const upper = () => counted((i) => (i as string).toUpperCase())
const wrap = () => counted((i) => ({ wasm: i }))
const settled = () => new Promise((r) => setTimeout(r, 0))

// a compiler resolving when told
function later() {
	const waiting: { resolve: (v: Value) => void; reject: (e: unknown) => void; input: Value }[] = []
	const f = counted((input) =>
		new Promise<Value>((resolve, reject) => waiting.push({ resolve, reject, input }))
	)
	return { f, waiting }
}

// the program's value through each compiler in turn
const through = (w: ReturnType<typeof world>, b: Builds, ids: Id[]) => () => {
	let v = w.places.readValue("value", "CAT")
	for (const id of ids) {
		v = b.compile(id, v)
		if (v === PENDING || v instanceof Error) break
	}
	return v
}

Deno.test("a compile: the output, a node in the cache folder at hex(hash([identity, input])); the compiler handed its key, id and identity", () => {
	const w = world()
	const up = upper(), named = upper()
	w.value("UP", up)
	w.value("U1", named)
	w.attrs("U1", { [COMPILER]: { name: "upper", version: "1" } })
	const b = w.builds()
	const one = w.watch(() => b.compile("UP", "hi"))
	const two = w.watch(() => b.compile("U1", "hi"))
	w.s.pulse()
	assertEquals([one.last, two.last], ["HI", "HI"])
	const byId = hex(hash(["UP", "hi"]))
	const byName = hex(hash([{ name: "upper", version: "1" }, "hi"]))
	assertEquals(w.cached(), { [byId]: "HI", [byName]: "HI" })
	assertEquals(up.handed, [["hi", { key: byId, id: "UP", identity: "UP" }]])
	assertEquals(named.handed, [["hi", {
		key: byName,
		id: "U1",
		identity: { name: "upper", version: "1" },
	}]])
})

Deno.test("two compiler nodes saying one identity share entries; another version, or none (each its id), compile apart", () => {
	const w = world()
	const server = upper(), wasm = upper(), next = upper()
	w.value("CLANG", server)
	w.value("WCLANG", wasm)
	w.value("NEW", next)
	w.attrs("CLANG", { [COMPILER]: CLANG })
	w.attrs("WCLANG", { [COMPILER]: CLANG })
	w.attrs("NEW", { [COMPILER]: { ...CLANG, version: "20.1.0" } })
	const b = w.builds()
	const a = w.watch(() => b.compile("CLANG", "int main"))
	w.s.pulse()
	const c = w.watch(() => b.compile("WCLANG", "int main"))
	const d = w.watch(() => b.compile("NEW", "int main"))
	w.s.pulse()
	assertEquals([a.last, c.last, d.last], ["INT MAIN", "INT MAIN", "INT MAIN"])
	assertEquals([server.calls, wasm.calls, next.calls], [1, 0, 1])
	// no identity: by id
	w.value("UP", upper())
	w.value("UP2", upper())
	w.watch(() => b.compile("UP", "int main"))
	w.watch(() => b.compile("UP2", "int main"))
	w.s.pulse()
	assertEquals(Object.keys(w.cached()).length, 4)
})

Deno.test("tracked: a run reruns as the step lands or the identity changes; not on other attributes, the function, other cache names", () => {
	const w = world()
	const up = upper()
	w.value("UP", up)
	w.attrs("UP", { [COMPILER]: { name: "upper", version: 1 } })
	const b = w.builds()
	const r = w.watch(() => b.compile("UP", "hi"))
	w.s.pulse()
	assertEquals([r.runs, r.last], [2, "HI"])
	w.patch("UP", ["ermine.programs.loader"], "loaders/wasm")
	w.value("UP", up)
	w.watch(() => b.compile("UP", "ho"))
	w.s.pulse()
	assertEquals(r.runs, 2)
	w.patch("UP", [COMPILER, "version"], 2)
	w.s.pulse()
	assertEquals([r.runs, r.last, up.calls], [4, "HI", 4])
})

Deno.test("in turn: an edit compiles only the steps after the change; an output the same is a hit for the next", () => {
	const w = world()
	const up = upper(), wr = wrap()
	w.value("UP", up)
	w.value("WR", wr)
	const b = w.builds()
	const r = w.watch(through(w, b, ["UP", "WR"]))
	w.s.pulse()
	assertEquals(r.last, { wasm: "HI" })
	w.value("CAT", "HI")
	w.s.pulse()
	assertEquals([up.calls, wr.calls], [2, 1])
	w.value("CAT", "ho")
	w.s.pulse()
	assertEquals(r.last, { wasm: "HO" })
	assertEquals([up.calls, wr.calls], [3, 2])
})

Deno.test("async: pending while the step is, its value as it lands; rejected, the compiler's own Error, never cached", async () => {
	const w = world()
	const { f, waiting } = later()
	w.value("SL", f)
	const b = w.builds()
	const r = w.watch(through(w, b, ["SL"]))
	w.s.pulse()
	assertStrictEquals(r.last, PENDING)
	assertEquals(w.cached(), {})
	waiting.shift()!.resolve("HI")
	await settled()
	w.s.pulse()
	assertEquals(r.last as unknown, "HI")
	w.value("CAT", "ho")
	w.s.pulse()
	assertStrictEquals(r.last, PENDING)
	const offline = new Error("offline")
	waiting.shift()!.reject(offline)
	await settled()
	w.s.pulse()
	assertStrictEquals(r.last, offline)
	assertEquals(Object.values(w.cached()), ["HI"])
})

Deno.test("a pending step's status is on a node of its own, gone with the step as it lands", async () => {
	const w = world()
	const { f, waiting } = later()
	w.value("SL", f)
	const b = w.builds()
	w.watch(() => b.compile("SL", "hi"))
	w.s.pulse()
	assertEquals(w.statuses("step:"), [PENDING])
	waiting.shift()!.resolve("HI")
	await settled()
	w.s.pulse()
	assertEquals(w.statuses("step:"), [])
})

Deno.test("one step per key: two runs before a pulse compile once; a run after a stop, and a fresh createBuilds, find the cache", () => {
	const w = world()
	const up = upper()
	w.value("UP", up)
	const b = w.builds()
	const one = w.watch(through(w, b, ["UP"])), two = w.watch(through(w, b, ["UP"]))
	w.s.pulse()
	assertEquals([one.last, two.last, up.calls], ["HI", "HI", 1])
	w.s.teardown(one.o)
	const three = w.watch(through(w, b, ["UP"]))
	w.s.pulse()
	assertEquals([three.last, up.calls], ["HI", 1])
	w.s.teardown(two.o)
	w.s.teardown(three.o)
	b.stop()
	// fresh, the function gone (never saved): cached, so nothing misses
	w.value("UP", "gone")
	const fresh = w.builds()
	const four = w.watch(through(w, fresh, ["UP"]))
	w.s.pulse()
	assertEquals([four.last, up.calls], ["HI", 1])
	// a miss: refused, the node holding no function
	w.value("CAT", "ho")
	w.s.pulse()
	assertInstanceOf(four.last, BuildError)
	assertEquals((four.last as BuildError).code, "not-a-compiler")
})

Deno.test("uncacheable: the result, the input, the identity; refused, nothing cached", () => {
	const w = world()
	const live = counted(() => (() => {}) as never)
	w.value("LV", live)
	w.value("UP", upper())
	w.attrs("ODD", { [COMPILER]: { name: "odd", hook: () => {} } })
	w.value("ODD", upper())
	const b = w.builds()
	const result = w.watch(() => b.compile("LV", "hi"))
	const input = w.watch(() => b.compile("UP", () => {}))
	const identity = w.watch(() => b.compile("ODD", "hi"))
	w.s.pulse()
	for (const r of [result, input, identity]) {
		assertInstanceOf(r.last, BuildError)
		assertEquals((r.last as BuildError).code, "uncacheable")
	}
	assertEquals(live.calls, 1)
	assertEquals(w.cached(), {})
})

Deno.test("errors are never cached: one Error for every run reading the step; once none does, called again", () => {
	const w = world()
	const boom = counted(() => {
		throw new Error("boom")
	})
	w.value("BM", boom)
	const b = w.builds()
	const one = w.watch(() => b.compile("BM", "hi"))
	w.s.pulse()
	assertInstanceOf(one.last, Error)
	const two = w.watch(() => b.compile("BM", "hi"))
	w.s.pulse()
	assertStrictEquals(two.last, one.last)
	assertEquals(boom.calls, 1)
	w.s.teardown(one.o)
	w.s.teardown(two.o)
	const three = w.watch(() => b.compile("BM", "hi"))
	w.s.pulse()
	assertInstanceOf(three.last, Error)
	assertEquals(boom.calls, 2)
	assertEquals(w.cached(), {})
})

Deno.test("outside a run: the step starts at once, the read untracked", () => {
	const w = world()
	const up = upper()
	w.value("UP", up)
	const b = w.builds()
	assertStrictEquals(w.hosted(() => b.compile("UP", "hi")), PENDING)
	w.s.pulse()
	assertEquals([b.compile("UP", "hi"), up.calls], ["HI", 1])
})

Deno.test("stop: its steps torn down, a pending one's result landing nowhere", async () => {
	const w = world()
	const { f, waiting } = later()
	w.value("SL", f)
	const b = w.builds()
	const r = w.watch(() => b.compile("SL", "hi"))
	w.s.pulse()
	w.s.teardown(r.o)
	b.stop()
	assertEquals(w.statuses("step:"), [])
	waiting.shift()!.resolve("HI")
	await settled()
	w.s.pulse()
	assertEquals(w.cached(), {})
})
