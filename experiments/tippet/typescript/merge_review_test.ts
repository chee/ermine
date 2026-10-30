import { assertEquals } from "@std/assert"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createLog } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSigner, type Signer } from "./sign.ts"
import { encodeStep, hashStep, type Step } from "./step.ts"
import type { Patch } from "@ermine/changeable/apply"

async function receiver() {
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
	const log = createLog({ writes: true })
	const history = createHistory({ log, table, places, run: (f) => s.runWithScope(scope, f) })
	await history.load()
	return { log, history, value: (id: string) => table.get("value", id)?.value }
}

type Out = { device: string; steps: Uint8Array[]; sig: Uint8Array; name: string }
const chains = new Map<string, Uint8Array | null>()
async function step(
	w: Signer,
	name: string,
	n: number,
	lamport: number,
	patches: Patch[],
): Promise<Out> {
	const s: Step = {
		device: w.device,
		n,
		before: chains.get(w.device) ?? null,
		node: "pig",
		part: "value",
		patches,
		lamport,
		when: 0,
	}
	const bytes = encodeStep(s)
	chains.set(w.device, hashStep(bytes))
	return { device: w.device, steps: [bytes], sig: await w.sign(hashStep(bytes)), name }
}

function orders<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs]
	return xs.flatMap((x, i) =>
		orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])
	)
}

Deno.test("review: three devices, every arrival order, one value", async () => {
	const [a, b, c] = await Promise.all([createSigner(), createSigner(), createSigner()])
	const base = await step(a, "a1 {x:0,y:0} @1", 1, 1, [{ path: [], value: { x: 0, y: 0 } }])
	const by = await step(b, "b1 y=2 @2", 1, 2, [{ path: ["y"], value: 2 }])
	const axy = await step(a, "a2 x=1,y=1 @3", 2, 3, [
		{ path: ["x"], value: 1 },
		{ path: ["y"], value: 1 },
	])
	const cx = await step(c, "c1 x=3 @4", 1, 4, [{ path: ["x"], value: 3 }])

	const results = new Map<string, string[]>()
	for (const rest of orders([by, axy, cx])) {
		const r = await receiver()
		for (const o of [base, ...rest]) {
			assertEquals((await r.log.take(o)).hasOwnProperty("added"), true)
		}
		const v = JSON.stringify(r.value("pig"))
		results.set(v, [...(results.get(v) ?? []), rest.map((o) => o.name).join(" → ")])
	}
	assertEquals(results.size, 1, JSON.stringify([...results], null, 1))
})

Deno.test("review: a deeper winner arriving after a shallower loser", async () => {
	const [a, b] = await Promise.all([createSigner(), createSigner()])
	chains.clear()
	const whole = await step(a, "a1 {x:0,y:9} @1", 1, 1, [{ path: [], value: { x: 0, y: 9 } }])
	const deep = await step(b, "b1 x=5 @2", 1, 2, [{ path: ["x"], value: 5 }])
	const r1 = await receiver(), r2 = await receiver()
	await r1.log.take(whole), await r1.log.take(deep)
	await r2.log.take(deep), await r2.log.take(whole)
	assertEquals(r1.value("pig"), r2.value("pig"), JSON.stringify(r2.history.failed))
})
