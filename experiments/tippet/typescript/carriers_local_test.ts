import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createHistory } from "./history.ts"
import { createLog } from "./log.ts"
import { createSync, wire } from "./sync.ts"
import { bus } from "./carriers/broadcastchannel.ts"
import { connect, listen } from "./carriers/unix.ts"
import { socket } from "./carriers/websocket.ts"

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
	const history = createHistory({ log, table, places, run })
	await history.load()
	const sync = createSync({ log })
	return {
		log,
		sync,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
	}
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 2000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}

Deno.test("a bus: a write in one tab is in the other", async () => {
	const name = `tippet-${crypto.randomUUID()}`
	const a = await device(), b = await device()
	const unlinks = [a.sync.link(bus(name)), b.sync.link(bus(name))]
	a.put("pig", { x: 1 })
	await until(() => b.value("pig") !== undefined)
	assertEquals(b.value("pig"), { x: 1 })
	b.put("cow", 2)
	await until(() => a.value("cow") === 2)
	unlinks.forEach((u) => u())
})

Deno.test("a unix socket: a write shared, and one who joins later catches up", async () => {
	const dir = await Deno.makeTempDir()
	const path = `${dir}/tippet.sock`
	const a = await device(), b = await device(), c = await device()
	const server = listen(path, (link) => a.sync.link(link))
	const unb = b.sync.link(await connect(path))
	a.put("pig", { x: 1 })
	await until(() => b.value("pig") !== undefined)
	assertEquals(b.value("pig"), { x: 1 })
	b.put("cow", 2)
	await until(() => a.value("cow") === 2)

	const unc = c.sync.link(await connect(path))
	await until(() => c.value("pig") !== undefined && c.value("cow") === 2)
	assertEquals(c.value("pig"), { x: 1 })
	assertEquals(c.log.have(), a.log.have())

	unb(), unc(), server.close()
	await until(() => a.sync.links === 0)
	await tick()
	assertEquals(await Deno.stat(path).then(() => true, () => false), false)
	await Deno.remove(dir, { recursive: true })
})

// a websocket whose peer never reads: what is sent stays unsent
function stuck() {
	const on: Record<string, ((e: unknown) => void)[]> = {}
	return {
		CONNECTING: 0,
		CLOSING: 2,
		readyState: 1,
		bufferedAmount: 0,
		binaryType: "",
		closed: false,
		send(b: Uint8Array) {
			this.bufferedAmount += b.length
		},
		close() {
			this.closed = true, this.readyState = 3
			for (const f of on.close ?? []) f({})
		},
		addEventListener(t: string, f: (e: unknown) => void) {
			;(on[t] ??= []).push(f)
		},
		hear(b: Uint8Array) {
			for (const f of on.message ?? []) f({ data: b.slice().buffer })
		},
	}
}

Deno.test("a websocket whose peer never reads: runs wait, and past 8 MB unsent the link is closed", async () => {
	const log = createLog({ writes: true })
	await log.load()
	const big = "x".repeat(512 * 1024)
	for (let i = 0; i < 40; i++) {
		log.write({ node: "pig", part: "value", patches: [{ path: [], value: big + i }], when: 0 })
	}
	const sync = createSync({ log, relay: true })
	const ws = stuck()
	sync.link(socket(ws as unknown as WebSocket))
	// asked for everything, again and again: runs go only while under 1 MB is unsent
	for (let i = 0; i < 20; i++) {
		ws.hear(wire({ t: "have", have: {} }))
		await new Promise((r) => setTimeout(r, 10))
	}
	assert(ws.bufferedAmount < 2 * 1024 * 1024, `${ws.bufferedAmount} unsent`)
	assertEquals(sync.links, 1)
	// what doesn't wait (live things) closes it past 8 MB
	for (let i = 0; i < 10 && !ws.closed; i++) sync.live(new Uint8Array(1024 * 1024))
	assert(ws.closed)
	assertEquals(sync.links, 0)
})
