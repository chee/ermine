import { assertEquals } from "@std/assert"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import { createPlaces } from "@ermine/places"
import { createPaths } from "@ermine/scheduler/paths"
import { createScheduler } from "@ermine/scheduler"
import { createTable, type Key } from "@ermine/table"
import { connect, readPresence, setPresence, type World } from "@ermine/presence"
import { createChannel } from "./channel.ts"
import { createDevice, LIMIT } from "./transport.ts"

// a pipe: what one end sends the other receives, in order
function pipe(): [Transport, Transport] {
	type End = Transport & { other?: End; queue: Uint8Array[]; waiting: ((b: Uint8Array) => void)[] }
	const make = (): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				const o = end.other!, w = o.waiting.shift()
				if (w) w(bytes.slice())
				else o.queue.push(bytes.slice())
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				return b ? Promise.resolve(b) : new Promise((r) => end.waiting.push(r))
			},
			disconnect: () => Promise.resolve(),
			onDisconnect() {},
		}
		return end
	}
	const a = make(), b = make()
	a.other = b, b.other = a
	return [a, b]
}

function party(n: number) {
	const secret = new Uint8Array(32).fill(n), key = ed25519.getPublicKey(secret)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
	return { device: createDevice({ signer }), key, signer }
}

const opts = { sanitizeOps: false, sanitizeResources: false }
const wait = async (...ps: ReturnType<typeof party>[]) => {
	for (let i = 0; i < 5; i++) {
		await Promise.all(ps.map((p) => p.device.idle()))
		await new Promise((r) => setTimeout(r, 10))
	}
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const text = (s: string) => new TextEncoder().encode(s)

async function joined() {
	const a = party(1), b = party(2)
	const [x, y] = pipe()
	await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
	return { a, b }
}

Deno.test({
	name:
		"channel: bytes on a topic reach the other device's listeners, from the sender's key; another topic gets nothing",
	...opts,
	async fn() {
		const { a, b } = await joined()
		const got: [string, string][] = [], other: unknown[] = [], mine: unknown[] = []
		b.device.listen("cursor", (from, bytes) => got.push([from, new TextDecoder().decode(bytes)]))
		b.device.listen("else", (...m) => other.push(m))
		a.device.listen("cursor", (...m) => mine.push(m))
		await wait(a, b)
		await a.device.send("cursor", text("hi"))
		await wait(a, b)
		assertEquals(got, [[hex(a.key), "hi"]])
		assertEquals(other, [])
		assertEquals(mine, [])
		const stop = b.device.listen("cursor", () => got.push(["x", "x"]))
		stop()
		await a.device.send("cursor", text("again"))
		await wait(a, b)
		assertEquals(got.length, 2)
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "channel: a payload over LIMIT arrives whole, as parts joined",
	...opts,
	async fn() {
		const { a, b } = await joined()
		const got: Uint8Array[] = []
		b.device.listen("big", (_, bytes) => got.push(bytes))
		await wait(a, b)
		const big = Uint8Array.from({ length: LIMIT * 2 + 5 }, (_, i) => i % 251)
		await a.device.send("big", big)
		await wait(a, b)
		assertEquals(got.length, 1)
		assertEquals(got[0], big)
		await a.device.close(), await b.device.close()
	},
})

function world(actor: string, clock = { t: 1000 }): World {
	const scheduler = createScheduler()
	const paths = createPaths<unknown>()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths, scheduler })
	scheduler.onTrackingEnd((k) => places.release(k))
	const scope = scheduler.createRootScope([["actor", actor]])
	return { table, places, scheduler, scope, now: () => clock.t }
}

Deno.test({
	name: "channel: presence rows cross a Subduction connection under the sender's key hex",
	...opts,
	async fn() {
		const { a, b } = await joined()
		const wa = world("a"), wb = world("b")
		const ca = createChannel(a.device, a.key), cb = createChannel(b.device, b.key)
		assertEquals(ca.name, hex(a.key))
		const anchor = "ermine://anchor" as never
		connect(wa, ca, { topic: anchor })
		connect(wb, cb, { topic: anchor })
		await wait(a, b)
		setPresence(wa, anchor, ca.name, { cursor: [12, 40] }, 5000)
		await wait(a, b)
		assertEquals(readPresence(wb, anchor).map((r) => [r.who, r.value]), [[
			hex(a.key),
			{ cursor: [12, 40] },
		]])
		await a.device.close(), await b.device.close()
	},
})
