// the gateway in one process, no server: littlesync-pigs (C) over --pipe as one link, fake TS
// devices (link.ts) as others, and a lab-pig-style sync.ts device as the gateway's Subduction peer
// (an in-memory pipe in place of the server)
import { assert, assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { pipe } from "../../../typescript/harnesses.ts"
import { createSigner, seal, type Signer } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import { createGateway, type Gateway } from "./gateway.ts"
import { Link } from "./link.ts"
import { MERGE, type Message } from "./wire.ts"
import { row, spawnPigs, until } from "./pigs_harness.ts"
import { createHost } from "./host_harness.ts"

const opts = { sanitizeOps: false, sanitizeResources: false }
const zeros = (b: Uint8Array) => "ermine://" + hex(b) + "0".repeat(32)
const fresh = () => zeros(crypto.getRandomValues(new Uint8Array(16)))

async function world() {
	const lines: string[] = []
	const gateway = createGateway({ signer: await createSigner(), log: (l) => lines.push(l) })
	const host = await createHost("ts")
	const { ends: [x, y] } = pipe()
	await Promise.all([gateway.connectTransport(x, true), host.device.connect(y, false)])
	const timer = setInterval(() => gateway.tick(), 20)
	return {
		gateway,
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
			const orphan = await f.commit(room, {
				parents: [nameOf(crypto.getRandomValues(new Uint8Array(8)))],
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
