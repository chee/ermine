// the slice fuzzed: random places writes, value edits, children edits and table events, the
// host's, a pulse after each. then every compute's value is the graph read again from scratch:
// places with nothing told, values straight from the table. at the end, every compute disposed:
// no spot is kept (the scheduler's forget). a few dozen seeds (fuzz runs small)
import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { ApplyError, type Key as Step, type Patch } from "@ermine/op/apply"
import { type Address, createPlaces, type Entry, type Item, PlacesError } from "@ermine/places"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key, TableError } from "@ermine/graph/table"
import { at, createLink } from "./link.ts"

const SEEDS = 40
const STEPS = 60
const COMPUTES = 8
const IDS = ["R", "A", "B", "C", "D"]
const NAMES = ["a", "b", "c"]
const PATHS: Step[][] = [[], ["t"], ["u"], ["l"], ["l", 0], ["l", 1]]
const TOP: Entry = ["stored", "R"]

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

// how a compute reads: through link (tracked), or from scratch
type Ways = {
	get: (address: Address) => readonly Item[]
	names: (item: Item) => string[]
	read: (id: string, path: readonly Step[]) => unknown
}

type Reach = { landed: number; refused: number; runs: number; events: number }

function seeded(seed: number, reach: Reach) {
	const { pick, one } = rand(seed)
	const s = createScheduler({
		hook: (m) => void ("starts" in m && reach.runs++),
		forget: (key) => l.forget(key),
	})
	const table = createTable((part, id) => l.event(part as Key, id))
	const paths = createPaths<unknown>()
	const l = createLink({ table, paths, scheduler: s })
	const children = (_: unknown, id: Id) => table.get("children", id)
	const places = createPlaces({ root: TOP, children, read: l.read })
	const plain = createPlaces({ root: TOP, children })
	const o = s.root()
	// the host's writes, in its scope
	const host = s.root([["actor", "fuzz"]])
	const h = () => l.header()
	// the patches to the entry there, reported; none there: one made with them, added
	function edit(part: Key, id: Id, patches: Patch[]) {
		const there = table.get(part, id)
		if (there === undefined) {
			const node = createEntry<unknown>(undefined, h())
			update(node, patches, node.change)
			table.add(part, id, node)
		} else {
			update(there, patches, h())
			l.wrote([{ node: there }])
		}
	}

	// places' entry: the source names nothing, one table holds every entry
	const entry = (): Entry => ["stored", one(IDS)]
	function kids(): Record<string, unknown> {
		const v: Record<string, unknown> = {}
		for (const name of NAMES) {
			if (pick(3)) v[name] = Array.from({ length: pick(3) }, entry)
		}
		return v
	}
	const value = (): unknown =>
		pick(5)
			? { t: pick(10), u: "abc".slice(pick(4)), l: [pick(9), pick(9)].slice(pick(3)) }
			: "plain"
	s.run(host, () => {
		for (const id of IDS) {
			if (pick(5)) table.add("children", id, createEntry(kids(), h()))
			if (pick(4)) table.add("value", id, createEntry<unknown>(value(), h()))
		}
	})

	const live: Ways = {
		get: (a) => places.get(a),
		names: (i) => places.names(i),
		read: (id, path) => l.get("value", id, path),
	}
	const fresh: Ways = {
		get: (a) => plain.get(a),
		names: (i) => plain.names(i),
		read: (id, path) => at(table.get("value", id)?.value, path),
	}

	// computes: a walk of an address (or a held one), then each item's value at a path, or names
	const computes = Array.from({ length: COMPUTES }, () => {
		const address = Array.from({ length: 1 + pick(3) }, () => one(NAMES))
		const path = one(PATHS)
		const kind = pick(3)
		const held = kind === 1 ? places.open(address) : undefined
		const show = (ways: Ways, items: readonly Item[]) =>
			JSON.stringify(items.map((i) => {
				const key = `${String(i.source)}:${String(i.id)}#${i.at}`
				return kind === 2
					? [key, ways.names(i)]
					: [key, ways.read(i.id as string, path) ?? null]
			}))
		const c = {
			what: `${["get", "open", "names"][kind]} ${address.join("/")} ${path.join(".")}`,
			value: undefined as string | undefined,
			scratch: () => show(fresh, fresh.get(address)),
		}
		s.run(o, () =>
			s.compute(() => show(live, held ? held.items() : live.get(address)), (v) => {
				c.value = v
			}))
		return c
	})

	const slot = (): [Entry, string] => [entry(), one(NAMES)]
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
		if (k === 0) {
			const at = slot(), e = entry(), i = pick(2) ? undefined : pick(3)
			l.wrote(places.place(at, e, h(), i))
			return `place ${at} ${e} ${i}`
		}
		if (k === 1) {
			const at = slot(), i = pick(3)
			l.wrote(places.unplace(at, i, h()))
			return `unplace ${at} ${i}`
		}
		if (k === 2) {
			const at = slot(), a = pick(3), b = pick(3)
			l.wrote(places.order(at, a, b, h()))
			return `order ${at} ${a} ${b}`
		}
		if (k === 3) {
			const at = slot(), to = one(NAMES)
			l.wrote(places.rename(at, to, h()))
			return `rename ${at} ${to}`
		}
		if (k === 4) {
			const a = slot(), b = slot(), i = pick(3), j = pick(2) ? undefined : pick(3)
			l.wrote(places.move(a, i, b, h(), j))
			return `move ${a} ${i} ${b} ${j}`
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
			what = s.run(host, write)
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
	s.dispose(o)
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
