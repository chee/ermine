// a value mirror: one node's value and one file, made the same both ways. it makes no history of
// its own: a hand edit to the file becomes an ordinary write into the graph, made in the scope it
// is given (the one device watching the file: its info says the actor), named by whatever history
// the graph has, like any other write
//
//   const mirror = await openMirror({ scheduler, table, places, scope, node: "NOTE", file, codec: text })
//
// opened: a file there is read into the graph; no file, the graph's value written to it. then:
//   - the value written in the graph: the file written (no value: the file left as it is)
//   - the file changed: read, and when its bytes are not what the mirror last read or wrote,
//     decoded and written into the graph at the root (one patch, the whole value)
// echo: the mirror knows the bytes the file holds as far as it knows (held). its own write to the
// file is heard back by the watch with the same bytes, and nothing is done; its own write into the
// graph is told back by watchAll with a value of the same bytes, and nothing is written
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { createChangeHeader } from "@ermine/places/header"
import type { Places } from "@ermine/places"
import { upsert } from "@ermine/places/upsert"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Table } from "@ermine/table"
import type { FileAccess } from "./access.ts"

// a value as a file's bytes, and back. decode throws: not a value
export type Codec = { encode(value: unknown): Uint8Array; decode(bytes: Uint8Array): unknown }

// a string as UTF-8 text: a file a person edits. a value not a string is written as its JSON
export const text: Codec = {
	encode: (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)),
	decode: (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
}

// any value, as canonical CBOR
export const cbor: Codec = {
	encode: (v) => encode(v as Value),
	decode: (bytes) => decode(bytes),
}

export type MirrorSetup = {
	scheduler: Pick<Scheduler, "runWithScope" | "getCurrentScope" | "getRun">
	table: Pick<Table, "get" | "add">
	places: Pick<Places, "watchAll" | "commit">
	scope: Scope
	node: string
	file: FileAccess
	codec: Codec
}

export type Mirror = {
	// done when nothing is waiting to be read or written
	idle(): Promise<void>
	// what went wrong last; none: nothing
	trouble(): string | undefined
	stop(): void
}

const equal = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i])

export async function openMirror(setup: MirrorSetup): Promise<Mirror> {
	const { scheduler, table, places, scope, node, file, codec } = setup
	let held: Uint8Array | undefined
	let trouble: string | undefined

	// one at a time, in the order asked
	let queue: Promise<void> = Promise.resolve()
	const serial = (f: () => Promise<void>) =>
		queue = queue.then(f).catch((e) => void (trouble = String(e)))

	// the graph's value, as it is when this runs, written to the file
	async function out() {
		const value = table.get("value", node)?.value
		if (value === undefined) return
		const bytes = codec.encode(value)
		if (equal(bytes, held)) return
		await file.write(bytes)
		held = bytes
	}

	// the file's bytes, when new, written into the graph as the mirror's scope
	async function into() {
		const bytes = await file.read()
		if (bytes === undefined || equal(bytes, held)) return
		held = bytes
		let value: unknown
		try {
			value = codec.decode(bytes)
		} catch (e) {
			trouble = `unreadable: ${e}`
			return
		}
		trouble = undefined
		scheduler.runWithScope(scope, () => {
			const header = createChangeHeader(scheduler)
			places.commit(upsert(table, "value", node, [], value, header))
		})
	}

	const first = await file.read()
	await (first === undefined ? out() : into())

	const unwatch = places.watchAll((fact) => {
		if (fact.id === node && fact.part === "value") serial(out)
	})
	const unhear = file.watch(() => serial(into))

	return {
		async idle() {
			let last
			while (last !== queue) await (last = queue)
		},
		trouble: () => trouble,
		stop() {
			unwatch()
			unhear()
		},
	}
}
