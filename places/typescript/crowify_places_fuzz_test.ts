// Crow driven as places drives folders: nothing a run kept changes; a folder map copies at most once per burst.
import { assert, assertEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/graph/entry"
import apply, { ApplyError, type Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { rand } from "../../conformance/typescript/rand.ts"
import { show, sorted } from "../../crow/typescript/model_harness.ts"
import { text } from "../../crow/typescript/random_harness.ts"
import { createCrow } from "@ermine/crow"
import { crowify, updateEntry } from "./crowify.ts"

const h = () => ({ time: 1, actor: "host", frame: { info: {}, parent: undefined } })
const SEEDS = Number(Deno.env.get("SEEDS") ?? 30)
type Folder = { e: Entry<unknown>; key: object; oracle: Record<string, string> }
type How = "whole" | "wrap" | "names" | "one" | "throws" | "effect" | "spread"
const HOWS: How[] = ["whole", "wrap", "names", "one", "throws", "effect", "spread"]

export function places(seed: number, n: number, steps: number) {
	const p = rand(seed * 31 + n)
	const u = createCrow()
	const s = createScheduler()
	const folders: Folder[] = Array.from({ length: 1 + p(3) }, (_, f) => {
		const v = Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, `f${f}i${i}`]))
		return { e: createEntry<unknown>({ ...v }, h()), key: {}, oracle: { ...v } }
	})
	const byKey = new Map(folders.map((f) => [f.key as unknown, f]))
	crowify(s, u, (key) => byKey.get(key)?.e.value)
	const held: { thing: unknown; was: string; what: string }[] = []
	const hold = (thing: unknown, what: string) => {
		if (thing !== null && typeof thing === "object") held.push({ thing, was: show(thing), what })
	}
	const keptSince = new Set<Folder>(folders)
	s.onRunEnd((_c, _n, _ended, _reads, more) => {
		if ("kept" in more) hold(more.kept, "a run's kept")
	})
	const scope = s.createRootScope({ actor: "reader" })
	for (let i = 0; i < 2 + p(6); i++) {
		const f = folders[p(folders.length)], how = HOWS[p(HOWS.length)]
		const read = () => (s.track(f.key), f.e.value as Record<string, string>)
		const fn = () => {
			const m = read()
			if (how === "whole") return keptSince.add(f), m
			if (how === "wrap") return keptSince.add(f), { size: Object.keys(m).length, m }
			if (how === "names") return Object.keys(m)
			if (how === "one") return m[`n${p(n + 2)}`] ?? null
			if (how === "spread") return { ...m }
			if (how === "effect") return keptSince.add(f), m
			throw new Error("a run that throws")
		}
		s.runWithScope(scope, () => {
			if (how === "effect") s.createEffect(fn, (v) => hold(v, "an effect acted on"))
			else s.createComputer(fn, (v) => hold(v, "a set was given"))
		})
	}
	s.pulse()
	let copies = 0, writes = 0
	for (let step = 0; step < steps; step++) {
		const where = `seed ${seed}, ${n} names, step ${step}`
		const f = folders[p(folders.length)]
		const names = Object.keys(f.oracle)
		const any = () => names.length && p(4) ? names[p(names.length)] : `new${p(n + 9)}`
		const k = p(10)
		const patch: Patch = k < 4
			? { path: [any()], value: p(2) ? `id${p(1e6)}` : text(p) }
			: k < 6
			? { path: [any()] }
			: k < 9
			? { path: [any()], move: { path: [any()] } }
			: { path: [any()], move: { path: [`missing${p(9)}`] } }
		let next: unknown, refused = false
		try {
			next = apply(f.oracle, [patch])
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
			refused = true
		}
		const root = f.e.value, before = f.oracle
		let threw = false
		try {
			updateEntry(u, f.e, [patch], h())
		} catch (e) {
			if (!(e instanceof ApplyError)) throw e
			threw = true
		}
		assertEquals(threw, refused, `${where}: refused as apply refuses`)
		if (!refused) {
			f.oracle = next as Record<string, string>
			writes++
			if (f.e.value !== root) {
				copies++
				assert(keptSince.has(f), `${where}: copied with nothing kept since the last write`)
			}
			const none = patch.move
				? patch.move.path[0] === patch.path[0]
				: !("value" in patch) && !Object.hasOwn(before, patch.path[0])
			if (!none) keptSince.delete(f)
			s.mark([f.key])
		} else assert(f.e.value === root, `${where}: refused, the same root`)
		assertEquals(sorted(f.e.value), sorted(f.oracle), `${where}: as copy-on-write apply`)
		if (!p(3)) s.pulse()
		for (const x of held) assertEquals(show(x.thing), x.was, `${where}: ${x.what} changed`)
	}
	return { copies, writes }
}

for (const n of [1, 10, 100, 1000, 10000]) {
	Deno.test(`crow as places' folders, ${n} names: what runs keep never changes, copies once per burst`, () => {
		let copies = 0, writes = 0
		const seeds = n >= 10000 ? Math.min(SEEDS, 3) : n >= 1000 ? Math.min(SEEDS, 10) : SEEDS
		for (let seed = 1; seed <= seeds; seed++) {
			const r = places(seed, n, n >= 10000 ? 40 : n >= 1000 ? 60 : 120)
			copies += r.copies, writes += r.writes
		}
		console.log(`${n} names: ${writes} writes landed, ${copies} copied`)
	})
}
