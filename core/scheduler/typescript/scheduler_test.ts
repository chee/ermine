// the scheduler, where the suite (core/scheduler/conformance/scheduler) does not reach: keys of any kind, its
// own equal, sets and cleanups that throw, scopes under a computation, the plain read, wake, the
// sweep, and scopes: what is open, and nothing after an await
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import {
	type Computation,
	createScheduler,
	type Moment,
	type Pair,
	PENDING,
	SchedulerError,
	type Scope,
	type Writer,
} from "./scheduler.ts"

// a scheduler over a little store: write(key, value, by?) keeps it and says it changed. at(f): f
// under the one root a test makes its computations in
function setup() {
	const moments: Moment[] = []
	const s = createScheduler({ hook: (m) => void moments.push(m) })
	const store = new Map<unknown, unknown>()
	const write = (key: unknown, v: unknown, by?: Writer) => {
		store.set(key, v)
		return s.changed([key], by)
	}
	const get = (key: unknown) => {
		s.read(key)
		return store.get(key)
	}
	const ends = (c: Computation) =>
		moments.filter((m) => "ends" in m && m.ends === c) as Extract<Moment, { ends: unknown }>[]
	const o = s.root()
	const at = <T>(f: () => T) => s.run(o, f)
	return { s, store, write, get, moments, ends, o, at }
}

const unscoped = (f: () => unknown) => {
	const e = assertThrows(f, SchedulerError)
	assertEquals(e.code, "unscoped")
}

Deno.test("a computation's f is given its last result: a compute's last set, an effect's last acted on", () => {
	const { s, at, write, get } = setup()
	write("k", 1)
	// results in the same ten are equal: an equal result is not set, so what is given stays the
	// last one set, not the last result
	const tens = (a: number, b: number) => Math.floor(a / 10) === Math.floor(b / 10)
	const given: unknown[] = []
	at(() =>
		s.compute(
			(previous: number | undefined) => (given.push(previous), get("k") as number),
			() => {},
			tens,
		)
	)
	const acted: unknown[] = []
	at(() =>
		s.effect(
			(previous: number | undefined) => (acted.push(previous), get("k") as number),
			() => {},
			tens,
		)
	)
	for (const k of [5, 12, 13]) {
		s.pulse()
		write("k", k)
	}
	s.pulse()
	assertEquals(given, [undefined, 1, 1, 12])
	assertEquals(acted, [undefined, 1, 1, 12])
})

Deno.test("keys are opaque, by identity: strings, symbols, objects", () => {
	const { s, at, write, get } = setup()
	const sym = Symbol("k")
	const obj = { k: 1 }
	const seen: unknown[] = []
	at(() => s.compute(() => [get("k"), get(sym), get(obj)], (v) => void seen.push(v)))
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
	const { s, at, write, get, ends } = setup()
	const set: unknown[] = []
	let bad = false
	const c = at(() =>
		s.compute(() => get("a") as number, (v) => void set.push(v), (x, y) => {
			if (bad) throw new Error("bad equal")
			return x % 10 === y % 10
		})
	)
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
	const { s, at, write, get, ends } = setup()
	const set: unknown[] = []
	let fail = true
	const c = at(() =>
		s.compute(() => get("a"), (v) => {
			if (fail) throw new Error("no")
			set.push(v)
		})
	)
	write("a", 1)
	s.pulse()
	assertEquals(ends(c).at(-1)!.ended, "failed")
	fail = false
	write("a", 1)
	s.pulse()
	assertEquals(set, [1])
})

Deno.test("dispose: every cleanup runs, the first error after; one added later runs at once", () => {
	const { s, o, at } = setup()
	const ran: string[] = []
	const p = at(() => s.scope())
	s.run(p, () => {
		s.cleanup(() => ran.push("p1"))
		s.cleanup(() => {
			ran.push("p2")
			throw new Error("first")
		})
	})
	at(() =>
		s.cleanup(() => {
			ran.push("o")
			throw new Error("second")
		})
	)
	// a cleanup added in a scope gone while it was open runs at once
	const late = s.scope([], p)
	s.run(late, () => {
		const e = assertThrows(() => s.dispose(o))
		assertEquals((e as Error).message, "first")
		assertEquals(ran, ["p2", "p1", "o"])
		s.cleanup(() => ran.push("late"))
		// nothing made in it now
		assertThrows(() => s.scope(), SchedulerError, "disposed")
		assertThrows(() => s.compute(() => 1, () => {}), SchedulerError, "disposed")
	})
	assertEquals(ran.at(-1), "late")
	// a gone scope is opened by no one, and has nothing made under it
	assertThrows(() => s.run(o, () => {}), SchedulerError, "disposed")
	assertThrows(() => s.scope([], o), SchedulerError, "disposed")
})

Deno.test("what is made under a compute goes before its next run", () => {
	const { s, at, write, get } = setup()
	const inner: unknown[] = []
	let made = 0
	const c: Computation = at(() =>
		s.compute(() => {
			const n = get("a")
			made++
			// in a run, the scope open is the computation
			s.effect(() => get("b"), (v) => void inner.push([n, v]))
			return n
		}, () => {})
	)
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
	const { s, o, at, write, store } = setup()
	let runs = 0
	s.read("a") // outside: nothing
	at(() =>
		s.compute(() => {
			runs++
			s.read("a")
			s.run(o, () => s.read("b"))
			return store.get("a") ?? 0
		}, () => {})
	)
	s.pulse()
	write("b", 1)
	s.pulse()
	assertEquals(runs, 1)
	write("a", 1)
	s.pulse()
	assertEquals(runs, 2)
})

Deno.test("after an await a read counts for nothing; the writer kept from the run's start still names the run", async () => {
	const { s, at, ends, write, get, moments } = setup()
	let resolve!: () => void
	const gate = new Promise<void>((r) => resolve = r)
	const c = at(() =>
		s.compute(async () => {
			const writer = s.current()?.writer
			await gate
			get("a")
			write("w", 1, writer)
			return 1
		}, () => {})
	)
	const b = at(() => s.compute(() => get("w"), () => {}))
	s.pulse()
	resolve()
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(ends(c).map((m) => m.ended), ["pending", "done"])
	assert(moments.some((m) => "due" in m && m.due === b && m.writer === c))
	// a was read after the await: nothing reruns c
	const before = ends(c).length
	write("a", 2)
	s.pulse()
	assertEquals(ends(c).length, before)
})

Deno.test("wake: told when a promise settles; its result lands at the next pulse", async () => {
	let woken = 0
	const s = createScheduler({ wake: () => woken++ })
	const set: number[] = []
	// set's value is the promise's: number
	s.run(s.root(), () => s.compute(() => Promise.resolve(7), (v: number) => void set.push(v)))
	s.pulse()
	assertEquals(woken, 0)
	await new Promise((r) => setTimeout(r, 0))
	assertEquals([woken, set], [1, []])
	s.pulse()
	assertEquals(set, [7])
})

Deno.test("a computation disposed while pending: its promise lands nowhere", async () => {
	const { s, at, ends } = setup()
	let woken = false
	let resolve!: (v: number) => void
	const c = at(() => s.compute(() => new Promise<number>((r) => resolve = r), () => woken = true))
	s.pulse()
	s.dispose(c)
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(woken, false)
	assertEquals(ends(c).map((m) => m.ended), ["pending"])
})

Deno.test("a pulse in a pulse does nothing; the outer one runs what it made due", () => {
	const { s, at, write, get } = setup()
	const seen: unknown[] = []
	at(() => {
		s.compute(() => get("a"), (v) => {
			write("b", v)
			s.pulse()
		})
		s.effect(() => get("b"), (v) => void seen.push(v))
	})
	write("a", 1)
	s.pulse()
	assertEquals(seen, [1])
})

Deno.test("disposed in its own run: its result goes nowhere, and it is told nothing more", () => {
	const { s, at, write, get, ends } = setup()
	const set: unknown[] = []
	const c: Computation = at(() =>
		s.compute(() => {
			const v = get("a")
			if (v === 2) s.dispose(c)
			return v
		}, (v) => void set.push(v))
	)
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
	const { s, o, at, write, get, ends } = setup()
	write("flag", false)
	const q: Computation = at(() =>
		s.compute(() => {
			if (!get("flag")) return 0
			try {
				return get("w")
			} catch {
				return "caught"
			}
		}, (v) => void write("q", v, q))
	)
	const w: Computation = at(() =>
		s.compute(() => (get("x") as number ?? 0) + 1, (v) => {
			write("w", v, w)
		})
	)
	s.pulse()
	write("flag", true)
	write("x", 5)
	s.pulse()
	assertEquals(ends(q).map((m) => m.ended), ["done", "stopped", "done"])
	assertEquals(s.run(o, () => get("q")), 6)
})

Deno.test("keys nobody reads any more are forgotten, and tracking stays right", () => {
	const { s, at, write, get } = setup()
	let i = 0
	const set: unknown[] = []
	// each run reads the next key: the old ones are left with no readers
	at(() => s.compute(() => get(`k${i}`) ?? i, (v) => void set.push(v)))
	s.pulse()
	for (i = 1; i < 300; i++) {
		write(`k${i - 1}`, undefined)
		s.pulse()
	}
	i = 299
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
		const { s, at, write, get } = setup()
		write("a", 1)
		const given: unknown[] = []
		at(() => s.compute(() => get("b"), (v) => void given.push(v)))
		const w: Computation = at(() =>
			s.compute(
				() => (get("a") as number) + 1,
				(v) => void write("b", v, w),
				undefined,
				declared ? "b" : undefined,
			)
		)
		s.pulse()
		assertEquals(given, declared ? [2] : [undefined, 2], declared ? "declared" : "learned")
	}
})

// a pulse past this many runs is endless: the hook throws, and the pulse is left
function bounded(limit = 2000) {
	let runs = 0
	const s = createScheduler({
		hook: (m) => {
			if ("starts" in m && ++runs > limit) throw new Error("endless")
		},
	})
	const store = new Map<unknown, unknown>()
	const write = (key: unknown, v: unknown, by?: Writer) => {
		store.set(key, v)
		return s.changed([key], by)
	}
	const get = (key: unknown) => {
		s.read(key)
		return store.get(key)
	}
	const o = s.root()
	return { s, store, write, get, at: <T>(f: () => T) => s.run(o, f), runs: () => runs }
}

Deno.test("made in an act, under the effect, its set changing what the effect read: the loop ends (C6)", () => {
	const { s, at, write, get, store } = bounded()
	write("k", 1)
	at(() =>
		s.effect(() => get("k") as number, () => {
			const x: Computation = s.compute(
				() => (get("k") as number) + 1,
				(v) => void write("k", v, x),
			)
		})
	)
	s.pulse()
	assertEquals(store.get("k"), 2)
})

Deno.test("a cleanup writing what its computation read, on a plain scope made in the run: the loop ends, as one on the computation does", () => {
	// written by the writer open (current().writer), as a program that knows no more would
	const go = (nested: boolean) => {
		const { s, at, write, get, store, runs } = bounded(50)
		store.set("k", 0)
		at(() =>
			s.compute(() => {
				const k = get("k") as number
				const f = () => void write("k", k + 1, s.current()?.writer)
				if (nested) s.run(s.scope(), () => s.cleanup(f))
				else s.cleanup(f)
				return 0
			}, () => {})
		)
		s.pulse()
		write("k", 100)
		s.pulse()
		return [runs(), store.get("k")]
	}
	assertEquals(go(false), [3, 2])
	assertEquals(go(true), [3, 2])
})

Deno.test("what an effect's runs make goes before its next run: equal results pile nothing up (D3)", () => {
	const { s, at, write, get } = setup()
	const e: Computation = at(() =>
		s.effect(() => {
			get("k")
			s.scope()
			return 0
		}, () => {})
	)
	for (let i = 0; i < 5; i++) {
		write("k", i)
		s.pulse()
	}
	assertEquals(e.children.length, 1)
})

Deno.test("what an act makes stays until the next act, though the effect runs again in between", () => {
	const { s, at, write, get } = setup()
	const undone: unknown[] = []
	const e: Computation = at(() =>
		s.effect(() => (get("k") as number) % 2, (v) => {
			s.cleanup(() => void undone.push(v))
			s.scope()
		})
	)
	write("k", 1)
	s.pulse()
	write("k", 3)
	s.pulse()
	assertEquals([undone, e.children.length], [[], 1])
	write("k", 2)
	s.pulse()
	assertEquals([undone, e.children.length], [[1], 1])
})

Deno.test("a set that writes and then throws: its next result is given to set, equal or not", () => {
	const { s, at, write, get, store } = setup()
	let fail = false
	const c: Computation = at(() =>
		s.compute(() => get("a"), (v) => {
			write("out", v, c)
			if (fail) throw new Error("half")
		})
	)
	write("a", 0)
	s.pulse()
	fail = true
	write("a", 1)
	s.pulse()
	assertEquals(store.get("out"), 1)
	fail = false
	write("a", 0)
	s.pulse()
	assertEquals(store.get("out"), 0)
})

Deno.test("changed with a writer: the run, from current().writer, names that run; without one, the change is outside", () => {
	for (const named of [true, false]) {
		const { s, at, write, get, moments } = setup()
		write("x", 1)
		// a writes w in its run; b reads w
		const a = at(() =>
			s.compute(() => {
				write("w", get("x"), named ? s.current()?.writer : undefined)
				return 0
			}, () => {})
		)
		const b = at(() => s.compute(() => get("w"), () => {}))
		s.pulse()
		write("x", 2)
		s.pulse()
		const by = moments.flatMap((m) => "due" in m && m.due === b ? [m.writer === a] : [])
		const ranks = moments.flatMap((m) => "starts" in m && m.starts === b ? [m.rank] : [])
		// named: a is w's writer, so b ranks after it
		assertEquals([by, ranks], named ? [[false, true], [0, 1]] : [[false, false], [0, 0]])
	}
})

Deno.test("made in a run known to loop, its set changing what that run read: the loop ends", () => {
	const { s, at, store, runs } = bounded()
	store.set("k", 0)
	// each run makes a compute whose set says k changed, its value the same
	at(() =>
		s.compute(() => {
			s.read("k")
			const c: Computation = s.compute(() => 0, (v) => {
				store.set("k", v)
				s.changed(["k"], c)
			})
			return store.get("k")
		}, () => {})
	)
	s.pulse()
	assert(runs() < 10, `${runs()} runs`)
})

Deno.test("a compute that throws PENDING is pending: nothing set, its last result kept", () => {
	const { s, at, write, get, ends } = setup()
	const set: unknown[] = []
	const c = at(() =>
		s.compute(() => {
			const v = get("x")
			if (v === 0) throw PENDING
			return v
		}, (v) => void set.push(v))
	)
	write("x", 1)
	s.pulse()
	write("x", 0)
	s.pulse()
	write("x", 1)
	s.pulse()
	assertEquals(set, [1])
	assertEquals(ends(c).map((m) => [m.ended, m.equal]), [
		["done", false],
		["pending", undefined],
		["done", true],
	])
})

Deno.test("pending through reads: a read of something pending throws it, and every compute above is pending; the value comes, they all land", () => {
	// a host keeping pending places as ermine will: a compute's run ending pending makes its key
	// pending, and any other end makes it not; each said changed. a read of a pending key throws
	const store = new Map<unknown, unknown>()
	const pending = new Set<unknown>()
	const keyOf = new Map<Computation, string>()
	const s = createScheduler({
		hook: (m) => {
			if (!("ends" in m) || m.ended === "stopped" || !keyOf.has(m.ends)) return
			const k = keyOf.get(m.ends)!
			if ((m.ended === "pending") === pending.has(k)) return
			if (m.ended === "pending") pending.add(k)
			else pending.delete(k)
			s.changed([k], m.ends)
		},
	})
	const get = (key: unknown) => {
		s.read(key)
		if (pending.has(key)) throw PENDING
		return store.get(key) as number
	}
	const runs = new Map<string, number>()
	// c1 reads x; c2 reads c1; c3 reads c2: each adds one, and only reads
	const chain = (name: string, from: string) => {
		const c: Computation = s.compute(() => {
			runs.set(name, (runs.get(name) ?? 0) + 1)
			return get(from) + 1
		}, (v) => {
			store.set(name, v)
			s.changed([name], c)
		})
		keyOf.set(c, name)
	}
	s.run(s.root(), () => {
		chain("c1", "x")
		chain("c2", "c1")
		chain("c3", "c2")
	})
	store.set("x", 1)
	s.pulse()
	assertEquals([store.get("c3"), [...pending]], [4, []])
	// x is pending: only c1's read throws
	pending.add("x")
	s.changed(["x"])
	s.pulse()
	assertEquals([store.get("c3"), [...pending].sort()], [4, ["c1", "c2", "c3", "x"]])
	// the value comes
	pending.delete("x")
	store.set("x", 10)
	s.changed(["x"])
	s.pulse()
	assertEquals([store.get("c1"), store.get("c2"), store.get("c3"), [...pending]], [11, 12, 13, []])
	assertEquals([...runs.values()], [3, 3, 3])
})

// scopes: what is open

Deno.test("scope: nothing open: no scope; making a scope, a computation or a cleanup is unscoped", () => {
	const s = createScheduler()
	assertEquals(s.current(), undefined)
	unscoped(() => s.scope())
	unscoped(() => s.compute(() => 1, () => {}))
	unscoped(() => s.effect(() => 1, () => {}))
	unscoped(() => s.cleanup(() => {}))
	// a root is made with nothing open
	assertEquals(s.root().parent, undefined)
})

Deno.test("scope: one tree: a write's pairs are the info of each scope from the root down, repeats kept", () => {
	const s = createScheduler()
	const chee = s.root([["actor", "chee"]])
	const app = s.scope([["app", "notes"], ["actor", "notes"]], chee)
	const seen: unknown[] = []
	s.run(app, () => {
		const save = s.scope([["why", "save"]])
		assertStrictEquals(save.parent, app)
		s.run(save, () => seen.push(s.current()!.pairs))
		seen.push(s.current()!.pairs)
	})
	assertEquals(seen, [
		[["actor", "chee"], ["app", "notes"], ["actor", "notes"], ["why", "save"]],
		[["actor", "chee"], ["app", "notes"], ["actor", "notes"]],
	])
	// the owner too: disposing the root takes all of it
	s.dispose(chee)
	assertEquals(app.state, "gone")
	assertThrows(() => s.run(app, () => {}), SchedulerError, "disposed")
})

Deno.test("scope: run(o, f) opens o for f, the one before back after; a throw too", () => {
	const s = createScheduler()
	const a = s.root([["a", 1]]), b = s.root([["b", 2]])
	s.run(a, () => {
		s.run(b, () => assertStrictEquals(s.current()!.scope, b))
		assertStrictEquals(s.current()!.scope, a)
		assertThrows(() => s.run(b, () => assert(false)))
		assertStrictEquals(s.current()!.scope, a)
	})
	assertEquals(s.current(), undefined)
})

Deno.test("scope: a run opens its computation, its info the run's, written by the run; a set and an act by the computation", () => {
	const { s, at, write, get } = setup()
	const seen: Record<string, ReturnType<typeof s.current>> = {}
	let c!: Computation, e!: Computation
	let own!: unknown
	const notes = at(() => s.scope([["actor", "notes"]]))
	s.run(notes, () => {
		c = s.compute(() => {
			own = s.current()?.writer
			get("a")
			seen.run = s.current()
			return 1
		}, () => void (seen.set = s.current()))
		e = s.effect(() => get("a"), () => void (seen.act = s.current()))
	})
	const t = write("a", 1)
	s.pulse()
	const shown = (x: ReturnType<typeof s.current>) => [x!.scope, x!.pairs, x!.writer]
	const pairs = (
		n: number,
		mark: number,
	): Pair[] => [["actor", "notes"], ["run", n], ["mark", mark]]
	assertStrictEquals(c.parent, notes)
	// each made due by its making: the mark is the tick it was made at, before the write's
	assertEquals(shown(seen.run), [c, pairs(1, t - 2), own])
	assertEquals(shown(seen.set), [c, pairs(1, t - 2), c])
	assertEquals(shown(seen.act), [e, pairs(1, t - 1), e])
	const t2 = write("a", 2)
	s.pulse()
	assertEquals(seen.run!.pairs, pairs(2, t2))
})

Deno.test("scope: a run's scope is its own: a pulse with another scope open lends it nothing", () => {
	const { s, at, write, get } = setup()
	let seen!: ReturnType<typeof s.current>
	const c = at(() => s.compute(() => (get("a"), seen = s.current()), () => {}))
	write("a", 1)
	s.run(s.root([["actor", "host"]]), () => s.pulse())
	assertStrictEquals(seen!.scope, c)
	assertEquals([seen!.pairs.map(([k]) => k), typeof seen!.writer], [["run", "mark"], "function"])
})

Deno.test("scope: after an await in a run nothing is open; making is unscoped", async () => {
	const { s, at } = setup()
	const seen: unknown[] = []
	at(() =>
		s.compute(async () => {
			seen.push(s.current() !== undefined)
			await null
			seen.push(s.current())
			for (const f of [() => s.scope(), () => s.cleanup(() => {})]) {
				try {
					f()
				} catch (e) {
					seen.push((e as SchedulerError).code)
				}
			}
			return 0
		}, () => {})
	)
	s.pulse()
	await new Promise((r) => setTimeout(r, 0))
	assertEquals(seen, [true, undefined, "unscoped", "unscoped"])
})

Deno.test("scope: the caller of an async function doesn't see the callee's scope after its first await", async () => {
	const s = createScheduler()
	const caller = s.root([["caller", 1]]), callee = s.root([["callee", 1]])
	const seen: unknown[] = []
	const call = () =>
		s.run(callee, async () => {
			seen.push(s.current()!.pairs)
			await null
			seen.push(s.current())
		})
	await s.run(caller, () => {
		const p = call()
		// back in the caller at once, the callee's scope closed
		seen.push(s.current()!.pairs)
		return p
	})
	seen.push(s.current())
	assertEquals(seen, [[["callee", 1]], [["caller", 1]], undefined, undefined])
})

Deno.test("scope: a cleanup opens its scope: a computation's written by it", () => {
	const { s, at, write, get } = setup()
	const seen: ReturnType<typeof s.current>[] = []
	let c!: Computation, p!: Scope
	at(() => {
		p = s.scope([["why", "plain"]])
		s.run(p, () => s.cleanup(() => void seen.push(s.current())))
		c = s.compute(() => {
			get("a")
			s.cleanup(() => void seen.push(s.current()))
			return 0
		}, () => {})
	})
	write("a", 1)
	s.pulse()
	write("a", 2)
	s.pulse()
	s.dispose(p)
	assertEquals(seen.map((x) => [x!.scope, x!.writer]), [[c, c], [p, undefined]])
	assertEquals(seen[1]!.pairs, [["why", "plain"]])
})

Deno.test("scope: a click dispatched in a run, its scope made there, is under the run's: the process's", () => {
	const { s, at, write, get } = setup()
	let seen!: ReturnType<typeof s.current>
	let own!: unknown
	const notes = at(() => s.scope([["actor", "notes"]]))
	const c = s.run(notes, () =>
		s.compute(() => {
			own = s.current()?.writer
			get("a")
			// dispatchEvent: sync, a scope of the event's, under the one open
			s.run(s.scope([["event", "click"]]), () => void (seen = s.current()))
			return 0
		}, () => {}))
	write("a", 1)
	s.pulse()
	assertStrictEquals(seen!.scope.parent, c)
	assertEquals(seen!.pairs.map(([k]) => k), ["actor", "run", "mark", "event"])
	assertStrictEquals(seen!.writer, own)
})

Deno.test("scope: a handler's call, as a scope: under the definer's (it dies with it), the caller and trusted as its info", () => {
	const { s, at, write, get } = setup()
	// notes defines a handler: a scope of its own, under notes
	const notes = at(() => s.scope([["actor", "notes"]]))
	const handler = s.scope([["handler", "click"]], notes)
	// a call: a scope under the definer's, the caller and whether the event was trusted as data;
	// only the host, making the call, says trusted
	const made: Computation[] = []
	const seen: unknown[] = []
	const call = (caller: unknown, trusted: boolean) =>
		s.run(s.scope([["caller", caller], ["trusted", trusted]], handler), () => {
			seen.push(s.current()!.pairs)
			made.push(s.compute(() => 0, () => {}))
		})
	// games' run calls it, a script's click; the host calls it, the user's
	const games = at(() => s.scope([["actor", "games"]]))
	s.run(games, () => s.compute(() => (get("a"), call("games", false)), () => {}))
	write("a", 1)
	s.pulse()
	s.run(s.root([["actor", "host"]]), () => call("chee", true))
	const definer = [["actor", "notes"], ["handler", "click"]]
	assertEquals(seen, [
		[...definer, ["caller", "games"], ["trusted", false]],
		[...definer, ["caller", "chee"], ["trusted", true]],
	])
	// what a call made is the definer's: it goes with notes, not with games
	s.dispose(games)
	assertEquals(made.map((c) => c.state), ["alive", "alive"])
	s.dispose(notes)
	assertEquals(made.map((c) => c.state), ["gone", "gone"])
})
