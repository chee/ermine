// places over nodes and a table, where places' own fuzz (places_test.ts) and the places suite do
// not reach: writes from items as well as entries, names that are not names, arrays holding
// what is no entry, names holding what is no array, children nodes put, replaced and taken out
// between writes. after every write:
//   - each node it gave back is the one there now, at a new change, and that change's undo takes
//     its value back to what it was; every other node is as it was (same node, change, value)
//   - a refused write changes nothing at all
//   - opened places (with ., .. and / steps) give what get gives
//   - every item found (from the root, an entry or an item; get, lookup) is found again from its
//     start by path(item); lookup with all is lib's lookups; names are the arrays' names
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import apply from "@ermine/op/apply"
import createEntry from "@ermine/node"
import { createTable } from "@ermine/graph/table"
import { createPlaces, type Item, path, PlacesError } from "@ermine/places"
import { lookups } from "../places/typescript/lib.ts"
import { differ, isMap, rand, snap } from "./gen.ts"
import { alike, createWorld, items, show, type Wrote } from "./world.ts"

const SEEDS = 40
const STEPS = 60

Deno.test(`places + update fuzz: ${SEEDS} seeds × ${STEPS} writes, undo, nothing else touched`, () => {
	let undone = 0, refused = 0, events = 0
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const w = createWorld(pick)
		const addresses = Array.from({ length: 6 }, () => w.address())
		const holds = addresses.map((a) => w.p.open(a))
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
			const changed = new Map<string, number>()
			wrote?.changed.forEach((c, i) => changed.set(`${String(c.source)} ${String(c.id)}`, i))
			assertEquals(changed.size, wrote?.changed.length ?? 0, `${at}: a node given twice`)
			const evented = new Set(wrote?.events.map((e) => `${String(e.source)} ${String(e.id)}`))
			events += evented.size
			for (const b of before) {
				const key = `${String(b.source)} ${String(b.id)}`
				const now = w.children(b.source, b.id)
				if (evented.has(key)) continue
				const i = changed.get(key)
				if (i === undefined) {
					// untouched: the same node, at the same change, its value as it was
					assertStrictEquals(now, b.node, `${at}: ${key}`)
					assertStrictEquals(now?.change, b.change, `${at}: ${key}'s change`)
					assertStrictEquals(now?.value, b.value, `${at}: ${key}'s value`)
					assertEquals(differ(b.value, b.was, true), "", `${at}: ${key}'s value changed`)
					continue
				}
				const c = wrote!.changed[i]
				assertStrictEquals(c.node, now, `${at}: ${key} is the node there`)
				assertStrictEquals(c.node, b.node, `${at}: ${key} the same node`)
				assert(c.node.change !== b.change, `${at}: ${key} at a new change`)
				const back = apply(c.node.value, c.node.change.op!.undo)
				assertEquals(differ(back, b.was), "", `${at}: ${key}'s undo ${show(c.node.change.op)}`)
				assertEquals(differ(b.value, b.was, true), "", `${at}: ${key}'s old value changed`)
				undone++
			}
			// opened places give what get gives
			holds.forEach((held, i) => {
				assertEquals(items(held.items()), items(w.p.get(addresses[i])), `${at}: hold ${i}`)
			})
			// items found are found again by their path, from their start
			for (let k = 0; k < 4; k++) {
				const from = w.from(), address = w.address()
				const found = pick(2)
					? w.p.get(address, from)
					: w.p.lookup(address, from, pick(2) === 0)
				for (const item of found) {
					let start: Item = item
					while (start.up) start = start.up
					const again = w.p.get(path(item), start)
					assert(
						again.some((x) => alike(x, item)),
						`${at}: ${show(item)} from ${show(from)} by ${show(address)}, again ${
							items(again)
						}`,
					)
				}
				assertEquals(
					items(w.p.lookup(address, from, true)),
					items(lookups(w.p, address, w.p.get([], from)[0] ?? w.p.get([])[0])),
					`${at}: lookups`,
				)
			}
			// names: the names holding arrays, in their order
			for (const { source, id, node } of w.nodes()) {
				const v = node?.value
				const want = isMap(v) ? Object.keys(v).filter((k) => Array.isArray(v[k])) : []
				assertEquals(w.p.names([source, id]), want, `${at}: names`)
			}
		}
		for (const held of holds) held.drop()
	}
	assert(
		undone > 1000 && refused > 200 && events > 50,
		`the fuzz reaches: ${undone}, ${refused}, ${events}`,
	)
})

// the table holds one node under any number of keys, and places tells children nodes apart by the
// node, not the key: a move between two keys whose children are one node is one change on it
// (the patches of a move within one parent), given back once with the target's key
Deno.test({
	name: "places + table: a move between two keys holding one children node",
	fn() {
		const t = createTable<unknown>()
		const n = createEntry<unknown>({ t: [["e", "0"], ["e", "1"]] }, { time: 0, actor: "me" })
		t.add("stored", "X", n)
		t.add("drag", "X", n)
		const p = createPlaces({
			root: ["stored", "X"],
			children: (source, id) => t.get(source, id),
		})
		const out = p.move(
			[["stored", "X"], "t"],
			1,
			[["drag", "X"], "t"],
			{ time: 1, actor: "me" },
			0,
		)
		assertEquals(n.value, { t: [["e", "1"], ["e", "0"]] })
		const patches = out.flatMap((c) => c.node.change.op!.patches)
		assert(patches.some((x) => "value" in x || x.move), `the place's patches: ${show(patches)}`)
	},
})
