// a fresh review: one test per bug found, each failing while the bug stands
import { assert, assertEquals } from "@std/assert"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Key } from "@ermine/core/table"
import { children, createPlaces } from "@ermine/places"
import type { Patch } from "@ermine/core/op/apply"
import { createLog, createMemoryStore, type Log, type Store } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync, type Link } from "./sync.ts"
import { createSigner } from "./sign.ts"
import { encodeStep, hashStep } from "./step.ts"
import { createGalaxy } from "./galaxy.ts"
import { httpLinks, poll } from "./carriers/http.ts"
import { socket } from "./carriers/websocket.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}
async function writer() {
	const log = createLog({ writes: true })
	await log.load()
	return log
}
const put = (log: Log, value: unknown, node = "pig") =>
	log.write({ node, part: "value", patches: [{ path: [], value }], when: 0 })

async function receiver(store?: Store) {
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
	const log = createLog({ writes: true, store })
	const history = createHistory({ log, table, places, run: (f) => s.runWithScope(scope, f) })
	await history.load()
	return { log, history, value: (id: string) => table.get("value", id)?.value }
}

// a device's steps, made by hand: lamports as given, one run signed at its last
async function steps(lamports: number[], patches: (i: number) => Patch[]) {
	const w = await createSigner()
	let before: Uint8Array | null = null
	const out = lamports.map((lamport, i) => {
		const b = encodeStep({
			device: w.device,
			n: i + 1,
			before,
			node: "doc",
			part: "value",
			patches: patches(i),
			lamport,
			when: 0,
		})
		before = hashStep(b)
		return b
	})
	return { device: w.device, steps: out, sig: await w.sign(before!) }
}

Deno.test("fresh 1: a run sent by a peer that holds less marks it as holding all this side has", async () => {
	const d = await writer()
	put(d, 1)
	const one = (await d.run(d.device!, 1))!
	put(d, 2)
	const two = (await d.run(d.device!, 2))!
	const b = createLog(), r = createLog()
	await b.take(one)
	// r's link to b: a link that can take more only once let (an http link with 1 MB queued)
	let open!: () => void
	const gate = new Promise<void>((x) => open = x)
	const fns: ((x: Uint8Array) => void)[] = []
	const mk = (i: number, wait?: () => Promise<void>): Link => ({
		send: (x) => void setTimeout(() => fns[1 - i]?.(x), 0),
		onMessage: (fn) => void (fns[i] = fn),
		wait,
	})
	createSync({ log: r }).link(mk(0, () => gate)), createSync({ log: b }).link(mk(1))
	// b says it has step 1 and sends it; r meanwhile takes 1 and 2 from elsewhere
	await r.take(one), await r.take(two)
	await tick(50)
	open()
	await tick(100)
	assertEquals(b.count(d.device!), 2, "b never sent step 2 on this link")
})

Deno.test("fresh 2: catching up on two devices' turns at one entry redoes it once per step", async () => {
	const count = async (k: number) => {
		const a = await steps(
			Array.from({ length: k }, (_, i) => 2 * i + 1),
			(i) => [{ path: [], value: i }],
		)
		const b = await steps(
			Array.from({ length: k }, (_, i) => 2 * i + 2),
			(i) => [{ path: [], value: i }],
		)
		const mem = createMemoryStore()
		let gets = 0
		const r = await receiver({ ...mem, get: (d, n) => (gets++, mem.get(d, n)) })
		await r.log.take(a), await r.log.take(b)
		return gets
	}
	const small = await count(100), big = await count(200)
	assert(big < small * 2.5, `${small} reads for 100 each, ${big} for 200 each`)
})

Deno.test("fresh 3: a link sync drops for a send that threw is never closed, and still polls", async () => {
	let recvs = 0
	const server = createSync({ log: createLog() })
	const http = httpLinks((l) => server.link(l))
	const srv = Deno.serve({ port: 0, onListen() {} }, (req) => {
		if (req.url.includes("/recv")) recvs++
		return http(req)!
	})
	const w = await writer(), sync = createSync({ log: w })
	const link = poll(`http://localhost:${srv.addr.port}/t`)
	let closed = false
	link.onClose!(() => closed = true)
	sync.link(link)
	await until(() => sync.links === 1)
	put(w, "z".repeat(1_100_000))
	await until(() => sync.links === 0)
	const before = recvs
	await tick(300)
	const after = recvs, wasClosed = closed
	link.close!(), http.close()
	await srv.shutdown()
	assertEquals({ wasClosed, polling: after > before }, { wasClosed: true, polling: false })
})

Deno.test("fresh 4: a stranger fills galaxy's disk: a dir per name. a step of any size is kept (chee: no cap for now)", async () => {
	const dir = await Deno.makeTempDir()
	const g = createGalaxy({ dir })
	const srv = Deno.serve({ port: 0, onListen() {} }, g.handler)
	for (let i = 0; i < 20; i++) {
		const stop = new AbortController()
		const res = g.handler(
			new Request(`http://x/tippet/junk${i}/recv?link=x&ack=0`, { signal: stop.signal }),
		)
		stop.abort()
		await (await res).body?.cancel()
	}
	const w = await writer()
	const ws = new WebSocket(`ws://localhost:${srv.addr.port}/tippet/pigs`)
	const shut = new Promise((r) => ws.addEventListener("close", r))
	const sync = createSync({ log: w })
	sync.link(socket(ws))
	put(w, "z".repeat(8_000_000))
	let size = 0
	const room = async () => {
		for await (const e of Deno.readDir(dir)) {
			const s = await Deno.stat(`${dir}/${e.name}/log`).catch(() => undefined)
			size = Math.max(size, s?.size ?? 0)
		}
	}
	for (let i = 0; i < 100 && size < 8_000_000; i++) await tick(20), await room()
	ws.close(), await shut
	await g.close(), await srv.shutdown()
	const dirs = (await Array.fromAsync(Deno.readDir(dir))).length
	await Deno.remove(dir, { recursive: true })
	assertEquals({ dirs, big: size >= 8_000_000 }, { dirs: 1, big: true })
})

Deno.test("fresh 6: a step that failed and then applied in a redo stays in failed", async () => {
	const a = await steps([1], () => [{ path: [], value: { x: 0 } }])
	const b = await steps([2], () => [{ path: ["y"], value: 1 }])
	const r1 = await receiver(), r2 = await receiver()
	await r1.log.take(a), await r1.log.take(b)
	await r2.log.take(b), await r2.log.take(a)
	assertEquals(r1.value("doc"), r2.value("doc"))
	assertEquals(r2.history.failed, r1.history.failed)
})
