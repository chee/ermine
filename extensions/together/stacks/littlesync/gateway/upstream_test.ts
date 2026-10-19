// the upstream kept (gateway.ts, keep): a sync.ts device serving Subduction over a WebSocket here
// (socket.ts), the gateway dialling it, a TS device (link.ts) on the gateway. the server's socket is
// closed under it: the gateway dials again, and what either side wrote meanwhile crosses
import { assert, assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { createSigner, seal, type Signer } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import { createGateway } from "./gateway.ts"
import { Link } from "./link.ts"
import { type Message, peek } from "./wire.ts"
import { dial, socket } from "./socket.ts"
import { until } from "./pigs_harness.ts"
import { createHost } from "./host_harness.ts"

const opts = { sanitizeOps: false, sanitizeResources: false }
const fresh = () => "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)

Deno.test({
	name:
		"upstream: the server's socket closed, the gateway dials again; writes from both sides cross",
	...opts,
	async fn() {
		const host = await createHost("server")
		// the server: each WebSocket accepted as a Subduction connection; refuse: no upgrades for now
		const sockets: WebSocket[] = []
		let refuse = false
		const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
			if (refuse) return new Response("down", { status: 503 })
			const { socket: ws, response } = Deno.upgradeWebSocket(req)
			sockets.push(ws)
			const t = socket(ws)
			ws.addEventListener("open", () => void host.device.connect(t, false).catch(() => {}))
			return response
		})
		const lines: string[] = []
		const gateway = createGateway({ signer: await createSigner(), log: (l) => lines.push(l) })
		const stop = gateway.keep(() => dial(`ws://localhost:${server.addr.port}/`))
		const tick = setInterval(() => gateway.tick(), 20)

		// a device on the gateway
		const signer = await createSigner()
		const got: Message[] = []
		const link = new Link(signer.key, (m) => got.push(m))
		const conn = gateway.open((b) => link.feed(b, Date.now()))
		const pump = setInterval(() => {
			link.tick(Date.now())
			const b = link.next()
			if (b.length) conn.feed(b)
		}, 10)
		let nonce = 0
		const commit = async (
			id: string,
			c: { parents: Uint8Array[]; lamport: number; patches: unknown[] },
		) => {
			const bytes = encodeCommit({
				table: "value",
				actor: null,
				time: Math.floor(Date.now() / 1000),
				signer: signer.key,
				nonce: nonce++,
				...c,
			} as never)
			const node = unhex(id.slice(9))
			link.send({ t: "commits", node, sealed: [await seal(bytes, signer as Signer, node)] })
			return nameOf(bytes)
		}
		const acked = (n: Uint8Array) =>
			got.some((m) => m.t === "ack" && m.names.some((x) => hex(x) === hex(n)))
		const heard = (n: string) =>
			got.some((m) =>
				m.t === "commits" &&
				m.sealed.some((s) => {
					const c = peek(s)
					return c !== undefined && hex(nameOf(c)) === n
				})
			)

		try {
			await until(() => gateway.stats.upstream.up && link.up, 10000, "upstream and the link up")
			const room = fresh()
			await host.sync.follow(room)
			const a = await commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			await until(() => host.read(room)?.a === 1, 5000, "a on the server")
			await until(() => acked(a), 3000, "a acked")

			// the server's socket closed, and no new one for a while
			refuse = true
			for (const ws of sockets.splice(0)) ws.close()
			await until(() => !gateway.stats.upstream.up, 3000, "the gateway sees it gone")
			assertEquals(gateway.stats.upstream.drops, 1)
			// meanwhile: a device write (taken, not acked), and a server write
			const b = await commit(room, {
				parents: [a],
				lamport: 2,
				patches: [{ path: ["b"], value: 2 }],
			})
			await until(() => gateway.stats.upstream.held === 1, 3000, "b's ack held")
			assert(!acked(b))
			host.set(room, "c", 3)
			await new Promise((r) => setTimeout(r, 1200))
			assertEquals(host.read(room)?.b, undefined)
			assert(lines.some((l) => l.startsWith("upstream:") && l.includes("again in")))

			// the server takes connections again
			refuse = false
			await until(() => gateway.stats.upstream.up, 10000, "connected again")
			assertEquals(gateway.stats.upstream.connects, 2)
			await until(() => host.read(room)?.b === 2, 10000, "b on the server")
			await until(() => acked(b), 3000, "b acked")
			const c = host.device.history(room).all().find((k) =>
				hex(k.name) !== hex(a) && hex(k.name) !== hex(b)
			)
			assert(c)
			await until(() => heard(hex(c.name)), 10000, "the server's c on the device")
			assertEquals(host.read(room), { a: 1, b: 2, c: 3 })
			assertEquals(gateway.stats.upstream.held, 0)
		} catch (e) {
			console.log(lines.join("\n"))
			throw e
		} finally {
			clearInterval(pump)
			clearInterval(tick)
			stop()
			conn.close()
			await gateway.close()
			await host.close()
			await server.shutdown()
		}
	},
})
