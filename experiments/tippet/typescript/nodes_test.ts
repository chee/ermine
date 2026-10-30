import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createLog } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync } from "./sync.ts"
import { decodeStep } from "./step.ts"
import { port } from "./carriers/messagechannel.ts"
import { notKept, show, type Shown } from "./nodes.ts"

async function device() {
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
	const history = createHistory({ log, table, places, run, kept: notKept(["sync"]) })
	await history.load()
	const sync = createSync({ log })
	return {
		log,
		history,
		sync,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
	}
}

async function until(f: () => boolean, ms = 2000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise((r) => setTimeout(r, 5))
	}
}

Deno.test("sync shows itself at a node, and that node makes no step", async () => {
	const a = await device(), b = await device()
	let writes = 0
	const stop = show({
		...a,
		write: (v) => (writes++, a.put("sync", v)),
	})
	const shown = () => a.value("sync") as Shown | undefined
	await until(() => shown() !== undefined)
	assertEquals(shown(), { device: a.log.device!, have: {}, links: 0, failed: [], unkept: 0 })

	a.put("pig", { x: 1 })
	await until(() => shown()!.have[a.log.device!] === 1)

	const { port1, port2 } = new MessageChannel()
	a.sync.link(port(port1)), b.sync.link(port(port2))
	b.put("cow", { moo: 1 })
	await until(() => shown()!.have[b.log.device!] === 1)
	assertEquals(shown()!.links, 1)
	assertEquals(a.value("cow"), { moo: 1 })
	port1.close(), port2.close()
	stop()

	assert(writes >= 3)
	const nodes = [a, b].flatMap((d) =>
		Object.keys(d.log.have()).flatMap((k) => d.log.steps(k).map((x) => decodeStep(x).node))
	)
	assert(nodes.length > 0 && !nodes.includes("sync"), nodes.join())
	assertEquals(b.value("sync"), undefined)
	assertEquals(a.history.unkept.length, 0)
})
