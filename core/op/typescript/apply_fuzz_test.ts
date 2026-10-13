// apply's undo option and batches, where invert's fuzz (invert_test.ts) and the op-apply suite do
// not reach: the undo pushed after what the array held, a refused batch leaving the array as it
// was, the undo's own undo redoing, separate undos joined, and one call as one call each under
// the list option too. a few dozen seeds (fuzz runs small)
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "./apply.ts"
import invert from "./invert.ts"
import { batch, differ, rand, show, snap, start } from "../../fuzz/gen.ts"

const SEEDS = 40

// the value as apply has it: the list option's empty list is nothing
const norm = (v: unknown, list: boolean) => apply(v, [], { list })

Deno.test(`apply fuzz: ${SEEDS} seeds, the undo option: after what was there, back and forth`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const list = seed % 4 === 0, o = { list }
		const from = start(pick, list)
		const { good } = batch(pick, from, list)
		const at = `seed ${seed} (list ${list}): ${show(from)}\n${show(good)}`
		const was = snap(from), values = good.map((p) => snap(p.value))
		// the undo goes after what the array held, which is left as it was
		const mine: Patch = { path: ["mine"], value: { held: 1 } }
		const undo: Patch[] = [mine]
		const out = apply(from, good, { list, undo })
		assertStrictEquals(undo[0], mine, at)
		assertEquals(mine, { path: ["mine"], value: { held: 1 } }, at)
		const u = undo.slice(1)
		assertEquals(show(u), show(invert(from, good, o)), `${at}: as invert's`)
		assertEquals(differ(from, was, true), "", `${at}: the value given changed`)
		good.forEach((p, i) =>
			assertEquals(differ(p.value, values[i], true), "", `${at}: patch ${i}`)
		)
		// back, then the undo's own undo forward again
		const outWas = snap(out), uWas = snap(u)
		const back = apply(out, u, o)
		assertEquals(differ(back, norm(from, list)), "", `${at}: back\nundo ${show(u)}`)
		const redo = invert(out, u, o)
		const again = apply(back, redo, o)
		assertEquals(differ(again, out), "", `${at}: redo\nundo ${show(u)}\nredo ${show(redo)}`)
		// what the undo holds is shared with the value: nothing above changed either
		assertEquals(differ(out, outWas, true), "", `${at}: the value after changed`)
		assertEquals(differ(u, uWas, true), "", `${at}: the undo changed`)
		assertEquals(differ(from, was, true), "", `${at}: the value given changed, later`)
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, a refused batch leaves the undo array as it was`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 100)
		const list = seed % 4 === 0, o = { list }
		const from = start(pick, list)
		const { good, bad } = batch(pick, from, list)
		const was = snap(from)
		// the array already holds an undo, made from these same patches
		const held: Patch[] = []
		apply(from, good, { list, undo: held })
		const heldWas = snap(held)
		for (const [k, p] of bad) {
			const ps = [...good.slice(0, k), p, ...good.slice(k)]
			const at = `seed ${seed}: refused at ${k}: ${show(p)}`
			const undo = held.slice()
			const e = assertThrows(() => apply(from, ps, { list, undo }), ApplyError) as ApplyError
			assertEquals(e.patch, k, at)
			assertEquals(undo.length, held.length, at)
			undo.forEach((x, i) => assertStrictEquals(x, held[i], `${at}: undo ${i}`))
			assertEquals(differ(held, heldWas, true), "", `${at}: what it held changed`)
			assertEquals(differ(from, was, true), "", `${at}: the value given changed`)
			// and the same refusal without the option
			const plain = assertThrows(() => apply(from, ps, o), ApplyError) as ApplyError
			assertEquals([plain.code, plain.patch], [e.code, e.patch], at)
		}
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, one call as one call each; each call's undo, joined, goes back`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 200)
		const list = seed % 3 === 0, o = { list }
		const from = start(pick, list)
		const { good, end } = batch(pick, from, list)
		const at = `seed ${seed} (list ${list}): ${show(from)}\n${show(good)}`
		// one call each, and each call's undo
		// the list option: a call's nothing starts the next as []; in one call, nothing there takes
		// only a put at [], which ends the same
		let v = from
		const undos: Patch[][] = [], befores: unknown[] = []
		for (const p of good) {
			befores.push(v)
			const undo: Patch[] = []
			v = apply(v, [p], { list, undo })
			undos.push(undo)
		}
		assertEquals(differ(v, end, true), "", `${at}: one call each`)
		// the undos, last call's first, take the end back to each value before
		let back = v
		for (let i = good.length - 1; i >= 0; i--) {
			back = apply(back, undos[i], o)
			assertEquals(differ(back, norm(befores[i], list)), "", `${at}: back before patch ${i}`)
		}
		// the undos joined, last call's first, are one call's undo's effect
		const joined = undos.slice().reverse().flat()
		assertEquals(differ(apply(end, joined, o), norm(from, list)), "", `${at}: joined`)
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, a batch split anywhere: the two calls end where one does`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 300)
		const list = seed % 3 === 0, o = { list }
		const from = start(pick, list)
		const { good, end } = batch(pick, from, list)
		for (let tries = 0; tries < 4; tries++) {
			const k = pick(good.length + 1)
			const mid = apply(from, good.slice(0, k), o)
			const at = `seed ${seed} split at ${k}`
			const u1: Patch[] = [], u2: Patch[] = []
			apply(from, good.slice(0, k), { list, undo: u1 })
			const two = apply(mid, good.slice(k), { list, undo: u2 })
			assertEquals(differ(two, end, true), "", at)
			// the second call's undo, then the first's
			assert(differ(apply(apply(two, u2, o), u1, o), norm(from, list)) === "", at)
		}
	}
})
