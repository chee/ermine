// Unit tests for the tracker's edges: the two lists, the cursor and the links' fields.
import { assert, assertEquals, assertThrows } from "@std/assert"
import { createModel } from "./tracker_model.ts"
import { createScheduler } from "./scheduler.ts"
import { createTracker, type Node } from "./tracker.ts"

function setup() {
	const t = createTracker<string>()
	const nodes = new Map<string, Node<string>>()
	const n = (name: string) => {
		let x = nodes.get(name)
		if (x === undefined) nodes.set(name, x = t.node(name))
		return x
	}
	const reads = (r: string) => t.reads(n(r)).map((x) => x.owner)
	const readers = (a: string) => t.readers(n(a)).map((l) => l.from.owner)
	const run = (r: string, ...to: string[]) => {
		t.begin(n(r))
		for (const x of to) t.track(n(r), n(x))
		t.end(n(r))
	}
	return { t, n, reads, readers, run }
}

function consistent(t: { n: (s: string) => Node<string> }, names: string[]) {
	for (const name of names) {
		const node = t.n(name)
		let before = null
		for (let l = node.first; l !== null; l = l.after) {
			assert(l.to === node, `${name}: to`)
			assert(l.before === before, `${name}: before`)
			before = l
		}
		assert(node.last === before, `${name}: last`)
		assert(node.first === null || node.first.before === null, `${name}: first`)
		let prev = null
		for (let l = node.reads; l !== null; l = l.next) {
			assert(l.from === node, `${name}: from`)
			assert(l.prev === prev, `${name}: prev`)
			let there = false
			for (let r = l.to.first; r !== null; r = r.after) there ||= r === l
			assert(there, `${name}: in the spot's readers`)
			prev = l
		}
	}
}

Deno.test("node: empty, owner kept, never read", () => {
	const { t } = setup()
	const o = { any: "thing" }
	const t2 = createTracker<typeof o>()
	const n = t2.node(o)
	assert(n.owner === o)
	assertEquals(n.reads, null)
	assertEquals(n.cursor, null)
	assertEquals(n.first, null)
	assertEquals(n.last, null)
	assertEquals(t.reads(t.node("x")), [])
	assertEquals(t2.readers(n), [])
})

Deno.test("reads: none is the same frozen empty list every time", () => {
	const { t, n } = setup()
	const a = t.reads(n("a"))
	assert(a === t.reads(n("b")))
	assert(Object.isFrozen(a))
})

Deno.test("reads: a copy, not live", () => {
	const { t, n, run } = setup()
	run("r", "a", "b")
	const got = t.reads(n("r"))
	run("r", "a")
	assertEquals(got.map((x) => x.owner), ["a", "b"])
})

Deno.test("readers: a copy, in the order made", () => {
	const { t, n, run } = setup()
	assert(t.readers(n("a")) === t.readers(n("b")))
	run("r", "a")
	const got = t.readers(n("a"))
	run("s", "a")
	assertEquals(got.map((l) => l.from.owner), ["r"])
	assertEquals(t.readers(n("a")).map((l) => l.from.owner), ["r", "s"])
})

Deno.test("first run: links made in read order", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "b", "c")
	assertEquals(reads("r"), ["a", "b", "c"])
	for (const x of ["a", "b", "c"]) assertEquals(readers(x), ["r"])
})

Deno.test("re-run reading the same in the same order keeps the very same links", () => {
	const { t, n, run } = setup()
	run("r", "a", "b", "c")
	const before: unknown[] = []
	for (let l = n("r").reads; l !== null; l = l.next) before.push(l)
	run("r", "a", "b", "c")
	const after: unknown[] = []
	for (let l = n("r").reads; l !== null; l = l.next) after.push(l)
	assertEquals(after.length, 3)
	after.forEach((l, i) => assert(l === before[i]))
	assertEquals(t.reads(n("r")).length, 3)
})

Deno.test("re-run reading fewer drops the tail and only the tail", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "b", "c")
	run("r", "a")
	assertEquals(reads("r"), ["a"])
	assertEquals(readers("a"), ["r"])
	assertEquals(readers("b"), [])
	assertEquals(readers("c"), [])
})

Deno.test("re-run reading nothing drops everything", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "b")
	run("r")
	assertEquals(reads("r"), [])
	assertEquals(readers("a"), [])
	assertEquals(readers("b"), [])
})

Deno.test("re-run reading more links the new ones at the end", () => {
	const { reads, readers, run } = setup()
	run("r", "a")
	run("r", "a", "b", "c")
	assertEquals(reads("r"), ["a", "b", "c"])
	assertEquals(readers("c"), ["r"])
})

Deno.test("re-run reading new things in front: they go before, the old are confirmed after", () => {
	const { reads, run } = setup()
	run("r", "a", "b")
	run("r", "x", "a", "b")
	assertEquals(reads("r"), ["x", "a", "b"])
})

Deno.test("re-run in a different order: nothing is lost, nothing read twice", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "b", "c")
	run("r", "c", "b", "a")
	assertEquals([...new Set(reads("r"))].sort(), ["a", "b", "c"])
	for (const x of ["a", "b", "c"]) assertEquals(new Set(readers(x)), new Set(["r"]))
})

Deno.test("re-run reading a different subset", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "b", "c", "d")
	run("r", "b", "d")
	assertEquals(reads("r"), ["b", "d"])
	assertEquals(readers("a"), [])
	assertEquals(readers("b"), ["r"])
	assertEquals(readers("c"), [])
})

Deno.test("a read made twice in one run is one link, in a row", () => {
	const { reads, readers, run } = setup()
	run("r", "a", "a", "a")
	assertEquals(reads("r"), ["a"])
	assertEquals(readers("a"), ["r"])
})

Deno.test("a read made twice in one run, on a re-run, is still one", () => {
	const { reads, run } = setup()
	run("r", "a", "b")
	run("r", "a", "a", "b", "b")
	assertEquals(reads("r"), ["a", "b"])
})

Deno.test("a read made again after another reader read the spot: found by the cursor", () => {
	const { reads, run, t, n } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	run("s", "a")
	t.track(n("r"), n("a"))
	t.end(n("r"))
	assertEquals(reads("r"), ["a"])
})

Deno.test("a read made again, not next to the first, with another reader's link between: a second link", () => {
	const { reads, readers, run, t, n } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.track(n("r"), n("b"))
	run("s", "a") // a's last reader is now s, not r
	t.track(n("r"), n("a"))
	t.end(n("r"))
	// a's newest reader is s, not r, and the cursor is on b, so the check misses and a is linked twice.
	assertEquals(reads("r"), ["a", "b", "a"])
	assertEquals(readers("a"), ["r", "s", "r"])
	consistent({ n }, ["r", "s", "a", "b"])
})

Deno.test("a read made again whatever happened between: duplicates where the checks miss", () => {
	const { reads, readers, run, t, n } = setup()
	t.begin(n("r"))
	for (const x of ["a", "b", "c"]) t.track(n("r"), n(x))
	run("s", "a", "b", "c")
	run("u", "c", "b", "a")
	// Out of order, with s and u the last readers of each: b, a, c are linked again at the cursor,
	// then a and b are r's own newest links and are not linked a third time.
	for (const x of ["b", "a", "c", "a", "b"]) t.track(n("r"), n(x))
	t.end(n("r"))
	assertEquals(reads("r"), ["a", "b", "c", "b", "a", "c"])
	for (const x of ["a", "b", "c"]) assertEquals(readers(x), ["r", "s", "u", "r"])
})

Deno.test("a read made out of order, then met in order again: the old link stays, b is linked twice", () => {
	const { n, reads, readers, run } = setup()
	run("r", "a", "b")
	run("r", "b", "a", "b")
	assertEquals(reads("r"), ["b", "a", "b"])
	assertEquals(readers("a"), ["r"])
	assertEquals(readers("b"), ["r", "r"])
	consistent({ n }, ["r", "a", "b"])
})

Deno.test("a read made again after an untrack of it is a new link", () => {
	const { reads, run, t, n } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.track(n("r"), n("b"))
	run("s", "a")
	t.untrack(n("r"), n("a"))
	t.track(n("r"), n("a"))
	t.end(n("r"))
	assertEquals(reads("r"), ["b", "a"])
})

Deno.test("a reader reading itself", () => {
	const { reads, readers, run, t, n } = setup()
	run("r", "r")
	assertEquals(reads("r"), ["r"])
	assertEquals(readers("r"), ["r"])
	run("r", "r", "r")
	assertEquals(reads("r"), ["r"])
	t.untrack(n("r"))
	assertEquals(reads("r"), [])
	assertEquals(readers("r"), [])
})

Deno.test("end outside a run drops nothing", () => {
	const { t, n, reads, run } = setup()
	run("r", "a", "b")
	t.end(n("r"))
	t.end(n("r"))
	assertEquals(reads("r"), ["a", "b"])
	t.end(n("fresh"))
	assertEquals(reads("fresh"), [])
})

Deno.test("end after add (no begin): the cursor is the last link, nothing dropped", () => {
	const { t, n, reads } = setup()
	t.add(n("r"), n("a"))
	t.add(n("r"), n("b"))
	t.end(n("r"))
	assertEquals(reads("r"), ["a", "b"])
})

Deno.test("end with no cursor in a run drops all", () => {
	const { t, n, reads, run } = setup()
	run("r", "a", "b")
	t.begin(n("r"))
	t.end(n("r"))
	assertEquals(reads("r"), [])
})

Deno.test("add: appends once, ignores one already read", () => {
	const { t, n, reads, readers } = setup()
	t.add(n("r"), n("a"))
	t.add(n("r"), n("b"))
	t.add(n("r"), n("a"))
	assertEquals(reads("r"), ["a", "b"])
	assertEquals(readers("a"), ["r"])
})

Deno.test("add: leaves a re-run's links alone, and a following re-run still confirms them", () => {
	const { t, n, reads, run } = setup()
	run("r", "a", "b")
	t.add(n("r"), n("c"))
	assertEquals(reads("r"), ["a", "b", "c"])
	run("r", "a", "b", "c")
	assertEquals(reads("r"), ["a", "b", "c"])
})

Deno.test("untrack(from, to): that one only; unknown ones do nothing", () => {
	const { t, n, reads, readers, run } = setup()
	run("r", "a", "b", "c")
	t.untrack(n("r"), n("b"))
	t.untrack(n("r"), n("zzz"))
	assertEquals(reads("r"), ["a", "c"])
	assertEquals(readers("b"), [])
	assertEquals(readers("a"), ["r"])
})

Deno.test("untrack(from, to): drops every duplicate of it", () => {
	const { t, n, reads, readers, run } = setup()
	run("r", "a", "b", "a") // a not next to the first: may be two links
	t.untrack(n("r"), n("a"))
	assertEquals(reads("r"), ["b"])
	assertEquals(readers("a"), [])
})

Deno.test("untrack(from): all of from's, cursor reset, from can read again", () => {
	const { t, n, reads, readers, run } = setup()
	run("r", "a", "b")
	run("s", "a")
	t.untrack(n("r"))
	assertEquals(reads("r"), [])
	assertEquals(readers("a"), ["s"])
	assertEquals(readers("b"), [])
	assertEquals(n("r").cursor, null)
	run("r", "b")
	assertEquals(reads("r"), ["b"])
})

Deno.test("untrack of the cursor's link in a run: the cursor steps back, the run goes on", () => {
	const { t, n, reads, readers } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.track(n("r"), n("b"))
	t.untrack(n("r"), n("b"))
	t.track(n("r"), n("c"))
	t.end(n("r"))
	assertEquals(reads("r"), ["a", "c"])
	assertEquals(readers("b"), [])
})

Deno.test("untrack a spot in a run, then read it again: a new link", () => {
	const { t, n, reads } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.untrack(n("r"), n("a"))
	t.track(n("r"), n("a"))
	t.end(n("r"))
	assertEquals(reads("r"), ["a"])
})

Deno.test("untrack(from) in a run: later reads start over, end keeps them", () => {
	const { t, n, reads, readers } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.untrack(n("r"))
	t.track(n("r"), n("b"))
	t.end(n("r"))
	assertEquals(reads("r"), ["b"])
	assertEquals(readers("a"), [])
})

Deno.test("untrack of an unread-from node does nothing", () => {
	const { t, n, reads } = setup()
	t.untrack(n("r"))
	t.untrack(n("r"), n("a"))
	assertEquals(reads("r"), [])
})

Deno.test("nested runs: each reader has its own cursor", () => {
	const { t, n, reads, readers, run } = setup()
	run("p", "a", "b")
	run("q", "b")
	t.begin(n("p"))
	t.track(n("p"), n("a"))
	t.begin(n("q"))
	t.track(n("q"), n("b"))
	t.track(n("q"), n("c"))
	t.end(n("q"))
	t.track(n("p"), n("b"))
	t.end(n("p"))
	assertEquals(reads("p"), ["a", "b"])
	assertEquals(reads("q"), ["b", "c"])
	assertEquals(readers("b"), ["p", "q"])
})

Deno.test("interleaved runs: p and q alternate their reads", () => {
	const { t, n, reads, readers } = setup()
	t.begin(n("p"))
	t.begin(n("q"))
	for (const x of ["a", "b", "c"]) {
		t.track(n("p"), n(x))
		t.track(n("q"), n(x))
	}
	t.end(n("p"))
	t.end(n("q"))
	assertEquals(reads("p"), ["a", "b", "c"])
	assertEquals(reads("q"), ["a", "b", "c"])
	for (const x of ["a", "b", "c"]) assertEquals(readers(x), ["p", "q"])
	t.begin(n("p"))
	t.begin(n("q"))
	for (const x of ["a", "b", "c"]) t.track(n("p"), n(x))
	for (const x of ["c", "a"]) t.track(n("q"), n(x))
	t.end(n("p"))
	t.end(n("q"))
	assertEquals(reads("p"), ["a", "b", "c"])
	assertEquals([...new Set(reads("q"))].sort(), ["a", "c"])
	assertEquals(readers("b"), ["p"])
})

Deno.test("a nested run's ending leaves the outer cursor where it was", () => {
	const { t, n, reads } = setup()
	t.begin(n("p"))
	t.track(n("p"), n("a"))
	t.begin(n("q"))
	t.track(n("q"), n("a"))
	t.end(n("q"))
	assert(n("p").cursor?.to === n("a"))
	t.track(n("p"), n("b"))
	t.end(n("p"))
	assertEquals(reads("p"), ["a", "b"])
})

Deno.test("begin takes a new tick and resets the cursor; end closes it; a stale gen is not 'read this run'", () => {
	const { t, n, run } = setup()
	run("r", "a")
	assertEquals(n("r").open, false)
	t.begin(n("r"))
	const g = n("r").gen
	assert(g > 0)
	assert(n("r").open)
	assertEquals(n("r").cursor, null)
	t.end(n("r"))
	assertEquals(n("r").open, false)
	assertEquals(n("r").gen, g)
	t.begin(n("r"))
	assert(n("r").gen > g)
	t.track(n("r"), n("a"))
	assertEquals(n("r").reads!.gen, n("r").gen)
})

Deno.test("old: a link the latest run did not read, once that run is over", () => {
	const { t, n } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.track(n("r"), n("b"))
	t.end(n("r"))
	const [a, b] = t.readers(n("a")).concat(t.readers(n("b")))
	assert(!t.old(a) && !t.old(b))
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	assert(!t.old(a) && !t.old(b))
	t.leave(n("r"))
	assert(!t.old(a))
	assert(t.old(b))
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	t.track(n("r"), n("b"))
	t.leave(n("r"))
	assert(!t.old(a) && !t.old(b))
})

Deno.test("a removed reader in the middle: the order is kept, the others untouched", () => {
	const { t, n, run, readers } = setup()
	for (let i = 0; i < 8; i++) run(`r${i}`, "hot")
	t.untrack(n("r3"))
	assertEquals(readers("hot"), ["r0", "r1", "r2", "r4", "r5", "r6", "r7"])
	consistent({ n }, ["hot"])
})

Deno.test("removing the first and the last reader moves first and last", () => {
	const { t, n, run, readers } = setup()
	for (let i = 0; i < 4; i++) run(`r${i}`, "hot")
	t.untrack(n("r0"))
	t.untrack(n("r3"))
	assertEquals(n("hot").first!.from.owner, "r1")
	assertEquals(n("hot").last!.from.owner, "r2")
	assertEquals(readers("hot"), ["r1", "r2"])
	consistent({ n }, ["hot"])
})

Deno.test("new readers after removals come after the old, in the order made", () => {
	const { t, n, run, readers } = setup()
	for (let i = 0; i < 10; i++) run(`r${i}`, "hot")
	for (let i = 0; i < 6; i++) t.untrack(n(`r${i}`))
	run("late1", "hot")
	run("late2", "hot")
	t.untrack(n("r7"))
	run("late3", "hot")
	assertEquals(readers("hot"), ["r6", "r8", "r9", "late1", "late2", "late3"])
	consistent({ n }, ["hot"])
})

Deno.test("removing the only reader empties the list", () => {
	const { t, n, run } = setup()
	run("r", "hot")
	t.untrack(n("r"))
	assertEquals(n("hot").first, null)
	assertEquals(n("hot").last, null)
})

Deno.test("end dropping stale links takes them out of the readers", () => {
	const { n, run, readers } = setup()
	for (let i = 0; i < 8; i++) run(`r${i}`, "hot")
	for (let i = 0; i < 5; i++) run(`r${i}`) // re-runs reading nothing
	assertEquals(readers("hot"), ["r5", "r6", "r7"])
	consistent({ n }, ["hot"])
})

Deno.test("add: throws in a run, changes nothing; works again after the run", () => {
	const { t, n, reads, readers, run } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	assertThrows(() => t.add(n("r"), n("b")))
	assertEquals(reads("r"), ["a"])
	assertEquals(readers("b"), [])
	t.end(n("r"))
	t.add(n("r"), n("b"))
	assertEquals(reads("r"), ["a", "b"])
	run("r", "a", "b")
	t.add(n("r"), n("c"))
	assertEquals(reads("r"), ["a", "b", "c"])
})

Deno.test("begin: throws in a run, changes nothing; works again after the run", () => {
	const { t, n, reads, readers } = setup()
	t.begin(n("r"))
	t.track(n("r"), n("a"))
	const gen = n("r").gen
	assertThrows(() => t.begin(n("r")), Error, "begin in a run")
	assertEquals(n("r").gen, gen)
	t.track(n("r"), n("b"))
	assertEquals(reads("r"), ["a", "b"])
	assertEquals(readers("a"), ["r"])
	t.end(n("r"))
	t.begin(n("r"))
	t.end(n("r"))
	assertEquals(reads("r"), [])
})

Deno.test("a long run of out-of-order re-reads stays linear: nothing else read the spots", () => {
	const { t, n } = setup()
	const names = Array.from({ length: 2000 }, (_, i) => `a${i}`)
	t.begin(n("r"))
	for (const x of names) t.track(n("r"), n(x))
	for (const x of names.toReversed()) t.track(n("r"), n(x))
	t.end(n("r"))
	assertEquals(t.reads(n("r")).length, 2000)
})

Deno.test("garbage: a node with no links holds nothing", () => {
	const { t, n, run } = setup()
	run("r", "a", "b")
	t.untrack(n("r"))
	for (const x of ["r", "a", "b"]) {
		const node = n(x)
		assertEquals(node.reads, null)
		assertEquals(node.first, null)
		assertEquals(node.last, null)
	}
})

Deno.test("garbage: a dropped link points at nothing live from the readers side", () => {
	const { t, n, run } = setup()
	run("r", "a")
	const l = n("r").reads!
	run("r") // drops it
	assert(!t.readers(n("a")).includes(l))
})

Deno.test("many reads on one node: sizes stay consistent", () => {
	const s = setup()
	const names = Array.from({ length: 200 }, (_, i) => `a${i}`)
	s.run("r", ...names)
	consistent(s, ["r", ...names])
	s.run("r", ...names.slice(50, 150))
	consistent(s, ["r", ...names])
	assertEquals(s.reads("r"), names.slice(50, 150))
})

Deno.test("fuzz: 30 seeds against the model", () => {
	const READERS = ["p", "q", "r", "s"]
	const TARGETS = ["a", "b", "c", "d", "e", "p", "q"]
	for (let seed = 1; seed <= 30; seed++) {
		let x = seed * 2654435761 >>> 0 || 1
		const pick = (n: number) => {
			x ^= x << 13
			x ^= x >>> 17
			x ^= x << 5
			return (x >>> 0) % n
		}
		const one = <T>(xs: T[]) => xs[pick(xs.length)]
		const s = setup()
		const m = createModel()
		const open: string[] = []
		const check = (at: string, r: string, a: string) => {
			assertEquals(s.reads(r), m.reads(r), `seed ${seed} ${at}: reads of ${r}`)
			assertEquals(s.readers(a), m.readers(a), `seed ${seed} ${at}: readers of ${a}`)
		}
		for (let i = 0; i < 300; i++) {
			const k = pick(20)
			let r: string, a: string
			let what: string
			if (k < 3 && open.length < READERS.length) {
				r = one(READERS.filter((y) => !open.includes(y)))
				open.push(r)
				a = one(TARGETS)
				s.t.begin(s.n(r))
				m.begin(r)
				what = `begin ${r}`
			} else if (k < 11 && open.length > 0) {
				r = pick(4) === 0 ? one(open) : open[open.length - 1]
				a = one(TARGETS)
				s.t.track(s.n(r), s.n(a))
				m.track(r, a)
				what = `track ${r} ${a}`
			} else if (k < 14 && open.length > 0) {
				r = open.pop()!
				a = one(TARGETS)
				s.t.end(s.n(r))
				m.end(r)
				what = `end ${r}`
			} else if (k < 16) {
				r = one(READERS)
				a = one(TARGETS)
				if (open.includes(r)) continue
				s.t.add(s.n(r), s.n(a))
				m.add(r, a)
				what = `add ${r} ${a}`
			} else if (k < 17) {
				r = one(READERS)
				a = one(TARGETS)
				s.t.untrack(s.n(r), s.n(a))
				m.untrack(r, a)
				what = `untrack ${r} ${a}`
			} else if (k < 18) {
				r = one(READERS)
				a = one(TARGETS)
				s.t.untrack(s.n(r))
				m.untrack(r)
				what = `untrack ${r}`
			} else {
				const idle = READERS.filter((y) => !open.includes(y))
				if (idle.length === 0) continue
				r = one(idle)
				a = one(TARGETS)
				s.t.end(s.n(r))
				m.end(r)
				what = `idle end ${r}`
			}
			check(`step ${i} ${what}`, r, a)
		}
		consistent(s, [...READERS, ...TARGETS])
	}
})

Deno.test("fuzz: 40 seeds, after every end the reads deduplicated are the distinct reads in first-read order", () => {
	const READERS = ["p", "q", "r", "s"]
	const SPOTS = ["a", "b", "c", "d", "p", "q"]
	for (let seed = 1; seed <= 40; seed++) {
		let x = seed * 2654435761 >>> 0 || 1
		const pick = (n: number) => {
			x ^= x << 13
			x ^= x >>> 17
			x ^= x << 5
			return (x >>> 0) % n
		}
		const one = <T>(xs: T[]) => xs[pick(xs.length)]
		const s = setup()
		const m = createModel()
		const open: string[] = []
		const read = new Map<string, string[]>()
		const same = (at: string, r: string, a: string) => {
			assertEquals(s.reads(r), m.reads(r), `${at}: reads of ${r}`)
			assertEquals(s.readers(a), m.readers(a), `${at}: readers of ${a}`)
		}
		for (let i = 0; i < 400; i++) {
			const k = pick(10)
			if (k < 2 && open.length < READERS.length) {
				const r = one(READERS.filter((y) => !open.includes(y)))
				open.push(r)
				read.set(r, [])
				s.t.begin(s.n(r))
				m.begin(r)
			} else if (k < 8 && open.length > 0) {
				const r = pick(4) === 0 ? one(open) : open[open.length - 1]
				const a = one(SPOTS)
				s.t.track(s.n(r), s.n(a))
				m.track(r, a)
				if (!read.get(r)!.includes(a)) read.get(r)!.push(a)
				same(`seed ${seed}, step ${i}, track ${r} ${a}`, r, a)
			} else if (open.length > 0) {
				const r = pick(4) === 0 ? open.splice(pick(open.length), 1)[0] : open.pop()!
				s.t.end(s.n(r))
				m.end(r)
				const at = `seed ${seed}, step ${i}, end ${r}`
				assertEquals([...new Set(s.reads(r))], read.get(r), `${at}: reads`)
				for (const a of SPOTS) same(at, r, a)
			}
		}
		consistent(s, [...READERS, ...SPOTS])
	}
})

// A duplicate link is harmless to the scheduler: its reader is due once, and a run that no
// longer reads the spot leaves no link of it behind.
Deno.test("scheduler: a reader linked twice to a spot runs once when it changes, and both links go", () => {
	const s = createScheduler()
	let runs = 0
	let shape = ["a", "b"]
	s.runWithScope(s.createRootScope({ actor: "test" }), () =>
		s.createComputer(() => {
			runs++
			for (const k of shape) s.track(k)
			return runs
		}, () => {}))
	s.pulse()
	assertEquals(runs, 1)
	// old [a, b], read b, a, b: two links to b
	shape = ["b", "a", "b"]
	s.mark(["a"])
	s.pulse()
	assertEquals(runs, 2)
	s.mark(["b"])
	s.pulse()
	assertEquals(runs, 3)
	shape = ["a"]
	s.mark(["b"])
	s.pulse()
	assertEquals(runs, 4)
	s.mark(["b"])
	s.pulse()
	assertEquals(runs, 4)
	s.mark(["a"])
	s.pulse()
	assertEquals(runs, 5)
})
