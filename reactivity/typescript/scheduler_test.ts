// Tests the scheduler beyond the conformance suite: keys of any kind, throwing sets and cleanups,
// scopes under a computation, the sweep, and what is open.
import { assert, assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import {
	type Computer,
	createScheduler,
	type Info,
	PENDING,
	type Run,
	SchedulerError,
	type Scope,
} from "./scheduler.ts"
import { type Told, trace } from "./scheduler_harness.ts"

const under = (o: Scope) => {
	const out: Scope[] = []
	for (let x = o.newest; x; x = x.older) out.unshift(x)
	return out
}

type Now = { scope: Scope; info: Info; run: Run | undefined } | undefined
const now = (s: ReturnType<typeof createScheduler>): Now => {
	const scope = s.getCurrentScope()
	return scope && { scope, info: { ...s.getInfo()! }, run: s.getRun() }
}
const named = (run: Run | undefined) => run && [run.computer, run.n]

function setup() {
	const moments: Told[] = []
	const s = createScheduler()
	trace(s, (m) => void moments.push(m))
	const store = new Map<unknown, unknown>()
	const write = (key: unknown, v: unknown, by?: Run | Computer) => {
		store.set(key, v)
		return s.mark([key], by)
	}
	const get = (key: unknown) => {
		s.track(key)
		return store.get(key)
	}
	const ends = (c: Computer) =>
		moments.filter((m) => "ends" in m && m.ends === c) as Extract<Told, { ends: unknown }>[]
	const o = s.createRootScope({ actor: "test" })
	const at = <T>(f: () => T) => s.runWithScope(o, f)
	return { s, store, write, get, moments, ends, o, at }
}

const unscoped = (f: () => unknown) => {
	const e = assertThrows(f, SchedulerError)
	assertEquals(e.code, "unscoped")
}

Deno.test("a computation's f is given its last result: a compute's last set, an effect's last acted on", () => {
	const { s, at, write, get } = setup()
	write("k", 1)
	// Results in the same ten are equal, so an equal result is not set; what is given stays the last
	// set, not the last result.
	const tens = (a: number, b: number) => Math.floor(a / 10) === Math.floor(b / 10)
	const given: unknown[] = []
	at(() =>
		s.createComputer(
			(previous: number | undefined) => (given.push(previous), get("k") as number),
			() => {},
			tens,
		)
	)
	const acted: unknown[] = []
	at(() =>
		s.createEffect(
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
	at(() => s.createComputer(() => [get("k"), get(sym), get(obj)], (v) => void seen.push(v)))
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
		s.createComputer(() => get("a") as number, (v) => void set.push(v), (x, y) => {
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
		s.createComputer(() => get("a"), (v) => {
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

Deno.test("a run's end says what it keeps past it: a result given to set (even one that throws), or to be acted on; never an equal one", () => {
	const { s, at, write, get } = setup()
	const kept: [Computer, unknown][] = []
	s.onRunEnd((c, _n, _ended, _reads, more) => void ("kept" in more && kept.push([c, more.kept])))
	const v = { x: 1 }
	const c = at(() => s.createComputer(() => (get("a"), v), () => {}))
	const e = at(() => s.createEffect(() => get("b"), () => {}))
	write("a", 1)
	write("b", 2)
	s.pulse()
	assertEquals(kept.length, 2)
	assertStrictEquals(kept.find(([k]) => k === c)![1], v)
	assertEquals(kept.find(([k]) => k === e)![1], 2)
	write("a", 2)
	s.pulse()
	assertEquals(kept.length, 2)
	const w = { x: 2 }
	at(() =>
		s.createComputer(() => (get("c"), w), () => {
			throw new Error("no")
		})
	)
	write("c", 1)
	s.pulse()
	assertStrictEquals(kept.at(-1)![1], w)
})

Deno.test("dispose: every cleanup runs, the first error after; one added later runs at once", () => {
	const { s, o, at } = setup()
	const ran: string[] = []
	const p = at(() => s.createScope({ why: "test" }))
	s.runWithScope(p, () => {
		s.registerTeardown(s.getCurrentScope()!, () => ran.push("p1"))
		s.registerTeardown(s.getCurrentScope()!, () => {
			ran.push("p2")
			throw new Error("first")
		})
	})
	at(() =>
		s.registerTeardown(s.getCurrentScope()!, () => {
			ran.push("o")
			throw new Error("second")
		})
	)
	const late = s.createScope({ why: "test" }, p)
	s.runWithScope(late, () => {
		const e = assertThrows(() => s.teardown(o))
		assertEquals((e as Error).message, "first")
		assertEquals(ran, ["p2", "p1", "o"])
		s.registerTeardown(s.getCurrentScope()!, () => ran.push("late"))
		assertThrows(() => s.createScope({ why: "test" }), SchedulerError, "disposed")
		assertThrows(() => s.createComputer(() => 1, () => {}), SchedulerError, "disposed")
	})
	assertEquals(ran.at(-1), "late")
	assertThrows(() => s.runWithScope(o, () => {}), SchedulerError, "disposed")
	assertThrows(() => s.createScope({ why: "test" }, o), SchedulerError, "disposed")
})

Deno.test("what is made under a compute goes before its next run", () => {
	const { s, at, write, get } = setup()
	const inner: unknown[] = []
	let made = 0
	const c: Computer = at(() =>
		s.createComputer(() => {
			const n = get("a")
			made++
			s.createEffect(() => get("b"), (v) => void inner.push([n, v]))
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
	assertEquals(made, 2)
	assertEquals(inner, [[1, "x"], [2, "x"], [2, "y"]])
	assertEquals(under(c).length, 1)
})

Deno.test("read: tracked in a run's synchronous part; outside a run, and in run(), nothing", () => {
	const { s, o, at, write, store } = setup()
	let runs = 0
	s.track("a") // outside: nothing
	at(() =>
		s.createComputer(() => {
			runs++
			s.track("a")
			s.runWithScope(o, () => s.track("b"))
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
		s.createComputer(async () => {
			const writer = s.getRun()
			await gate
			get("a")
			write("w", 1, writer)
			return 1
		}, () => {})
	)
	const b = at(() => s.createComputer(() => get("w"), () => {}))
	s.pulse()
	resolve()
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(ends(c).map((m) => m.ended), ["pending", "done"])
	assert(moments.some((m) => "due" in m && m.due === b && m.by === c))
	const before = ends(c).length
	write("a", 2)
	s.pulse()
	assertEquals(ends(c).length, before)
})

Deno.test("wake: told when a promise settles; its result lands at the next pulse", async () => {
	let woken = 0
	const s = createScheduler()
	s.onSettle(() => woken++)
	const set: number[] = []
	s.runWithScope(
		s.createRootScope({ actor: "test" }),
		() => s.createComputer(() => Promise.resolve(7), (v: number) => void set.push(v)),
	)
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
	const c = at(() =>
		s.createComputer(() => new Promise<number>((r) => resolve = r), () => woken = true)
	)
	s.pulse()
	s.teardown(c)
	resolve(1)
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(woken, false)
	assertEquals(ends(c).map((m) => m.ended), ["pending"])
})

Deno.test("a thenable settles once: what it says after its first resolve or reject is not heard", async () => {
	const { s, at, ends } = setup()
	let woken = 0
	s.onSettle(() => woken++)
	const set: number[] = []
	const loud = {
		then(resolve: (v: number) => void, reject: (e: unknown) => void) {
			resolve(1)
			resolve(2)
			reject(new Error("late"))
		},
	}
	const c = at(() =>
		s.createComputer(() => loud as unknown as Promise<number>, (v) => set.push(v))
	)
	s.pulse()
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals([woken, set], [1, [1]])
	assertEquals(ends(c).map((m) => m.ended), ["pending", "done"])
})

Deno.test("a thenable whose then throws: the run fails, as if it rejected", async () => {
	const { s, at, ends } = setup()
	const broken = {
		then() {
			throw new Error("no then")
		},
	}
	const c = at(() => s.createComputer(() => broken as unknown as Promise<number>, () => {}))
	s.pulse()
	await new Promise((r) => setTimeout(r, 0))
	s.pulse()
	assertEquals(ends(c).map((m) => m.ended), ["pending", "failed"])
})

Deno.test("a pulse in a pulse does nothing; the outer one runs what it made due", () => {
	const { s, at, write, get } = setup()
	const seen: unknown[] = []
	at(() => {
		s.createComputer(() => get("a"), (v) => {
			write("b", v)
			s.pulse()
		})
		s.createEffect(() => get("b"), (v) => void seen.push(v))
	})
	write("a", 1)
	s.pulse()
	assertEquals(seen, [1])
})

Deno.test("disposed in its own run: its result goes nowhere, and it is told nothing more", () => {
	const { s, at, write, get, ends } = setup()
	const set: unknown[] = []
	const c: Computer = at(() =>
		s.createComputer(() => {
			const v = get("a")
			if (v === 2) s.teardown(c)
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
	const q: Computer = at(() =>
		s.createComputer(() => {
			if (!get("flag")) return 0
			try {
				return get("w")
			} catch {
				return "caught"
			}
		}, (v) => void write("q", v, q))
	)
	const w: Computer = at(() =>
		s.createComputer(() => (get("x") as number ?? 0) + 1, (v) => {
			write("w", v, w)
		})
	)
	s.pulse()
	write("flag", true)
	write("x", 5)
	s.pulse()
	assertEquals(ends(q).map((m) => m.ended), ["done", "stopped", "done"])
	assertEquals(s.runWithScope(o, () => get("q")), 6)
})

Deno.test("keys nobody reads any more are forgotten, and tracking stays right", () => {
	const { s, at, write, get } = setup()
	let i = 0
	const set: unknown[] = []
	at(() => s.createComputer(() => get(`k${i}`) ?? i, (v) => void set.push(v)))
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
	// A reader made before its writer is given its first result again, unless the key is declared.
	for (const declared of [false, true]) {
		const { s, at, write, get } = setup()
		write("a", 1)
		const given: unknown[] = []
		at(() => s.createComputer(() => get("b"), (v) => void given.push(v)))
		const w: Computer = at(() =>
			s.createComputer(
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

function bounded(limit = 2000) {
	let runs = 0
	const s = createScheduler()
	s.onRunStart(() => {
		if (++runs > limit) throw new Error("endless")
	})
	const store = new Map<unknown, unknown>()
	const write = (key: unknown, v: unknown, by?: Run | Computer) => {
		store.set(key, v)
		return s.mark([key], by)
	}
	const get = (key: unknown) => {
		s.track(key)
		return store.get(key)
	}
	const o = s.createRootScope({ actor: "test" })
	return { s, store, write, get, at: <T>(f: () => T) => s.runWithScope(o, f), runs: () => runs }
}

Deno.test("made in an act, under the effect, its set changing what the effect read: the loop ends (C6)", () => {
	const { s, at, write, get, store } = bounded()
	write("k", 1)
	at(() =>
		s.createEffect(() => get("k") as number, () => {
			const x: Computer = s.createComputer(
				() => (get("k") as number) + 1,
				(v) => void write("k", v, x),
			)
		})
	)
	s.pulse()
	assertEquals(store.get("k"), 2)
})

Deno.test("a cleanup writing what its computation read, on a plain scope made in the run: the loop ends, as one on the computation does", () => {
	// Written by the writer open. The plain scope stays through the next run; the computation's own
	// cleanup runs once the round's runs are done. The run-1 cleanup writes 1 after run 2, a loop,
	// and run 3's cleanup write (101) is cut.
	const go = (nested: boolean) => {
		const { s, at, write, get, store, runs } = bounded(50)
		store.set("k", 0)
		at(() =>
			s.createComputer(() => {
				const k = get("k") as number
				const f = () => void write("k", k + 1, s.getRun())
				if (nested) {
					s.runWithScope(s.createScope({ why: "test" }), () =>
						s.registerTeardown(s.getCurrentScope()!, f))
				} else s.registerTeardown(s.getCurrentScope()!, f)
				return 0
			}, () => {})
		)
		s.pulse()
		write("k", 100)
		s.pulse()
		return [runs(), store.get("k")]
	}
	assertEquals(go(false), [3, 101])
	assertEquals(go(true), [3, 101])
})

Deno.test("what an effect's runs make goes before its next run: equal results pile nothing up (D3)", () => {
	const { s, at, write, get } = setup()
	const e: Computer = at(() =>
		s.createEffect(() => {
			get("k")
			s.createScope({ why: "test" })
			return 0
		}, () => {})
	)
	for (let i = 0; i < 5; i++) {
		write("k", i)
		s.pulse()
	}
	assertEquals(under(e).length, 1)
})

Deno.test("what an act makes stays until the next act, though the effect runs again in between", () => {
	const { s, at, write, get } = setup()
	const undone: unknown[] = []
	const e: Computer = at(() =>
		s.createEffect(() => (get("k") as number) % 2, (v) => {
			s.registerTeardown(s.getCurrentScope()!, () => void undone.push(v))
			s.createScope({ why: "test" })
		})
	)
	write("k", 1)
	s.pulse()
	write("k", 3)
	s.pulse()
	assertEquals([undone, under(e).length], [[], 1])
	write("k", 2)
	s.pulse()
	assertEquals([undone, under(e).length], [[1], 1])
})

Deno.test("a set that writes and then throws: its next result is given to set, equal or not", () => {
	const { s, at, write, get, store } = setup()
	let fail = false
	const c: Computer = at(() =>
		s.createComputer(() => get("a"), (v) => {
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
		const a = at(() =>
			s.createComputer(() => {
				write("w", get("x"), named ? s.getRun() : undefined)
				return 0
			}, () => {})
		)
		const b = at(() => s.createComputer(() => get("w"), () => {}))
		s.pulse()
		write("x", 2)
		s.pulse()
		const by = moments.flatMap((m) => "due" in m && m.due === b ? [m.by === a] : [])
		const ranks = moments.flatMap((m) => "starts" in m && m.starts === b ? [m.rank] : [])
		assertEquals([by, ranks], named ? [[false, true], [0, 1]] : [[false, false], [0, 0]])
	}
})

Deno.test("made in a run known to loop, its set changing what that run read: the loop ends", () => {
	const { s, at, store, runs } = bounded()
	store.set("k", 0)
	at(() =>
		s.createComputer(() => {
			s.track("k")
			const c: Computer = s.createComputer(() => 0, (v) => {
				store.set("k", v)
				s.mark(["k"], c)
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
		s.createComputer(() => {
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
	const store = new Map<unknown, unknown>()
	const pending = new Set<unknown>()
	const keyOf = new Map<Computer, string>()
	const s = createScheduler()
	s.onRunEnd((c, _n, ended) => {
		if (ended === "stopped" || !keyOf.has(c)) return
		const k = keyOf.get(c)!
		if ((ended === "pending") === pending.has(k)) return
		if (ended === "pending") pending.add(k)
		else pending.delete(k)
		s.mark([k], c)
	})
	const get = (key: unknown) => {
		s.track(key)
		if (pending.has(key)) throw PENDING
		return store.get(key) as number
	}
	const runs = new Map<string, number>()
	const chain = (name: string, from: string) => {
		const c: Computer = s.createComputer(() => {
			runs.set(name, (runs.get(name) ?? 0) + 1)
			return get(from) + 1
		}, (v) => {
			store.set(name, v)
			s.mark([name], c)
		})
		keyOf.set(c, name)
	}
	s.runWithScope(s.createRootScope({ actor: "test" }), () => {
		chain("c1", "x")
		chain("c2", "c1")
		chain("c3", "c2")
	})
	store.set("x", 1)
	s.pulse()
	assertEquals([store.get("c3"), [...pending]], [4, []])
	pending.add("x")
	s.mark(["x"])
	s.pulse()
	assertEquals([store.get("c3"), [...pending].sort()], [4, ["c1", "c2", "c3", "x"]])
	pending.delete("x")
	store.set("x", 10)
	s.mark(["x"])
	s.pulse()
	assertEquals([store.get("c1"), store.get("c2"), store.get("c3"), [...pending]], [11, 12, 13, []])
	assertEquals([...runs.values()], [3, 3, 3])
})

Deno.test("scope: nothing open: no scope; making a scope or a computer is unscoped", () => {
	const s = createScheduler()
	assertEquals(s.getCurrentScope(), undefined)
	unscoped(() => s.createScope({ why: "test" }))
	unscoped(() => s.createComputer(() => 1, () => {}))
	unscoped(() => s.createEffect(() => 1, () => {}))
	assertEquals(s.createRootScope({ actor: "test" }).parent, undefined)
})

Deno.test("scope: a scope with no keys is empty: a root, a scope", () => {
	const s = createScheduler()
	assertThrows(() => s.createRootScope({}), SchedulerError, "no keys")
	const o = s.createRootScope({ actor: "test" })
	assertThrows(() => s.createScope({}, o), SchedulerError, "no keys")
	s.runWithScope(o, () => assertThrows(() => s.createScope({}), SchedulerError, "no keys"))
	assertEquals(under(o), [])
})

Deno.test("scope: one tree: a write's info is the scope open's, nothing added; the tree is parent", () => {
	const s = createScheduler()
	const chee = s.createRootScope({ actor: "chee" })
	const app = s.createScope({ app: "notes", actor: "notes" }, chee)
	const seen: Info[] = []
	s.runWithScope(app, () => {
		const save = s.createScope({ why: "save" })
		assertStrictEquals(save.parent, app)
		s.runWithScope(save, () => seen.push(s.getInfo()!))
		seen.push(s.getInfo()!)
	})
	assertEquals(seen, [{ why: "save" }, { app: "notes", actor: "notes" }])
	assertStrictEquals(seen[1], app.info)
	assertStrictEquals(app.parent, chee)
	assertEquals(chee.parent, undefined)
	s.teardown(chee)
	assertEquals(app.state, "gone")
	assertThrows(() => s.runWithScope(app, () => {}), SchedulerError, "disposed")
})

Deno.test("scope: run(o, f) opens o for f, the one before back after; a throw too", () => {
	const s = createScheduler()
	const a = s.createRootScope({ a: 1 }), b = s.createRootScope({ b: 2 })
	s.runWithScope(a, () => {
		s.runWithScope(b, () => assertStrictEquals(s.getCurrentScope()!, b))
		assertStrictEquals(s.getCurrentScope()!, a)
		assertThrows(() => s.runWithScope(b, () => assert(false)))
		assertStrictEquals(s.getCurrentScope()!, a)
	})
	assertEquals(s.getCurrentScope(), undefined)
})

Deno.test("scope: a run opens its computation, its info the run's, written by the run; a set and an act by the computation", () => {
	const { s, at, write, get } = setup()
	const seen: Record<string, Now> = {}
	let c!: Computer, e!: Computer
	let own!: unknown, eown!: unknown
	const notes = at(() => s.createScope({ actor: "notes" }))
	s.runWithScope(notes, () => {
		c = s.createComputer(() => {
			own = s.getRun()
			get("a")
			seen.run = now(s)
			return 1
		}, () => void (seen.set = now(s)))
		e = s.createEffect(() => (eown = s.getRun(), get("a")), () => void (seen.act = now(s)))
	})
	const t = write("a", 1)
	assertEquals(c.info, { mark: t - 2 })
	s.pulse()
	const shown = (x: Now) => [x!.scope, x!.info, x!.run]
	const pairs = (n: number, mark: number): Info => ({ run: n, mark })
	assertStrictEquals(c.parent, notes)
	assertEquals(shown(seen.run), [c, pairs(1, t - 2), own])
	assertEquals(shown(seen.set), [c, pairs(1, t - 2), own])
	assertEquals(shown(seen.act), [e, pairs(1, t - 1), eown])
	const t2 = write("a", 2)
	s.pulse()
	assertEquals(seen.run!.info, pairs(2, t2))
})

Deno.test("scope: a run's scope is its own: a pulse with another scope open lends it nothing", () => {
	const { s, o, at, write, get } = setup()
	let seen!: Now
	const c = at(() => s.createComputer(() => (get("a"), seen = now(s)), () => {}))
	write("a", 1)
	s.runWithScope(s.createRootScope({ actor: "host" }), () => s.pulse())
	assertStrictEquals(seen!.scope, c)
	assertEquals([Object.keys(seen!.info).sort(), named(seen!.run)], [["mark", "run"], [c, 1]])
	assertStrictEquals(c.parent, o)
})

Deno.test("scope: after an await in a run nothing is open; making is unscoped", async () => {
	const { s, at } = setup()
	const seen: unknown[] = []
	at(() =>
		s.createComputer(async () => {
			seen.push(s.getCurrentScope() !== undefined)
			await null
			seen.push(s.getCurrentScope())
			try {
				s.createScope({ why: "test" })
			} catch (e) {
				seen.push((e as SchedulerError).code)
			}
			return 0
		}, () => {})
	)
	s.pulse()
	await new Promise((r) => setTimeout(r, 0))
	assertEquals(seen, [true, undefined, "unscoped"])
})

Deno.test("scope: the caller of an async function doesn't see the callee's scope after its first await", async () => {
	const s = createScheduler()
	const caller = s.createRootScope({ caller: 1 }), callee = s.createRootScope({ callee: 1 })
	const seen: unknown[] = []
	const call = () =>
		s.runWithScope(callee, async () => {
			seen.push(s.getInfo()!)
			await null
			seen.push(s.getCurrentScope())
		})
	await s.runWithScope(caller, () => {
		const p = call()
		seen.push(s.getInfo()!)
		return p
	})
	seen.push(s.getCurrentScope())
	assertEquals(seen, [{ callee: 1 }, { caller: 1 }, undefined, undefined])
})

Deno.test("scope: a teardown opens its scope: a computer's by it (its latest run)", () => {
	const { s, at, write, get } = setup()
	const seen: Now[] = []
	let c!: Computer, p!: Scope
	at(() => {
		p = s.createScope({ why: "plain" })
		s.registerTeardown(p, () => void seen.push(now(s)))
		c = s.createComputer(() => {
			get("a")
			s.registerTeardown(s.getCurrentScope()!, () => void seen.push(now(s)))
			return 0
		}, () => {})
	})
	write("a", 1)
	s.pulse()
	write("a", 2)
	s.pulse()
	s.teardown(p)
	assertEquals(seen.map((x) => [x!.scope, named(x!.run)]), [[c, [c, 2]], [p, undefined]])
	assertEquals(seen[1]!.info, { why: "plain" })
})

Deno.test("scope: a scope made in an act is under the effect, made in the run acted on, past a later run that did not act", () => {
	const { s, at, write, get } = setup()
	let k!: Scope
	let made!: Info
	const e = at(() =>
		s.createEffect(() => (get("a") as number) > 0, (on) => {
			if (on) k = s.createScope({ why: "listen" }), made = { ...s.getInfo()! }
		})
	)
	write("a", 1)
	s.pulse()
	write("a", 2)
	s.pulse()
	assertEquals([k.state, e.runs], ["alive", 2])
	assertEquals(k.info, { why: "listen" })
	assertStrictEquals(k.parent, e)
	assertEquals(made, { run: 1, mark: 1 })
})

Deno.test("scope: a click dispatched in a run, its scope made there, is under the run's: the process's", () => {
	const { s, at, write, get } = setup()
	let seen!: Now
	let own!: unknown
	const notes = at(() => s.createScope({ actor: "notes" }))
	const c = s.runWithScope(notes, () =>
		s.createComputer(() => {
			own = s.getRun()
			get("a")
			s.runWithScope(s.createScope({ event: "click" }), () => void (seen = now(s)))
			return 0
		}, () => {}))
	write("a", 1)
	s.pulse()
	assertStrictEquals(seen!.scope.parent, c)
	assertEquals(seen!.info, { event: "click" })
	assertEquals(c.info, { mark: 1 })
	assertStrictEquals(c.parent, notes)
	assertStrictEquals(seen!.run, own)
	assertStrictEquals(seen!.scope.frame.parent, (own as Run).frame)
})

Deno.test("scope: a handler's call, as a scope: under the definer's (it dies with it), the caller and trusted-event as its info", () => {
	const { s, at, write, get } = setup()
	const notes = at(() => s.createScope({ actor: "notes" }))
	const handler = s.createScope({ handler: "click" }, notes)
	const made: Computer[] = []
	const seen: unknown[] = []
	const ups: (Scope | undefined)[] = []
	const call = (caller: unknown, trusted: boolean) =>
		s.runWithScope(s.createScope({ caller, "trusted-event": trusted }, handler), () => {
			seen.push(s.getInfo()!)
			ups.push(s.getCurrentScope()!.parent)
			made.push(s.createComputer(() => 0, () => {}))
		})
	const games = at(() => s.createScope({ actor: "games" }))
	s.runWithScope(games, () => s.createComputer(() => (get("a"), call("games", false)), () => {}))
	write("a", 1)
	s.pulse()
	s.runWithScope(s.createRootScope({ actor: "host" }), () => call("chee", true))
	assertEquals(seen, [{ caller: "games", "trusted-event": false }, {
		caller: "chee",
		"trusted-event": true,
	}])
	assertEquals(ups, [handler, handler])
	assertStrictEquals(handler.parent, notes)
	s.teardown(games)
	assertEquals(made.map((c) => c.state), ["alive", "alive"])
	s.teardown(notes)
	assertEquals(made.map((c) => c.state), ["gone", "gone"])
})

Deno.test("onTrackingStart: told when a key gains its first tracker, again after onTrackingEnd; not for a second reader", () => {
	const { s, at, write, get } = setup()
	const told: [string, unknown][] = []
	s.onTrackingStart((k) => void told.push(["first", k]))
	s.onTrackingEnd((k) => void told.push(["gone", k]))
	const a = at(() => s.createComputer(() => get("x"), () => {}))
	at(() => s.createComputer(() => get("x"), () => {}))
	s.pulse()
	assertEquals(told, [["first", "x"]])
	s.teardown(a)
	assertEquals(told.length, 1)
	write("x", 1)
	s.pulse()
	s.teardown(s.getCurrentScope() ?? a)
	assertEquals(told.filter(([w]) => w === "gone"), [])
})

Deno.test("onAfterPulse: told once a pulse is over, after its acts; not for a pulse called inside it; a pulse called there is a new one", () => {
	const { s, at, write, get } = setup()
	const told: string[] = []
	s.onAfterPulse(() => void told.push("after"))
	write("x", 1)
	at(() => s.createEffect(() => (s.pulse(), get("x")), (v) => void told.push(`act ${v}`)))
	s.pulse()
	assertEquals(told, ["act 1", "after"])
	s.pulse()
	assertEquals(told, ["act 1", "after", "after"])
	told.length = 0
	let once = true
	const off = s.onAfterPulse(() => {
		if (!once) return
		once = false
		write("x", 2)
		s.pulse()
	})
	s.pulse()
	assertEquals(told, ["after", "act 2", "after"])
	off()
})

Deno.test("a computer's info: one object, the keys given copied once, as it is made, and mark, never changed after; each run has a frame of its own, { run, mark }, under the computer's", () => {
	const { s, at, write, get } = setup()
	const given: Info = { node: "N" }
	const seen: Info[] = []
	const live: Info[] = []
	let early: Info | undefined
	const c = at(() =>
		s.createComputer(
			() => (seen.push({ ...s.getInfo()! }), live.push(s.getInfo()!), get("x")),
			() => {},
			undefined,
			undefined,
			given,
		)
	)
	given.late = true
	const made = c.info
	assertEquals(c.info, { node: "N", mark: 1 })
	s.pulse()
	write("x", 1)
	s.pulse()
	assertEquals(seen, [{ run: 1, mark: 1 }, { run: 2, mark: 2 }])
	assertStrictEquals(c.info, made)
	assertEquals(c.info, { node: "N", mark: 1 })
	assert(live[0] !== live[1] && live[0] !== made)
	const e = at(() =>
		s.createEffect(() => (early = { ...s.getInfo() }, 1), () => {}, undefined, { early: true }, {
			node: "E",
		})
	)
	assertEquals(early, { run: 1, mark: 3 })
	assertEquals(e.info, { node: "E", mark: 3 })
	const d = at(() => s.createComputer(() => 1, () => {}))
	assertEquals(d.info, { mark: 4 })
})
