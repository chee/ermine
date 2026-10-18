// keeping n changes over a backend whose every write takes 2ms, as IndexedDB's do in a busy app:
// how many writes, and how long, with and without behind. deno run -A live/storage_bench.ts
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type * as sd from "npm:@automerge/subduction@0.23.0"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable } from "@ermine/table"
import { createSync } from "../typescript/sync.ts"
import { createDevice } from "../typescript/transport.ts"
import { id } from "../typescript/id.ts"
import { type Backend, Storage } from "./storage.ts"

const n = Number(Deno.args[0] ?? 300), wait = Number(Deno.args[1] ?? 2)

async function keep(behind: boolean) {
	const kept = new Map<string, Uint8Array>()
	let writes = 0
	const backend: Backend = {
		read: () => Promise.resolve(new Map(kept)),
		async write(batch) {
			writes++
			await new Promise((r) => setTimeout(r, wait))
			for (const [k, v] of batch) v === null ? kept.delete(k) : kept.set(k, v)
		},
	}
	const storage = await Storage.open(backend, { behind })
	const secret = new Uint8Array(32).fill(1), key = ed25519.getPublicKey(secret)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
	const device = createDevice({ signer, storage: storage as unknown as sd.SedimentreeStorage })
	const scheduler = createScheduler()
	const table = createTable((part, i) => {
		places.onTableChange(part, i)
		sync.tableChanged(part, i)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({ table, device, signer, commit: (c) => places.commit(c) })
	const scope = scheduler.createRootScope({ actor: "bench" })
	const doc = id("unlocked", new Uint8Array(32).fill(7))
	const start = performance.now()
	scheduler.runWithScope(scope, () => {
		table.add("value", doc, createEntry(0 as never, createChangeHeader(scheduler)))
		places.commit([table.get("value", doc)!])
		sync.wrote([table.get("value", doc)!])
	})
	for (let i = 1; i < n; i++) {
		scheduler.runWithScope(scope, () => {
			const e = table.get("value", doc)!
			update(e, [{ path: [], value: i }] as never, createChangeHeader(scheduler))
			places.commit([e])
			sync.wrote([e])
		})
	}
	await sync.idle()
	await storage.flush()
	const ms = performance.now() - start
	console.log(
		`${behind ? "behind (default)" : "behind: false  "}  ${n} changes  ${writes} writes  ${
			ms.toFixed(0)
		}ms  ` +
			`${(writes / n).toFixed(2)} writes/change`,
	)
}

await keep(false)
await keep(true)
