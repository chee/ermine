// sync on the rewritten pieces (commit, seal, history, replay, transport): two hosts, each a table,
// places, a scheduler and sync over its own device,
// joined by a pipe. one commit per entry change, the node one object, conflicts in a table, a
// reload from storage, and what is not kept staying home
import { assert, assertEquals } from "@std/assert"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import * as sd from "npm:@automerge/subduction@0.23.0"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { createSigner } from "./seal.ts"
import { createSync } from "./sync.ts"

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

// a host: the graph, and sync beside places over its own device
async function host(n: number, storage = new sd.MemoryStorage(), zeros = false) {
	const signer = await createSigner(new Uint8Array(32).fill(n))
	const scheduler = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({
		table,
		signer,
		zeros,
		storage: storage as unknown as sd.SedimentreeStorage,
		commit: (changed) => places.commit(changed),
	})
	const device = sync.device
	const scope = scheduler.createRootScope([["actor", `host${n}`]])
	// patches to the entry under (part, id), made whole first if none
	const write = (part: Key, id: Id, patches: Patch[]) =>
		scheduler.runWithScope(scope, () => {
			const entry = table.get(part, id)
			if (entry === undefined) {
				const first = patches[0]
				table.add(part, id, createEntry(first.value as never, createChangeHeader(scheduler)))
				patches = patches.slice(1)
				if (!patches.length) return
			}
			const e = table.get(part, id)!
			update(e, patches as never, createChangeHeader(scheduler))
			places.commit([e])
			sync.wrote([e])
		})
	const read = (part: Key, id: Id) => table.get(part, id)?.value
	return { device, table, places, sync, write, read, storage }
}
type Host = Awaited<ReturnType<typeof host>>

async function quiet(...hs: Host[]) {
	for (let i = 0; i < 6; i++) {
		await Promise.all(hs.map((h) => h.sync.idle()))
		await new Promise((r) => setTimeout(r, 5))
	}
}

async function connect(a: Host, b: Host) {
	const [x, y] = pipe()
	await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
}

const opts = { sanitizeOps: false, sanitizeResources: false }

Deno.test({
	name: "sync: a node's tables cross, one commit per entry change",
	...opts,
	async fn() {
		const a = await host(1), b = await host(2)
		const id = a.sync.mint()
		await b.sync.follow(id)
		await connect(a, b)
		a.write("value", id, [{ path: [], value: { title: "hi" } }])
		a.write("value", id, [{ path: ["title"], value: "hello" }])
		a.write("attributes", id, [{ path: [], value: { color: "cherry" } }])
		a.write("children", id, [{ path: [], value: { notes: "ermine://" + "ab".repeat(32) } }])
		await quiet(a, b)
		assertEquals(b.read("value", id), { title: "hello" })
		assertEquals(b.read("attributes", id), { color: "cherry" })
		assertEquals(b.read("children", id), { notes: "ermine://" + "ab".repeat(32) })
		// four entry changes, four commits
		// (counted in the history: storage lets go of loose commits a fragment stands for)
		assertEquals(a.device.history(id).all().length, 4)
		assertEquals(b.read("conflicts", id), undefined)
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "sync: what isn't kept stays home: a local id, a table not kept",
	...opts,
	async fn() {
		const a = await host(1)
		const id = a.sync.mint()
		a.write("value", "local", [{ path: [], value: 1 }])
		a.write("presence" as Key, id, [{ path: [], value: { me: 1 } }])
		await quiet(a)
		assertEquals((await a.device.stored(id)).length, 0)
		await a.device.close()
	},
})

Deno.test({
	name: "sync: writes on both sides at once are two heads, listed as conflicts until settled",
	...opts,
	async fn() {
		const a = await host(1), b = await host(2)
		const id = a.sync.mint()
		await b.sync.follow(id)
		await connect(a, b)
		a.write("value", id, [{ path: [], value: { n: 0 } }])
		await quiet(a, b)
		assertEquals(b.read("value", id), { n: 0 })
		// apart: each writes, then they meet
		a.write("value", id, [{ path: ["n"], value: 1 }])
		b.write("value", id, [{ path: ["n"], value: 2 }])
		await quiet(a, b)
		const shown = a.read("value", id)
		assertEquals(b.read("value", id), shown)
		const ca = a.read("conflicts", id) as { tables: Record<string, unknown> }[]
		const cb = b.read("conflicts", id) as { tables: Record<string, unknown> }[]
		assertEquals(ca.length, 1)
		assertEquals(cb, ca)
		assertEquals(ca[0].tables.value, { n: (shown as { n: number }).n === 1 ? 2 : 1 })
		// settled on one side: one head everywhere, nothing listed
		a.sync.settle(id)
		await quiet(a, b)
		assertEquals(a.read("conflicts", id), undefined)
		assertEquals(b.read("conflicts", id), undefined)
		assertEquals(b.read("value", id), shown)
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name: "sync: a host made again over the same storage has its nodes back",
	...opts,
	async fn() {
		const storage = new sd.MemoryStorage()
		const a = await host(1, storage)
		const id = a.sync.mint()
		a.write("value", id, [{ path: [], value: "kept" }])
		a.write("attributes", id, [{ path: [], value: { k: 1 } }])
		await quiet(a)
		await a.device.close()
		const again = await host(1, storage)
		await again.sync.follow(id)
		await quiet(again)
		assertEquals(again.read("value", id), "kept")
		assertEquals(again.read("attributes", id), { k: 1 })
		await again.device.close()
	},
})

Deno.test({
	name: "sync: until Keyhive, ids can be minted with their last 16 bytes zero",
	...opts,
	async fn() {
		const a = await host(1, undefined, true)
		const id = a.sync.mint()
		assert(id.startsWith("ermine://"))
		assert(id.endsWith("0".repeat(32)))
		assert(!(await host(2)).sync.mint().endsWith("0".repeat(32)))
	},
})

Deno.test({
	name: "sync: a rename in children, a patch deep in a value, an entry taken out",
	...opts,
	async fn() {
		const a = await host(1), b = await host(2)
		const id = a.sync.mint()
		await b.sync.follow(id)
		await connect(a, b)
		const x = "ermine://" + "cd".repeat(32)
		a.write("children", id, [{ path: [], value: { old: x } }])
		a.write("children", id, [{ path: ["new"], move: { path: ["old"] } }])
		a.write("value", id, [{ path: [], value: { doc: { lines: ["a", "b"] } } }])
		a.write("value", id, [{ path: ["doc", "lines", 1], value: "B" }])
		await quiet(a, b)
		assertEquals(b.read("children", id), { new: x })
		assertEquals(b.read("value", id), { doc: { lines: ["a", "B"] } })
		a.write("attributes", id, [{ path: [], value: { k: 1 } }])
		await quiet(a, b)
		assertEquals(b.read("attributes", id), { k: 1 })
		a.table.del("attributes", id)
		await quiet(a, b)
		assertEquals(b.read("attributes", id), undefined)
		await a.device.close(), await b.device.close()
	},
})

Deno.test({
	name:
		"sync: the next commit on the head shown comes in as patches, the entry kept, nothing copied whole",
	...opts,
	async fn() {
		const a = await host(1), b = await host(2)
		const id = a.sync.mint()
		await b.sync.follow(id)
		await connect(a, b)
		const names: Record<string, string> = {}
		for (let i = 0; i < 1000; i++) {
			names["n" + i] = "ermine://" + (i % 256).toString(16).padStart(2, "0").repeat(32)
		}
		// the entry holds names itself, changed in place from here on: what n7 was, kept apart
		const seven = names.n7
		a.write("children", id, [{ path: [], value: names }])
		await quiet(a, b)
		const entry = b.table.get("children", id)!
		const before = entry.value
		a.write("children", id, [{ path: ["renamed"], move: { path: ["n7"] } }])
		await quiet(a, b)
		// the same entry, its value changed in place (places keeps children so), by the one patch
		assertEquals(b.table.get("children", id), entry)
		assertEquals(entry.value, before)
		const now = entry.value as Record<string, string>
		assertEquals(now.renamed, seven)
		assertEquals(now.n7, undefined)
		assertEquals(Object.keys(now).length, 1000)
		await a.device.close(), await b.device.close()
	},
})
