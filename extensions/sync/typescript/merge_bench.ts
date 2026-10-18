// two hosts typing into one text at once, merging by eg-walker: the CPU time it takes (the machine
// may be loaded, so wall time misleads), and the part of it merging. deno run -A merge_bench.ts
// [keys per host] [pure: egwalker from scratch every merge, without its walker]
import process from "node:process"
import * as sd from "npm:@automerge/subduction@0.23.0"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
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
import { egwalker } from "./egwalker.ts"
import type { Merge } from "./replay.ts"

const keys = Number(Deno.args[0] ?? 150)
const pure = Deno.args[1] === "pure"
// every merge timed, the walker's too
let merging = 0
const timed = (m: Merge): Merge => (history, heads, get) => {
	const t = process.cpuUsage()
	try {
		return m(history, heads, get)
	} finally {
		const u = process.cpuUsage(t)
		merging += u.user + u.system
	}
}
const rule: Merge = Object.assign(timed(egwalker), {
	keeping: pure ? undefined : () => timed(egwalker.keeping!()),
})

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

async function host(n: number) {
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
		storage: new sd.MemoryStorage() as unknown as sd.SedimentreeStorage,
		commit: (changed) => places.commit(changed),
		merges: { "eg-walker": rule },
		merge: "eg-walker",
	})
	const scope = scheduler.createRootScope({ actor: `host${n}` })
	const write = (part: Key, id: Id, patches: Patch[]) =>
		scheduler.runWithScope(scope, () => {
			const entry = table.get(part, id)
			if (entry === undefined) {
				table.add(
					part,
					id,
					createEntry(patches[0].value as never, createChangeHeader(scheduler)),
				)
				return
			}
			update(entry, patches as never, createChangeHeader(scheduler))
			places.commit([entry])
			sync.wrote([entry])
		})
	const read = (part: Key, id: Id) => table.get(part, id)?.value
	return { device: sync.device, sync, write, read }
}
type Host = Awaited<ReturnType<typeof host>>

async function quiet(...hs: Host[]) {
	for (let i = 0; i < 6; i++) {
		await Promise.all(hs.map((h) => h.sync.idle()))
		await new Promise((r) => setTimeout(r, 5))
	}
}

const a = await host(1), b = await host(2)
const id = a.sync.mint()
await b.sync.follow(id)
const [x, y] = pipe()
await Promise.all([a.device.connect(x, true), b.device.connect(y, false)])
a.write("value", id, [{ path: [], value: "" }])
await quiet(a, b)
let seed = 7
const r = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
const type = (h: Host, c: string) => {
	const at = r([...(h.read("value", id) as string)].length + 1)
	h.write("value", id, [{ path: [], range: [at, at], value: c }])
}
const cpu = process.cpuUsage(), wall = performance.now()
for (let i = 0; i < keys; i++) {
	type(a, "a"), type(b, "b")
	if (r(3) === 0) await new Promise((r) => setTimeout(r, 0))
	if (r(10) === 0) await quiet(a, b)
}
await quiet(a, b)
const used = process.cpuUsage(cpu)
const text = a.read("value", id) as string
if (b.read("value", id) !== text || text.length !== 2 * keys) throw new Error("not converged")
const ms = (us: number) => (us / 1000).toFixed(0)
console.log(
	`2×${keys} keys${pure ? ", pure" : ""}: cpu ${ms(used.user + used.system)} ms, merging ${
		ms(merging)
	} ms, wall ${(performance.now() - wall).toFixed(0)} ms`,
)
await a.device.close(), await b.device.close()
Deno.exit(0)
