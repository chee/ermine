// the gateway against a real server (UPSTREAM, default wss://galaxy.observer), in lab-pig's room:
// main.ts as its own process, littlesync-pigs (C) over --pipe relayed to its /littlesync WebSocket,
// and a lab-pig-style sync.ts device on the same server. what the room refuses is printed, not
// failed on: the merge gap (gateway.ts, merges) is the thing to see. and two TS devices over HTTP
// sessions (http.ts) in a room of their own; and the gateway's own socket to the server closed under
// it (keep); and presence rows, as web pigs send them (presence.ts over the together device's channel),
// between a C peer and a presence world, both ways; and messages on a topic that is no node's
// ("dens:test-<random>") between a TS littlesync link and a together device, both ways
import { assert, assertEquals } from "@std/assert"
import { hex } from "../../../typescript/hex.ts"
import { httpDevice, names } from "./http_harness.ts"
import { createSigner, openMessage, sealMessage } from "../../../typescript/seal.ts"
import { createGateway } from "./gateway.ts"
import { createSessions } from "./http.ts"
import { dial, type Socket } from "./socket.ts"
import { createHost } from "./host_harness.ts"
import { type Pigs, row, spawnPigs, until } from "./pigs_harness.ts"
import {
	clear,
	connect,
	ensure,
	readPresence,
	setPresence,
} from "../../../presence/typescript/presence.ts"
import { device as presenceDevice } from "../../../presence/typescript/world.ts"
import { createChannel } from "../../../typescript/channel.ts"
import * as cbor from "@ermine/encoding/cbor"
import { Link } from "./link.ts"
import type { Message } from "./wire.ts"

const UPSTREAM = Deno.env.get("UPSTREAM") ?? "wss://galaxy.observer"
const ROOM = "ermine://bf04115f9b284145026eab6801219d6e" + "0".repeat(32)
const opts = { sanitizeOps: false, sanitizeResources: false }

// main.ts, on a free port: its log lines kept
async function gateway() {
	const port = 20000 + Math.floor(Math.random() * 20000)
	const child = new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"--allow-net",
			"--allow-env",
			"--allow-read",
			new URL("./main.ts", import.meta.url).pathname,
		],
		env: { PORT: String(port), UPSTREAM },
		stdout: "piped",
		stderr: "piped",
	}).spawn()
	const lines: string[] = []
	for (const s of [child.stdout, child.stderr]) {
		;(async () => {
			let buf = ""
			for await (const t of s.pipeThrough(new TextDecoderStream())) {
				buf += t
				const parts = buf.split("\n")
				buf = parts.pop()!
				lines.push(...parts)
			}
		})()
	}
	await until(
		() => lines.some((l) => l.includes("upstream") && l.includes("connected")),
		30000,
		"the gateway joins upstream",
	)
		.catch((e) => {
			throw new Error(`${e.message}\n${lines.join("\n")}`)
		})
	const status = async () => await (await fetch(`http://localhost:${port}/`)).json()
	return {
		port,
		lines,
		status,
		async stop() {
			child.kill("SIGTERM")
			await child.status
		},
	}
}

// a C peer through the gateway's WebSocket
async function cPeer(port: number, o: Parameters<typeof spawnPigs>[0]): Promise<Pigs> {
	const pigs = await spawnPigs(o)
	const ws = new WebSocket(`ws://localhost:${port}/littlesync`)
	ws.binaryType = "arraybuffer"
	await new Promise((r, j) => (ws.onopen = r, ws.onerror = j))
	ws.onmessage = (e) => void pigs.write(new Uint8Array(e.data as ArrayBuffer))
	pigs.on((b) => ws.readyState === WebSocket.OPEN && ws.send(b))
	pigs.done.then(() => ws.close())
	return pigs
}

Deno.test({
	name: `galaxy: a C pig through the gateway reaches a TS device on ${UPSTREAM}, and back`,
	...opts,
	async fn() {
		const g = await gateway()
		const host = await createHost("ts-galaxy")
		let pigs: Pigs | undefined
		const report: string[] = []
		try {
			await host.device.connectDiscover(UPSTREAM)
			await host.sync.follow(ROOM)
			const before = await until(() => host.read(ROOM), 30000, "the room on the TS device")
			report.push(`room on the TS device: ${Object.keys(before).length} keys`)
			const dir = await Deno.makeTempDir({ prefix: "littlesync-galaxy-" })
			// the C peer: 10 s for the room to come, adds a pig, then picks it up and carries it
			pigs = await cPeer(g.port, { dir, keys: ".".repeat(20) + "a" + ".".repeat(8) + " lll" })
			let followed: string[] = []
			const poll = setInterval(() => g.status().then((st) => followed = st.followed), 500)
			const id = await until(
				() => {
					const d = pigs!.dump()
					const sel = d.split("\n").find((l) => l.startsWith("selected "))?.[9]
					if (!sel || sel === "-" || !d.includes("carrying " + sel)) return
					const r = d.split("\n").find((l) => l.startsWith(sel + " "))
					return r && followed.find((f) => f.startsWith("ermine://" + r.slice(2, 10)))
				},
				40000,
				"the C peer's new pig, carried, followed at the gateway",
			).finally(() => clearInterval(poll))
			assert(id)
			report.push(`C pig ${id}`)
			await host.sync.follow(id)
			const value = await until(() => host.read(id), 30000, "the C pig's value on the TS device")
			report.push(`C pig on the TS device: ${JSON.stringify(value)}`)
			const held = await until(
				() => host.read(id)?.held === true && host.read(id),
				30000,
				"the C hold on the TS device",
			)
			report.push(`C hold on the TS device: ${JSON.stringify(held)}`)
			// the room: whether the C peer's key landed, or what refused it
			await new Promise((r) => setTimeout(r, 2000))
			report.push(`room key on the TS device: ${JSON.stringify(host.read(ROOM)?.[id])}`)
			const refused = host.device.history(ROOM).refused()
			report.push(
				`room refusals on the TS device: ${
					JSON.stringify(refused.slice(-5))
				} (${refused.length})`,
			)
			const rh = pigs.log().split("\n").filter((l) =>
				l.includes("heads bf04115f") || l.includes("refused")
			)
			report.push(`C log, the room's heads and refusals: ${rh.slice(-4).join(" | ")}`)
			await pigs.stop()

			// TS → C
			pigs = await cPeer(g.port, { dir })
			host.store(id, { x: 0.25, y: 0.75, at: Date.now(), seed: 9 })
			await until(
				() => row(pigs!.dump(), id)?.includes("x=0.25 y=0.75"),
				30000,
				"the TS move on the C screen",
			)
			report.push(`TS move on the C screen: ${row(pigs.dump(), id)}`)
			const wave = () =>
				host.wave(id, { x: 0.5, y: 0.5, held: true, by: "tsdev", colour: "#000000", who: "ts" })
			wave()
			const beat = setInterval(wave, 500)
			try {
				await until(
					() => row(pigs!.dump(), id)?.includes("held by tsdev"),
					30000,
					"the TS hold on the C screen",
				)
			} finally {
				clearInterval(beat)
			}
			report.push(`TS hold on the C screen: ${row(pigs.dump(), id)}`)
			// tidy: the test pig binned for everyone (lab-pig's format)
			host.store(id, { x: 0.96, y: 0.96, at: Date.now(), seed: 1, binned: true })
			host.set(ROOM, id, false)
			await host.sync.idle()
			const st = await g.status()
			report.push(`gateway stats: ${JSON.stringify(st.stats)}`)
			report.push(`gateway refusals: ${JSON.stringify(st.refusals)}`)
		} catch (e) {
			report.push(`gateway log:\n${g.lines.join("\n")}`)
			if (pigs) {
				report.push(
					`C screen:\n${pigs.dump()}\nC log (tail):\n${
						pigs.log().split("\n").slice(-30).join("\n")
					}`,
				)
			}
			throw e
		} finally {
			console.log(report.join("\n"))
			console.log(
				"gateway log, merges and refusals:\n" +
					g.lines.filter((l) => /merge|refused|can't send|waiting/.test(l)).slice(0, 40).join(
						"\n",
					),
			)
			await pigs?.stop()
			await host.close()
			await g.stop()
		}
	},
})

Deno.test({
	name: `galaxy: two HTTP devices through the gateway and a TS device on ${UPSTREAM} converge`,
	...opts,
	async fn() {
		const g = await gateway()
		const host = await createHost("ts-galaxy-http")
		const base = `http://localhost:${g.port}/littlesync/`
		const a = await httpDevice(base), b = await httpDevice(base)
		// a room of its own, zero-padded as galaxy stores
		const room = "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)
		try {
			await host.device.connectDiscover(UPSTREAM)
			await host.sync.follow(room)
			await until(() => a.link.up && b.link.up, 10000, "both HTTP links up")
			b.follow(room)
			const ra = await a.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			await until(() => host.read(room)?.a === 1, 30000, "a's commit on the TS device")
			await until(() => names(b).has(hex(ra)), 30000, "a's commit on b")
			const rb = await b.commit(room, {
				parents: [ra],
				lamport: 2,
				patches: [{ path: ["b"], value: 2 }],
			})
			await until(() => host.read(room)?.b === 2, 30000, "b's commit on the TS device")
			await until(() => names(a).has(hex(rb)), 30000, "b's commit on a")
			host.set(room, "c", 3)
			await until(
				() => {
					const ns = host.device.history(room).heads().map((k) => hex(k.name))
					return ns.length === 1 && names(a).has(ns[0]) && names(b).has(ns[0])
				},
				30000,
				"the TS device's commit on a and b",
			)
			assertEquals(host.read(room), { a: 1, b: 2, c: 3 })
			const st = await g.status()
			assertEquals(st.sessions, 2)
		} catch (e) {
			console.log(`gateway log:\n${g.lines.join("\n")}`)
			throw e
		} finally {
			await a.stop()
			await b.stop()
			await host.close()
			await g.stop()
		}
	},
})

Deno.test({
	name:
		`galaxy: the gateway's socket to ${UPSTREAM} closed, dialled again; a write made between lands`,
	...opts,
	async fn() {
		const lines: string[] = []
		const gw = createGateway({
			signer: await createSigner(),
			service: new URL(UPSTREAM).host,
			log: (l) => lines.push(l),
		})
		const sockets: Socket[] = []
		const stop = gw.keep(async () => {
			const s = await dial(UPSTREAM)
			sockets.push(s)
			return s
		})
		const sessions = createSessions(gw)
		const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
			const path = new URL(req.url).pathname
			return sessions.handle(req, path.slice(12))
		})
		const tick = setInterval(() => gw.tick(), 50)
		const host = await createHost("ts-galaxy-again")
		const d = await httpDevice(`http://localhost:${server.addr.port}/littlesync/`)
		const room = "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)
		try {
			await host.device.connectDiscover(UPSTREAM)
			await host.sync.follow(room)
			await until(() => gw.stats.upstream.up && d.link.up, 30000, "upstream and the device up")
			const ra = await d.commit(room, {
				parents: [],
				lamport: 1,
				patches: [{ path: [], value: { a: 1 } }],
			})
			await until(() => host.read(room)?.a === 1, 30000, "a on the TS device")
			// the gateway's socket closed: a write made before it is back
			await sockets.at(-1)!.disconnect()
			await until(() => !gw.stats.upstream.up, 5000, "the gateway sees it gone")
			const rb = await d.commit(room, {
				parents: [ra],
				lamport: 2,
				patches: [{ path: ["b"], value: 2 }],
			})
			await until(() => gw.stats.upstream.connects === 2, 30000, "dialled again")
			await until(() => host.read(room)?.b === 2, 30000, "b on the TS device")
			await until(
				() => d.got.some((m) => m.t === "ack" && m.names.some((n) => hex(n) === hex(rb))),
				10000,
				"b acked",
			)
			assertEquals(gw.stats.upstream.drops, 1)
		} catch (e) {
			console.log(lines.join("\n"))
			throw e
		} finally {
			await d.stop()
			clearInterval(tick)
			stop()
			sessions.close()
			await server.shutdown()
			await gw.close()
			await host.close()
		}
	},
})

Deno.test({
	name:
		`galaxy: presence rows between a web-style presence world and a C peer through the gateway`,
	...opts,
	async fn() {
		const g = await gateway()
		const host = await createHost("ts-galaxy-presence")
		const room = "ermine://" + hex(crypto.getRandomValues(new Uint8Array(16))) + "0".repeat(32)
		// lab-pig's sync world, in short: presence.ts's rows at the room, over the device's channel
		const w = presenceDevice("web", {
			get t() {
				return Date.now()
			},
		})
		const me = hex(host.signer.key)
		const row = () => ({ name: "juno", colour: "#2e86ab", pointer: { x: 0.25, y: 0.75 } })
		let pigs: Pigs | undefined
		let beat: ReturnType<typeof setInterval> | undefined
		try {
			await host.device.connectDiscover(UPSTREAM)
			ensure(w, room)
			connect(w, createChannel(host.device, host.signer), { topic: room })
			setPresence(w, room, me, row(), 6000)
			beat = setInterval(() => setPresence(w, room, me, row(), 6000), 2000)
			// the C peer in that room, its pointer moved right three steps (0.56)
			pigs = await cPeer(g.port, { room, name: "otter", keys: "...lll" })
			await until(
				() => pigs!.dump().includes("@ juno x=0.25 y=0.75"),
				30000,
				"the web row on the C screen",
			)
			const theirs = await until(
				() =>
					readPresence(w, room).find((r) =>
						(r.value as { name?: string })?.name === "otter" &&
						(r.value as { pointer?: { x: number } }).pointer!.x > 0.55
					),
				30000,
				"the C row in the presence world",
			)
			assert(theirs.who !== me)
			// the web side leaves: gone from the C screen before its ttl
			clearInterval(beat)
			clear(w, room, me)
			await until(
				() => !pigs!.dump().includes("@ juno"),
				4000,
				"the web row gone on the C screen",
			)
			// the C peer quits: its row is taken out (a gone, before its ttl)
			await pigs.stop()
			await until(
				() =>
					!readPresence(w, room).some((r) => (r.value as { name?: string })?.name === "otter"),
				4000,
				"the C row gone in the presence world",
			)
			const st = await g.status()
			console.log(`gateway message stats: ${JSON.stringify(st.stats.messages)}`)
		} catch (e) {
			console.log(`gateway log:\n${g.lines.join("\n")}`)
			if (pigs) console.log(`C screen:\n${pigs.dump()}`)
			throw e
		} finally {
			clearInterval(beat)
			await pigs?.stop()
			await host.close()
			await g.stop()
		}
	},
})

Deno.test({
	name: `galaxy: messages on a topic that is no node's, between a littlesync link and ${UPSTREAM}`,
	...opts,
	async fn() {
		const g = await gateway()
		const host = await createHost("ts-galaxy-topic")
		// a fresh topic each run, as a den's: nothing of another run's is heard
		const topic = `dens:test-${hex(crypto.getRandomValues(new Uint8Array(8)))}`
		const channel = createChannel(host.device, host.signer)
		const heard: { from: string; bytes: Uint8Array }[] = []
		const stop = channel.on(topic, (from, bytes) => void heard.push({ from, bytes }))
		// a TS littlesync device on the gateway's WebSocket, listening to the topic
		const signer = await createSigner()
		const got: Message[] = []
		const link = new Link(signer.key, (m) => got.push(m))
		const ws = new WebSocket(`ws://localhost:${g.port}/littlesync`)
		ws.binaryType = "arraybuffer"
		const open = new Promise((r, j) => (ws.onopen = r, ws.onerror = j))
		let timer: ReturnType<typeof setInterval> | undefined
		let beat: ReturnType<typeof setInterval> | undefined
		try {
			await host.device.connectDiscover(UPSTREAM)
			await open
			ws.onmessage = (e) => link.feed(new Uint8Array(e.data as ArrayBuffer), Date.now())
			timer = setInterval(() => {
				link.tick(Date.now())
				const b = link.next()
				if (b.length && ws.readyState === WebSocket.OPEN) ws.send(b)
			}, 20)
			link.send({ t: "listen", topics: [topic] })
			// down: a den's row (3.3 KB), sent till it comes (the gateway subscribes in its own time)
			const row = crypto.getRandomValues(new Uint8Array(3300))
			beat = setInterval(() => channel.send(topic, row), 1000)
			const down = await until(
				() => got.find((m) => m.t === "say" && m.topic === topic),
				30000,
				"the together device's message on the littlesync link",
			)
			clearInterval(beat)
			assert(down.t === "say")
			const o = await openMessage(down.bytes, topic)
			assertEquals([hex(o.signer), hex(o.bytes)], [hex(host.signer.key), hex(row)])
			// up: an ask, sealed by this link's device: under its own key
			const ask = cbor.encode({ n: 1, op: "look", at: topic })
			const sealed = await sealMessage(topic, ask, signer)
			beat = setInterval(() => link.send({ t: "say", topic, bytes: sealed }), 1000)
			const up = await until(
				() => heard.find((h) => hex(h.bytes) === hex(ask)),
				30000,
				"the littlesync message on the together device",
			)
			assertEquals(up.from, hex(signer.key))
			const st = await g.status()
			console.log(
				`topic ${topic}: down and up; gateway message stats: ${
					JSON.stringify(st.stats.messages)
				}`,
			)
		} catch (e) {
			console.log(`gateway log:\n${g.lines.join("\n")}`)
			throw e
		} finally {
			clearInterval(beat)
			clearInterval(timer)
			stop()
			ws.close()
			await host.close()
			await g.stop()
		}
	},
})
