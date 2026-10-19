// HTTP sessions (http.ts): two TS devices (link.ts) each over POSTs to /littlesync/<session>, and a
// lab-pig-style sync.ts device as the gateway's Subduction peer (an in-memory pipe), in one process
import { assert, assertEquals } from "@std/assert"
import { name as nameOf } from "@ermine/encoding/commit"
import { pipe } from "../../../typescript/harnesses.ts"
import { createSigner } from "../../../typescript/seal.ts"
import { hex } from "../../../typescript/hex.ts"
import { createGateway } from "./gateway.ts"
import { createSessions } from "./http.ts"
import { frame, Unframer } from "./frame.ts"
import { decode, encode } from "./wire.ts"
import { httpDevice as device, names } from "./http_harness.ts"
import { until } from "./pigs_harness.ts"
import { createHost } from "./host_harness.ts"

const opts = { sanitizeOps: false, sanitizeResources: false }
const fresh = () => "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)

async function world(o: { idle?: number } = {}) {
	const gateway = createGateway({ signer: await createSigner(), log: () => {} })
	const sessions = createSessions(gateway, { idle: o.idle })
	const host = await createHost("ts")
	const { ends: [x, y] } = pipe()
	await Promise.all([gateway.connectTransport(x, true), host.device.connect(y, false)])
	const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
		const path = new URL(req.url).pathname
		return path.startsWith("/littlesync/")
			? sessions.handle(req, path.slice(12))
			: new Response("", { status: 404 })
	})
	const timers = [setInterval(() => gateway.tick(), 20), setInterval(() => sessions.tick(), 100)]
	return {
		gateway,
		sessions,
		host,
		base: `http://localhost:${server.addr.port}/littlesync/`,
		async close() {
			for (const t of timers) clearInterval(t)
			sessions.close()
			await server.shutdown()
			await gateway.close()
			await host.close()
		},
	}
}

Deno.test({
	name: "http: two devices over HTTP sessions and a sync.ts device converge",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		await w.host.sync.follow(room)
		const a = await device(w.base), b = await device(w.base)
		try {
			await until(() => a.link.up && b.link.up, 5000, "both links up")
			assertEquals(w.sessions.count(), 2)
			b.follow(room)
			const ra = await a.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			await until(() => w.host.read(room)?.a === 1, 5000, "a's commit on the sync.ts device")
			await until(() => names(b).has(hex(ra)), 5000, "a's commit on b")
			const rb = await b.commit(room, {
				parents: [ra],
				lamport: 2,
				patches: [{ path: ["b"], value: 2 }],
			})
			await until(() => w.host.read(room)?.b === 2, 5000, "b's commit on the sync.ts device")
			await until(() => names(a).has(hex(rb)), 5000, "b's commit on a")
			w.host.set(room, "c", 3)
			await until(
				() => {
					const ns = w.host.device.history(room).heads().map((k) => hex(k.name))
					return ns.length === 1 && names(a).has(ns[0]) && names(b).has(ns[0])
				},
				5000,
				"the sync.ts device's commit on a and b",
			)
			assertEquals(w.host.read(room), { a: 1, b: 2, c: 3 })
			// each acked its own
			for (const [d, n] of [[a, ra], [b, rb]] as const) {
				assert(d.got.some((m) => m.t === "ack" && m.names.some((x) => hex(x) === hex(n))))
			}
			assertEquals(w.gateway.stats.forwarded, 2)
		} finally {
			await a.stop()
			await b.stop()
			await w.close()
		}
	},
})

Deno.test({
	name: "http: a waiting request answers when frames come; most; bad sessions; idle sessions end",
	...opts,
	async fn() {
		const w = await world({ idle: 400 })
		try {
			const key = (await createSigner()).key
			const hello = frame(encode({ t: "hello", key, stack: "littlesync/0" }))
			assertEquals((await fetch(w.base + "short", { method: "POST" })).status, 400)
			assertEquals((await fetch(w.base + "a".repeat(8), { method: "PUT" })).status, 405)
			// a hello up: the gateway's hello (and its heads, none) come back at once
			const id = "session-1"
			let r = await fetch(w.base + id, {
				method: "POST",
				body: hello as Uint8Array<ArrayBuffer>,
			})
			assertEquals(r.headers.get("content-type"), "application/octet-stream")
			const u = new Unframer()
			const first = u.feed(new Uint8Array(await r.arrayBuffer())).map(decode)
			assert(first.some((m) => m?.t === "hello"))
			assertEquals(w.gateway.stats.links, 1)
			// nothing waiting: a GET waits; the gateway's next hello (every 4 s) answers it
			const t0 = Date.now()
			r = await fetch(w.base + id + "?wait=6000")
			const late = u.feed(new Uint8Array(await r.arrayBuffer())).map(decode)
			assert(late.some((m) => m?.t === "hello"))
			assert(Date.now() - t0 > 200, "it waited")
			// wait=0 with nothing: empty, at once
			r = await fetch(w.base + id)
			assertEquals((await r.arrayBuffer()).byteLength, 0)
			// a newer request ends the waiting one, empty
			const waiting = fetch(w.base + id + "?wait=5000")
			await new Promise((r) => setTimeout(r, 100))
			const newer = fetch(w.base + id + "?wait=50")
			assertEquals((await (await waiting).arrayBuffer()).byteLength, 0)
			await (await newer).arrayBuffer()
			// most: whole frames, one at least. heads naming commits the gateway lacks: a want each
			const heads = () =>
				frame(encode({
					t: "heads",
					node: crypto.getRandomValues(new Uint8Array(32)),
					heads: [nameOf(crypto.getRandomValues(new Uint8Array(8)))],
				}))
			const three = new Uint8Array([...heads(), ...heads(), ...heads()])
			r = await fetch(w.base + id + "?most=1", { method: "POST", body: three })
			const one = u.feed(new Uint8Array(await r.arrayBuffer())).map(decode)
			assertEquals(one.map((m) => m?.t), ["want"])
			r = await fetch(w.base + id)
			const rest = u.feed(new Uint8Array(await r.arrayBuffer())).map(decode)
			assertEquals(rest.map((m) => m?.t), ["want", "want"])
			// idle: no request for 400 ms, the session ends and its link closes
			await until(() => w.sessions.count() === 0, 3000, "the idle session ended")
			assertEquals(w.gateway.stats.links, 0)
			// the same session again: a new link (the gateway says hello first)
			r = await fetch(w.base + id, { method: "POST", body: hello as Uint8Array<ArrayBuffer> })
			assert(
				u.feed(new Uint8Array(await r.arrayBuffer())).map(decode).some((m) => m?.t === "hello"),
			)
			assertEquals(w.gateway.stats.links, 1)
			assertEquals((await fetch(w.base + id, { method: "DELETE" })).status, 204)
			assertEquals(w.sessions.count(), 0)
		} finally {
			await w.close()
		}
	},
})
