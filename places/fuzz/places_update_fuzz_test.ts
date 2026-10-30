// Fuzzes places' writes: after every write the returned entries are the ones there with an undo
// that restores the old value, others are untouched, and a refused write changes nothing.
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import apply from "@ermine/changeable/apply"
import createEntry, { type Entry } from "@ermine/graph/entry"
import { createTable } from "@ermine/graph/table"
import { move, PlacesError } from "@ermine/places"
import { differ, isMap, rand, snap } from "../../conformance/typescript/gen.ts"
import { createWorld, show, type Wrote } from "./world_harness.ts"
import { get, list, lookup } from "@ermine/places/lib"

const SEEDS = 40
const STEPS = 60

Deno.test(`places + update fuzz: ${SEEDS} seeds × ${STEPS} writes, undo, nothing else touched`, () => {
	let undone = 0, refused = 0, events = 0
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const w = createWorld(pick)
		for (let step = 0; step < STEPS; step++) {
			const before = w.nodes().map((x) => ({
				...x,
				change: x.node?.change,
				value: x.node?.value,
				was: snap(x.node?.value),
			}))
			let wrote: Wrote | undefined
			try {
				wrote = w.write()
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
				refused++
			}
			const at = `seed ${seed}, step ${step}: ${wrote?.what ?? "refused"}`
			const changed = new Map<Entry<unknown>, number>()
			wrote?.changed.forEach((c, i) => changed.set(c, i))
			assertEquals(changed.size, wrote?.changed.length ?? 0, `${at}: an entry given twice`)
			const evented = new Set(wrote?.events.map((e) => e.id))
			events += evented.size
			for (const b of before) {
				const key = String(b.id)
				const now = w.children(b.id)
				if (evented.has(b.id)) continue
				const i = b.node && changed.get(b.node)
				if (i === undefined) {
					assertStrictEquals(now, b.node, `${at}: ${key}`)
					assertStrictEquals(now?.change, b.change, `${at}: ${key}'s change`)
					assertStrictEquals(now?.value, b.value, `${at}: ${key}'s value`)
					assertEquals(differ(b.value, b.was, true), "", `${at}: ${key}'s value changed`)
					continue
				}
				const c = wrote!.changed[i]
				assertStrictEquals(c, now, `${at}: ${key} is the entry there`)
				assert(c.change !== b.change, `${at}: ${key} at a new change`)
				const back = apply(c.value, c.change.op!.undo)
				assertEquals(differ(back, b.was), "", `${at}: ${key}'s undo ${show(c.change.op)}`)
				// children are written through places' crow: in place where it owns, else a copy
				if (c.value !== b.value) {
					assertEquals(differ(b.value, b.was, true), "", `${at}: ${key}'s old value changed`)
				}
				undone++
			}
			for (let k = 0; k < 4; k++) {
				const from = w.path(), names = w.path(2)
				const all = lookup(w.p, names, from, true)
				for (const found of all) assert(get(w.p, found) !== undefined, `${at}: ${show(found)}`)
				assertEquals(lookup(w.p, names, from), all[0], `${at}: nearest`)
			}
			// list: every name there, in its order, including a name holding no id
			for (let k = 0; k < 4; k++) {
				const where = w.path()
				const id = get(w.p, where)
				const v = id === undefined ? undefined : w.children(id)?.value
				const want = isMap(v) ? Object.keys(v) : []
				assertEquals([...list(w.p, where)], want, `${at}: list ${show(where)}`)
			}
		}
	}
	assert(
		undone > 1000 && refused > 200 && events > 50,
		`the fuzz reaches: ${undone}, ${refused}, ${events}`,
	)
})

// The table holds one entry under any number of ids, and places' writes tell entries apart by
// the entry, not the id: a move between two ids whose children are one entry is one change.
Deno.test("places + table: a move between two ids holding one children entry", () => {
	const t = createTable()
	const n = createEntry<Record<string, unknown>>({ t: "0" }, {
		time: 0,
		actor: "me",
		frame: { info: {}, parent: undefined },
	})
	t.add("children", "X", n)
	t.add("children", "Y", n)
	const out = move([t.get("children", "X")!, "t"], [t.get("children", "Y")!, "u"], {
		time: 1,
		actor: "me",
		frame: { info: {}, parent: undefined },
	})
	assertEquals(n.value, { u: "0" })
	assertEquals(out, [n])
	assertEquals(n.change.op!.patches, [{ path: ["u"], move: { path: ["t"] } }])
})
