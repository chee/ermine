// the path cache (cache.ts) on a real scheduler, table and places, children alone. the cache with a
// second contributor (processes) is tested in ermine/processes. numbers are printed with -- -v
import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import { type Computer, createScheduler, type Ended } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { type Contributor, createPlaces, place, rename } from "./places.ts"
import { entries, get, list, members } from "./lib.ts"
import { createChangeHeader } from "./header.ts"
import { createPathCache } from "./cache.ts"

const verbose = Deno.args.includes("-v")
const say = (...a: unknown[]) => verbose && console.log(...a)

// cached: false, no cache made (plain places, as a host without one has it)
function world(contributors?: Contributor[], cached = true) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s, contributors })
	s.onTrackingEnd((key) => places.release(key))
	const cache = cached ? createPathCache({ places, scheduler: s }) : undefined!
	const host = s.createRootScope([["actor", "host"]])
	const notes = s.createRootScope([["actor", "notes"]])
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const kid = (id: Id) => table.get("children", id)!
	const kids = (id: Id, v: Record<string, unknown>) =>
		hosted(() => table.sub("children", id, createEntry(v, createChangeHeader(s))))
	const value = (id: Id, v: unknown) =>
		hosted(() => table.sub("value", id, createEntry<unknown>(v, createChangeHeader(s))))
	const ends: { c: Computer; ended: Ended }[] = []
	s.onRunEnd((c, _n, ended) => void ends.push({ c, ended }))
	type W<T> = { runs: number; value: T | undefined; values: T[]; c: Computer }
	function watch<T>(f: () => T): W<T> {
		const w = { runs: 0, value: undefined, values: [] } as unknown as W<T>
		w.c = s.runWithScope(notes, () =>
			s.createComputer(() => (w.runs++, f()), (v) => {
				w.value = v
				w.values.push(v)
			}))
		return w
	}
	const count = () => ({
		...(cache?.kept() ?? { entries: 0, reads: 0 }),
		spots: paths.kept().spots,
	})
	function tree() {
		kids("R", { work: "W" })
		kids("W", { clock: "C0", notes: "N" })
		kids("C0", { on: "ON0" })
		kids("ON0", { reset: "RS0" })
		kids("N", {})
	}
	return {
		s,
		table,
		paths,
		places,
		cache,
		host,
		hosted,
		kids,
		value,
		ends,
		watch,
		count,
		tree,
		place: (parent: Id, n: string, id: Id) =>
			hosted(() => places.commit(place(kid(parent), n, id, createChangeHeader(s)))),
		rename: (parent: Id, a: string, b: string) =>
			hosted(() => places.commit(rename(kid(parent), a, b, createChangeHeader(s)))),
		renameIn: (parent: Id, a: string, b: string) =>
			places.commit(rename(kid(parent), a, b, createChangeHeader(s))),
	}
}
type World = ReturnType<typeof world>
const endsOf = (w: World, c: Computer) => w.ends.filter((e) => e.c === c).map((e) => e.ended)

Deno.test("cache: a read right after a write is the new answer, no pulse between", () => {
	const w = world()
	w.tree()
	const r = w.watch(() => w.cache.get(["work", "clock"]))
	w.s.pulse()
	w.rename("W", "clock", "clock2")
	assertEquals(w.cache.get(["work", "clock"]), undefined)
	assertEquals(w.cache.get(["work", "clock2", "on"]), "ON0")
	assertEquals(w.cache.list(["work"]), ["notes", "clock2"])
	w.s.pulse()
	assertEquals(r.values, ["C0", undefined])
})

Deno.test("cache: a run that writes then reads the path gets the new answer", () => {
	const w = world()
	w.tree()
	w.value("go", false)
	let done = false
	const r = w.watch(() => {
		if (w.places.readValue("value", "go") && !done) {
			done = true
			w.renameIn("W", "clock", "clock2")
		}
		return w.cache.get(["work", "clock"])
	})
	w.s.pulse()
	w.value("go", true)
	w.s.pulse()
	assertEquals(r.values, ["C0", undefined])
	assertEquals(endsOf(w, r.c).filter((e) => e !== "done"), [])
})

Deno.test("cache: a first read is right in the reader's first run, an entry per step", () => {
	for (const path of [["work", "clock"], ["work", "clock", "on", "reset"]]) {
		const w = world()
		w.tree()
		const r = w.watch(() => w.cache.get(path))
		w.s.pulse()
		assertEquals([r.values, r.runs], [[path.length === 2 ? "C0" : "RS0"], 1])
		assertEquals(w.count().entries, path.length)
		assertEquals(endsOf(w, r.c), ["done"])
	}
})

Deno.test("cache: the equal cut, a change that leaves the answer as it was reruns no reader", () => {
	const w = world()
	w.tree()
	const cached = w.watch(() => w.cache.get(["work", "clock"]))
	const plain = w.watch(() => get(w.places, ["work", "clock"]))
	const names = w.watch(() => w.cache.list(["work"]).join())
	w.s.pulse()
	// R's children put back as they are: every spot of R's children marked
	w.kids("R", { work: "W" })
	w.s.pulse()
	assertEquals([cached.runs, plain.runs, names.runs], [1, 2, 1])
	// a name added beside: the cached path's answer is the same, the list's is not
	w.place("W", "other", "O")
	w.s.pulse()
	assertEquals([cached.runs, plain.runs, names.runs], [1, 2, 2])
	assertEquals(names.value, "clock,notes,other")
	// the path's own name moved: both rerun
	w.rename("W", "clock", "clock2")
	w.s.pulse()
	assertEquals([cached.runs, plain.runs], [2, 3])
	assertEquals([cached.value, plain.value], [undefined, undefined])
})

Deno.test("cache: teardown leaves nothing, no entry, no spot", () => {
	const w = world()
	w.tree()
	const r = w.watch(() => w.cache.get(["work", "clock", "on", "reset"]))
	const l = w.watch(() => w.cache.members(["work"]).length)
	w.s.pulse()
	const during = w.count()
	assertEquals(during.entries, 5)
	assert(during.spots > 0)
	w.s.teardown(r.c)
	w.s.teardown(l.c)
	assertEquals(w.count(), { entries: 0, reads: 0, spots: 0 })
})

Deno.test("cache: a read outside any run keeps nothing", () => {
	const w = world()
	w.tree()
	assertEquals(w.cache.get(["work", "clock", "on"]), "ON0")
	assertEquals(w.cache.list(["work"]), ["clock", "notes"])
	w.hosted(() => w.cache.members(["work", "clock"]))
	assertEquals(w.count(), { entries: 0, reads: 0, spots: 0 })
})

Deno.test("cache: a rerun that stops reading a deep path lets its entries go, keeps the shared one", () => {
	const w = world()
	w.tree()
	w.value("deep", true)
	const r = w.watch(() =>
		w.places.readValue("value", "deep")
			? w.cache.get(["work", "clock", "on", "reset"])
			: w.cache.get(["work"])
	)
	w.s.pulse()
	w.value("deep", false)
	w.s.pulse()
	assertEquals(r.values, ["RS0", "W"])
	assertEquals(w.count().entries, 1)
})

Deno.test("cache: a plain reader of a spot an entry reads going lets nothing go under the entry", () => {
	const w = world()
	w.tree()
	const plain = w.watch(() => get(w.places, ["work", "clock"]))
	const r = w.watch(() => w.cache.get(["work", "clock"]))
	w.s.pulse()
	w.s.teardown(plain.c)
	w.rename("W", "clock", "clock2")
	w.s.pulse()
	assertEquals(r.values, ["C0", undefined])
	assertEquals(w.cache.get(["work", "clock"]), undefined)
	w.s.teardown(r.c)
	assertEquals(w.count(), { entries: 0, reads: 0, spots: 0 })
})

Deno.test("cache: an entry a plain reader shares going leaves the plain reader's spots", () => {
	const w = world()
	w.tree()
	const r = w.watch(() => w.cache.get(["work", "clock"]))
	const plain = w.watch(() => get(w.places, ["work", "clock"]))
	w.s.pulse()
	w.s.teardown(r.c)
	assertEquals(w.count().entries, 0)
	w.rename("W", "clock", "clock2")
	w.s.pulse()
	assertEquals(plain.values, ["C0", undefined])
})

Deno.test("cache: entries, list and members give lib's answers, and their readers rerun as lib's", () => {
	for (const given of [undefined, true]) {
		const w = world(given ? [{ ...childrenOf() }] : undefined)
		w.tree()
		w.kids("W", { clock: "C0", notes: "N", junk: [1] })
		const at = (p: string[]) => ({
			entries: entries(w.places, p),
			list: list(w.places, p),
			members: members(w.places, p),
		})
		const cached = (p: string[]) => ({
			entries: w.cache.entries(p),
			list: w.cache.list(p),
			members: w.cache.members(p),
		})
		for (const p of [[], ["work"], ["work", "clock"], ["work", "nope"], ["nope", "x"]]) {
			assertEquals(cached(p), at(p), JSON.stringify(p))
		}
		const r = w.watch(() => w.cache.members(["work"]).map((m) => m.name).join())
		w.s.pulse()
		w.place("W", "x", "X")
		w.s.pulse()
		assertEquals(r.values, ["clock,notes", "clock,notes,x"])
	}
})

// children by another name: a places given contributors, the same answers
function childrenOf(): Contributor {
	return {
		from: "children",
		step: ({ id }, name, r) => {
			const v = r.read("children", id, [name])
			return typeof v === "string" ? v : undefined
		},
		names: ({ id }, r) => r.keys("children", id),
	}
}

Deno.test("cache: cost at 300 paths, against plain places", () => {
	const N = 300
	const out: Record<string, Record<string, number>> = {}
	// each twice, the second kept: the first warms the engine up
	for (const kind of ["cache", "places", "cache", "places"] as const) {
		const w = world(undefined, kind === "cache")
		const top: Record<string, string> = {}
		for (let i = 0; i < N; i++) top[`d${i}`] = `D${i}`
		w.kids("R", top)
		for (let i = 0; i < N; i++) w.kids(`D${i}`, { x: `X${i}` })
		const rs: { runs: number; value: unknown; values: unknown[]; c: Computer }[] = []
		for (let i = 0; i < N; i++) {
			const p = [`d${i}`, "x"]
			rs.push(w.watch(() => kind === "cache" ? w.cache.get(p) : get(w.places, p)))
		}
		const runs = () => rs.reduce((n, r) => n + r.runs, 0)
		let t = performance.now()
		w.s.pulse()
		const first = performance.now() - t
		const c0 = w.count()
		// R's children put back as they are: every top spot marked
		t = performance.now()
		w.kids("R", { ...top })
		w.s.pulse()
		const same = performance.now() - t
		const sameRuns = runs() - N
		t = performance.now()
		for (let i = 0; i < N; i++) w.rename(`D${i}`, "x", "z")
		w.s.pulse()
		const renamed = performance.now() - t
		const renameRuns = runs() - N - sameRuns
		for (const r of rs) w.s.teardown(r.c)
		const c1 = w.count()
		const ms = (x: number) => Math.round(x * 10) / 10
		out[kind] = {
			entries: c0.entries,
			spots: c0.spots,
			firstMs: ms(first),
			sameMs: ms(same),
			sameRuns,
			renameMs: ms(renamed),
			renameRuns,
			afterEntries: c1.entries,
			afterSpots: c1.spots,
		}
		assert(rs.every((r, i) => r.values[0] === `X${i}` && r.value === undefined))
	}
	say("cost,", N, "paths:", out)
	assertEquals([out.cache.entries, out.cache.sameRuns, out.cache.renameRuns], [2 * N, 0, N])
	assertEquals([out.places.sameRuns, out.places.renameRuns], [N, N])
	assertEquals([out.cache.afterEntries, out.cache.afterSpots], [0, 0])
})
