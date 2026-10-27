// createSelector and the keyed index (selector.ts)
import { assertEquals } from "@std/assert"
import { createScheduler } from "./scheduler.ts"
import { createSelector, keyed } from "./selector.ts"

function setup() {
	const s = createScheduler()
	const root = s.createRootScope({ actor: "test" })
	const host = s.createRootScope({ actor: "host" })
	const store = { current: "a" }
	const cur = {}
	const source = () => (s.track(cur), store.current)
	const isSelected = s.runWithScope(root, () => createSelector(s, source))
	const move = (to: string) => {
		store.current = to
		s.runWithScope(host, () => s.mark([cur], undefined))
		s.pulse()
	}
	const reader = (key: string) => {
		const r = { runs: 0, values: [] as boolean[] }
		const c = s.runWithScope(
			root,
			() => s.createComputer(() => (r.runs++, isSelected(key)), (v) => void r.values.push(v)),
		)
		return { ...r, r, c }
	}
	return { s, root, host, isSelected, move, reader }
}

Deno.test("selector: a move from a to b reruns the readers of a and b, not c", () => {
	const w = setup()
	const a = w.reader("a"), b = w.reader("b"), c = w.reader("c")
	w.s.pulse()
	assertEquals([a.r.values, b.r.values, c.r.values], [[true], [false], [false]])
	w.move("b")
	assertEquals([a.r.runs, b.r.runs, c.r.runs], [2, 2, 1])
	assertEquals([a.r.values, b.r.values, c.r.values], [[true, false], [false, true], [false]])
	// a move to what it is: nobody reruns
	w.move("b")
	assertEquals([a.r.runs, b.r.runs, c.r.runs], [2, 2, 1])
	w.move("c")
	assertEquals([a.r.runs, b.r.runs, c.r.runs], [2, 3, 2])
	assertEquals(c.r.values, [false, true])
})

Deno.test("selector: a key is dropped when its readers go, and a read outside a run holds nothing", () => {
	const w = setup()
	assertEquals(w.isSelected("a"), false)
	const a = w.reader("a")
	w.s.pulse()
	assertEquals(w.isSelected("a"), true)
	// a key held by a reader that is torn down: dropped, a later move marks nothing held
	w.s.teardown(a.c)
	const before = keyed(w.s).deliveries()
	w.move("b")
	assertEquals(keyed(w.s).deliveries(), before)
	const again = w.reader("b")
	w.s.pulse()
	assertEquals(again.r.values, [true])
})

Deno.test("selector: a given equal asks every key held", () => {
	const s = createScheduler()
	const root = s.createRootScope({ actor: "test" })
	const cur = {}
	let current = 5
	const evens = s.runWithScope(
		root,
		() =>
			createSelector(
				s,
				() => (s.track(cur), current),
				(k: number, v: number) => k % 2 === v % 2,
			),
	)
	const rs = [1, 2, 3].map((k) => {
		const r = { runs: 0 }
		s.runWithScope(root, () => s.createComputer(() => (r.runs++, evens(k)), () => {}))
		return r
	})
	s.pulse()
	current = 7
	s.runWithScope(root, () => s.mark([cur]))
	s.pulse()
	// 5 and 7 are both odd: nobody changes
	assertEquals(rs.map((r) => r.runs), [1, 1, 1])
	current = 8
	s.runWithScope(root, () => s.mark([cur]))
	s.pulse()
	assertEquals(rs.map((r) => r.runs), [2, 2, 2])
})

Deno.test("selector: a read in an act or a set tracks nothing and holds nothing", () => {
	const w = setup()
	w.s.runWithScope(
		w.root,
		() => w.s.createEffect(() => 1, () => void w.isSelected("z")),
	)
	w.s.runWithScope(
		w.root,
		() => w.s.createComputer(() => 1, () => void w.isSelected("y")),
	)
	w.s.pulse()
	const before = keyed(w.s).deliveries()
	w.move("z")
	w.move("y")
	assertEquals(keyed(w.s).deliveries(), before)
})
