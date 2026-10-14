// update on one entry over many changes, where update_test.ts and the update suite do not reach:
// random values of every kind and random batches, a new change each update,
// the header given left as it was, refused batches changing nothing, and every change's op still
// walking back and forth through the history after the changes that came later. a few dozen
// seeds (fuzz runs small)
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "@ermine/op/apply"
import createEntry, { type ChangeHeader, type Entry } from "./node.ts"
import update from "./update.ts"
import { differ, patch, rand, show, snap, start } from "../../fuzz/gen.ts"

const SEEDS = 40
const STEPS = 30

const norm = (v: unknown) => apply(v, [])

Deno.test(`update fuzz: ${SEEDS} seeds × ${STEPS} updates, every change kept walks back and forth`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const first = start(pick)
		const n: Entry<unknown> = createEntry(first, { time: 0, actor: "host" })
		// what each update was given and made: the value before, the change, the value after
		const history: { before: unknown; change: ChangeHeader; after: unknown }[] = []
		const changes = new Set<ChangeHeader>([n.change])
		for (let step = 0; step < STEPS; step++) {
			const at = `seed ${seed}, step ${step}`
			// a few patches, each on what the ones before it made; now and then one refused
			const ps: Patch[] = []
			let v = n.value
			for (let k = 1 + pick(4); k > 0; k--) {
				const p = patch(pick, v)
				try {
					v = apply(n.value, [...ps, p])
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
				update(n, given, header)
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
				assertThrows(() => apply(before, ps), ApplyError)
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
			const want = apply(before, ps)
			assertEquals(differ(n.value, want, true), "", `${at}: ${show(ps)}`)
			assertEquals("value" in n, want !== undefined, at)
			assertEquals(differ(before, beforeWas, true), "", `${at}: the value before changed`)
			assertEquals(
				differ(apply(n.value, op!.undo), norm(before)),
				"",
				`${at}: undo ${show(op!.undo)}`,
			)
			history.push({ before: beforeWas, change: n.change, after: snap(n.value) })
		}
		// every change still holds: back from the end, change by change, then forward again
		let v = n.value
		for (let i = history.length - 1; i >= 0; i--) {
			const h = history[i]
			assertEquals(differ(v, norm(h.after)), "", `seed ${seed}: at change ${i}`)
			v = apply(v, h.change.op!.undo)
			assertEquals(differ(v, norm(h.before)), "", `seed ${seed}: back past change ${i}`)
		}
		assertEquals(differ(v, norm(first)), "", `seed ${seed}: back to the first`)
		for (const [i, h] of history.entries()) {
			v = apply(v, h.change.op!.patches)
			assertEquals(differ(v, norm(h.after)), "", `seed ${seed}: forward past change ${i}`)
		}
	}
})

Deno.test(`update fuzz: ${SEEDS} seeds, one update of many patches, as one update each`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 500)
		const first = start(pick)
		const ps: Patch[] = []
		let v = first
		for (let tries = 0; ps.length < 12 && tries < 50; tries++) {
			const p = patch(pick, v)
			try {
				v = apply(first, [...ps, p])
				ps.push(p)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
			}
		}
		const h: ChangeHeader = { time: 1, actor: "me" }
		const all = createEntry(first, h), each = createEntry(first, h)
		update(all, ps, h)
		const undos: Patch[][] = []
		for (const p of ps) {
			update(each, [p], h)
			undos.push(each.change.op!.undo as Patch[])
		}
		const at = `seed ${seed}: ${show(first)}\n${show(ps)}`
		assertEquals(differ(all.value, each.value, true), "", at)
		assertEquals("value" in all, "value" in each, at)
		// the one change's undo and the many, last first, take it to the same place
		let back = each.value
		for (let i = undos.length - 1; i >= 0; i--) back = apply(back, undos[i])
		assertEquals(differ(back, apply(all.value, all.change.op!.undo)), "", at)
		assertEquals(differ(back, norm(first)), "", at)
	}
})

Deno.test(`update fuzz: ${SEEDS} seeds × ${STEPS} updates, an entry with cow: false as one without`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 900)
		const first = start(pick)
		const h: ChangeHeader = { time: 0, actor: "host" }
		const a = createEntry(snap(first), h), b = createEntry(snap(first), h, { cow: false })
		for (let step = 0; step < STEPS; step++) {
			const at = `seed ${seed}, step ${step}`
			const ps: Patch[] = []
			let v = a.value
			for (let k = 1 + pick(4); k > 0; k--) {
				const p = patch(pick, v)
				try {
					v = apply(a.value, [...ps, p])
				} catch (e) {
					if (!(e instanceof ApplyError)) throw e
					if (pick(4)) continue
				}
				ps.push(p)
			}
			const header: ChangeHeader = { time: step + 1, actor: "me" }
			const held = b.value
			let ea: ApplyError | undefined, eb: ApplyError | undefined
			try {
				update(a, ps, header)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				ea = e
			}
			// in place, the patches are given copies: what they put becomes the value
			const copy = snap(ps) as Patch[]
			try {
				update(b, copy, header)
			} catch (e) {
				if (!(e instanceof ApplyError)) throw e
				eb = e
			}
			assertEquals([eb?.code, eb?.patch], [ea?.code, ea?.patch], at)
			assertEquals(differ(b.value, a.value), "", `${at}: the value`)
			assertEquals("value" in b, "value" in a, at)
			// (a key put back by a refused update goes last in its map: compared by content)
			assertEquals(differ(b.change.op?.undo, a.change.op?.undo), "", `${at}: the undo`)
			if (eb) assertStrictEquals(b.value, held, at)
		}
	}
})
