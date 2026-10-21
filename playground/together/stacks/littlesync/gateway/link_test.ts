// the TS littlesync peer (link.ts, wire.ts) on its own, and against the C side: littlesync-pigs
// --pipe, whose seals TS opens and whose screen shows what TS sealed
import { assert, assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { createSigner, seal, unseal } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import { Link } from "./link.ts"
import type { Message } from "./wire.ts"
import { row, rows, spawnPigs, until } from "./pigs_harness.ts"

const key = (n: number) => Uint8Array.from([0xed, 0x01, ...new Uint8Array(32).fill(n)])
// a fresh ermine id: ermine:0010, then 16 bytes in hex
const node = "ermine:0010" + "07".repeat(16)

Deno.test("link: two TS links say hello, come up, pass messages; silent after 8 s", () => {
	const got: Message[][] = [[], []]
	const a = new Link(key(1), (m) => got[0].push(m)), b = new Link(key(2), (m) => got[1].push(m))
	let t = 0
	const cross = () => {
		for (let i = 0; i < 4; i++) b.feed(a.next(), t), a.feed(b.next(), t)
	}
	a.tick(t), b.tick(t)
	cross()
	assert(a.up && b.up)
	assertEquals(a.peer, key(2))
	assertEquals(b.peer, key(1))
	a.send({ t: "want", node, names: [new Uint8Array(34).fill(3)] })
	cross()
	const want = got[1].find((m) => m.t === "want")
	assertEquals(want, { t: "want", node, names: [new Uint8Array(34).fill(3)] })
	// a's hellos again every 4 s keep it heard; b says nothing for 8 s: a takes it as silent
	t = 8001
	a.tick(t)
	assert(!a.up)
	// down: hello every 2 s
	a.next()
	a.tick(t + 1000)
	assertEquals(a.next().length, 0)
	a.tick(t + 2000)
	assert(a.next().length > 0)
})

Deno.test("link: a message before hello brings the link up and is answered with hello", () => {
	const got: Message[] = []
	const a = new Link(key(1), () => {}), b = new Link(key(2), (m) => got.push(m))
	a.up = true // a thinks it is up already: it talks without saying hello
	a.send({ t: "ack", node, names: [] })
	b.feed(a.next(), 0)
	assert(b.up)
	assertEquals(got[0].t, "ack")
	assert(b.next().length > 0)
})

const opts = { sanitizeOps: false, sanitizeResources: false }

// a TS peer that follows like a device: the room and the pig, its own commits sealed by seal.ts
Deno.test({
	name:
		"link: against littlesync-pigs over --pipe, both ways (C seals open in TS, TS seals show in C)",
	...opts,
	async fn() {
		const room = "ermine:0010" + "ab".repeat(16)
		const pigs = await spawnPigs({ keys: "a", room })
		const signer = await createSigner()
		const got: Message[] = []
		const link = new Link(signer.key, (m) => got.push(m))
		pigs.on((b) => link.feed(b, Date.now()))
		const pump = setInterval(() => {
			link.tick(Date.now())
			const out = link.next()
			if (out.length) pigs.write(out)
		}, 20)
		try {
			await until(() => link.up, 5000, "the C peer says hello")
			// the C peer added a pig: two commits, the pig's value and the room's key, each a seal
			// that verifies here in its node
			const sealedIn = () => got.flatMap((m) => m.t === "commits" ? [m] : [])
			await until(() => sealedIn().flatMap((m) => m.sealed).length >= 2, 8000, "two commits")
			const commits = sealedIn()
			const opened = []
			for (const m of commits) for (const s of m.sealed) opened.push(await unseal(s, m.node))
			// the room's children name the pig: pig-<its hex> holds its id
			const roomCommit = opened.find((u) =>
				u.commit.table === "children" && u.commit.patches[0].path.length === 1
			)!
			assert(roomCommit, "a commit naming the pig in the room's children")
			const pigId = roomCommit.commit.patches[0].value as string
			assert(typeof pigId === "string" && pigId.startsWith("ermine:"))
			assertEquals(roomCommit.commit.lamport, 1)
			const pigCommit = opened.find((u) => u.commit.patches[0].path.length === 0)!
			const pigValue = pigCommit.commit.patches[0].value as Record<string, number>
			assert(pigValue.x > 0 && pigValue.x < 1)

			// TS → C: the pig's value again, a commit on the C one (its parent, lamport 2), sealed here
			const commit = {
				table: "value",
				actor: null,
				time: Math.floor(Date.now() / 1000),
				signer: signer.key,
				nonce: 1,
				parents: [pigCommit.name],
				lamport: 2,
				patches: [{ path: [], value: { x: 0.25, y: 0.75, at: Date.now(), seed: 7 } }],
			}
			const bytes = encodeCommit(commit)
			const pigNode = pigId
			link.send({ t: "commits", node: pigNode, sealed: [await seal(bytes, signer, pigNode)] })
			await until(
				() => row(pigs.dump(), pigId)?.includes("x=0.25 y=0.75"),
				5000,
				"the C screen shows it",
			)
			// acked by the C side
			const acks = got.filter((m) => m.t === "ack" && m.node === pigNode)
			assert(
				acks.some((m) => m.t === "ack" && m.names.some((n) => hex(n) === hex(nameOf(bytes)))),
			)
			assert(rows(pigs.dump()).includes(pigId.slice(11, 19)))
		} finally {
			clearInterval(pump)
			await pigs.stop()
		}
	},
})
