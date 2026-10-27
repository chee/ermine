// two hosts, each its own graph (scheduler, table, places) and its own sync (@ermine/together over
// Subduction), as playground/together/typescript/sync_test.ts makes them; and a cable between
// them: the test's in-memory pipe, wrapped so the page can see each message, hold it a moment,
// and cut it
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Patch } from "@ermine/core/changeable/apply"
import { createPlaces } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createSigner } from "@ermine/together/seal"
import { createSync, type Sync } from "@ermine/together/sync"
import { egwalker } from "@ermine/egwalker"

export type Transport = Parameters<Sync["device"]["connect"]>[0]

// a host: the graph, and sync beside places over its own device. told: each table event
export async function host(n: number, name: string, told: (part: Key, id: Id) => void) {
	const signer = await createSigner(new Uint8Array(32).fill(n))
	const scheduler = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
		told(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({
		table,
		signer,
		// what comes in on the head shown: told to places, as its patches
		commit: (changed) => (places.commit(changed), told("value", "")),
		// known here, so a merge by it is taken; used only when the reader turns it on
		merges: { "eg-walker": egwalker },
	})
	const scope = scheduler.createRootScope({ actor: name })
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
	return { name, device: sync.device, table, places, sync, scheduler, write }
}
export type Host = Awaited<ReturnType<typeof host>>

// a message on the cable: from which end, how many bytes
export type Parcel = { from: 0 | 1; bytes: number }

// the cable: the test's pipe, each message held `delay` ms on the way and told to `seen`. cut:
// nothing more crosses, a receive waiting is told so, what was on the way is dropped
export function cable(seen: (p: Parcel) => void, delay: () => number) {
	type Waiting = { take(b: Uint8Array): void; fail(e: Error): void }
	type End = Transport & { other?: End; queue: Uint8Array[]; waiting: Waiting[] }
	let open = true
	const cut = () => {
		if (!open) return
		open = false
		for (const e of [a, b]) for (const w of e.waiting.splice(0)) w.fail(new Error("unplugged"))
	}
	const deliver = (to: End, bytes: Uint8Array) => {
		if (!open) return
		const w = to.waiting.shift()
		if (w) w.take(bytes)
		else to.queue.push(bytes)
	}
	const make = (side: 0 | 1): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				if (!open) return Promise.reject(new Error("unplugged"))
				const copy = bytes.slice(), o = end.other!
				seen({ from: side, bytes: copy.length })
				const d = delay()
				if (d > 0) setTimeout(() => deliver(o, copy), d)
				else deliver(o, copy)
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				if (b) return Promise.resolve(b)
				if (!open) return Promise.reject(new Error("unplugged"))
				return new Promise((take, fail) => end.waiting.push({ take, fail }))
			},
			disconnect() {
				cut()
				return Promise.resolve()
			},
			onDisconnect() {},
		}
		return end
	}
	const a = make(0), b = make(1)
	a.other = b, b.other = a
	return { ends: [a, b] as [Transport, Transport], cut, open: () => open }
}
