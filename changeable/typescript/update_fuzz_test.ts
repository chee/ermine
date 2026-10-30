// Fuzz test of update on one entry over many changes; runs a few dozen seeds.
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "@ermine/changeable/apply"
import type { Changeable, ChangeHeader } from "@ermine/changeable"
import update from "./update.ts"
import { differ, patch, rand, show, snap, start } from "../../conformance/typescript/gen.ts"
const createChangeable = <V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Changeable<V> => {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const c: Changeable<V> = { change }
	if (value !== undefined) c.value = value
	return c
}

const SEEDS = 40
const STEPS = 30

const norm = (v: unknown) => apply(v, [])

Deno.test(`update fuzz: ${SEEDS} seeds × ${STEPS} updates, every change kept walks back and forth`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const first = start(pick)
		const n: Changeable<unknown> = createChangeable(first, {
			time: 0,
			actor: "host",
			frame: { info: {}, parent: undefined },
		})
		const history: { before: unknown; change: ChangeHeader; after: unknown }[] = []
		const changes = new Set<ChangeHeader>([n.change])
		for (let step = 0; step < STEPS; step++) {
			const at = `seed ${seed}, step ${step}`
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
				frame: { info: { step }, parent: undefined },
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
				assertStrictEquals(n.value, before, at)
				assertStrictEquals(n.change, change, at)
				assertEquals("value" in n, had, at)
				assertEquals(differ(before, beforeWas, true), "", `${at}: the value changed`)
				assertThrows(() => apply(before, ps), ApplyError)
				continue
			}
			assert(!changes.has(n.change), `${at}: a change object again`)
			changes.add(n.change)
			assert(n.change !== header, at)
			const { op, ...rest } = n.change
			assertEquals(rest, header, at)
			if (given === ps) assertStrictEquals(op!.patches, ps, at)
			else assertEquals(op!.patches, ps, at)
			const want = apply(before, ps)
			assertEquals(differ(n.value, want), "", `${at}: ${show(ps)}`)
			assertEquals("value" in n, want !== undefined, at)
			assertEquals(differ(before, beforeWas, true), "", `${at}: the value before changed`)
			assertEquals(
				differ(apply(n.value, op!.undo), norm(before)),
				"",
				`${at}: undo ${show(op!.undo)}`,
			)
			history.push({ before: beforeWas, change: n.change, after: snap(n.value) })
		}
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
		const h: ChangeHeader = { time: 1, actor: "me", frame: { info: {}, parent: undefined } }
		const all = createChangeable(first, h), each = createChangeable(first, h)
		update(all, ps, h)
		const undos: Patch[][] = []
		for (const p of ps) {
			update(each, [p], h)
			undos.push(each.change.op!.undo as Patch[])
		}
		const at = `seed ${seed}: ${show(first)}\n${show(ps)}`
		assertEquals(differ(all.value, each.value), "", at)
		assertEquals("value" in all, "value" in each, at)
		let back = each.value
		for (let i = undos.length - 1; i >= 0; i--) back = apply(back, undos[i])
		assertEquals(differ(back, apply(all.value, all.change.op!.undo)), "", at)
		assertEquals(differ(back, norm(first)), "", at)
	}
})
