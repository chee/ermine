// a folder of n children placed on one host, then fetched by another: how long each takes.
// deno run -A typescript/fetch_bench.ts [n]
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
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
import { createSync } from "./sync.ts"
import { createDevice } from "./transport.ts"

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

// a host: the graph, a device over storage, and sync beside places
function host(n: number, storage = new sd.MemoryStorage(), zeros = false) {
	const secret = new Uint8Array(32).fill(n), key = ed25519.getPublicKey(secret)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
	const device = createDevice({ signer, storage: storage as unknown as sd.SedimentreeStorage })
	const scheduler = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({
		table,
		device,
		signer,
		zeros,
		commit: (changed) => places.commit(changed),
	})
	const scope = scheduler.createRootScope({ actor: `host${n}` })
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
type Host = ReturnType<typeof host>

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

const n = Number(Deno.args[0] ?? 900)
const a = host(1), b = host(2)
const folder = a.sync.mint()
const written = performance.now()
a.write("children", folder, [{ path: [], value: {} } as Patch])
for (let i = 0; i < n; i++) {
	a.write("children", folder, [{ path: [`e${i}`], value: `id${i}` } as Patch])
}
await quiet(a)
console.log(`${n} children written in ${(performance.now() - written).toFixed(0)}ms`)
await b.sync.follow(folder)
const start = performance.now()
await connect(a, b)
for (;;) {
	await b.sync.idle()
	const v = b.read("children", folder) as Record<string, unknown> | undefined
	if (v && Object.keys(v).length === n) break
	await new Promise((r) => setTimeout(r, 1))
}
console.log(`${n} children fetched in ${(performance.now() - start).toFixed(0)}ms`)
await a.device.close(), await b.device.close()
Deno.exit(0)
