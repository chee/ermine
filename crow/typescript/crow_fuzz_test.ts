// crow at random, a few dozen seeds each, on random values (maps, lists, strings, typed arrays,
// bytes) and patches (random_harness.ts):
// - one root against its twin under update: the same values, undos and throws; nothing
//   read, kept, put or held by an undo ever changes; and two writes with no read between change
//   the root in place (the first owns it)
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import type { ChangeHeader } from "@ermine/changeable"
import update from "@ermine/changeable/update"
import apply, { ApplyError, type Patch } from "@ermine/changeable/apply"
import { rand } from "../../conformance/typescript/rand.ts"
import { above, at, isMap, made, patch, paths } from "./random_harness.ts"
import { createCrow } from "./crow.ts"
import { createRoot, write as writeRoot } from "./root_harness.ts"

const h = (): ChangeHeader => ({ time: 1, actor: "test", frame: { info: {}, parent: undefined } })
// a root with names, so most paths are into something
const start = (p: (n: number) => number) => {
	const v = made(p, 3)
	return isMap(v) ? v : { a: v, b: made(p, 2), c: made(p, 2) }
}

Deno.test("crow: as node's update, nothing held ever changes, and in place when crow, at random", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const p = rand(seed)
		const u = createCrow()
		const v = start(p)
		const e = createRoot(structuredClone(v))
		const twin = { value: structuredClone(v) as unknown, change: h() }
		// what is held (read, kept, put, held by an undo) and what it was then
		const held: [unknown, unknown, string][] = []
		const hold = (x: unknown, what: string) => held.push([x, structuredClone(x), what])
		// the root after the last write that owned it, while nothing has held it since
		let owned: unknown
		const write = (ps: Patch[], where: string) => {
			for (const x of ps) if ("value" in x) hold(x.value, `${where}, a value put`)
			let threw: ApplyError | undefined
			try {
				apply(twin.value, ps)
			} catch (error) {
				threw = error as ApplyError
			}
			const root = e.value, before = threw && structuredClone(e.value)
			if (threw) {
				let error: unknown
				try {
					writeRoot(u, e, ps)
				} catch (x) {
					error = x
				}
				assert(error instanceof ApplyError, `${where}: throws as update does`)
				assertEquals([error.code, error.patch], [threw.code, threw.patch], where)
				assertStrictEquals(e.value, root, `${where}: a throw leaves the root`)
				assertEquals(e.value, before, `${where}: a throw changes nothing`)
				return
			}
			update(twin, ps, h())
			writeRoot(u, e, ps)
			assertEquals(e.value, twin.value, where)
			assertEquals(e.undo, twin.change.op?.undo, `${where}, undo`)
			for (const x of e.undo!) if ("value" in x) hold(x.value, `${where}, an undo's`)
			// below the root everywhere: the root a write before owned is changed in place
			const below = ps.every((x) => x.path.length > 0 && (!x.move || x.move.path.length > 0))
			if (below && owned !== undefined) {
				assertStrictEquals(e.value, owned, `${where}: crow, so in place`)
			}
			// a write owns the root when it copied it, or it was owned: one that changed nothing (a
			// move onto itself) leaves a read root unowned
			owned = below && (e.value !== root || owned === root) ? e.value : undefined
		}
		for (let step = 0; step < 80; step++) {
			const where = `seed ${seed}, step ${step}`
			const k = p(100)
			if (k < 10) {
				u.letGo(e)
				hold(e.value, `${where}, a read`)
				owned = undefined
			} else if (k < 22) {
				const ps = paths(e.value)
				const x = at(e.value, ps[p(ps.length)])
				const kept = p(2) ? x : [x]
				u.letGoIn(kept)
				hold(kept, `${where}, kept`)
				if (x === e.value) owned = undefined
			} else if (k < 27) {
				const undo = e.undo
				if (undo) write([...undo], `${where} (unwrite)`)
			} else if (k < 34) {
				// a put of a container the entry itself made and owns, alone or in a list: the
				// caller's from now (held, and the patch lets go of what is owned in it), so the
				// writes after never change it, though they reach the same spot through the tree
				const ps = paths(e.value)
				const from = ps[1 + p(ps.length - 1)] ?? []
				const x = at(e.value, from)
				const into = ps.filter((q) => !above(from, q))
				if (from.length && typeof x === "object" && x !== null && into.length) {
					const value = p(2) ? x : [x]
					write([{ path: into[p(into.length)], value }], `${where} (put an owned)`)
					// and a write right under what was put, in place if it were still owned
					const under = paths(x)
					write([{ path: [...from, ...under[p(under.length)]], value: made(p, 1) }], where)
				}
			} else {
				write(Array.from({ length: 1 + p(3) }, () => patch(p, e.value)), where)
			}
			for (const [x, was, what] of held) assertEquals(x, was, what)
		}
	}
})
