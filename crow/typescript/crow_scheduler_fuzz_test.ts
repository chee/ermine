// crow wired to a scheduler with crowify (handed: the value at a key's path, as places gives it),
// a few dozen seeds: computations read paths of one entry (nested maps, lists, typed arrays) and
// keep what they read (alone, wrapped, in a map they make that holds it twice, a number from it),
// hand it on (a computation whose result another reads), or throw; effects keep it too. the host
// writes, unwrites and reads between pulses. checked after every step: what a run kept, a set was
// given, an effect acted on, a read gave, an undo holds, never changes; the value is what
// copy-on-write apply gives.
// off by default, each a way a value held changes (crow_scheduler_fuzz_test.ts --set, --async,
// --run, run as a program, says what it finds): a set that writes the entry (it is given the
// result before the run's end lets go of it), an async computation (what it read before its
// await, written while it waits), a run that writes the entry after it read (its own write, in
// place: what it returns is taken as it is at its return, so that write shows in it)
import { assert } from "@std/assert"
import createEntry, { type Entry } from "@ermine/graph/entry"
import apply, { ApplyError, type Key, type Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { rand } from "../../conformance/typescript/rand.ts"
import { at, container, show, sorted } from "./model_harness.ts"
import { made, patch, paths } from "./random_harness.ts"
import { createCrow } from "./crow.ts"
import { crowify, updateEntry } from "@ermine/places/crowify"

const h = () => ({ time: 1, actor: "host", frame: { info: {}, parent: undefined } })
const SEEDS = Number(Deno.env.get("SEEDS") ?? 30)
type Ways = { set?: boolean; async?: boolean; run?: boolean }

export async function world(seed: number, ways: Ways = {}): Promise<string | undefined> {
	const p = rand(seed)
	const u = createCrow()
	const s = createScheduler()
	const start = { a: made(p, 3), b: [made(p, 2), { c: made(p, 2) }], t: new Int16Array([1, 2]) }
	const e: Entry<unknown> = createEntry<unknown>(structuredClone(start), h())
	let oracle: unknown = structuredClone(start)
	// a key per path read; handed: the value there now
	const keys = new Map<string, { path: Key[] }>()
	const keyOf = (path: Key[]) => {
		const id = JSON.stringify(path)
		let k = keys.get(id)
		if (!k) keys.set(id, k = { path })
		return k
	}
	crowify(s, u, (key) => {
		const k = [...keys.values()].find((x) => x === key)
		return k ? at(e.value, k.path) : undefined
	})
	const held: { thing: unknown; was: string; what: string }[] = []
	const hold = (thing: unknown, what: string) => {
		if (container(thing)) held.push({ thing, was: show(thing), what })
	}
	s.onRunEnd((_c, _n, _ended, _reads, more) => {
		if ("kept" in more) hold(more.kept, "a run's kept")
	})
	const write = (ps: Patch[]) => {
		let next: unknown
		try {
			next = apply(oracle, ps)
		} catch (x) {
			if (x instanceof ApplyError) return false
			throw x
		}
		updateEntry(u, e, ps, h())
		oracle = next
		hold(ps, "a write's patches")
		hold(e.change.op!.undo, "an undo")
		// the keys whose paths a patch touches (one above or under the other) said changed
		const near = (a: readonly Key[], b: readonly Key[]) =>
			a.slice(0, Math.min(a.length, b.length)).every((k, i) => k === b[i])
		s.mark(
			[...keys.values()].filter((k) =>
				ps.some((x) => near(k.path, x.path) || (x.move && near(k.path, x.move.path)))
			),
		)
		return true
	}
	const read = (path: Key[]) => (s.track(keyOf(path)), at(e.value, path))
	// a run's result as it was made, right after the read (again at its return, after its own
	// writes): what its set or effect is given must be that (one while it awaits must not show)
	const results = new WeakMap<object, string>()
	let resulted: object[] = []
	const result = <T>(r: T): T => (container(r) && (results.set(r, show(r)), resulted.push(r)), r)
	const given = (v: unknown, what: string) => {
		if (container(v) && results.has(v) && results.get(v) !== show(v)) {
			broke ??= `${what} not what the run made: ${results.get(v)} → ${show(v)}`
		}
		hold(v, what)
	}
	let broke: string | undefined
	const scope = s.createRootScope({ actor: "reader" })
	const gates: (() => void)[] = []
	const all = paths(e.value)
	// a computation handing on what it read: another reads its result
	let middle: { value?: unknown; key: object } = { key: {} }
	for (let i = 0; i < 3 + p(6); i++) {
		const path = all[p(all.length)]
		const how = p(ways.async ? 8 : 7)
		const f = (): unknown => {
			resulted = []
			const v = read(path)
			let r: unknown
			switch (how) {
				case 0:
				case 6:
					r = result(v)
					break
				case 1:
					r = result([v])
					break
				case 2:
					r = result({ x: v, y: [v] })
					break
				case 3:
					r = typeof v === "number" ? v : JSON.stringify(show(v)).length
					break
				case 4:
					throw new Error("a run that throws")
				case 5:
					// handed on: another computation reads what this one gave its set
					s.track(middle.key)
					r = result({ from: middle.value, v })
					break
				default: {
					const w = result([v])
					r = new Promise((resolve) => gates.push(() => resolve(w)))
				}
			}
			if (ways.run && p(2)) {
				const ps = [patch(p, e.value)]
				try {
					apply(oracle, ps)
					write(ps)
				} catch { /* refused: not written */ }
				for (const x of resulted) results.set(x, show(x))
			}
			return r
		}
		s.runWithScope(scope, () => {
			if (how === 6) s.createEffect(f, (v) => given(v, "an effect acted on"))
			else {
				s.createComputer(f, (v) => {
					given(v, "a set was given")
					if (ways.set && p(2)) {
						const ps = [patch(p, e.value)]
						try {
							apply(oracle, ps)
							write(ps)
						} catch { /* refused */ }
					}
					if (how !== 5 && p(4) === 0) {
						middle.value = v
						s.mark([middle.key])
					}
				})
			}
		})
	}
	middle = { ...middle }
	s.pulse()
	for (let step = 0; step < 60; step++) {
		const k = p(10)
		if (k < 6) write(Array.from({ length: 1 + p(2) }, () => patch(p, e.value)))
		else if (k === 6) {
			const undo = e.change.op?.undo
			if (undo) write([...undo])
		} else if (k === 7) {
			u.letGo(e)
			hold(e.value, "a host's read")
		} else if (k === 8) {
			// what waits lands
			for (const g of gates.splice(0)) g()
			await new Promise((r) => setTimeout(r, 0))
		}
		if (p(2)) s.pulse()
		if (broke) return `seed ${seed}, step ${step}: ${broke}`
		if (sorted(e.value) !== sorted(oracle)) {
			return `seed ${seed}, step ${step}: value is not apply's`
		}
		for (const x of held) {
			const now = show(x.thing)
			if (now !== x.was) {
				return `seed ${seed}, step ${step}: ${x.what} changed: ${x.was} → ${now}`
			}
		}
	}
}

if (import.meta.main) {
	const ways: Ways = {
		set: Deno.args.includes("--set"),
		async: Deno.args.includes("--async"),
		run: Deno.args.includes("--run"),
	}
	let bad = 0
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = await world(seed, ways)
		if (r) bad++, bad <= 3 && console.log(r)
	}
	console.log(`${JSON.stringify(ways)}: ${bad} of ${SEEDS} seeds broke`)
}

Deno.test("crow through a scheduler: what runs keep, sets are given, effects act on never changes", async () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const r = await world(seed)
		assert(r === undefined, r)
	}
})
