// crow wired to a scheduler with crowify and places, a few dozen seeds, on random values and patches
// (crow/typescript/random_harness.ts): computations read paths and keep what they read (alone, in a
// list, or only a number from it); results walked whole, or stopped at what each run was handed;
// after every pulse each holds what a read now gives, and nothing one kept has changed since
import { assertEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/graph/entry"
import apply from "@ermine/changeable/apply"
import { createCrow } from "@ermine/crow"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable } from "@ermine/graph/table"
import { rand } from "../../conformance/typescript/rand.ts"
import { isMap, made, patch, paths } from "../../crow/typescript/random_harness.ts"
import { at as read, createPlaces, type Places } from "./places.ts"
import { createChangeHeader } from "./header.ts"
import { crowify, updateEntry } from "./crowify.ts"

// a root with names, so most paths are into something
const start = (p: (n: number) => number) => {
	const v = made(p, 3)
	return isMap(v) ? v : { a: v, b: made(p, 2), c: made(p, 2) }
}

Deno.test("crowify: through places and a scheduler with crowify, what a computation keeps never changes, at random", () => {
	for (let seed = 1; seed <= 30; seed++) {
		const p = rand(seed)
		const u = createCrow()
		const s = createScheduler()
		// odd seeds walk results whole; even ones stop at what the run was handed, as a host wires it
		crowify(
			s,
			u,
			seed % 2 ? undefined : (key) => {
				const where = places.describe(key)
				return where?.path
					? read(table.get(where.part, where.id)?.value, where.path)
					: undefined
			},
		)
		s.onTrackingEnd((key) => places.release(key))
		const table = createTable((part, id) => places.onTableChange(part, id))
		const places: Places = createPlaces({
			root: "R",
			table,
			paths: createPaths(),
			scheduler: s,
		})
		const host = s.createRootScope({ actor: "host" })
		const header = () => s.runWithScope(host, () => createChangeHeader(s))
		table.sub("value", "N", createEntry(start(p), header()) as never)
		const e = table.get("value", "N")! as Entry<unknown>
		// a computation: reads a path, keeps it alone, in a list, or only a number from it
		type Watch = { path: (string | number)[]; how: number; kept?: unknown; was?: unknown }
		const watches: Watch[] = []
		const shape = (w: Watch, x: unknown) =>
			w.how === 0 ? x : w.how === 1 ? [x] : JSON.stringify(x ?? null).length
		for (let i = 0; i < 8; i++) {
			const ps = paths(e.value)
			const w: Watch = { path: ps[p(ps.length)], how: p(3) }
			watches.push(w)
			s.runWithScope(
				s.createRootScope({ actor: "reader" }),
				() =>
					s.createComputer(
						() => shape(w, places.readValue("value", "N", w.path)),
						(v) => void (w.kept = v, w.was = structuredClone(v)),
					),
			)
		}
		s.pulse()
		for (let step = 0; step < 50; step++) {
			const where = `seed ${seed}, step ${step}`
			const ps = Array.from({ length: 1 + p(2) }, () => patch(p, e.value))
			let ok = true
			try {
				apply(e.value, ps)
			} catch {
				ok = false
			}
			if (ok) {
				updateEntry(u, e, ps, header())
				places.commit([e])
			}
			s.pulse()
			for (const w of watches) {
				assertEquals(w.kept, w.was, `${where}: what ${JSON.stringify(w.path)}'s reader kept`)
				assertEquals(w.kept, shape(w, read(e.value, w.path)), `${where}: told`)
			}
		}
	}
})
