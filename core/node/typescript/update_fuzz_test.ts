// update on one node over many changes, where update_test.ts and the update suite do not reach:
// random values of every kind and random batches, the list option, a new change each update,
// the header given left as it was, refused batches changing nothing, and every change's op still
// walking back and forth through the history after the changes that came later. a few dozen
// seeds (fuzz runs small)
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "@ermine/op/apply"
import createNode, { type ChangeHeader, type Node } from "./node.ts"
import update from "./update.ts"
import { differ, patch, rand, show, snap, start } from "../../fuzz/gen.ts"

const SEEDS = 40
const STEPS = 30

const norm = (v: unknown, list: boolean) => apply(v, [], { list })

Deno.test(`update fuzz: ${SEEDS} seeds × ${STEPS} updates, every change kept walks back and forth`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const list = seed % 4 === 0, o = { list }
		const first = start(pick, list)
		const n: Node<unknown> = createNode(first, { time: 0, actor: "host" })
		// what each update was given and made: the value before, the change, the value after
		const history: { before: unknown; change: ChangeHeader; after: unknown }[] = []
		const changes = new Set<ChangeHeader>([n.change])
		for (let step = 0; step < STEPS; step++) {
			const at = `seed ${seed} (list ${list}), step ${step}`
			// a few patches, each on what the ones before it made; now and then one refused
			const ps: Patch[] = []
			let v = n.value
			for (let k = 1 + pick(4); k > 0; k--) {
				const p = patch(pick, v, list)
				try {
					v = apply(n.value, [...ps, p], o)
				} catch (e) {
					if (!(e instanceof ApplyError)) throw e
					if (pick(4)) continue
				}
				ps.push(p)
			}
			const header: ChangeHeader = {
				time: step + 1,
				actor: pick(2) ? "me" : { person: "p", step },
				metadata: [["step", step]],
			}
			const headerWas = snap(header)
			const before = n.value, beforeWas = snap(before), had = "value" in n
			const change = n.change
			const given = pick(3) ? ps : (function* () {
				yield* ps
			})()
			let refused: ApplyError | undefined
			try {
				update(n, given, header, o)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				refused = e
			}
			assertEquals(differ(header, headerWas, true), "", `${at}: the header given changed`)
			assertEquals("op" in header, false, at)
			if (refused) {
				// nothing changes: the same value, the same change
				assertStrictEquals(n.value, before, at)
				assertStrictEquals(n.change, change, at)
				assertEquals("value" in n, had, at)
				assertEquals(differ(before, beforeWas, true), "", `${at}: the value changed`)
				assertThrows(() => apply(before, ps, o), ApplyError)
				continue
			}
			// a new change, the header's fields and the op
			assert(!changes.has(n.change), `${at}: a change object again`)
			changes.add(n.change)
			assert(n.change !== header, at)
			const { op, ...rest } = n.change
			assertEquals(rest, header, at)
			if (given === ps) assertStrictEquals(op!.patches, ps, at)
			else assertEquals(op!.patches, ps, at)
			// the value the patches make, the one before as it was
			const want = apply(before, ps, o)
			assertEquals(differ(n.value, want, true), "", `${at}: ${show(ps)}`)
			assertEquals("value" in n, want !== undefined, at)
			assertEquals(differ(before, beforeWas, true), "", `${at}: the value before changed`)
			assertEquals(
				differ(apply(n.value, op!.undo, o), norm(before, list)),
				"",
				`${at}: undo ${show(op!.undo)}`,
			)
			history.push({ before: beforeWas, change: n.change, after: snap(n.value) })
		}
		// every change still holds: back from the end, change by change, then forward again
		let v = n.value
		for (let i = history.length - 1; i >= 0; i--) {
			const h = history[i]
			assertEquals(differ(v, norm(h.after, list)), "", `seed ${seed}: at change ${i}`)
			v = apply(v, h.change.op!.undo, o)
			assertEquals(differ(v, norm(h.before, list)), "", `seed ${seed}: back past change ${i}`)
		}
		assertEquals(differ(v, norm(first, list)), "", `seed ${seed}: back to the first`)
		for (const [i, h] of history.entries()) {
			v = apply(v, h.change.op!.patches, o)
			assertEquals(differ(v, norm(h.after, list)), "", `seed ${seed}: forward past change ${i}`)
		}
	}
})

Deno.test(`update fuzz: ${SEEDS} seeds, one update of many patches, as one update each`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 500)
		const list = seed % 4 === 0, o = { list }
		const first = start(pick, list)
		const ps: Patch[] = []
		let v = first
		for (let tries = 0; ps.length < 12 && tries < 50; tries++) {
			const p = patch(pick, v, list)
			try {
				v = apply(first, [...ps, p], o)
				ps.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		const h: ChangeHeader = { time: 1, actor: "me" }
		const all = createNode(first, h), each = createNode(first, h)
		update(all, ps, h, o)
		const undos: Patch[][] = []
		for (const p of ps) {
			update(each, [p], h, o)
			undos.push(each.change.op!.undo as Patch[])
		}
		const at = `seed ${seed} (list ${list}): ${show(first)}\n${show(ps)}`
		assertEquals(differ(all.value, each.value, true), "", at)
		assertEquals("value" in all, "value" in each, at)
		// the one change's undo and the many, last first, take it to the same place
		let back = each.value
		for (let i = undos.length - 1; i >= 0; i--) back = apply(back, undos[i], o)
		assertEquals(differ(back, apply(all.value, all.change.op!.undo, o)), "", at)
		assertEquals(differ(back, norm(first, list)), "", at)
	}
})
