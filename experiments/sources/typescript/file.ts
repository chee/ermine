// a holder in one file: the file is a CBOR list of named writes (a graph in a file: every node's
// history, in the order this holder took them). in memory it is a log (log.ts), loaded from the
// file when opened and whenever the file changes, and saved whole on every put and drop
//
//   const holder = await openFile(denoFile("graph.cbor"))
//
// another process writing the file (another holder over it, or a person) is heard by its watch:
// what it added is loaded, and those watching this holder are poked. loading only adds: a write
// gone from the file is still held here until dropped. no lock: two processes saving at once, the
// last one wins the file (each reads it again first, so only a write made between is lost)
import { CborError, decode, encode, type Value } from "@ermine/encoding/cbor"
import type { FileAccess } from "./access.ts"
import type { Holder, Outcome } from "./holder.ts"
import { createLog } from "./log.ts"
import type { Write } from "./write.ts"

export const UNWRITABLE = "unwritable"

export type FileHolder = Holder & {
	// the file read again now, what is new in it taken; how many were taken, and how many it held
	// that were not taken (misnamed, missing parents, or no write at all)
	load(): Promise<{ taken: number; bad: number }>
	// what went wrong last reading the file; none: nothing
	readonly trouble: () => string | undefined
	close(): void
}

export async function openFile(file: FileAccess): Promise<FileHolder> {
	const log = createLog()
	const pokes = new Set<() => void>()
	const poke = () => [...pokes].forEach((p) => p())
	let trouble: string | undefined

	// one at a time: a load, a put or a drop, in the order asked
	let queue: Promise<unknown> = Promise.resolve()
	function serial<T>(f: () => Promise<T>): Promise<T> {
		const next = queue.then(f)
		queue = next.catch(() => {})
		return next
	}

	// the file's writes taken into the log, in its order; nothing there or unreadable: none
	async function read(): Promise<{ taken: number; bad: number }> {
		let listed: unknown
		try {
			const bytes = await file.read()
			if (bytes === undefined || bytes.length === 0) return { taken: 0, bad: 0 }
			listed = decode(bytes)
			trouble = undefined
		} catch (e) {
			trouble = e instanceof CborError ? `unreadable: ${e.message}` : String(e)
			return { taken: 0, bad: 0 }
		}
		if (!Array.isArray(listed)) {
			trouble = "unreadable: not a list"
			return { taken: 0, bad: 0 }
		}
		let taken = 0, bad = 0
		for (const w of listed) {
			if (typeof w !== "object" || w === null) {
				bad++
				continue
			}
			const said = log.check(w as Write)
			if (said === undefined) {
				log.add(w as Write)
				taken++
			} else if (said !== "passed") bad++
		}
		return { taken, bad }
	}

	const save = () => file.write(encode(log.all() as unknown as Value))

	const load = () =>
		serial(async () => {
			const got = await read()
			if (got.taken) poke()
			return got
		})

	const put = (writes: readonly Write[]) =>
		serial(async (): Promise<Outcome[]> => {
			// another process's writes first, so saving keeps them
			const loaded = await read()
			const added: Write[] = []
			const out = writes.map((w): Outcome => {
				const said = log.check(w)
				if (said !== undefined) return said
				log.add(w)
				added.push(w)
				return "taken"
			})
			if (added.length === 0) {
				if (loaded.taken) poke()
				return out
			}
			try {
				await save()
			} catch (e) {
				// not on disk: not held
				const gone = new Set(added.map((w) => w.name))
				log.remove((w) => gone.has(w.name))
				if (loaded.taken) poke()
				return out.map((o) => o === "taken" ? { refused: `${UNWRITABLE}: ${e}` } : o)
			}
			poke()
			return out
		})

	const drop = (node: string) =>
		serial(async () => {
			await read()
			if (log.remove((w) => w.node === node)) await save()
		})

	await load()
	const stop = file.watch(() => void load())

	return {
		since: async (cursor, limit) => {
			await queue
			return log.since(cursor, limit)
		},
		get: async (node) => {
			await queue
			return log.get(node)
		},
		put,
		drop,
		watch(p) {
			pokes.add(p)
			return () => void pokes.delete(p)
		},
		load,
		trouble: () => trouble,
		close: stop,
	}
}
