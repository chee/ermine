// the gateway in one process, no server: littlesync-pigs (C) over --pipe as one link, fake TS
// devices (link.ts) as others, and a lab-pig-style sync.ts device as the gateway's Subduction peer
// (an in-memory pipe in place of the server)
import { assert, assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { pipe } from "../../../typescript/harnesses.ts"
import {
	createSigner,
	openMessage,
	seal,
	sealMessage,
	type Signer,
} from "../../../typescript/seal.ts"
import { createChannel } from "../../../typescript/channel.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import * as cbor from "@ermine/encoding/cbor"
import { createGateway, type Gateway } from "./gateway.ts"
import { Link } from "./link.ts"
import { MERGE, type Message } from "./wire.ts"
import { row, spawnPigs, until } from "./pigs_harness.ts"
import { createHost } from "./host_harness.ts"

const opts = { sanitizeOps: false, sanitizeResources: false }
const fresh = () => "ermine:0010" + hex(crypto.getRandomValues(new Uint8Array(16)))
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
			const node = id
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
		const dir = await Deno.makeTempDir({ prefix: "littlesync-gateway-" })
		// the C peer adds a pig at 0.7 s, picks it up at about 5 s and carries it right
		let pigs = await cPeer(w.gateway, { dir, room, keys: "a......... lll" })
		// the gateway names the room as the C peer does (it follows what a device names), before the
		// TS device writes there: what a peer sends for a tree whose id is not named yet is refused
		await until(
			() => w.gateway.followed().includes(room),
			3000,
			"the room followed at the gateway",
		)
		await w.host.sync.follow(room)
		// the room has a value and children, as lab-pig's has (a key set on nothing is refused by
		// sync.ts)
		w.host.store(room, {})
		w.host.place(room, {})
		await w.host.sync.idle()
		try {
			// the room's children name the pig (pig-<its hex>: its id), then the pig's value, on the
			// sync.ts device
			const pig = await until(
				() =>
					Object.values(w.host.children(room) ?? {}).find((v): v is string =>
						typeof v === "string" && v.startsWith("ermine:")
					),
				10000,
				"the room's new pig on the TS device",
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
	name:
		"gateway: a key id (ed01 and an Ed25519 key) is a node as any ermine id: a commit there reaches a sync.ts device",
	...opts,
	async fn() {
		const w = await world()
		const id = "ermine:ed01" + hex(crypto.getRandomValues(new Uint8Array(32)))
		await w.host.sync.follow(id)
		const f = await fake(w.gateway)
		try {
			await until(() => f.link.up, 3000, "the fake device up")
			await f.commit(id, { parents: [], lamport: 1, patches: [{ path: [], value: { a: 1 } }] })
			await until(() => w.host.read(id)?.a === 1, 5000, "the key id's value on the TS device")
			assert(w.gateway.followed().includes(id))
			assert(!w.lines.some((l) => l.includes("not a node's id")))
		} finally {
			f.close()
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
		"gateway: presence rows pass both ways sealed and unchanged, a device's under its own key; device to device as they came",
	...opts,
	async fn() {
		const w = await world()
		const room = fresh()
		// what the TS device hears on the room's topic, through presence.ts's channel
		const channel = createChannel(w.host.device, w.host.signer)
		const heard: { from: string; bytes: Uint8Array }[] = []
		const stop = channel.on(room, (from, bytes) => void heard.push({ from, bytes }))
		const pigs = await cPeer(w.gateway, { room, name: "otter", keys: "lll" })
		// a fake device naming the room: rows come down to it too
		const f = await fake(w.gateway)
		const node = room
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
			// under the device's own key (its seal), not the gateway's
			const first = await until(
				() => says(f.got).find((x) => x.topic === room),
				5000,
				"the C peer's row on the other device",
			)
			const cKey = (await openMessage(first.bytes, room)).signer
			assertEquals(up.from, hex(cKey))
			assert(up.from !== hex(w.signer.key))
			// device to device: the sealed row as it came
			const opened = await Promise.all(
				says(f.got).map((x) => openMessage(x.bytes, x.topic).catch(() => undefined)),
			)
			assert(
				opened.some((o) => o && hex(o.signer) === hex(cKey) && hex(o.bytes) === hex(up.bytes)),
			)

			// TS → C: a web pig's row, renewed, then gone
			const juno = cbor.encode({
				ttl: 6000,
				value: { name: "juno", colour: "#000000", pointer: { x: 0.25, y: 0.75 } },
			})
			const send = () => channel.send(room, juno)
			send()
			beat = setInterval(send, 1000)
			await until(
				() => pigs.dump().includes("@ juno x=0.25 y=0.75"),
				10000,
				"the TS row on the C screen",
			)
			const downs = await Promise.all(
				says(f.got).map((x) => openMessage(x.bytes, x.topic).catch(() => undefined)),
			)
			assert(
				downs.some((o) =>
					o && hex(o.signer) === hex(w.host.signer.key) && hex(o.bytes) === hex(juno)
				),
			)
			clearInterval(beat)
			channel.send(room, cbor.encode({ gone: true }))
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
		"gateway: messages on any topic (not a node's) both ways, sealed, 3.3 KB, only to the devices listening",
	...opts,
	async fn() {
		const w = await world()
		const topic = `dens:test-${hex(crypto.getRandomValues(new Uint8Array(8)))}`
		const channel = createChannel(w.host.device, w.host.signer)
		const heard: { from: string; bytes: Uint8Array }[] = []
		const stop = channel.on(topic, (from, bytes) => void heard.push({ from, bytes }))
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
			// TS → a: a den's row, byte for byte, sealed by the TS device; b listens elsewhere
			const row = crypto.getRandomValues(new Uint8Array(3300))
			beat = setInterval(() => channel.send(topic, row), 300)
			const down = await until(
				() => a.got.find((x) => x.t === "say" && x.topic === topic),
				10000,
				"the TS message on a",
			)
			clearInterval(beat)
			assert(down.t === "say")
			const o = await openMessage(down.bytes, topic)
			assertEquals([hex(o.signer), hex(o.bytes)], [hex(w.host.signer.key), hex(row)])
			// a → TS: under a's own key (its seal); b hears nothing on that topic; unsealed: dropped
			const ask = cbor.encode({ n: 1, op: "look" })
			a.link.send({ t: "say", topic, bytes: ask })
			a.link.send({ t: "say", topic, bytes: await sealMessage(topic, ask, a.signer) })
			const up = await until(
				() => heard.find((h) => hex(h.bytes) === hex(ask)),
				10000,
				"a's message on the TS device",
			)
			assertEquals(up.from, hex(a.signer.key))
			assertEquals(heard.filter((h) => hex(h.bytes) === hex(ask)).length, 1)
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
