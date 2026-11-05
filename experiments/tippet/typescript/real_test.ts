// readAll through a real createErmine: two ermines, each with a tippet log and a history over the
// ermine's own table and places, and the reading feature. The history is made after createErmine,
// since the places are (a feature's setup that asked for them would throw not-yet), so the feature
// is given a thunk that reaches the history once it is there.
import { assertEquals } from "@std/assert"
import { createErmine, ensureNode, patch, read, readAll } from "@ermine/system"
import { createLog } from "./log.ts"
import { createHistory, type History } from "./history.ts"
import { reading } from "./reading.ts"

async function one(seed: number) {
	const log = createLog({ writes: true, seed: new Uint8Array(32).fill(seed) })
	const e = createErmine({
		root: "world",
		features: [reading({ versions: (...a) => history.versions(...a) })],
	})
	const history: History = createHistory({
		log,
		table: e.table as never,
		places: e.places as never,
		run: e.within,
	})
	await history.load()
	return { e, log, history }
}
const tick = () => new Promise((r) => setTimeout(r, 20))

Deno.test("readAll through a real ermine lists the cells at a key, then the one left once they are named", async () => {
	const a = await one(1), b = await one(2)
	const all = (x: typeof a, path: (string | number)[]) =>
		x.e.within(() => readAll("/doc", path)).map((v: { value: unknown }) => v.value)
	const pass = async (from: typeof a, to: typeof a, of: typeof a, at: number) => {
		const run = await from.log.run(of.log.device!, at)
		assertEquals(await to.log.take(run!), { added: at === 1 && from === a ? 2 : 1 })
		await tick()
	}
	a.e.within(() => ensureNode("/doc", { k: 0 }))
	await tick()
	await pass(a, b, a, 1)
	a.e.within(() => patch("/doc", [{ path: ["k"], value: 1 }]))
	b.e.within(() => patch("/doc", [{ path: ["k"], value: 2 }]))
	await tick()
	await pass(b, a, b, 1)
	await pass(a, b, a, 3)
	assertEquals(all(a, ["k"]), [1, 2])
	assertEquals(all(b, ["k"]), [1, 2])
	// the conflict is at k, not at the root: one cell there
	assertEquals(all(a, []), [{ k: 1 }])
	// b holds both cells: its removal names both
	b.e.within(() => patch("/doc", [{ path: ["k"] }]))
	await tick()
	await pass(b, a, b, 2)
	assertEquals(all(a, ["k"]), [])
	assertEquals(a.e.within(() => read("/doc")), {})
	assertEquals(b.e.within(() => read("/doc")), {})
	a.e.close(), b.e.close()
})
