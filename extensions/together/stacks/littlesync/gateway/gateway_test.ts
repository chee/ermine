// the gateway in one process, no server: littlesync-pigs (C) over --pipe as one link, fake TS
// devices (link.ts) as others, and a lab-pig-style sync.ts device as the gateway's Subduction peer
// (an in-memory pipe in place of the server)
import { assert, assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { pipe } from "../../../typescript/harnesses.ts"
import { createSigner, seal, type Signer } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import * as cbor from "@ermine/encoding/cbor"
import { createGateway, type Gateway } from "./gateway.ts"
import { Link } from "./link.ts"
import { MERGE, type Message } from "./wire.ts"
import { row, spawnPigs, until } from "./pigs_harness.ts"
import { createHost } from "./host_harness.ts"

const opts = { sanitizeOps: false, sanitizeResources: false }
const zeros = (b: Uint8Array) => "ermine://" + hex(b) + "0".repeat(32)
const fresh = () => zeros(crypto.getRandomValues(new Uint8Array(16)))
// the says among what a device got
const says = (got: Message[]) =>
	got.filter((x): x is Extract<Message, { t: "say" }> => x.t === "say")

async function world() {
	const lines: string[] = []
	const host = await createHost("ts")
	const signer = await createSigner()
	const gateway = createGateway({
		signer,
		log: (l) => lines.push(l),
		// a device's presence peer: a pipe of its own to the TS device
		async peer(connect) {
			const { ends: [x, y] } = pipe()
			await Promise.all([connect(x, true), host.device.connect(y, false)])
		},
	})
	const { ends: [x, y] } = pipe()
	await Promise.all([gateway.connectTransport(x, true), host.device.connect(y, false)])
	const timer = setInterval(() => gateway.tick(), 20)
	return {
		gateway,
		signer,
		host,
		lines,
		async close() {
			clearInterval(timer)
			await gateway.close()
			await host.close()
		},
	}
}

// a C peer as a gateway link
async function cPeer(gateway: Gateway, o: Parameters<typeof spawnPigs>[0]) {
	const pigs = await spawnPigs(o)
	const conn = gateway.open((b) => void pigs.write(b))
	pigs.on((b) => conn.feed(b))
	pigs.done.then(() => conn.close())
	return pigs
}

// a fake device: a TS link to the gateway, sealing its own commits
async function fake(gateway: Gateway) {
	const signer = await createSigner()
	const got: Message[] = []
	const link = new Link(signer.key, (m) => got.push(m))
	const conn = gateway.open((b) => link.feed(b, Date.now()))
	const timer = setInterval(() => {
		link.tick(Date.now())
		const b = link.next()
		if (b.length) conn.feed(b)
	}, 10)
	let nonce = 0
	return {
		signer,
		got,
		link,
		// a sealed commit to the gateway: its name
		async commit(
			id: string,
			c: { parents: Uint8Array[]; lamport: number; merge?: string; patches: unknown[] },
		) {
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
		},
		close() {
			clearInterval(timer)
			conn.close()
		},
	}
}

Deno.test({
	name: "gateway: a C peer's pig reaches a sync.ts device, and its moves and holds go back",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		await w.host.sync.follow(room)
		// the room has a value, as lab-pig's has (a key set on nothing is refused by sync.ts)
		w.host.store(room, {})
		await w.host.sync.idle()
		const dir = await Deno.makeTempDir({ prefix: "littlesync-gateway-" })
		// the C peer adds a pig at 0.7 s, picks it up at about 5 s and carries it right
		let pigs = await cPeer(w.gateway, { dir, room, keys: "a......... lll" })
		try {
			// the room's key, then the pig's value, on the sync.ts device
			const pig = await until(
				() => Object.keys(w.host.read(room) ?? {}).find((k) => k.startsWith("ermine://")),
				10000,
				"the room's new key on the TS device",
			)
			await w.host.sync.follow(pig)
			const stored = await until(
				() => w.host.read(pig),
				10000,
				"the pig's value on the TS device",
			)
			assert(typeof stored.x === "number" && typeof stored.seed === "number")
			assertEquals(w.gateway.stats.forwarded, 2)
			// carried: the C hold stands on the TS device, made again by the gateway
			const held = await until(
				() => w.host.read(pig)?.held === true && w.host.read(pig),
				10000,
				"held on the TS device",
			)
			assert(typeof held.by === "string")
			assert(w.host.sync.standing(pig).length === 1)
			assert(w.gateway.stats.ephemeral.in > 0)
			await pigs.stop()
			// the C peer gone: its hold stops on the TS device (the gateway's stop)
			await until(() => w.host.read(pig)?.held === undefined, 6000, "the hold stops")

			// TS → C: a stored move, then a hold of the TS device's own
			pigs = await cPeer(w.gateway, { dir, room })
			w.host.store(pig, { x: 0.25, y: 0.75, at: Date.now(), seed: 9 })
			await until(
				() => row(pigs.dump(), pig)?.includes("x=0.25 y=0.75"),
				10000,
				"the move on the C screen",
			)
			const wave = () =>
				w.host.wave(pig, {
					x: 0.5,
					y: 0.5,
					held: true,
					by: "tsdev",
					colour: "#000000",
					who: "ts",
				})
			wave()
			const beat = setInterval(wave, 500)
			try {
				await until(
					() => row(pigs.dump(), pig)?.includes("held by tsdev"),
					10000,
					"the TS hold on the C screen",
				)
			} finally {
				clearInterval(beat)
			}
			assert(w.gateway.stats.ephemeral.out > 0)
		} finally {
			await pigs.stop()
			await w.close()
		}
	},
})

Deno.test({
	name: "gateway: a lamport not 1 + its parents' is refused at the gateway, not forwarded",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		await w.host.sync.follow(room)
		const f = await fake(w.gateway)
		try {
			await until(() => f.link.up, 3000, "the fake device up")
			// a root sets the whole value (sync.ts refuses a key set on nothing: "patches")
			const ok = await f.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			const bad = await f.commit(room, {
				parents: [ok],
				lamport: 5,
				patches: [{ path: ["b"], value: 2 }],
			})
			const lost = nameOf(crypto.getRandomValues(new Uint8Array(8)))
			const orphan = await f.commit(room, {
				parents: [lost],
				lamport: 2,
				patches: [{ path: ["c"], value: 3 }],
			})
			await until(() => w.host.read(room)?.a === 1, 5000, "the good one on the TS device")
			await until(() => w.gateway.stats.refused["history: lamport"] === 1, 3000, "the refusal")
			await w.gateway.idle()
			const r = w.gateway.refusals.find((r) => r.name === hex(bad))!
			assertEquals(r.reason, "history: lamport")
			assertEquals(r.from, hex(f.signer.key))
			assert(w.lines.some((l) => l.startsWith("refused") && l.includes("history: lamport")))
			// never forwarded: the TS device has never heard of it
			await new Promise((r) => setTimeout(r, 300))
			assertEquals(w.host.device.history(room).get(bad), undefined)
			assertEquals(w.host.read(room), { a: 1 })
			// one whose parent is nowhere waits at the gateway
			assertEquals(w.gateway.stats.waiting, 1)
			assertEquals(w.host.device.history(room).get(orphan), undefined)
			// and its parent is asked of the device (a gateway begun again may lack what it was sent)
			assert(f.got.some((m) => m.t === "want" && m.names.some((n) => hex(n) === hex(lost))))
			// all acked, so the device stops resending
			const acked = f.got.flatMap((m) => m.t === "ack" ? m.names.map(hex) : [])
			for (const n of [ok, bad, orphan]) assert(acked.includes(hex(n)))
		} finally {
			f.close()
			await w.close()
		}
	},
})

Deno.test({
	name:
		"gateway: a littlesync merge commit is taken and forwarded (logged, counted); sync.ts refuses it",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		await w.host.sync.follow(room)
		const f = await fake(w.gateway)
		try {
			await until(() => f.link.up, 3000, "the fake device up")
			const a = await f.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			const b = await f.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { b: 2 } }],
			})
			const parents = [a, b].sort((x, y) => hex(x) < hex(y) ? -1 : 1)
			const m = await f.commit(room, {
				parents,
				lamport: 2,
				merge: MERGE,
				patches: [{ path: ["c"], value: 3 }],
			})
			const after = await f.commit(room, {
				parents: [m],
				lamport: 3,
				patches: [{ path: ["d"], value: 4 }],
			})
			await until(() => w.gateway.stats.forwarded === 4, 5000, "all four forwarded")
			assertEquals(w.gateway.stats.merges.device, 1)
			assertEquals(w.gateway.stats.merges.rules[MERGE], 1)
			assert(w.lines.some((l) => l.startsWith("merge") && l.includes(MERGE)))
			// the sync.ts device: the merge refused ("merge"), the one on it refused ("parent")
			const refused = await until(
				() =>
					w.host.device.history(room).refused().length >= 2 &&
					w.host.device.history(room).refused(),
				5000,
				"refused on the TS device",
			)
			assertEquals(refused.find((r) => r.name === hex(m))?.refused, "merge")
			assertEquals(refused.find((r) => r.name === hex(after))?.refused, "parent")
		} finally {
			f.close()
			await w.close()
		}
	},
})

Deno.test({
	name:
		"gateway: presence rows pass both ways unchanged, a device's under a key of its own; device to device as they came",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		// what the TS device hears on the room's topic, as presence.ts's channel would
		const heard: { from: string; bytes: Uint8Array }[] = []
		const stop = w.host.device.listen(room, (from, bytes) => void heard.push({ from, bytes }))
		const pigs = await cPeer(w.gateway, { room, name: "otter", keys: "lll" })
		// a fake device naming the room: rows come down to it too
		const f = await fake(w.gateway)
		const node = unhex(room.slice(9))
		f.link.send({ t: "heads", node, heads: [] })
		f.link.send({ t: "listen", topics: [room] })
		let beat: ReturnType<typeof setInterval> | undefined
		try {
			// C → TS: presence.ts's message, byte for byte as presence.ts encodes it
			const up = await until(
				() =>
					heard.find((h) => {
						const m = cbor.decode(h.bytes) as { value?: { pointer?: { x: number } } }
						return m.value?.pointer?.x !== undefined && m.value.pointer.x > 0.5 && h
					}),
				15000,
				"the C peer's row on the TS device",
			)
			const m = cbor.decode(up.bytes) as Record<string, unknown>
			assertEquals(Object.keys(m).sort(), ["ttl", "value"])
			assertEquals(m.ttl, 6000)
			assertEquals((m.value as { name: string }).name, "otter")
			assertEquals(cbor.encode(m as never), up.bytes)
			// under a key the gateway made for that device: neither the device's nor the gateway's
			const cKey = await until(
				() => says(f.got).find((x) => x.topic === room)?.who,
				5000,
				"the C peer's row on the other device",
			)
			assert(up.from !== hex(cKey) && up.from !== hex(w.signer.key))
			assertEquals(w.gateway.stats.messages.peers, 1)
			// device to device: its own key, the row as it came
			const relayed = await until(
				() => f.got.find((x) => x.t === "say" && hex(x.bytes) === hex(up.bytes)),
				5000,
				"the moved row on the other device",
			)
			assert(relayed.t === "say" && hex(relayed.who) === hex(cKey))

			// TS → C: a web pig's row, renewed, then gone
			const juno = cbor.encode({
				ttl: 6000,
				value: { name: "juno", colour: "#000000", pointer: { x: 0.25, y: 0.75 } },
			})
			const send = () => void w.host.device.send(room, juno)
			send()
			beat = setInterval(send, 1000)
			await until(
				() => pigs.dump().includes("@ juno x=0.25 y=0.75"),
				10000,
				"the TS row on the C screen",
			)
			const down = f.got.find((x) => x.t === "say" && hex(x.who) === hex(w.host.signer.key))
			assert(down?.t === "say" && hex(down.bytes) === hex(juno))
			clearInterval(beat)
			await w.host.device.send(room, cbor.encode({ gone: true }))
			await until(() => !pigs.dump().includes("@ juno"), 5000, "gone from the C screen")
			assert(w.gateway.stats.messages.in > 0 && w.gateway.stats.messages.out > 0)
		} finally {
			clearInterval(beat)
			stop()
			f.close()
			await pigs.stop()
			await w.close()
		}
	},
})

Deno.test({
	name:
		"gateway: messages on any topic (not a node's) both ways, 3.3 KB, only to the devices listening",
	...opts,
	async fn() {
		const w = await world()
		const topic = `dens:test-${hex(crypto.getRandomValues(new Uint8Array(8)))}`
		const heard: { from: string; bytes: Uint8Array }[] = []
		const stop = w.host.device.listen(topic, (from, bytes) => void heard.push({ from, bytes }))
		const a = await fake(w.gateway), b = await fake(w.gateway)
		a.link.send({ t: "listen", topics: [topic] })
		b.link.send({ t: "listen", topics: [topic + "/ask/someone"] })
		let beat: ReturnType<typeof setInterval> | undefined
		try {
			// told to send everything up
			await until(
				() => a.got.find((x) => x.t === "listen" && x.all === true),
				5000,
				"listen all from the gateway",
			)
			// TS → a: a den's row, byte for byte, under the TS device's key; b listens elsewhere
			const row = crypto.getRandomValues(new Uint8Array(3300))
			beat = setInterval(() => void w.host.device.send(topic, row), 300)
			const down = await until(
				() => a.got.find((x) => x.t === "say" && x.topic === topic),
				10000,
				"the TS message on a",
			)
			clearInterval(beat)
			assert(down.t === "say" && hex(down.bytes) === hex(row))
			assertEquals(hex(down.who), hex(w.host.signer.key))
			// a → TS: under a key the gateway made for a; b hears nothing on that topic
			const ask = cbor.encode({ n: 1, op: "look" })
			a.link.send({ t: "say", topic, who: a.signer.key, bytes: ask })
			const up = await until(
				() => heard.find((h) => hex(h.bytes) === hex(ask)),
				10000,
				"a's message on the TS device",
			)
			assert(up.from !== hex(a.signer.key) && up.from !== hex(w.signer.key))
			assert(!b.got.some((x) => x.t === "say"))
			assert(w.gateway.stats.messages.in >= 1 && w.gateway.stats.messages.out >= 1)
		} finally {
			clearInterval(beat)
			stop()
			a.close()
			b.close()
			await w.close()
		}
	},
})
