// unread at random, a few dozen seeds each, on random values (maps, lists, strings, typed arrays,
// bytes) and patches (random_harness.ts):
// - one entry against its twin under node's update: the same values, undos and throws; nothing
//   read, kept, put or held by an undo ever changes; and two writes with no read between change
//   the root in place (the first owns it)
// - places and a scheduler wired with keeping (walking results whole, or stopping at what each
//   run was handed): computations read paths and keep what they read (alone, in a list, or only
//   a number from it); after every pulse each holds what a read now gives, and nothing one kept
//   has changed since
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { ApplyError, type Patch } from "@ermine/core/op/apply"
import { at as read, createPlaces, type Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable } from "@ermine/core/table"
import { rand } from "../../../conformance/typescript/rand.ts"
import { above, at, isMap, made, patch, paths } from "./random_harness.ts"
import { createUnread, keeping } from "./unread.ts"

const h = (): ChangeHeader => ({ time: 1, actor: "test" })
// a root with names, so most paths are into something
const start = (p: (n: number) => number) => {
	const v = made(p, 3)
	return isMap(v) ? v : { a: v, b: made(p, 2), c: made(p, 2) }
}

Deno.test("unread: as node's update, nothing held ever changes, and in place when unread, at random", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const p = rand(seed)
		const u = createUnread()
		const v = start(p)
		const e = createEntry<unknown>(structuredClone(v), h())
		const twin = createEntry<unknown>(structuredClone(v), h())
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
					u.update(e, ps, h())
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
			u.update(e, ps, h())
			assertEquals(e.value, twin.value, where)
			assertEquals(e.change.op?.undo, twin.change.op?.undo, `${where}, undo`)
			for (const x of e.change.op!.undo) if ("value" in x) hold(x.value, `${where}, an undo's`)
			// below the root everywhere: the root a write before owned is changed in place
			const below = ps.every((x) => x.path.length > 0 && (!x.move || x.move.path.length > 0))
			if (below && owned !== undefined) {
				assertStrictEquals(e.value, owned, `${where}: unread, so in place`)
			}
			// a write owns the root when it copied it, or it was owned: one that changed nothing (a
			// move onto itself) leaves a read root unowned
			owned = below && (e.value !== root || owned === root) ? e.value : undefined
		}
		for (let step = 0; step < 80; step++) {
			const where = `seed ${seed}, step ${step}`
			const k = p(100)
			if (k < 10) {
				u.read(e)
				hold(e.value, `${where}, a read`)
				owned = undefined
			} else if (k < 22) {
				const ps = paths(e.value)
				const x = at(e.value, ps[p(ps.length)])
				const kept = p(2) ? x : [x]
				u.kept(kept)
				hold(kept, `${where}, kept`)
				if (x === e.value) owned = undefined
			} else if (k < 27) {
				const undo = e.change.op?.undo
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

Deno.test("unread: through places and a scheduler with keeping, what a computation keeps never changes, at random", () => {
	for (let seed = 1; seed <= 30; seed++) {
		const p = rand(seed)
		const u = createUnread()
		const s = createScheduler()
		// odd seeds walk results whole; even ones stop at what the run was handed, as a host wires it
		keeping(
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
				u.update(e, ps, header())
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
