// Rebase against working out from the first step: devices that hold an entry's newest steps' undos
// (rebase 1, 2, 256) see the same values and failures, after every take, as one that holds none
// (rebase 0). A few dozen seeds: writers splice a text, put keys and whole values, now and then
// passing runs to each other; readers take the writers' runs in a seeded order, some waited for
// one at a time, some several at once.
import { assertEquals, assertThrows } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { rand } from "../../../conformance/typescript/rand.ts"
import { createLog, type Run } from "./log.ts"
import { createHistory } from "./history.ts"
import { fresh, step } from "./elements.ts"

async function device(rebase?: number, forgets?: boolean) {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "root",
		table,
		paths: createPaths(),
		scheduler: s,
		contributors: [children],
	})
	s.onTrackingEnd((k) => places.release(k))
	const scope = s.createRootScope({ actor: "test" })
	const run = <T>(f: () => T) => s.runWithScope(scope, f)
	const log = createLog({ writes: true })
	const history = createHistory({ log, table, places, run, rebase, forgets })
	await history.load()
	return {
		log,
		history,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
		edit: (id: string, patches: Patch[]) =>
			run(() => {
				const e = table.get("value", id)!
				update(e, patches, createChangeHeader(s))
				places.commit([e])
			}),
	}
}
type Device = Awaited<ReturnType<typeof device>>

// every run of a device's, from the first
async function runs(d: Device): Promise<Run[]> {
	const out: Run[] = [], me = d.log.device!
	for (let from = 1; from <= d.log.count(me);) {
		const r = (await d.log.run(me, from))!
		out.push(r), from += r.steps.length
	}
	return out
}

async function writers(seed: number) {
	const r = rand(seed)
	const ws = [await device(), await device(), await device()]
	for (const w of ws) {
		w.put("doc", { t: "" }), w.put("map", {}), w.put("list", { arr: [{ t: "" }] })
	}
	for (let i = 0; i < 60; i++) {
		const w = ws[r(3)], t = (w.value("doc") as { t: string }).t
		const pick = r(10)
		if (pick < 5) {
			const from = r(t.length + 1), to = from + r(Math.min(3, t.length - from) + 1)
			w.edit("doc", [{ path: ["t"], range: [from, to], value: "abcxyz"[r(6)].repeat(r(3)) }])
		} else if (pick < 7) {
			// a text in an array, or an element into the array: positions under it name others then
			const arr = (w.value("list") as { arr: { t: string }[] }).arr
			if (r(2)) {
				const i = r(arr.length), t = arr[i].t, at = r(t.length + 1)
				w.edit("list", [{ path: ["arr", i, "t"], range: [at, at], value: "mn"[r(2)] }])
			} else {
				const at = r(arr.length + 1)
				w.edit("list", [{ path: ["arr"], range: [at, at], value: [{ t: "q" }] }])
			}
		} else if (pick < 8) w.edit("map", [{ path: [`k${r(4)}`], value: r(100) }])
		else if (pick < 9) w.put("map", { k0: r(100) })
		else {
			// one passes its runs to another: later writes there are on them
			const a = ws[r(3)], b = ws[r(3)]
			if (a !== b) { for (const run of await runs(a)) await b.log.take(run) }
		}
	}
	return Promise.all(ws.map(runs))
}

// what a reader shows after each take, its runs taken in a seeded order
async function read(all: Run[][], seed: number, rebase: number) {
	const r = rand(seed), d = await device(rebase), next = all.map(() => 0), seen: unknown[] = []
	const left = () => all.some((rs, i) => next[i] < rs.length)
	while (left()) {
		// one, or a few at once
		const takes = []
		for (let k = 1 + (r(3) === 0 ? r(4) : 0); k > 0 && left(); k--) {
			let i = r(all.length)
			while (next[i] >= all[i].length) i = (i + 1) % all.length
			takes.push(d.log.take(all[i][next[i]++]))
		}
		await Promise.all(takes)
		seen.push([
			d.value("doc"),
			d.value("map"),
			d.value("list"),
			d.history.failed.map((f) => `${f.device} ${f.n}`),
		])
	}
	return seen
}

Deno.test("rebase: the same values and failures after every take as working out from the first", async () => {
	for (let seed = 1; seed <= 30; seed++) {
		const all = await writers(seed)
		const from = await read(all, seed, 0)
		for (const rebase of [1, 2, 256]) {
			assertEquals(await read(all, seed, rebase), from, `seed ${seed}, rebase ${rebase}`)
		}
	}
})

Deno.test("ids: readers taking the same runs in other orders end the same", async () => {
	for (let seed = 1; seed <= 20; seed++) {
		const all = await writers(seed)
		// failed as a set: it grows in the order steps come
		const end = async (s: number) => {
			const [doc, map, list, failed] = (await read(all, s, 256)).at(-1) as unknown[]
			return [doc, map, list, (failed as string[]).toSorted()]
		}
		const ends = await Promise.all([seed, seed + 1000, seed + 2000].map(end))
		assertEquals(ends[1], ends[0], `seed ${seed}`)
		assertEquals(ends[2], ends[0], `seed ${seed}`)
	}
})

Deno.test("ids: a forgetting device takes a splice by ids as its range, as written", async () => {
	const w = await device(), f = await device(undefined, true)
	w.put("doc", { t: "ab" })
	w.edit("doc", [{ path: ["t"], range: [1, 1], value: "X" }])
	for (const r of await runs(w)) await f.log.take(r)
	assertEquals(f.value("doc"), { t: "aXb" })
	assertEquals(f.history.failed, [])
})

Deno.test("ids: a splice into an array makes the texts under it new: both sides end the same", async () => {
	const w = await device(), r = await device()
	w.put("doc", { arr: [{ t: "ab" }] })
	w.edit("doc", [{ path: ["arr", 0, "t"], range: [1, 1], value: "X" }])
	w.edit("doc", [{ path: ["arr"], range: [0, 0], value: [{ t: "hello" }] }])
	w.edit("doc", [{ path: ["arr", 0, "t"], range: [5, 5], value: "!" }])
	for (const run of await runs(w)) await r.log.take(run)
	assertEquals(w.value("doc"), { arr: [{ t: "hello!" }, { t: "aXb" }] })
	assertEquals(r.value("doc"), w.value("doc"))
	assertEquals([w.history.failed, r.history.failed], [[], []])
})

Deno.test("ids: an insert of another kind than its sequence doesn't apply, as apply refuses it", () => {
	const st = fresh()
	step(st, { device: "a", n: 1, lamport: 1, patches: [{ path: [], value: { t: "ab", l: [1] } }] })
	assertThrows(() =>
		step(st, {
			device: "a",
			n: 2,
			lamport: 2,
			patches: [{ path: ["t"], range: [1, 1], value: [1] }],
		})
	)
	assertThrows(() =>
		step(st, {
			device: "a",
			n: 2,
			lamport: 2,
			patches: [{ path: ["l"], range: [1, 1], value: "x" }],
		})
	)
	step(st, {
		device: "a",
		n: 2,
		lamport: 2,
		patches: [{ path: ["t"], range: [1, 1], value: "x" }],
	})
	assertEquals(st.value, { t: "axb", l: [1] })
})
