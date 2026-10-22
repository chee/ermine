// EXPERIMENTAL, optional, not part of the plan: packs (playground/encoding/typescript/pack.ts) kept in
// IndexedDB, for a page that wants its table back after a reload. One database, one object store,
// "packs": a record per name, the pack's bytes and when it was saved. Saving a name again replaces
// it whole. Which nodes go in is the caller's, as for pack itself; nothing here walks, loads into
// a table, or keeps anything in step.
import { type Entry, type Options, pack, type Reading, unpack } from "@ermine/formats/pack"

// the little of IndexedDB used, so this checks without the DOM's types
type Req<T> = {
	result: T
	error: unknown
	onsuccess: (() => void) | null
	onerror: (() => void) | null
}
type ObjectStore = {
	put(value: unknown, key: string): unknown
	delete(key: string): unknown
	get(key: string): Req<unknown>
	getAllKeys(): Req<unknown[]>
}
type Tx = {
	objectStore(name: string): ObjectStore
	oncomplete: (() => void) | null
	onerror: (() => void) | null
	onabort: (() => void) | null
	error: unknown
}
type Db = {
	transaction(store: string, mode: "readonly" | "readwrite"): Tx
	objectStoreNames: { contains(name: string): boolean }
	createObjectStore(name: string): unknown
	close(): void
}
export type Factory = { open(name: string, version?: number): unknown }

// a record as kept
export type Saved = { bytes: Uint8Array; time: number }

const STORE = "packs"

export type Store = {
	// the entries packed and kept under name, in place of what was there
	save(name: string, entries: Iterable<Entry>, options?: Options): Promise<void>
	// the entries kept under name; none: nothing kept there
	load(name: string, reading?: Reading): Promise<Entry[] | undefined>
	// the record itself, bytes and time; none: nothing kept there
	saved(name: string): Promise<Saved | undefined>
	// the names kept, in IndexedDB's order
	names(): Promise<string[]>
	remove(name: string): Promise<void>
	close(): Promise<void>
}

// the store in database (default "ermine-packs"); indexedDB: the factory, default the page's
export function createStore(
	database = "ermine-packs",
	{ indexedDB }: { indexedDB?: Factory } = {},
): Store {
	const factory = indexedDB ?? (globalThis as { indexedDB?: Factory }).indexedDB
	const db = new Promise<Db>((resolve, reject) => {
		if (!factory) return reject(new Error("there is no IndexedDB here"))
		const req = factory.open(database, 1) as Req<Db> & { onupgradeneeded: (() => void) | null }
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
	const asked = <T>(req: Req<T>) =>
		new Promise<T>((resolve, reject) => {
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
	async function saved(name: string): Promise<Saved | undefined> {
		const tx = (await db).transaction(STORE, "readonly")
		return (await asked(tx.objectStore(STORE).get(name))) as Saved | undefined
	}
	return {
		async save(name, entries, options) {
			// packed first: a pack that throws keeps nothing
			const record: Saved = { bytes: pack(entries, options), time: Date.now() }
			const tx = (await db).transaction(STORE, "readwrite")
			tx.objectStore(STORE).put(record, name)
			await done(tx)
		},
		async load(name, reading) {
			const record = await saved(name)
			return record && unpack(record.bytes, reading)
		},
		saved,
		async names() {
			const tx = (await db).transaction(STORE, "readonly")
			return (await asked(tx.objectStore(STORE).getAllKeys())) as string[]
		},
		async remove(name) {
			const tx = (await db).transaction(STORE, "readwrite")
			tx.objectStore(STORE).delete(name)
			await done(tx)
		},
		async close() {
			;(await db).close()
		},
	}
}
