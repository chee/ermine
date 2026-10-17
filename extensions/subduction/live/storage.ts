// storage: a device's Subduction storage (SedimentreeStorage) that outlives the device, over a
// backend keeping records by key: read whole when opened, written through. @automerge/subduction
// 0.23.0 ships only MemoryStorage. backends: deno/files.ts, indexeddb.ts (and
// experimental_layers/keep's).
//
//   tree-<tree>                 a sedimentree's id, empty
//   commit-<tree>-<commit id>   CBOR map {signed, blob}: the signed envelope and its blob
//   fragment-<tree>-<head>      a fragment, the same way
//
// other keys are the host's. on start, what storage holds that the device lacks is given to it.
// writes land in order; those made mid-write go as one batch after. behind (default): a save
// resolves at once, flush() resolves once kept (throws what a write threw). behind: false: a save
// resolves once kept. a crash loses saves since the last landed write, so hosts flush when quiet
// and on the way out (pagehide, visibilitychange hidden, a signal).

// deno-lint-ignore no-import-prefix
import * as wasm from "npm:@automerge/subduction@0.23.0"
import { decode, encode } from "@ermine/encoding/cbor"
import { hexOf, unhex } from "./blob.ts"

const {
	CommitId,
	CommitWithBlob,
	FragmentWithBlob,
	SedimentreeId,
	SignedFragment,
	SignedLooseCommit,
} = wasm

/**
 * Where records are kept, by key. A write's sets (bytes) and deletes (null)
 * are kept in order; once it resolves they are kept.
 */
export interface Backend {
	read(): Promise<Map<string, Uint8Array>>
	write(batch: ReadonlyMap<string, Uint8Array | null>): Promise<void>
}

type Id = { toBytes(): Uint8Array }
type Signed = { encode(): Uint8Array }

const TREE = "tree-"
const COMMIT = "commit-"
const FRAGMENT = "fragment-"

/** A commit's or fragment's record: its signed envelope and its blob. */
function pack(signed: Signed, blob: Uint8Array): Uint8Array {
	return encode({ signed: signed.encode(), blob })
}

function unpack(bytes: Uint8Array): { signed: Uint8Array; blob: Uint8Array } {
	const r = decode(bytes) as { signed?: unknown; blob?: unknown }
	if (!(r?.signed instanceof Uint8Array) || !(r.blob instanceof Uint8Array)) {
		throw new Error("a stored record is not {signed, blob}")
	}
	return { signed: r.signed, blob: r.blob }
}

/** Subduction's storage over a backend: open it with Storage.open. */
export class Storage {
	#backend: Backend
	#records: Map<string, Uint8Array>
	// the records' keys by their prefix: up to and with the last "-"
	#prefixes = new Map<string, Set<string>>()
	#behind: boolean
	// the last batch begun: once it is kept, every earlier one is
	#writing: Promise<void> = Promise.resolve()
	// the batch not begun yet, which writes join
	#next: Map<string, Uint8Array | null> | undefined
	// what writes threw, with behind, for flush
	#failed: unknown[] = []

	private constructor(
		backend: Backend,
		records: Map<string, Uint8Array>,
		behind: boolean,
	) {
		this.#backend = backend
		this.#records = records
		this.#behind = behind
		for (const k of records.keys()) this.#prefixed(k).add(k)
	}

	/** Reads what the backend keeps. behind (default true): saves resolve before they are kept. */
	static async open(backend: Backend, options: { behind?: boolean } = {}): Promise<Storage> {
		return new Storage(backend, await backend.read(), options.behind ?? true)
	}

	/** Resolves once every write begun is kept; with behind, throws what one threw. */
	async flush(): Promise<void> {
		await this.#writing.catch(() => {})
		if (this.#failed.length) throw this.#failed.shift()
	}

	#prefixed(k: string): Set<string> {
		const prefix = k.slice(0, k.lastIndexOf("-") + 1)
		let keys = this.#prefixes.get(prefix)
		if (!keys) this.#prefixes.set(prefix, keys = new Set())
		return keys
	}

	/** Sets and deletes records here at once, and in the backend after every earlier write. */
	#write(batch: Map<string, Uint8Array | null>): Promise<void> {
		for (const [k, v] of batch) {
			if (v === null) this.#records.delete(k), this.#prefixed(k).delete(k)
			else this.#records.set(k, v), this.#prefixed(k).add(k)
		}
		if (!this.#next) {
			const next = this.#next = new Map()
			this.#writing = this.#writing.catch(() => {}).then(() => {
				this.#next = undefined
				if (next.size) return this.#backend.write(next)
			})
			if (this.#behind) this.#writing.catch((e) => void this.#failed.push(e))
		}
		for (const [k, v] of batch) this.#next.set(k, v)
		return this.#behind ? Promise.resolve() : this.#writing
	}

	// prefix: a word and "-", and a tree and "-" or not
	#keys(prefix: string): string[] {
		return [...this.#prefixes.get(prefix) ?? []]
	}

	#deleteAll(prefix: string): Promise<void> {
		return this.#write(new Map(this.#keys(prefix).map((k) => [k, null])))
	}

	// ---------------------------------------------------------------- sedimentree ids

	// one already here is not written again: its write is an earlier one
	saveSedimentreeId(tree: Id): Promise<void> {
		const k = TREE + hexOf(tree.toBytes())
		return this.#write(new Map(this.#records.has(k) ? [] : [[k, new Uint8Array(0)]]))
	}

	deleteSedimentreeId(tree: Id): Promise<void> {
		return this.#write(new Map([[TREE + hexOf(tree.toBytes()), null]]))
	}

	loadAllSedimentreeIds(): Promise<wasm.SedimentreeId[]> {
		return Promise.resolve(
			this.#keys(TREE).map((k) => SedimentreeId.fromBytes(unhex(k.slice(TREE.length)))),
		)
	}

	containsSedimentreeId(tree: Id): Promise<boolean> {
		return Promise.resolve(this.#records.has(TREE + hexOf(tree.toBytes())))
	}

	// ---------------------------------------------------------------- commits

	saveCommit(tree: Id, id: Id, signed: Signed, blob: Uint8Array): Promise<void> {
		const k = `${COMMIT}${hexOf(tree.toBytes())}-${hexOf(id.toBytes())}`
		return this.#write(new Map([[k, pack(signed, blob)]]))
	}

	#commit(k: string): wasm.CommitWithBlob {
		const { signed, blob } = unpack(this.#records.get(k)!)
		return new CommitWithBlob(SignedLooseCommit.tryDecode(signed), blob)
	}

	loadCommit(tree: Id, id: Id): Promise<wasm.CommitWithBlob | null> {
		const k = `${COMMIT}${hexOf(tree.toBytes())}-${hexOf(id.toBytes())}`
		return Promise.resolve(this.#records.has(k) ? this.#commit(k) : null)
	}

	listCommitIds(tree: Id): Promise<wasm.CommitId[]> {
		const prefix = `${COMMIT}${hexOf(tree.toBytes())}-`
		return Promise.resolve(
			this.#keys(prefix).map((k) => CommitId.fromBytes(unhex(k.slice(prefix.length)))),
		)
	}

	loadAllCommits(tree: Id): Promise<wasm.CommitWithBlob[]> {
		return Promise.resolve(
			this.#keys(`${COMMIT}${hexOf(tree.toBytes())}-`).map((k) => this.#commit(k)),
		)
	}

	deleteCommit(tree: Id, id: Id): Promise<void> {
		const k = `${COMMIT}${hexOf(tree.toBytes())}-${hexOf(id.toBytes())}`
		return this.#write(new Map([[k, null]]))
	}

	deleteAllCommits(tree: Id): Promise<void> {
		return this.#deleteAll(`${COMMIT}${hexOf(tree.toBytes())}-`)
	}

	// ---------------------------------------------------------------- fragments

	saveFragment(tree: Id, head: Id, signed: Signed, blob: Uint8Array): Promise<void> {
		const k = `${FRAGMENT}${hexOf(tree.toBytes())}-${hexOf(head.toBytes())}`
		return this.#write(new Map([[k, pack(signed, blob)]]))
	}

	#fragment(k: string): wasm.FragmentWithBlob {
		const { signed, blob } = unpack(this.#records.get(k)!)
		return new FragmentWithBlob(SignedFragment.tryDecode(signed), blob)
	}

	loadFragment(tree: Id, head: Id): Promise<wasm.FragmentWithBlob | null> {
		const k = `${FRAGMENT}${hexOf(tree.toBytes())}-${hexOf(head.toBytes())}`
		return Promise.resolve(this.#records.has(k) ? this.#fragment(k) : null)
	}

	listFragmentIds(tree: Id): Promise<wasm.CommitId[]> {
		const prefix = `${FRAGMENT}${hexOf(tree.toBytes())}-`
		return Promise.resolve(
			this.#keys(prefix).map((k) => CommitId.fromBytes(unhex(k.slice(prefix.length)))),
		)
	}

	loadAllFragments(tree: Id): Promise<wasm.FragmentWithBlob[]> {
		return Promise.resolve(
			this.#keys(`${FRAGMENT}${hexOf(tree.toBytes())}-`).map((k) => this.#fragment(k)),
		)
	}

	deleteFragment(tree: Id, head: Id): Promise<void> {
		const k = `${FRAGMENT}${hexOf(tree.toBytes())}-${hexOf(head.toBytes())}`
		return this.#write(new Map([[k, null]]))
	}

	deleteAllFragments(tree: Id): Promise<void> {
		return this.#deleteAll(`${FRAGMENT}${hexOf(tree.toBytes())}-`)
	}

	// ---------------------------------------------------------------- both at once

	async saveBatchAll(
		tree: Id,
		commits: { commitId: Id; signedCommit: Signed; blob: Uint8Array }[],
		fragments: { fragmentHead: Id; signedFragment: Signed; blob: Uint8Array }[],
	): Promise<number> {
		const t = hexOf(tree.toBytes())
		const batch = new Map<string, Uint8Array | null>()
		for (const c of commits) {
			batch.set(`${COMMIT}${t}-${hexOf(c.commitId.toBytes())}`, pack(c.signedCommit, c.blob))
		}
		for (const f of fragments) {
			batch.set(
				`${FRAGMENT}${t}-${hexOf(f.fragmentHead.toBytes())}`,
				pack(f.signedFragment, f.blob),
			)
		}
		if (!this.#records.has(TREE + t)) batch.set(TREE + t, new Uint8Array(0))
		await this.#write(batch)
		return commits.length + fragments.length
	}
}
