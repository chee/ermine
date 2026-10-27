// boundaries over the scheduler: what each kind catches, the nearest only, what passes through,
// letting go, a computation going, a boundary going, and what no boundary catches
import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import { createBoundaries } from "./boundaries.ts"
import { type Computer, createScheduler, PENDING, type Scope } from "./scheduler.ts"

// a scheduler over a little store, boundaries over it, and a root scope
function setup() {
	const s = createScheduler()
	const b = createBoundaries(s)
	const store = new Map<string, unknown>()
	const write = (key: string, v: unknown) => (store.set(key, v), s.mark([key]))
	const get = (key: string) => (s.track(key), store.get(key))
	const o = s.createRootScope({ actor: "test" })
	const at = <T>(scope: Scope, f: () => T) => s.runWithScope(scope, f)
	const scope = (up: Scope = o) => s.createScope({ why: "test" }, up)
	// a compute reading key: PENDING while it holds "wait", a throw while it holds "fail"
	const compute = (up: Scope, key: string) =>
		at(up, () =>
			s.createComputer(() => {
				const v = get(key)
				if (v === "wait") return PENDING
				if (v === "fail") throw new Error("failed")
				return v
			}, () => {}))
	return { s, b, write, get, o, at, scope, compute }
}

const computers = (list: readonly { computer: Computer }[]) => list.map((x) => x.computer)

Deno.test("a loading boundary holds what under it ended pending, and lets go when it is done", () => {
	const { s, b, write, o, scope, compute } = setup()
	const panel = scope(o)
	const loading = b.loading(panel)
	let told = 0
	loading.on(() => void told++)
	write("k", "wait")
	const c = compute(scope(panel), "k")
	s.pulse()
	assertEquals(computers(loading.caught()), [c])
	assertEquals(told, 1)
	write("k", 1)
	s.pulse()
	assertEquals(loading.caught(), [])
	assertEquals(told, 2)
})

Deno.test("only the nearest boundary of a kind catches", () => {
	const { s, b, write, o, scope, compute } = setup()
	const outer = scope(o)
	const inner = scope(outer)
	const far = b.loading(outer)
	const near = b.loading(inner)
	write("k", "wait")
	const c = compute(inner, "k")
	const d = compute(outer, "k")
	s.pulse()
	assertEquals(computers(near.caught()), [c])
	assertEquals(computers(far.caught()), [d])
})

Deno.test("a failure passes a loading boundary up to an errored one; pending passes an errored one", () => {
	const { s, b, write, o, scope, compute } = setup()
	const errors = scope(o)
	const errored = b.errored(errors)
	const loads = scope(errors)
	const loading = b.loading(loads)
	write("k", "fail")
	write("j", "wait")
	const c = compute(loads, "k")
	s.pulse()
	assertEquals(computers(errored.caught()), [c])
	assertEquals((errored.caught()[0].error as Error).message, "failed")
	assertEquals(loading.caught(), [])
	// under an errored boundary only: pending goes up past it, to nothing
	const d = compute(errors, "j")
	s.pulse()
	assertEquals(computers(errored.caught()), [c])
	assertEquals(loading.caught(), [])
	// c now pending: it moves from the errored boundary to the loading one
	write("k", "wait")
	s.pulse()
	assertEquals(errored.caught(), [])
	assertEquals(computers(loading.caught()), [c])
	assertStrictEquals(d.state, "alive")
})

Deno.test("an act that throws is caught by an errored boundary, and let go by a run that ends done", () => {
	const { s, b, write, get, o, at, scope } = setup()
	const errors = scope(o)
	const errored = b.errored(errors)
	write("k", 1)
	const e = at(errors, () =>
		s.createEffect(() => get("k"), (v) => {
			if (v === 1) throw new Error("act")
		}))
	s.pulse()
	assertEquals(computers(errored.caught()), [e])
	assertEquals((errored.caught()[0].error as Error).message, "act")
	write("k", 2)
	s.pulse()
	assertEquals(errored.caught(), [])
})

Deno.test("a computation that goes is let go; a boundary whose scope goes catches nothing more", () => {
	const { s, b, write, o, scope, compute } = setup()
	const panel = scope(o)
	const loading = b.loading(panel)
	const part = scope(panel)
	write("k", "wait")
	compute(part, "k")
	s.pulse()
	assertEquals(loading.caught().length, 1)
	s.teardown(part)
	assertEquals(loading.caught(), [])
	// the boundary's scope goes: what is pending under a new one is caught by nothing
	const outer = b.loading(o)
	const inner = scope(o)
	const gone = b.loading(inner)
	s.teardown(inner)
	assertEquals(gone.caught(), [])
	const c = compute(scope(o), "k")
	s.pulse()
	assertEquals(computers(outer.caught()), [c])
})

Deno.test("a boundary on a computation lasts through its runs", () => {
	const { s, b, write, get, o, at, compute } = setup()
	write("k", 1)
	write("j", "wait")
	let inner: Computer | undefined
	const host = at(o, () =>
		s.createComputer(() => {
			get("k")
			// made in each run: torn down before the next
			inner = compute(s.getCurrentScope()!, "j")
			return get("k")
		}, () => {}))
	const loading = b.loading(host)
	s.pulse()
	s.pulse()
	assertEquals(computers(loading.caught()), [inner!])
	write("k", 2)
	s.pulse()
	s.pulse()
	assertEquals(computers(loading.caught()), [inner!])
})

Deno.test("what no boundary catches is as it was: told, nothing more", () => {
	const { s, b, write, o, scope, compute } = setup()
	const loading = b.loading(scope(o))
	write("k", "wait")
	write("j", "fail")
	const ended: string[] = []
	s.onRunEnd((_c, _n, how) => void ended.push(how))
	compute(o, "k")
	compute(o, "j")
	s.pulse()
	assertEquals(ended, ["pending", "failed"])
	assertEquals(loading.caught(), [])
})

Deno.test("a pending promise is held until it lands", async () => {
	const { s, b, get, o, at, scope } = setup()
	const panel = scope(o)
	const loading = b.loading(panel)
	let resolve!: (v: number) => void
	const c = at(panel, () =>
		s.createComputer(() => {
			get("k")
			return new Promise<number>((r) => (resolve = r))
		}, () => {}))
	let landed = false
	s.onSettle(() => void (landed = true))
	s.pulse()
	assertEquals(computers(loading.caught()), [c])
	resolve(1)
	await Promise.resolve()
	assertEquals(landed, true)
	s.pulse()
	assertEquals(loading.caught(), [])
})

Deno.test("a list given out stays as it was", () => {
	const { s, b, write, o, scope, compute } = setup()
	const panel = scope(o)
	const loading = b.loading(panel)
	write("k", "wait")
	compute(panel, "k")
	s.pulse()
	const before = loading.caught()
	write("k", 1)
	s.pulse()
	assertEquals(before.length, 1)
	assertEquals(loading.caught(), [])
})

Deno.test("listeners are told once after a pulse, however much changed in it; between pulses, after the next", () => {
	const { s, b, write, o, scope, compute } = setup()
	const panel = scope(o)
	const loading = b.loading(panel)
	let told = 0
	loading.on(() => void (told++, loading.caught()))
	write("k", "wait")
	const part = scope(panel)
	for (let i = 0; i < 3; i++) compute(part, "k")
	s.pulse()
	assertEquals([told, loading.caught().length], [1, 3])
	// a pulse that changes nothing it holds: not told
	s.pulse()
	assertEquals(told, 1)
	// torn down between pulses: what it holds changes at once, told after the next pulse
	s.teardown(part)
	assertEquals([told, loading.caught().length], [1, 0])
	s.pulse()
	assertEquals(told, 2)
})

Deno.test("a listener that throws: every other boundary's listeners are told all the same, then it comes out of the pulse", () => {
	const { s, b, write, o, scope, compute } = setup()
	const one = scope(o), two = scope(o)
	b.loading(one).on(() => {
		throw new Error("boom")
	})
	let told = 0
	b.loading(two).on(() => void told++)
	write("k", "wait")
	compute(one, "k")
	compute(two, "k")
	assertThrows(() => s.pulse(), Error, "boom")
	assertEquals(told, 1)
	compute(two, "k")
	s.pulse()
	assertEquals(told, 2)
})
