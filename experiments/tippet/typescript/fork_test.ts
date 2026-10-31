import { assertEquals } from "@std/assert"
import { createLog, createMemoryStore, type Run, type Store } from "./log.ts"

const seed = new Uint8Array(32).fill(7)
const put = (l: ReturnType<typeof createLog>, v: number) =>
	l.write({ node: "n", part: "value", patches: [{ path: [], value: v }], when: 0, on: [] })

async function twins(n: number) {
	const one = createLog({ seed }), two = createLog({ seed })
	await one.load(), await two.load()
	for (let i = 0; i < n; i++) put(one, i), put(two, 100 + i)
	return {
		one,
		two,
		device: one.device!,
		a: (await one.run(one.device!, 1))!,
		b: (await two.run(one.device!, 1))!,
	}
}
function counted(): Store & { reads: number; appends: number } {
	const s = createMemoryStore(),
		c = {
			...s,
			reads: 0,
			appends: 0,
			get: (d: string, n: number) => (c.reads++, s.get(d, n)),
			run: (d: string, n: number) => (c.reads++, s.run(d, n)),
			append: (
				r: Uint8Array,
				at?: Parameters<Store["append"]>[1],
			) => (c.appends++, s.append(r, at)),
		}
	return c
}
const junk = (r: Run, from: number): Run => ({
	...r,
	steps: r.steps.slice(from),
	sig: new Uint8Array(64),
})

Deno.test("an unsigned run reads no held step, and shows no fork", async () => {
	const { a, b, device } = await twins(3)
	const store = counted(), held = createLog({ store })
	await held.load()
	await held.take(a)
	const was = store.reads
	assertEquals(await held.take({ ...junk(b, 0), steps: b.steps.slice(0, 2) }), { added: 0 })
	assertEquals(await held.take(junk(b, 2)), { refused: "signature" })
	assertEquals(store.reads, was)
	assertEquals(held.forks(), [])
	assertEquals(held.count(device), 3)
})

Deno.test("an unsigned run of its own key closes and signs nothing", async () => {
	const { two, b } = await twins(2)
	const store = counted(), me = createLog({ seed, store })
	await me.load()
	put(me, 1), put(me, 2)
	const was = store.appends
	assertEquals(await me.take(junk(b, 1)), { refused: "own" })
	assertEquals(store.appends, was)
	put(me, 3)
	assertEquals((await me.run(me.device!, 1))!.steps.length, 3)
	assertEquals(me.forks(), [])
	void two
})

Deno.test("a proof is held only for a device whose steps are held, and only up to the cap", async () => {
	const { a, b, device } = await twins(3)
	const tail = (r: Run) => ({ steps: r.steps.slice(2), sig: r.sig })
	const none = createLog()
	await none.load()
	assertEquals(await none.fork(device, tail(a), tail(b)), false)
	assertEquals(none.forks(), [])
	const small = createLog({ forks: 10 })
	await small.load()
	await small.take(a)
	assertEquals(await small.fork(device, tail(a), tail(b)), false)
	assertEquals(small.forks(), [])
	const some = createLog()
	await some.load()
	await some.take(a)
	assertEquals(await some.fork(device, tail(a), tail(b)), true)
	assertEquals(some.forks().length, 1)
})
