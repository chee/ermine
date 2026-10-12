// a Backend (../live/storage.ts) for the browser: one IndexedDB database per device, one object
// store, "records", keyed by the record's key. A write is one transaction: its sets and deletes
// happen together or not at all. (Modelled on layers/subduction/typescript/indexeddb.ts.) The
// host's own keys (the device's seed) go in the same store through `host`, which Storage ignores
import type { Backend } from "../live/storage.ts"

// the little of IndexedDB used, so this checks without the DOM's types
type Req<T> = {
	result: T
	error: unknown
	onsuccess: (() => void) | null
	onerror: (() => void) | null
}
type Store = {
	put(value: unknown, key: string): unknown
	delete(key: string): unknown
	get(key: string): Req<unknown>
	openCursor(): Req<{ key: unknown; value: unknown; continue(): void } | null>
}
type Tx = {
	objectStore(name: string): Store
	oncomplete: (() => void) | null
	onerror: (() => void) | null
	onabort: (() => void) | null
	error: unknown
}
type Db = {
	transaction(store: string, mode: "readonly" | "readwrite"): Tx
	objectStoreNames: { contains(name: string): boolean }
	createObjectStore(name: string): unknown
}
type Factory = { open(name: string, version?: number): unknown }

const STORE = "records"

export function indexeddb(name: string): Backend & {
	host(key: string): Promise<Uint8Array | undefined>
	setHost(key: string, value: Uint8Array): Promise<void>
} {
	const factory = (globalThis as { indexedDB?: Factory }).indexedDB
	const db = new Promise<Db>((resolve, reject) => {
		if (!factory) return reject(new Error("there is no IndexedDB here"))
		const req = factory.open(name, 1) as Req<Db> & { onupgradeneeded: (() => void) | null }
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
	const done = (tx: Tx) =>
		new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
			tx.onabort = () => reject(tx.error ?? new Error("the transaction was aborted"))
		})
	const bytes = (v: unknown) => v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer)
	return {
		async read() {
			const tx = (await db).transaction(STORE, "readonly")
			const out = new Map<string, Uint8Array>()
			const req = tx.objectStore(STORE).openCursor()
			req.onsuccess = () => {
				const c = req.result
				if (!c) return
				out.set(String(c.key), bytes(c.value))
				c.continue()
			}
			await done(tx)
			// the host's keys are not records
			for (const k of [...out.keys()]) if (k.startsWith("host-")) out.delete(k)
			return out
		},
		async write(batch) {
			const tx = (await db).transaction(STORE, "readwrite")
			const store = tx.objectStore(STORE)
			for (const [k, v] of batch) v === null ? store.delete(k) : store.put(v.slice(), k)
			await done(tx)
		},
		async host(key) {
			const tx = (await db).transaction(STORE, "readonly")
			const req = tx.objectStore(STORE).get("host-" + key)
			await done(tx)
			return req.result === undefined ? undefined : bytes(req.result)
		},
		async setHost(key, value) {
			const tx = (await db).transaction(STORE, "readwrite")
			tx.objectStore(STORE).put(value.slice(), "host-" + key)
			await done(tx)
		},
	}
}
