import { assert, assertEquals } from "@std/assert"
import { snapshot } from "./snapshot.ts"
import * as sd from "npm:@automerge/subduction@0.23.0"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, encode, name as nameOf } from "@ermine/encoding/commit"
import type { Kept } from "./history.ts"
import { replay, type Tables } from "./replay.ts"
import { createSigner, seal, type Signer, stored } from "./seal.ts"
import {
	type Arrival,
	type Check,
	createDevice,
	type Layer,
	LIMIT,
	type Lock,
	unlocked,
} from "./transport.ts"
import {
	transport_conformance_hook_put,
	transport_conformance_hook_putFragment,
	transport_conformance_hook_taking,
} from "./transport_conformance_hook.ts"

const DOC = "ermine://" + "2a".repeat(16) + "0".repeat(32)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const names = (ks: Kept[]) => ks.map((k) => hex(k.name))

// a pipe: what one end sends the other receives, in order
function pipe(): [sd.Transport, sd.Transport] {
	type End = sd.Transport & {
		other?: End
		queue: Uint8Array[]
		waiting: ((b: Uint8Array) => void)[]
	}
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

type Options = Omit<Parameters<typeof createDevice>[0], "signer">
async function party(n: number, options: Options = {}) {
	const signer = await createSigner(new Uint8Array(32).fill(n))
	return { device: createDevice({ signer, ...options }), signer, key: signer.key }
}
type Party = Awaited<ReturnType<typeof party>>

async function joined(a: Party, b: Party) {
	await a.device.follow(DOC), await b.device.follow(DOC)
	const [x, y] = pipe()
	await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
}

let count = 0
type On = { name: Uint8Array; lamport: number }

// a commit's bytes by this key, on these parents; a nonce from a count, so each is new
function commitBy(key: Uint8Array, parents: On[], value: unknown) {
	const nonce = ++count
	const lamport = 1 + Math.max(0, ...parents.map((p) => p.lamport))
	const c: Commit = {
		table: "value",
		actor: "t",
		time: 1_760_000_000,
		signer: key,
		nonce,
		parents: parents.map((p) => p.name).sort(compare),
		lamport,
		patches: [{ path: [], value }],
	}
	if (parents.length > 1) c.base = c.parents[0]
	const bytes = encode(c)
	return { bytes, name: nameOf(bytes), lamport }
}

// sealed as its signer's device seals it. deep: its stored id starts with a zero byte (a
// fragment's head); else it does not
async function make(signer: Signer, parents: On[] = [], value: unknown = 0, deep = false) {
	for (;;) {
		const c = commitBy(signer.key, parents, value)
		const sealed = await seal(c.bytes, signer)
		const s = stored(sealed)
		if ((s[0] === 0) === deep) return { ...c, sealed, stored: s }
	}
}

// a line of three, the second a fragment's head: found once, as a deep one takes a few hundred
// seals to find
let line: ReturnType<typeof deepLine> | undefined
async function deepLine(signer: Signer) {
	const c1 = await make(signer, [], 1)
	const c2 = await make(signer, [c1], 2, true)
	return [c1, c2, await make(signer, [c2], 3)] as const
}

const quiet = async (...ps: Party[]) => {
	for (let i = 0; i < 5; i++) {
		await Promise.all(ps.map((p) => p.device.idle()))
		await new Promise((r) => setTimeout(r, 5))
	}
}
const told = (as: Arrival[]) => as.map((a) => [a.doc, a.layer, hex(a.kept.name), a.heard])
const opts = { sanitizeOps: false, sanitizeResources: false }

Deno.test({
	name:
		"transport: a stored commit taken here crosses, is taken in to both histories and announced; put as given is checked",
	...opts,
	async fn() {
		const a = await party(1), b = await party(2)
		await joined(a, b)
		const arrivals: Arrival[] = []
		b.device.arrived((r) => arrivals.push(r))
		const c = await make(a.signer, [], 1)
		assertEquals(a.device.take(DOC, c.bytes, "stored"), "taken")
		await quiet(a, b)
		assertEquals(names(b.device.history(DOC).heads()), [hex(c.name)])
		assertEquals(names(b.device.history(DOC, "ephemeral").heads()), [hex(c.name)])
		assertEquals(told(arrivals), [
			[DOC, "stored", hex(c.name), false],
			[DOC, "ephemeral", hex(c.name), false],
		])
		assertEquals((await b.device.stored(DOC)).map(hex), [hex(c.stored)])
		// not a seal: refused shape, by its head, and never stored, so never sent
		const head = new Uint8Array(32).fill(0x11)
		await transport_conformance_hook_put(a.device, DOC, head, [], new Uint8Array([1, 2, 3]))
		await quiet(a, b)
		assertEquals(transport_conformance_hook_taking(a.device, DOC).refused, [{
			commit: hex(head),
			refused: "shape",
		}])
		assertEquals((await a.device.stored(DOC)).map(hex), [hex(c.stored)])
		assertEquals(transport_conformance_hook_taking(b.device, DOC).refused, [])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "transport: a commit whose parent is not here waits, then is taken in",
	...opts,
	async fn() {
		const a = await party(1)
		const p = await make(a.signer, [], 1), c = await make(a.signer, [p], 2)
		await transport_conformance_hook_put(a.device, DOC, c.stored, [p.stored], c.sealed)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC).waiting, [{
			commit: hex(c.stored),
			waiting: [hex(p.name)],
		}])
		await transport_conformance_hook_put(a.device, DOC, p.stored, [], p.sealed)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC), { waiting: [], refused: [] })
		assertEquals(names(a.device.history(DOC).heads()), [hex(c.name)])
		await a.device.close()
	},
})

Deno.test({
	name: "transport: a lock that waits holds a commit until changed",
	...opts,
	async fn() {
		let ready = false
		const lock: Lock = { ...unlocked, open: (_d, bytes) => ready ? bytes : { wait: true } }
		const a = await party(1, { lock })
		const r = await make(a.signer, [], 1)
		await transport_conformance_hook_put(a.device, DOC, r.stored, [], r.sealed)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC).waiting, [{
			commit: hex(r.stored),
			waiting: [],
		}])
		ready = true
		await a.device.changed()
		assertEquals(transport_conformance_hook_taking(a.device, DOC), { waiting: [], refused: [] })
		assertEquals(a.device.history(DOC).heads().length, 1)
		await a.device.close()
	},
})

Deno.test({
	name:
		"transport: an own take is in the history at once, never checked, announced or opened; sealed and stored after",
	...opts,
	async fn() {
		let opened = 0, checked = 0
		const lock: Lock = { ...unlocked, open: (d, b) => (opened++, unlocked.open(d, b)) }
		const a = await party(1, { lock, check: () => (checked++, false) })
		const arrivals: Arrival[] = []
		a.device.arrived((r) => arrivals.push(r))
		const c1 = await make(a.signer, [], 1), c2 = await make(a.signer, [c1], 2)
		assertEquals(a.device.take(DOC, c1.bytes, "stored"), "taken")
		assertEquals(a.device.take(DOC, c2.bytes, "stored"), "taken")
		// synchronously: the next commit is made on it
		assertEquals(names(a.device.history(DOC).heads()), [hex(c2.name)])
		assertEquals(names(a.device.history(DOC, "ephemeral").heads()), [hex(c2.name)])
		assertEquals(a.device.take(DOC, c2.bytes, "stored"), "passed")
		await quiet(a)
		assertEquals([opened, checked, arrivals.length], [0, 0, 0])
		assertEquals(transport_conformance_hook_taking(a.device, DOC), { waiting: [], refused: [] })
		assertEquals(
			(await a.device.stored(DOC)).map(hex).sort(),
			[hex(c1.stored), hex(c2.stored)].sort(),
		)
		await a.device.close()
	},
})

Deno.test({
	name:
		"transport: a commit from a peer goes through check in each layer; one refused stays out of the history, and what is on it",
	...opts,
	async fn() {
		const calls: [string, string, string, Layer][] = []
		const check: Check = (doc, kept, commit, layer) => {
			calls.push([doc, hex(kept.name), commit.table, layer])
			return commit.patches[0].value !== 2
		}
		const a = await party(1), b = await party(2, { check })
		await joined(a, b)
		const c1 = await make(a.signer, [], 1)
		const c2 = await make(a.signer, [c1], 2), c3 = await make(a.signer, [c2], 3)
		for (const c of [c1, c2, c3]) a.device.take(DOC, c.bytes, "stored")
		await quiet(a, b)
		// a's own: taken, never checked
		assertEquals(names(a.device.history(DOC).heads()), [hex(c3.name)])
		const h = b.device.history(DOC)
		assertEquals(names(h.heads()), [hex(c1.name)])
		assertEquals(h.get(c2.name), undefined)
		assertEquals(h.refused().sort((x, y) => x.refused < y.refused ? -1 : 1), [
			{ name: hex(c3.name), refused: "parent" },
			{ name: hex(c2.name), refused: "patches" },
		])
		assertEquals(calls, [
			[DOC, hex(c1.name), "value", "stored"],
			[DOC, hex(c1.name), "value", "ephemeral"],
			[DOC, hex(c2.name), "value", "stored"],
			[DOC, hex(c2.name), "value", "ephemeral"],
		])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name:
		"transport: an ephemeral commit heard is taken in to the ephemeral history only; one from someone not its signer is refused",
	...opts,
	async fn() {
		const a = await party(1), b = await party(2)
		const other = await createSigner(new Uint8Array(32).fill(3))
		await joined(a, b)
		const arrivals: Arrival[] = []
		b.device.arrived((r) => arrivals.push(r))
		const e = commitBy(a.key, [], 1)
		assertEquals(a.device.take(DOC, e.bytes, "ephemeral"), "taken")
		await quiet(a, b)
		assertEquals(names(b.device.history(DOC, "ephemeral").heads()), [hex(e.name)])
		assertEquals(b.device.history(DOC).heads(), [])
		assertEquals(told(arrivals), [[DOC, "ephemeral", hex(e.name), true]])
		// a sends one whose signer is another's key
		const f = commitBy(other.key, [], 2)
		assertEquals(a.device.take(DOC, f.bytes, "ephemeral"), "taken")
		await quiet(a, b)
		assertEquals(b.device.history(DOC, "ephemeral").get(f.name), undefined)
		assertEquals(transport_conformance_hook_taking(b.device, DOC, "ephemeral").refused, [{
			commit: hex(f.name),
			refused: "signature",
		}])
		assertEquals(arrivals.length, 1)
		// one over LIMIT goes as parts, and arrives whole
		const big = commitBy(a.key, [e], new Uint8Array(LIMIT * 2).fill(7))
		assertEquals(a.device.take(DOC, big.bytes, "ephemeral"), "taken")
		await quiet(a, b)
		assertEquals(names(b.device.history(DOC, "ephemeral").heads()), [hex(big.name)])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name:
		"transport: a fragment built here carries snapshotOf's tables; a device on that storage, and a late joiner, check them once (a replay) and keep them",
	...opts,
	async fn() {
		const storage = new sd.MemoryStorage() as unknown as sd.SedimentreeStorage
		const asked: Kept[] = []
		let device: Party["device"] | undefined
		const snapshotOf = (_doc: string, head: Kept): Uint8Array => {
			asked.push(head)
			return snapshot(replay(device!.history(DOC), head.name)!)
		}
		const a = await party(1, { storage, snapshotOf })
		device = a.device
		await a.device.follow(DOC)
		const [c1, c2, c3] = await (line ??= deepLine(a.signer))
		for (const c of [c1, c2, c3]) a.device.take(DOC, c.bytes, "stored")
		await quiet(a)
		assertEquals(a.device.fragments(DOC).map((f) => hex(f.head)), [hex(c2.stored)])
		// asked once, with the history's own kept commit
		assertEquals(asked.length, 1)
		assert(asked[0] === a.device.history(DOC).get(c2.name))
		const want = 2
		assertEquals(a.device.snapshot(DOC, c2.name)?.value.value, want)
		assertEquals(a.device.snapshot(DOC, c2.name)?.value.change.actor, "t")
		// new objects each time
		assert(a.device.snapshot(DOC, c2.name)!.value !== a.device.snapshot(DOC, c2.name)!.value)
		assertEquals(a.device.snapshot(DOC, c3.name), undefined)

		const again = await party(1, { storage })
		await again.device.ready()
		await quiet(again)
		assertEquals(again.device.snapshot(DOC, c2.name)?.value.value, want)
		assertEquals(names(again.device.history(DOC).heads()), [hex(c3.name)])

		const late = await party(3)
		await joined(a, late)
		await quiet(a, late)
		assertEquals(names(late.device.history(DOC).heads()), [hex(c3.name)])
		assertEquals(late.device.snapshot(DOC, c2.name)?.value.value, want)
		await a.device.close(), await again.device.close(), await late.device.close()
	},
})

Deno.test({
	name:
		"transport: a fragment whose blob is a bare list of seals (the old shape) is refused whole",
	...opts,
	async fn() {
		const a = await party(1)
		const [, d] = await (line ??= deepLine(a.signer))
		await transport_conformance_hook_putFragment(
			a.device,
			DOC,
			d.stored,
			[],
			[],
			cbor.encode([d.sealed]),
		)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC).refused, [{
			fragment: hex(d.stored),
			refused: "shape",
		}])
		assertEquals(a.device.history(DOC).heads(), [])
		await a.device.close()
	},
})

Deno.test({
	name:
		"transport: a device made again on its storage takes in every commit, checked and announced",
	...opts,
	async fn() {
		const storage = new sd.MemoryStorage() as unknown as sd.SedimentreeStorage
		const a = await party(1, { storage })
		const c1 = await make(a.signer, [], 1)
		const c2 = await make(a.signer, [c1], 2), c3 = await make(a.signer, [c1], 3)
		for (const c of [c1, c2, c3]) a.device.take(DOC, c.bytes, "stored")
		await quiet(a)
		await a.device.close()

		// listened to at once: taking in starts as it is made
		let checked = 0
		const device = createDevice({ signer: a.signer, storage, check: () => (checked++, true) })
		const arrivals: Arrival[] = []
		device.arrived((r) => arrivals.push(r))
		await device.ready()
		await device.idle()
		assertEquals(checked, 6)
		const stored = told(arrivals.filter((r) => r.layer === "stored"))
		assertEquals(stored.map((r) => r[2]).sort(), [c1, c2, c3].map((c) => hex(c.name)).sort())
		assertEquals(arrivals.length, 6)
		assert(arrivals.every((r) => r.doc === DOC && !r.heard))
		const heads = [c2, c3].sort((x, y) => compare(y.name, x.name)).map((c) => hex(c.name))
		assertEquals(names(device.history(DOC).heads()), heads)
		await device.close()
	},
})

Deno.test({
	name: "transport: an own take waiting on a parent goes out once its parent is taken, after it",
	...opts,
	async fn() {
		const a = await party(1), b = await party(2)
		await joined(a, b)
		const c1 = await make(a.signer, [], 1)
		const c2 = await make(a.signer, [c1], 2), c3 = await make(a.signer, [c2], 3)
		assertEquals(a.device.take(DOC, c1.bytes, "stored"), "taken")
		assertEquals(a.device.take(DOC, c3.bytes, "stored"), { waiting: [hex(c2.name)] })
		assertEquals(a.device.take(DOC, c2.bytes, "stored"), "taken")
		await quiet(a, b)
		assertEquals(names(b.device.history(DOC).heads()), [hex(c3.name)])
		assertEquals(
			(await a.device.stored(DOC)).map(hex).sort(),
			[c1, c2, c3].map((c) => hex(c.stored)).sort(),
		)
		await a.device.close(), await b.device.close()
	},
})
