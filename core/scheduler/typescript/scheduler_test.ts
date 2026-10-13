// the scheduler, where the suite (conformance/scheduler) does not reach: keys of any kind, its
// own equal, sets and cleanups that throw, owners under a computation, the plain read, wake, and
// the sweep
import { assert, assertEquals, assertThrows } from "@std/assert"
import { type Computation, createScheduler, type Moment, SchedulerError } from "./scheduler.ts"

// a scheduler over a little store: write(key, value) keeps it and says it changed
function setup() {
	const moments: Moment[] = []
	const s = createScheduler({ hook: (m) => void moments.push(m) })
	const store = new Map<unknown, unknown>()
	const write = (key: unknown, v: unknown) => {
		store.set(key, v)
		return s.changed([key])
	}
	const get = (key: unknown) => {
		s.read(key)
		return store.get(key)
	}
	const ends = (c: Computation) =>
		moments.filter((m) => "ends" in m && m.ends === c) as Extract<Moment, { ends: unknown }>[]
	return { s, store, write, get, moments, ends, o: s.owner() }
}

Deno.test("keys are opaque, by identity: strings, symbols, objects", () => {
	const { s, o, write, get } = setup()
	const sym = Symbol("k")
	const obj = { k: 1 }
	const seen: unknown[] = []
	s.compute(o, () => [get("k"), get(sym), get(obj)], (v) => void seen.push(v))
	s.pulse()
	write(sym, 1)
	s.pulse()
	write({ k: 1 }, 2) // a look-alike: another key
	s.pulse()
	write(obj, 3)
	s.pulse()
	assertEquals(seen, [[undefined, undefined, undefined], [undefined, 1, undefined], [
		undefined,
		1,
		3,
	]])
})

Deno.test("its own equal: equal results stop there; an equal that throws fails the run", () => {
	const { s, o, write, get, ends } = setup()
	const set: unknown[] = []
	let bad = false
	const c = s.compute(o, () => get("a") as number, (v) => void set.push(v), (x, y) => {
		if (bad) throw new Error("bad equal")
		return x % 10 === y % 10
	})
	write("a", 1)
	s.pulse()
	write("a", 11)
	s.pulse()
	assertEquals(set, [1])
	bad = true
	write("a", 2)
	s.pulse()
	assertEquals(set, [1])
	assertEquals((ends(c).at(-1)!.error as Error).message, "bad equal")
	bad = false
	write("a", 3)
	s.pulse()
	assertEquals(set, [1, 3])
})

Deno.test("a set that throws fails the run; the result is given again the next time", () => {
	const { s, o, write, get, ends } = setup()
	const set: unknown[] = []
	let fail = true
	const c = s.compute(o, () => get("a"), (v) => {
		if (fail) throw new Error("no")
		set.push(v)
	})
	write("a", 1)
	s.pulse()
	assertEquals(ends(c).at(-1)!.ended, "failed")
	fail = false
	write("a", 1)
	s.pulse()
	assertEquals(set, [1])
})

Deno.test("dispose: every cleanup runs, the first error after; one added later runs at once", () => {
	const { s, o } = setup()
	const ran: string[] = []
	const p = s.owner(o)
	s.cleanup(p, () => ran.push("p1"))
	s.cleanup(p, () => {
		ran.push("p2")
		throw new Error("first")
	})
	s.cleanup(o, () => {
		ran.push("o")
		throw new Error("second")
	})
	const e = assertThrows(() => s.dispose(o))
	assertEquals((e as Error).message, "first")
	assertEquals(ran, ["p2", "p1", "o"])
	s.cleanup(p, () => ran.push("late"))
	assertEquals(ran.at(-1), "late")
	assertThrows(() => s.owner(o), SchedulerError, "disposed")
	assertThrows(() => s.compute(o, () => 1, () => {}), SchedulerError)
	assertThrows(() => s.effect(p, () => 1, () => {}), SchedulerError)
})

Deno.test("what is made under a compute goes before its next run", () => {
	const { s, o, write, get } = setup()
	const inner: unknown[] = []
	let made = 0
	const c: Computation = s.compute(o, () => {
		const n = get("a")
		made++
		s.effect(c, () => get("b"), (v) => void inner.push([n, v]))
		return n
	}, () => {})
	write("a", 1)
	write("b", "x")
	s.pulse()
	write("a", 2)
	s.pulse()
	write("b", "y")
	s.pulse()
	// one inner effect at a time: the first went with its compute's second run
	assertEquals(made, 2)
	assertEquals(inner, [[1, "x"], [2, "x"], [2, "y"]])
	assertEquals(c.children.length, 1)
})

Deno.test("read: tracked in a run's synchronous part; outside a run, and in run(), nothing", () => {
	const { s, o, write, store } = setup()
	let runs = 0
	s.read("a") // outside: nothing
	s.compute(o, () => {
		runs++
		s.read("a")
		s.run(o, () => s.read("b"))
		return store.get("a") ?? 0
	}, () => {})
	s.pulse()
	write("b", 1)
	s.pulse()
	assertEquals(runs, 1)
	write("a", 1)
	s.pulse()
	assertEquals(runs, 2)
})

Deno.test("a run's own read after an await throws stopped; the plain read can't tell", async () => {
	const { s, o, ends } = setup()
	let resolve!: () => void
	const gate = new Promise<void>((r) => resolve = r)
	let caught: unknown
	const c = s.compute(o, async (read) => {
		await gate
		try {
			read("a")
		} catch (e) {
			caught = e
		}
		return 1
	}, () => {})
	s.pulse()
	resolve()
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assert(caught instanceof SchedulerError)
	assertEquals(caught.code, "stopped")
	assertEquals(ends(c).map((m) => m.ended), ["pending", "done"])
})

Deno.test("wake: told when a promise settles; its result lands at the next pulse", async () => {
	let woken = 0
	const s = createScheduler({ wake: () => woken++ })
	const o = s.owner()
	const set: number[] = []
	// set's value is the promise's: number
	s.compute(o, () => Promise.resolve(7), (v: number) => void set.push(v))
	s.pulse()
	assertEquals(woken, 0)
	await new Promise((r) => setTimeout(r, 0))
	assertEquals([woken, set], [1, []])
	s.pulse()
	assertEquals(set, [7])
})

Deno.test("a computation disposed while pending: its promise lands nowhere", async () => {
	const { s, o, ends } = setup()
	let woken = false
	let resolve!: (v: number) => void
	const c = s.compute(o, () => new Promise<number>((r) => resolve = r), () => woken = true)
	s.pulse()
	s.dispose(c)
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(woken, false)
	assertEquals(ends(c).map((m) => m.ended), ["pending"])
})

Deno.test("a pulse in a pulse does nothing; the outer one runs what it made due", () => {
	const { s, o, write, get } = setup()
	const seen: unknown[] = []
	s.compute(o, () => get("a"), (v) => {
		write("b", v)
		s.pulse()
	})
	s.effect(o, () => get("b"), (v) => void seen.push(v))
	write("a", 1)
	s.pulse()
	assertEquals(seen, [1])
})

Deno.test("disposed in its own run: its result goes nowhere, and it is told nothing more", () => {
	const { s, o, write, get, ends } = setup()
	const set: unknown[] = []
	const c: Computation = s.compute(o, () => {
		const v = get("a")
		if (v === 2) s.dispose(c)
		return v
	}, (v) => void set.push(v))
	write("a", 1)
	s.pulse()
	write("a", 2)
	s.pulse()
	write("a", 3)
	s.pulse()
	assertEquals(set, [1])
	assertEquals(ends(c).length, 1)
	assertEquals(c.state, "gone")
})

Deno.test("a stop caught by the program is still a stop", () => {
	const { s, o, write, get, ends } = setup()
	write("flag", false)
	const q = s.compute(o, () => {
		if (!get("flag")) return 0
		try {
			return get("w")
		} catch {
			return "caught"
		}
	}, (v) => void write("q", v))
	s.compute(o, () => (get("x") as number ?? 0) + 1, (v) => void write("w", v))
	s.pulse()
	write("flag", true)
	write("x", 5)
	s.pulse()
	assertEquals(ends(q).map((m) => m.ended), ["done", "stopped", "done"])
	assertEquals(s.run(o, () => get("q")), 6)
})

Deno.test("keys nobody reads any more are forgotten, and tracking stays right", () => {
	const { s, o, write, get } = setup()
	let at = 0
	const set: unknown[] = []
	// each run reads the next key: the old ones are left with no readers
	s.compute(o, () => get(`k${at}`) ?? at, (v) => void set.push(v))
	s.pulse()
	for (at = 1; at < 300; at++) {
		write(`k${at - 1}`, undefined)
		s.pulse()
	}
	at = 299
	assertEquals(set.length, 300)
	write("k299", "last")
	s.pulse()
	assertEquals(set.at(-1), "last")
	write("k0", "old")
	s.pulse()
	assertEquals(set.length, 301)
})

Deno.test("a compute's key, given: its reader waits for it from the first pulse", () => {
	// a reader made before its writer: without the key, the reader's first result is from before
	// the writer ran, and it is given again; with it, the reader is given once, the writer's
	for (const declared of [false, true]) {
		const { s, o, write, get } = setup()
		write("a", 1)
		const given: unknown[] = []
		s.compute(o, () => get("b"), (v) => void given.push(v))
		s.compute(
			o,
			() => (get("a") as number) + 1,
			(v) => void write("b", v),
			undefined,
			declared ? "b" : undefined,
		)
		s.pulse()
		assertEquals(given, declared ? [2] : [undefined, 2], declared ? "declared" : "learned")
	}
})
