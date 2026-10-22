import { assert, assertEquals } from "@std/assert"
import { snapshot } from "./snapshot.ts"
import * as sd from "npm:@automerge/subduction@0.23.0"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, encode, name as nameOf } from "@ermine/formats/commit"
import type { Kept } from "./history.ts"
import { pack } from "./packer.ts"
import { replay, type Tables } from "./replay.ts"
import { createSigner, seal, type Signer, stored } from "./seal.ts"
import { envelope, treeOf } from "../stacks/subduction/typescript/subduction.ts"
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

// a fresh ermine id, and its bytes (what a seal binds)
const DOC = "ermine:0010" + "2a".repeat(16)
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
		const sealed = await seal(c.bytes, signer, DOC)
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
		// not a seal: refused shape, by its head, never stored and nothing thrown; Subduction (0.23)
		// lists it in memory and pushes it on as it came, and b's door refuses it too
		const head = new Uint8Array(32).fill(0x11)
		await transport_conformance_hook_put(a.device, DOC, head, [], new Uint8Array([1, 2, 3]))
		await quiet(a, b)
		const shape = [{ commit: hex(head), refused: "shape" as const }]
		assertEquals(transport_conformance_hook_taking(a.device, DOC).refused, shape)
		assertEquals(transport_conformance_hook_taking(b.device, DOC).refused, shape)
		assertEquals(names(b.device.history(DOC).heads()), [hex(c.name)])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "transport: a commit whose parent is not here waits, then is taken in",
	...opts,
	async fn() {
		const a = await party(1)
		// a put is from elsewhere: stored only at a document followed
		await a.device.follow(DOC)
		const p = await make(a.signer, [], 1), c = await make(a.signer, [p], 2)
		await transport_conformance_hook_put(
			a.device,
			DOC,
			c.stored,
			[p.stored],
			envelope(DOC, { sealed: c.sealed }),
		)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC).waiting, [{
			commit: hex(c.stored),
			waiting: [hex(p.name)],
		}])
		await transport_conformance_hook_put(
			a.device,
			DOC,
			p.stored,
			[],
			envelope(DOC, { sealed: p.sealed }),
		)
		await quiet(a)
		assertEquals(transport_conformance_hook_taking(a.device, DOC), { waiting: [], refused: [] })
		assertEquals(names(a.device.history(DOC).heads()), [hex(c.name)])
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
			{ name: hex(c3.name), refused: "parent", on: hex(c2.name) },
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
		// the tree is listed until its id is named: taken in on following
		assertEquals(again.device.unnamed(), 1)
		await again.device.follow(DOC)
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
		await a.device.follow(DOC)
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
		"transport: a device made again on its storage takes in every commit once it follows the document, checked and announced",
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
		assertEquals(arrivals.length, 0)
		await device.follow(DOC)
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

Deno.test({
	name:
		"transport: a check that throws is no refusal: the commit waits on the check, idle throws what it threw, and changed judges it again",
	...opts,
	async fn() {
		let broken = true
		const check: Check = () => {
			if (broken) throw new Error("the check broke")
			return true
		}
		const a = await party(1), b = await party(2, { check })
		await joined(a, b)
		const c = await make(a.signer, [], 1)
		a.device.take(DOC, c.bytes, "stored")
		await quiet(a)
		// thrown for each history that asked (the stored, then the ephemeral)
		const thrown: unknown[] = []
		for (let i = 0; i < 20 && thrown.length < 2; i++) {
			await b.device.idle().catch((e) => thrown.push(e))
			await new Promise((r) => setTimeout(r, 5))
		}
		assert(thrown.every((e) => e instanceof Error && e.message === "the check broke"))
		assertEquals(thrown.length, 2)
		assertEquals(b.device.history(DOC).refused(), [])
		assertEquals(b.device.history(DOC).waiting(), [{ name: hex(c.name), waiting: [] }])
		broken = false
		await b.device.changed()
		await quiet(b)
		assertEquals(names(b.device.history(DOC).heads()), [hex(c.name)])
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name:
		"transport: not shared means not stored: another commit under a real one's name, from a peer that stored it with no door, is turned away at a device not following the tree (offered once), nothing of it stored or held in memory, so once that device follows the real one comes",
	...opts,
	async fn() {
		const tree = sd.SedimentreeId.fromBytes(treeOf(DOC))
		const a = await party(1)
		await a.device.follow(DOC)
		const real = await make(a.signer, [], 1)
		assertEquals(a.device.take(DOC, real.bytes, "stored"), "taken")
		// m: a Subduction with no door, holding another commit's seal under the real one's stored id
		const m = await party(9)
		const fake = await make(m.signer, [], 2)
		const mstore = new sd.MemoryStorage()
		const raw = new sd.Subduction({
			signer: {
				sign: (x: Uint8Array) => m.signer.sign(x),
				verifyingKey: () => m.key.subarray(2),
			},
			storage: mstore as unknown as sd.SedimentreeStorage,
			onEphemeral: () => {},
		})
		await raw.addCommit(
			tree,
			new sd.CommitId(real.stored),
			[],
			envelope(DOC, { sealed: fake.sealed }),
		)
		const holder = await party(9, { storage: mstore as unknown as sd.SedimentreeStorage })
		await holder.device.follow(DOC)
		// b, not following: what comes for the tree is turned away at its policy
		const bstore = new sd.MemoryStorage()
		const b = await party(2, { storage: bstore as unknown as sd.SedimentreeStorage })
		{
			const [x, y] = pipe()
			await Promise.all([holder.device.connect(x, true), b.device.connect(y, false)])
		}
		await quiet(holder, b)
		assertEquals((await bstore.loadAllCommits(tree)).length, 0)
		assertEquals((await bstore.loadAllSedimentreeIds()).length, 0)
		assertEquals(b.device.unnamed(), 0)
		assertEquals(b.device.offered(), [{ tree: hex(treeOf(DOC)), count: 1 }])
		// nothing of it in Subduction's memory either
		assertEquals((await b.device.stored(DOC)).map(hex), [])
		// following, the holder gone, connected to the real one's holder: it comes
		await Promise.all([holder.device.disconnect(b.key), b.device.disconnect(holder.key)])
		await b.device.follow(DOC)
		{
			const [x, y] = pipe()
			await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
		}
		await quiet(a, b)
		for (let i = 0; i < 40 && b.device.history(DOC).heads().length === 0; i++) {
			await new Promise((r) => setTimeout(r, 50))
		}
		assertEquals(names(b.device.history(DOC).heads()), [hex(real.name)])
		await a.device.close(), await b.device.close(), await holder.device.close()
	},
})

Deno.test({
	name:
		"transport: what is refused as it is saved is no throw out of Subduction's storage: a bad signature and a fragment with one, from a peer with no door, are refused, and the connection stays up both ways (a throw: Subduction drops it, and sends that peer nothing more)",
	...opts,
	async fn() {
		const tree = sd.SedimentreeId.fromBytes(treeOf(DOC))
		// m: a Subduction with no door, so it stores and pushes whatever it is given
		const m = await party(9)
		const raw = new sd.Subduction({
			signer: {
				sign: (x: Uint8Array) => m.signer.sign(x),
				verifyingKey: () => m.key.subarray(2),
			},
			storage: new sd.MemoryStorage() as unknown as sd.SedimentreeStorage,
			onEphemeral: () => {},
		})
		const b = await party(2)
		await b.device.follow(DOC)
		// the ends' disconnects, counted
		const [x, y] = pipe()
		let dropped = 0
		for (const end of [x, y]) {
			end.disconnect = () => (dropped++, Promise.resolve())
		}
		await Promise.all([raw.connectTransport(x, "ermine"), b.device.connect(y, false)])
		// m subscribed to the tree at b: what b takes is pushed to it while b holds the connection
		await raw.syncWithAllPeers(tree, true)
		const bad = (sealed: Uint8Array) => {
			const o = cbor.decode(sealed) as { signature: Uint8Array }
			const signature = o.signature.slice()
			signature[signature.length - 1] ^= 1
			return cbor.encode({ ...(o as Record<string, cbor.Value>), signature })
		}
		const x1 = await make(m.signer, [], 1)
		await raw.addCommit(
			tree,
			new sd.CommitId(x1.stored),
			[],
			envelope(DOC, { sealed: bad(x1.sealed) }),
		)
		const [c1, c2] = await deepLine(m.signer)
		await raw.addFragment(
			tree,
			new sd.CommitId(c2.stored),
			[],
			[],
			envelope(DOC, { run: pack([c1.sealed, bad(c2.sealed)]) }),
		)
		const late = await make(m.signer, [], 4)
		await raw.addCommit(
			tree,
			new sd.CommitId(late.stored),
			[],
			envelope(DOC, { sealed: late.sealed }),
		)
		for (let i = 0; i < 40 && b.device.history(DOC).heads().length === 0; i++) {
			await quiet(b)
		}
		assertEquals(names(b.device.history(DOC).heads()), [hex(late.name)])
		assertEquals(
			transport_conformance_hook_taking(b.device, DOC).refused.map((r) => [
				"commit" in r ? r.commit : r.fragment,
				"refused" in r ? r.refused : "stuck",
			]).sort(),
			[[hex(c2.stored), "signature"], [hex(x1.stored), "signature"]].sort(),
		)
		// b took its own after them: pushed to m, so b holds the connection still
		const back = await make(b.signer, [], 5)
		assertEquals(b.device.take(DOC, back.bytes, "stored"), "taken")
		const has = async () =>
			((await raw.getCommits(tree)) ?? []).some((c) =>
				hex(c.commitId.toBytes()) === hex(back.stored)
			)
		for (let i = 0; i < 40 && !await has(); i++) await quiet(b)
		assert(await has())
		assertEquals(dropped, 0)
		await b.device.close()
		await raw.disconnectAll()
	},
})
