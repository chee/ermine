// one test per hardening of the flow: sync's pushes, refusals, backpressure, http and galaxy.
// numbered as the reviews numbered them
import { assert, assertEquals } from "@std/assert"
import { decode, encode } from "@ermine/encoding/cbor"
import { createLog, createMemoryStore, type Log } from "./log.ts"
import { createSync, type Link } from "./sync.ts"
import { unpack } from "./pack.ts"
import { hex } from "./step.ts"
import { createGalaxy } from "./galaxy.ts"
import { frames, httpLinks, poll } from "./carriers/http.ts"
import { socket } from "./carriers/websocket.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 3000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}

async function writer(seed?: Uint8Array) {
	const log = createLog({ writes: true, seed })
	await log.load()
	return log
}
const put = (log: Log, value: unknown, node = "pig") =>
	log.write({ node, part: "value", patches: [{ path: [], value }], when: 0 })

// two links joined in memory, each message a macrotask later; sent: what each side sent
function pair(o: { many?: boolean } = {}) {
	const sent: Uint8Array[][] = [[], []]
	const fns: ((b: Uint8Array) => void)[] = []
	const mk = (i: number): Link => ({
		send(b) {
			sent[i].push(b)
			setTimeout(() => fns[1 - i]?.(b), 0)
		},
		onMessage: (fn) => void (fns[i] = fn),
		many: o.many,
	})
	return { a: mk(0), b: mk(1), sent }
}
// a message's kind, and for a run its device and pack
const read = (b: Uint8Array) => {
	const [t, device, , pack] = decode(b) as [string, Uint8Array, Uint8Array, unknown]
	return { t, device: t === "run" ? hex(device) : undefined, pack }
}
// the steps in a side's runs, and its other messages by kind
function tally(list: Uint8Array[]) {
	const out: Record<string, number> = { steps: 0 }
	for (const m of list.map(read)) {
		out[m.t] = (out[m.t] ?? 0) + 1
		if (m.t === "run") out.steps += unpack(m.pack).length
	}
	return out
}

Deno.test("6. a burst of 100 writes sends each step once", async () => {
	const a = await writer(), b = createLog()
	const p = pair()
	createSync({ log: a }).link(p.a), createSync({ log: b }).link(p.b)
	await tick()
	for (let i = 0; i < 100; i++) put(a, i)
	await until(() => b.count(a.device!) === 100)
	await tick(100)
	assertEquals(tally(p.sent[0]).steps, 100)
})

Deno.test("0. a chain refused for good is told back, and later writes send nothing more", async () => {
	const seed = crypto.getRandomValues(new Uint8Array(32))
	const one = await writer(seed), two = await writer(seed), peer = createLog()
	put(one, 1)
	await peer.take((await one.run(one.device!, 1))!)
	for (let i = 0; i < 20; i++) put(two, i)
	const p = pair()
	createSync({ log: two }).link(p.a), createSync({ log: peer }).link(p.b)
	await tick(100)
	const before = tally(p.sent[0]).steps
	for (let i = 0; i < 10; i++) put(two, 100 + i), await tick(10)
	await tick(100)
	assertEquals(tally(p.sent[1]).refused, 1)
	// the peer holds step 1 of that device already: 2 to 20, once
	assertEquals(before, 19)
	assertEquals(tally(p.sent[0]).steps, before)
	assertEquals(peer.count(two.device!), 1)
})

Deno.test("2. a push whose store throws ends, and nothing is left unhandled", async () => {
	const caught: unknown[] = []
	const on = (e: PromiseRejectionEvent) => (e.preventDefault(), caught.push(e.reason))
	globalThis.addEventListener("unhandledrejection", on)
	const a = await writer(), mem = createMemoryStore()
	put(a, 1)
	const relay = createLog({
		store: {
			...mem,
			get: () => {
				throw new Error("the disk is gone")
			},
		},
	})
	await relay.take((await a.run(a.device!, 1))!)
	const p = pair()
	createSync({ log: relay }).link(p.a), createSync({ log: createLog() }).link(p.b)
	await tick(100)
	globalThis.removeEventListener("unhandledrejection", on)
	assertEquals(caught.map(String), [])
	assertEquals(tally(p.sent[0]).steps, 0)
})

Deno.test("9. a push stops once its link can't send", async () => {
	const a = await writer()
	for (let i = 0; i < 100; i++) put(a, i)
	const sync = createSync({ log: a })
	let tries = 0
	sync.link({
		send(b) {
			if (read(b).t === "run" && ++tries > 3) throw new Error("closed")
		},
		onMessage: (fn) => void setTimeout(() => fn(encode(["have", []])), 0),
	})
	await tick(200)
	assertEquals([tries, sync.links], [4, 0])
})

Deno.test("9. on a broadcast, a have is answered with this device's own steps alone", async () => {
	const a = await writer(), other = await writer()
	put(other, 1)
	await a.take((await other.run(other.device!, 1))!)
	put(a, 2)
	const sent: Uint8Array[] = []
	let fn!: (b: Uint8Array) => void
	createSync({ log: a }).link({
		send: (b) => void sent.push(b),
		onMessage: (f) => void (fn = f),
		many: true,
	})
	fn(encode(["have", []]))
	await tick(50)
	const batches = sent.map(read).filter((m) => m.t === "run")
	assertEquals(batches.map((m) => m.device), [a.device])
})

Deno.test("3. an http catch-up past 8 MB finishes on one link, in batches of 64 KB at most", async () => {
	const w = await writer()
	for (let i = 0; i < 200; i++) put(w, "z".repeat(50_000), `n${i}`)
	const server = createSync({ log: w })
	let made = 0, biggest = 0
	const http = httpLinks((l) => {
		made++
		const send = l.send.bind(l)
		l.send = (b) => (biggest = Math.max(biggest, b.length), send(b))
		server.link(l)
	})
	const srv = Deno.serve({ port: 0, onListen() {} }, (req) => http(req)!)
	const c = createLog(), link = poll(`http://localhost:${srv.addr.port}/t`)
	let closed = false
	link.onClose!(() => closed = true)
	createSync({ log: c }).link(link)
	try {
		await until(() => c.count(w.device!) === 200, 15_000)
	} finally {
		link.close!(), http.close()
		await srv.shutdown()
	}
	assertEquals([made, closed], [1, true])
	assert(biggest < 64 * 1024 + 1024, `${biggest} bytes`)
})

Deno.test("3. a link closed on the server is answered 410, even at ack 0", async () => {
	const links: Link[] = []
	const http = httpLinks((l) => links.push(l))
	const recv = () => {
		const stop = new AbortController()
		setTimeout(() => stop.abort(), 20)
		return http(new Request("http://x/t/recv?link=a&ack=0", { signal: stop.signal }))!
	}
	await (await recv()).body?.cancel()
	links[0].close!()
	const again = await recv(),
		send = await http(
			new Request("http://x/t/send?link=a&ack=0&n=1", {
				method: "POST",
				body: new Uint8Array(),
			}),
		)!
	await again.body?.cancel(), await send.body?.cancel()
	http.close()
	assertEquals([again.status, send.status, links.length], [410, 410, 1])
})

Deno.test("10. a send tried again is taken once", async () => {
	const got: Uint8Array[] = []
	const http = httpLinks((l) => l.onMessage((b) => got.push(b)))
	const post = async (n: number, list: Uint8Array[]) => {
		const res = await http(
			new Request(`http://x/t/send?link=a&ack=0&n=${n}`, { method: "POST", body: frames(list) }),
		)!
		await res.body?.cancel()
		return res.status
	}
	const one = new Uint8Array([1]), two = new Uint8Array([2])
	assertEquals(await post(1, [one]), 204)
	// its answer lost: sent again, with one more
	assertEquals(await post(1, [one, two]), 204)
	assertEquals(await post(4, [two]), 409)
	http.close()
	assertEquals(got, [one, two])
})

Deno.test("9. an http client that can't send closes past 1 MB held", async () => {
	const l = Deno.listen({ port: 0 }), port = (l.addr as Deno.NetAddr).port
	l.close()
	const link = poll(`http://localhost:${port}/t`)
	let closed = false
	link.onClose!(() => closed = true)
	for (let i = 0; i < 4 && !closed; i++) link.send(new Uint8Array(300_000))
	const shut = closed
	link.close!()
	assert(shut)
})

// a galaxy on a port; open: a websocket to a room, and when it has closed
function galaxy(dir: string, o: { idle: number; most: number }) {
	const g = createGalaxy({ dir, ...o })
	const srv = Deno.serve({ port: 0, onListen() {} }, g.handler)
	const at = `localhost:${srv.addr.port}/tippet`
	return {
		g,
		open(room: string) {
			const ws = new WebSocket(`ws://${at}/${room}`)
			const closed = new Promise((r) => ws.addEventListener("close", r))
			return { link: socket(ws), close: () => (ws.close(), closed) }
		},
		// a send with nothing in it: the room opened, or why not
		async poke(room: string) {
			const res = await fetch(`http://${at}/${room}/send?link=${room}&ack=0`, { method: "POST" })
			await res.body?.cancel()
			return res.status
		},
		async close() {
			await g.close()
			await srv.shutdown()
		},
	}
}

Deno.test("9. galaxy lets a room with no links go, and loads it again on use", async () => {
	const dir = await Deno.makeTempDir()
	const s = galaxy(dir, { idle: 50, most: 1000 })
	const a = await writer(), c = createLog()
	const one = s.open("pigs")
	createSync({ log: a }).link(one.link)
	put(a, 1)
	await tick(100)
	await one.close()
	await until(() => s.g.open === 0)
	const two = s.open("pigs")
	createSync({ log: c }).link(two.link)
	await until(() => c.count(a.device!) === 1)
	await two.close()
	await s.close()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("9. galaxy keeps to its most rooms: the one least recently written let go, links or not", async () => {
	const dir = await Deno.makeTempDir()
	const s = galaxy(dir, { idle: 60_000, most: 2 })
	const a = await writer()
	const pigs = s.open("pigs"), cows = s.open("cows")
	createSync({ log: a }).link(pigs.link)
	createSync({ log: createLog() }).link(cows.link)
	put(a, 1)
	await tick(100)
	// cows never written: let go for hens, though linked; pigs stays
	const hens = await s.poke("hens")
	const open = s.g.open
	await cows.close(), await pigs.close()
	await s.close()
	await Deno.remove(dir, { recursive: true })
	assertEquals([hens, open], [204, 2])
})
