import { assertEquals } from "@std/assert"
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import { decode, encode, name } from "../../encoding/ts/blop.ts"
import { id } from "./id.ts"
import { seal, stored } from "./seal.ts"
import { createDevice, type Lock, unlocked } from "./transport.ts"

const DOC = id("unlocked", Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

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

function party(n: number, lock?: Lock) {
	const secret = new Uint8Array(32).fill(n), key = ed25519.getPublicKey(secret)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
	return { device: createDevice({ signer, lock }), key, signer }
}

// a root blop of the document, sealed
async function root(
	p: ReturnType<typeof party>,
	value: number,
	parents: Uint8Array[] = [],
	lamport = 1,
) {
	const bytes = encode({
		node: DOC,
		object: "value",
		actor: "t",
		signer: p.key,
		nonce: new Uint8Array(8).fill(value),
		parents,
		lamport,
		patches: [{ path: [], value }],
	})
	return { name: name(bytes), sealed: await seal(bytes, p.signer) }
}

const quiet = async (...ps: ReturnType<typeof party>[]) => {
	for (let i = 0; i < 5; i++) {
		await Promise.all(ps.map((p) => p.device.idle()))
		await new Promise((r) => setTimeout(r, 5))
	}
}
const opts = { sanitizeOps: false, sanitizeResources: false }

Deno.test({
	name: "transport: a stored blop crosses and is taken in; put as given is checked",
	...opts,
	async fn() {
		const a = party(1), b = party(2)
		await a.device.follow(DOC), await b.device.follow(DOC)
		const [x, y] = pipe()
		await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
		const r = await root(a, 1)
		await a.device.add(r.sealed)
		await quiet(a, b)
		assertEquals(b.device.histories(DOC).heads("value").map((h) => hex(h.name)), [hex(r.name)])
		assertEquals((await b.device.stored(DOC)).map(hex), [hex(stored(r.sealed))])
		// not a seal: refused shape, by its head
		const head = new Uint8Array(32).fill(0x11)
		await a.device.put(DOC, head, [], new Uint8Array([1, 2, 3]))
		await quiet(a, b)
		assertEquals(b.device.taking(DOC).refused, [{ commit: hex(head), refused: "shape" }])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "transport: a commit whose parent is not here waits, then is taken in",
	...opts,
	async fn() {
		const a = party(1)
		const p = await root(a, 1), c = await root(a, 2, [p.name], 2)
		await a.device.put(DOC, stored(c.sealed), [stored(p.sealed)], c.sealed)
		await quiet(a)
		assertEquals(a.device.taking(DOC).waiting, [{
			commit: hex(stored(c.sealed)),
			waiting: [hex(p.name)],
		}])
		await a.device.put(DOC, stored(p.sealed), [], p.sealed)
		await quiet(a)
		assertEquals(a.device.taking(DOC), { waiting: [], refused: [] })
		assertEquals(a.device.histories(DOC).heads("value").map((h) => hex(h.name)), [hex(c.name)])
		await a.device.close()
	},
})

Deno.test({
	name: "transport: a lock that waits holds a commit until changed",
	...opts,
	async fn() {
		let ready = false
		const lock: Lock = {
			...unlocked,
			open: (_d, bytes) => ready ? bytes : { wait: true },
		}
		const a = party(1, lock)
		const r = await root(a, 1)
		await a.device.put(DOC, stored(r.sealed), [], r.sealed)
		await quiet(a)
		assertEquals(a.device.taking(DOC).waiting, [{ commit: hex(stored(r.sealed)), waiting: [] }])
		ready = true
		await a.device.changed()
		assertEquals(a.device.taking(DOC), { waiting: [], refused: [] })
		assertEquals(a.device.histories(DOC).heads("value").length, 1)
		await a.device.close()
	},
})

Deno.test({
	name:
		"transport: a device's own add with made is handed over, its save passed over, never opened",
	...opts,
	async fn() {
		let opened = 0
		const lock: Lock = { ...unlocked, open: (d, b) => (opened++, unlocked.open(d, b)) }
		const a = party(1, lock)
		const bytes = encode({
			node: DOC,
			object: "value",
			actor: "t",
			signer: a.key,
			nonce: new Uint8Array(8).fill(1),
			parents: [],
			lamport: 1,
			patches: [{ path: [], value: 1 }],
		})
		const made = { blop: decode(bytes), name: name(bytes) }
		a.device.take(DOC, bytes, "stored", made)
		const sealed = await seal(bytes, a.signer, made)
		await a.device.add(sealed, { ...made, stored: stored(sealed) })
		await quiet(a)
		assertEquals(opened, 0)
		assertEquals(a.device.taking(DOC), { waiting: [], refused: [] })
		assertEquals(a.device.histories(DOC).heads("value").map((h) => hex(h.name)), [hex(made.name)])
		assertEquals((await a.device.stored(DOC)).map(hex), [hex(stored(sealed))])
		await a.device.close()
	},
})
