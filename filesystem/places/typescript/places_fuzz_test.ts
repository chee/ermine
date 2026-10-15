// the slice fuzzed: random places writes, value edits, children edits and table events, the
// host's, a pulse after each. then every compute's value is the graph read again from scratch:
// paths walked straight through the table, values straight from it. at the end, every compute disposed:
// no spot is kept (the scheduler's onTrackingEnd). a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { ApplyError, type Key as Step, type Patch } from "@ermine/op/apply"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, TableError } from "@ermine/table"
import { at, createPlaces, move, type Path, place, PlacesError, rename, unplace } from "./places.ts"
import { get, list } from "./lib.ts"
import { createChangeHeader } from "./header.ts"

const SEEDS = 40
const STEPS = 60
const COMPUTES = 8
const IDS = ["R", "A", "B", "C", "D"]
const NAMES = ["a", "b", "c"]
const PATHS: Step[][] = [[], ["t"], ["u"], ["l"], ["l", 0], ["l", 1]]

// xorshift: a seed is a run
function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	const pick = (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	return { pick, one }
}

// how a compute reads: through places (tracked), or from scratch
type Ways = {
	get: (path: Path) => Id | undefined
	list: (path: Path) => string[]
	read: (id: Id, path: readonly Step[]) => unknown
}

type Reach = { landed: number; refused: number; runs: number; events: number }

function seeded(seed: number, reach: Reach) {
	const { pick, one } = rand(seed)
	const s = createScheduler()
	s.onRunStart(() => void reach.runs++)
	s.onTrackingEnd((key) => l.release(key))
	const table = createTable((part, id) => l.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const l = createPlaces({ root: "R", table, paths, scheduler: s })
	const places = l
	const o = s.createRootScope()
	// the host's writes, in its scope
	const host = s.createRootScope([["actor", "fuzz"]])
	const h = () => createChangeHeader(s)
	// the patches to the entry there, reported; none there: one made with them, added
	function edit(part: Key, id: Id, patches: Patch[]) {
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h())
			update(node, patches, node.change)
			table.add(part, id, node)
		} else {
			update(there, patches, h())
			l.commit([there])
		}
	}

	const entry = (): Id => one(IDS)
	function kids(): Record<string, unknown> {
		const v: Record<string, unknown> = {}
		for (const name of NAMES) {
			// now and then something that is no id: taken, no item
			if (pick(3)) v[name] = pick(8) === 0 ? [entry()] : entry()
		}
		return v
	}
	const value = (): unknown =>
		pick(5)
			? { t: pick(10), u: "abc".slice(pick(4)), l: [pick(9), pick(9)].slice(pick(3)) }
			: "plain"
	s.runWithScope(host, () => {
		for (const id of IDS) {
			if (pick(5)) table.add("children", id, createEntry(kids(), h()))
			if (pick(4)) table.add("value", id, createEntry<unknown>(value(), h()))
		}
	})

	const live: Ways = {
		get: (p) => get(places, p),
		list: (p) => list(places, p),
		read: (id, path) => l.readValue("value", id, path),
	}
	// from scratch: each name in the children value of the id before, nothing told
	const isId = (x: unknown): x is Id => typeof x === "string" || typeof x === "symbol"
	function scratch(p: Path): Id | undefined {
		let id: Id | undefined = "R"
		for (const name of p) {
			const v = table.get("children", id)?.value as Record<string, unknown> | undefined
			const next: unknown = v && typeof v === "object" && Object.hasOwn(v, name)
				? v[name]
				: undefined
			if (!isId(next)) return undefined
			id = next
		}
		return id
	}
	const fresh: Ways = {
		get: scratch,
		list: (p) => {
			const id = scratch(p)
			const v = id === undefined ? undefined : table.get("children", id)?.value
			if (!v || typeof v !== "object" || Array.isArray(v)) return []
			return Object.keys(v)
		},
		read: (id, path) => at(table.get("value", id)?.value, path),
	}

	// computes: a path walked, then the value there at a path, or the names there
	const computes = Array.from({ length: COMPUTES }, () => {
		const where = Array.from({ length: 1 + pick(3) }, () => one(NAMES))
		const path = one(PATHS)
		const kind = pick(2) ? 0 : 2
		const show = (ways: Ways, id: Id | undefined) =>
			JSON.stringify(
				kind === 2 ? ways.list(where) : [
					id === undefined ? null : String(id),
					id === undefined ? null : ways.read(id, path) ?? null,
				],
			)
		const c = {
			what: `${kind ? "list" : "get"} ${where.join("/")} ${path.join(".")}`,
			value: undefined as string | undefined,
			scratch: () => show(fresh, fresh.get(where)),
		}
		s.runWithScope(o, () =>
			s.createComputer(() => show(live, live.get(where)), (v) => {
				c.value = v
			}))
		return c
	})

	// a parent's children entry; none: nothing-there
	const kid = (id: Id) => {
		const n = table.get("children", id)
		if (n === undefined) throw new PlacesError("nothing-there")
		return n
	}

	const slot = (): [Id, string] => [entry(), one(NAMES)]
	function patch(): Patch {
		switch (pick(10)) {
			case 0:
				return { path: ["t"], value: pick(10) }
			case 1:
				return { path: ["t"] }
			case 2: {
				const a = pick(3)
				return { path: ["u"], range: [a, a + pick(2)], value: "x" }
			}
			case 3:
				return { path: ["l", pick(2)], value: pick(9) }
			case 4:
				return { path: ["l"], range: [0, 0], value: [pick(9)] }
			case 5:
				return { path: ["l"], range: [0, 1] }
			case 6:
				return { path: ["l", 0] }
			case 7:
				return { path: [], value: value() }
			case 8:
				return { path: [] }
			default:
				return { path: ["t"], move: { path: ["l", 0] } }
		}
	}

	// one random write; refused: it throws, and nothing changed
	function write(): string {
		const k = pick(16)
		const id = one(IDS)
		if (k === 0 || k === 2) {
			const at = slot(), e = entry()
			l.commit(place(kid(at[0]), at[1], e, h()))
			return `place ${at} ${String(e)}`
		}
		if (k === 1) {
			const at = slot()
			l.commit(unplace(kid(at[0]), at[1], h()))
			return `unplace ${at}`
		}
		if (k === 3) {
			const at = slot(), to = one(NAMES)
			l.commit(rename(kid(at[0]), at[1], to, h()))
			return `rename ${at} ${to}`
		}
		if (k === 4) {
			const a = slot(), b = slot()
			l.commit(move([kid(a[0]), a[1]], [kid(b[0]), b[1]], h()))
			return `move ${a} ${b}`
		}
		if (k < 9) {
			const ps = Array.from({ length: 1 + pick(2) }, patch)
			edit("value", id, ps)
			return `edit ${id} ${JSON.stringify(ps)}`
		}
		if (k === 9) {
			const v = kids()
			edit("children", id, [{ path: [], value: v }])
			return `edit children ${id} ${JSON.stringify(v)}`
		}
		reach.events++
		if (k === 10) {
			table.sub("children", id, createEntry(kids(), h()))
			return `sub children ${id}`
		}
		if (k === 11) {
			table.sub("value", id, createEntry<unknown>(value(), h()))
			return `sub value ${id}`
		}
		if (k === 12) {
			const part = pick(2) ? "children" : "value"
			table.del(part, id)
			return `del ${part} ${id}`
		}
		// one children entry under another key too: a write through either reaches both
		const from = one(IDS), shared = table.get("children", from)
		if (shared) table.sub("children", id, shared)
		return `share children ${from} at ${id}`
	}

	for (let step = 0; step < STEPS; step++) {
		let what: string
		try {
			what = s.runWithScope(host, write)
			reach.landed++
		} catch (e) {
			if (!(e instanceof PlacesError || e instanceof ApplyError || e instanceof TableError)) {
				throw e
			}
			reach.refused++
			what = "refused"
		}
		s.pulse()
		for (const c of computes) {
			assertEquals(c.value, c.scratch(), `seed ${seed} step ${step} (${what}): ${c.what}`)
		}
	}
	s.teardown(o)
	assertEquals(paths.kept(), { keys: 0, spots: 0, steps: 0 }, `seed ${seed}: spots kept`)
}

Deno.test("link fuzz: every compute is the graph read from scratch after each pulse", () => {
	const reach: Reach = { landed: 0, refused: 0, runs: 0, events: 0 }
	for (let seed = 1; seed <= SEEDS; seed++) seeded(seed, reach)
	// not vacuous: writes landed, table events happened, computes ran again
	assert(reach.landed > SEEDS * STEPS / 3, `landed ${reach.landed}`)
	assert(reach.events > SEEDS, `events ${reach.events}`)
	assert(reach.runs > SEEDS * COMPUTES * 2, `runs ${reach.runs}`)
})
