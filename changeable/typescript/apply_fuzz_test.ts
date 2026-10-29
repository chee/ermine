// apply's undo option and batches, where invert's fuzz (invert_test.ts) and the op-apply suite do
// not reach: the undo pushed after what the array held, a refused batch leaving the array as it
// was, the undo's own undo redoing, separate undos joined, and one call as one call each.
// a few dozen seeds (fuzz runs small)
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import apply, { ApplyError, type Patch } from "./apply.ts"
import invert from "./invert.ts"
import { batch, differ, rand, show, snap, start } from "../../places/fuzz/gen_harness.ts"

const SEEDS = 40

// the value as apply has it
const norm = (v: unknown) => apply(v, [])

Deno.test(`apply fuzz: ${SEEDS} seeds, the undo option: after what was there, back and forth`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const from = start(pick)
		const { good } = batch(pick, from)
		const at = `seed ${seed}: ${show(from)}\n${show(good)}`
		const was = snap(from), values = good.map((p) => snap(p.value))
		// the undo goes after what the array held, which is left as it was
		const mine: Patch = { path: ["mine"], value: { held: 1 } }
		const undo: Patch[] = [mine]
		const out = apply(from, good, { undo })
		assertStrictEquals(undo[0], mine, at)
		assertEquals(mine, { path: ["mine"], value: { held: 1 } }, at)
		const u = undo.slice(1)
		assertEquals(differ(u, invert(from, good)), "", `${at}: as invert's`)
		assertEquals(differ(from, was, true), "", `${at}: the value given changed`)
		good.forEach((p, i) =>
			assertEquals(differ(p.value, values[i], true), "", `${at}: patch ${i}`)
		)
		// back, then the undo's own undo forward again
		const outWas = snap(out), uWas = snap(u)
		const back = apply(out, u)
		assertEquals(differ(back, norm(from)), "", `${at}: back\nundo ${show(u)}`)
		const redo = invert(out, u)
		const again = apply(back, redo)
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
		const from = start(pick)
		const { good, bad } = batch(pick, from)
		const was = snap(from)
		// the array already holds an undo, made from these same patches
		const held: Patch[] = []
		apply(from, good, { undo: held })
		const heldWas = snap(held)
		for (const [k, p] of bad) {
			const ps = [...good.slice(0, k), p, ...good.slice(k)]
			const at = `seed ${seed}: refused at ${k}: ${show(p)}`
			const undo = held.slice()
			const e = assertThrows(() => apply(from, ps, { undo }), ApplyError) as ApplyError
			assertEquals(e.patch, k, at)
			assertEquals(undo.length, held.length, at)
			undo.forEach((x, i) => assertStrictEquals(x, held[i], `${at}: undo ${i}`))
			assertEquals(differ(held, heldWas, true), "", `${at}: what it held changed`)
			assertEquals(differ(from, was, true), "", `${at}: the value given changed`)
			// and the same refusal without the option
			const plain = assertThrows(() => apply(from, ps), ApplyError) as ApplyError
			assertEquals([plain.code, plain.patch], [e.code, e.patch], at)
		}
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, one call as one call each; each call's undo, joined, goes back`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 200)
		const from = start(pick)
		const { good, end } = batch(pick, from)
		const at = `seed ${seed}: ${show(from)}\n${show(good)}`
		// one call each, and each call's undo
		let v = from
		const undos: Patch[][] = [], befores: unknown[] = []
		for (const p of good) {
			befores.push(v)
			const undo: Patch[] = []
			v = apply(v, [p], { undo })
			undos.push(undo)
		}
		assertEquals(differ(v, end), "", `${at}: one call each`)
		// the undos, last call's first, take the end back to each value before
		let back = v
		for (let i = good.length - 1; i >= 0; i--) {
			back = apply(back, undos[i])
			assertEquals(differ(back, norm(befores[i])), "", `${at}: back before patch ${i}`)
		}
		// the undos joined, last call's first, are one call's undo's effect
		const joined = undos.slice().reverse().flat()
		assertEquals(differ(apply(end, joined), norm(from)), "", `${at}: joined`)
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, a batch split anywhere: the two calls end where one does`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 300)
		const from = start(pick)
		const { good, end } = batch(pick, from)
		for (let tries = 0; tries < 4; tries++) {
			const k = pick(good.length + 1)
			const mid = apply(from, good.slice(0, k))
			const at = `seed ${seed} split at ${k}`
			const u1: Patch[] = [], u2: Patch[] = []
			apply(from, good.slice(0, k), { undo: u1 })
			const two = apply(mid, good.slice(k), { undo: u2 })
			assertEquals(differ(two, end), "", at)
			// the second call's undo, then the first's
			assert(differ(apply(apply(two, u2), u1), norm(from)) === "", at)
		}
	}
})

Deno.test(`apply fuzz: ${SEEDS} seeds, cow: false gives the same value and undo; refused, it leaves the value as it was`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 400)
		const from = start(pick)
		const { good, bad } = batch(pick, from)
		// in place changes what it is given and what the patches put: it is given copies
		const given = () => ({ v: snap(from), ps: snap(good) as Patch[] })
		const at = `seed ${seed}: ${show(from)}\n${show(good)}`
		const cow: Patch[] = [], place: Patch[] = []
		const want = apply(from, good, { undo: cow })
		const { v, ps } = given()
		const got = apply(v, ps, { undo: place, cow: false })
		assertEquals(differ(got, want), "", `${at}: the value`)
		assertEquals(differ(place, cow), "", `${at}: the undo`)
		// no undo asked for
		const again = given()
		assertEquals(differ(apply(again.v, again.ps, { cow: false }), want), "", at)
		if (v !== null && typeof v === "object" && !ArrayBuffer.isView(v)) {
			if (!good.some((p) => p.path.length === 0 || p.move?.path.length === 0)) {
				assertStrictEquals(got, v, `${at}: the value given`)
			}
		}
		for (const [k, p] of bad) {
			const refused = [...good.slice(0, k), p, ...good.slice(k)]
			const { v: w, ps: qs } = { v: snap(from), ps: snap(refused) as Patch[] }
			const e = assertThrows(() => apply(from, refused), ApplyError) as ApplyError
			const f = assertThrows(() => apply(w, qs, { cow: false }), ApplyError) as ApplyError
			assertEquals([f.code, f.patch], [e.code, e.patch], `${at}: refused at ${k}`)
			assertEquals(differ(w, from), "", `${at}: refused at ${k}: the value`)
			assertEquals(differ(qs, snap(refused)), "", `${at}: refused at ${k}: the patches`)
		}
	}
})
