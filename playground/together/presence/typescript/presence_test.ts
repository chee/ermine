import { assert, assertEquals } from "@std/assert"
import { decode } from "@ermine/encoding/cbor"
import createEntry from "@ermine/core/node/entry"
import { place } from "@ermine/places"
import { createPair } from "./channel.ts"
import { type Device, device } from "./world.ts"
import {
	clear,
	connect,
	editPresence,
	keep,
	type Live,
	PART,
	readPresence,
	readRow,
	renew,
	setPresence,
	sweep,
} from "./presence.ts"

const ANCHOR = "work"

function two() {
	const clock = { t: 1000 }
	const a = device("a", clock), b = device("b", clock)
	const pair = createPair("a", "b")
	connect(a, pair.a, { topic: ANCHOR })
	connect(b, pair.b, { topic: ANCHOR })
	return { clock, a, b, pair }
}

// a computation reading the live rows, tracked, with how many times it ran
function watch(d: Device, anchor = ANCHOR) {
	const seen: Live[][] = []
	d.scheduler.runWithScope(
		d.scope,
		() => d.scheduler.createComputer(() => readPresence(d, anchor), (v) => void seen.push(v)),
	)
	d.scheduler.pulse()
	return seen
}

Deno.test("a row set on one device arrives on the other under its name", () => {
	const { a, b } = two()
	const seen = watch(b)
	setPresence(a, ANCHOR, "juno", { cursor: [12, 40] }, 5000)
	b.scheduler.pulse()
	assertEquals(seen.at(-1)!.map((r) => [r.who, r.value]), [["a", { cursor: [12, 40] }]])
	// the writer sees its own row under its own name
	assertEquals(readPresence(a, ANCHOR).map((r) => r.who), ["juno"])
})

Deno.test("one row per device: moving replaces the row", () => {
	const { a, b } = two()
	setPresence(a, ANCHOR, "juno", 1, 5000)
	setPresence(a, ANCHOR, "juno", 2, 5000)
	setPresence(b, ANCHOR, "chee", 3, 5000)
	assertEquals(readPresence(b, ANCHOR).map((r) => [r.who, r.value]), [["a", 2], ["chee", 3]])
	assertEquals(Object.keys(b.table.get(PART, ANCHOR)!.value!).length, 2)
})

Deno.test("a cursor at 60 Hz for a second: a patch and a rerun a change, one send each", () => {
	const { a, b, pair, clock } = two()
	// mount the anchor in b's tree so places can watch its path
	b.scheduler.runWithScope(b.scope, () => {
		const kids = createEntry<Record<string, unknown>>({}, { actor: "b", time: 0 })
		b.table.add("children", "R", kids)
		place(kids, "doc", ANCHOR, { actor: "b", time: 0 })
		b.places.commit([kids])
	})
	const patches: unknown[] = []
	b.places.watchPath(["doc"], (f) => patches.push(...f.patches), { part: PART })
	let reruns = 0
	b.scheduler.runWithScope(
		b.scope,
		() => b.scheduler.createComputer(() => (reruns++, readRow(b, ANCHOR, "a")), () => {}),
	)
	b.scheduler.pulse()
	const base = reruns
	for (let i = 0; i < 60; i++) {
		clock.t += 1000 / 60
		setPresence(a, ANCHOR, "x", { cursor: [i, i] }, 5000)
		b.scheduler.pulse()
	}
	assertEquals(patches.length, 60)
	assertEquals(reruns - base, 60)
	assertEquals(pair.sent.filter((m) => m.from === "a").length, 60)
	assertEquals(readRow(b, ANCHOR, "a")!.value, { cursor: [59, 59] })
})

Deno.test("a device going quiet: its row expires on the other side after until", () => {
	const { a, b, clock } = two()
	const seen = watch(b)
	setPresence(a, ANCHOR, "x", 1, 2000)
	b.scheduler.pulse()
	assertEquals(seen.at(-1)!.length, 1)
	clock.t += 1999
	assertEquals(sweep(b), [])
	clock.t += 1
	assertEquals(sweep(b), [{ anchor: ANCHOR, who: "a" }])
	b.scheduler.pulse()
	assertEquals(seen.at(-1), [])
	assertEquals(b.table.get(PART, ANCHOR)!.value, {})
})

Deno.test("a renewed row stays", () => {
	const { a, b, clock } = two()
	setPresence(a, ANCHOR, "x", 1, 2000)
	for (let i = 0; i < 5; i++) {
		clock.t += 1500
		assert(renew(a, ANCHOR, "x", 2000))
		assertEquals(sweep(a), [])
		assertEquals(sweep(b), [])
	}
	assertEquals(readPresence(b, ANCHOR).length, 1)
	assertEquals(renew(a, ANCHOR, "nobody", 1), false)
})

Deno.test("nothing is sent back", () => {
	const { a, b, pair } = two()
	setPresence(a, ANCHOR, "x", 1, 5000)
	assertEquals(pair.sent.map((m) => m.from), ["a"])
	clear(b, ANCHOR, "a") // b removing a's row is its own business: not mine, not sent
	assertEquals(pair.sent.length, 1)
	sweep(a, 1e12)
	assertEquals(pair.sent.length, 1) // sweeping is each side's own
})

Deno.test("clear removes the row at once, there too", () => {
	const { a, b } = two()
	setPresence(a, ANCHOR, "x", 1, 5000)
	assertEquals(readPresence(b, ANCHOR).length, 1)
	clear(a, ANCHOR, "x")
	assertEquals(readPresence(a, ANCHOR), [])
	assertEquals(readPresence(b, ANCHOR), [])
})

Deno.test("two anchors do not mix", () => {
	const { clock, a, b, pair } = two()
	connect(a, pair.a, { topic: "other" })
	connect(b, pair.b, { topic: "other" })
	setPresence(a, ANCHOR, "x", "w", 5000)
	setPresence(a, "other", "x", "o", 5000)
	assertEquals(readPresence(b, ANCHOR).map((r) => r.value), ["w"])
	assertEquals(readPresence(b, "other").map((r) => r.value), ["o"])
	clock.t += 6000
	assertEquals(sweep(b).length, 2)
})

Deno.test("a late joiner hears my rows when I announce", () => {
	const clock = { t: 0 }
	const a = device("a", clock), b = device("b", clock)
	const pair = createPair()
	const mine = connect(a, pair.a, { topic: ANCHOR })
	setPresence(a, ANCHOR, "x", 1, 5000)
	connect(b, pair.b, { topic: ANCHOR })
	assertEquals(readPresence(b, ANCHOR), [])
	mine.announce()
	assertEquals(readPresence(b, ANCHOR).length, 1)
})

Deno.test("presence is kept out of a save unless the side says so", () => {
	const { a } = two()
	assertEquals(keep(a, PART), false)
	assertEquals(keep(a, "children"), true)
	assertEquals(keep({ save: true }, PART), true)
})

Deno.test("an edit with patches on: patches cross, the row is the sender's, one write a side", () => {
	const clock = { t: 0 }
	const a = device("a", clock), b = device("b", clock)
	const pair = createPair("a", "b")
	connect(a, pair.a, { topic: ANCHOR, patches: true })
	connect(b, pair.b, { topic: ANCHOR, patches: true })
	setPresence(a, ANCHOR, "x", { pts: [[0, 0]] }, 5000)
	const seen = watch(b)
	clock.t = 1000
	assert(editPresence(a, ANCHOR, "x", [{ path: ["pts"], range: [1, 1], value: [[1, 1]] }], 5000))
	b.scheduler.pulse()
	assertEquals(readRow(b, ANCHOR, "a"), {
		who: "a",
		value: { pts: [[0, 0], [1, 1]] },
		until: 6000,
	})
	assertEquals(readRow(a, ANCHOR, "x")!.value, { pts: [[0, 0], [1, 1]] })
	assertEquals(seen.length, 2)
	assert(!editPresence(a, ANCHOR, "nobody", [], 5000))
	// the message is the patch, numbered
	assertEquals(decode(pair.sent.at(-1)!.bytes), {
		ttl: 5000,
		patches: [{ path: ["pts"], range: [1, 1], value: [[1, 1]] }],
		n: 2,
	})
})

Deno.test("a missed patch message is dropped and the receiver says hello: the sender's announce heals at once", () => {
	const clock = { t: 0 }
	const a = device("a", clock), b = device("b", clock)
	const pair = createPair("a", "b")
	const ca = connect(a, pair.a, { topic: ANCHOR, patches: true })
	const stopB = connect(b, pair.b, { topic: ANCHOR, patches: true }).stop
	setPresence(a, ANCHOR, "x", [1], 5000)
	stopB()
	editPresence(a, ANCHOR, "x", [{ path: [], range: [1, 1], value: [2] }], 5000)
	connect(b, pair.b, { topic: ANCHOR, patches: true })
	editPresence(a, ANCHOR, "x", [{ path: [], range: [2, 2], value: [3] }], 5000)
	assertEquals(readRow(b, ANCHOR, "a")!.value, [1, 2, 3])
	ca.announce()
	assertEquals(readRow(b, ANCHOR, "a")!.value, [1, 2, 3])
})

Deno.test("an invalid edit throws and changes nothing", () => {
	const { a, pair } = two()
	setPresence(a, ANCHOR, "x", { n: 1 }, 5000)
	const sent = pair.sent.length
	let threw = false
	try {
		editPresence(a, ANCHOR, "x", [{ path: ["no", "where"], value: 1 }], 5000)
	} catch {
		threw = true
	}
	assert(threw)
	assertEquals(readRow(a, ANCHOR, "x")!.value, { n: 1 })
	assertEquals(pair.sent.length, sent)
})
