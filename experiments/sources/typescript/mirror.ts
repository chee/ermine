// a value mirror: one node's value and one file, made the same both ways. it makes no history of
// its own: a hand edit to the file becomes an ordinary write into the graph, made as the mirror's
// process, under the scope it is given (the one device watching the file: its info says the
// actor), named by whatever history the graph has, like any other write
//
//   const mirror = await openMirror({ scheduler, table, places, processes, scope, node: "NOTE", file, codec: text })
//
// a process (ermine/processes' start) at /system/mirrors/<the file's name> (encoded as one name),
// or the at given: a process is this device's, and the node mirrored may be placed anywhere, many
// times or nowhere, so there is no one place beside it. the path is one per file name, so a second
// mirror of the file here is refused by start ("taken"), nothing made; one at another at, or one
// file under two names (a symlink, a second path), is not seen. its state (status.ts) is its
// computer's value, its node's value; its records FILE, MIRRORS, UNWRITTEN are its attributes
//
// opened: a file there is read into the graph; no file, the graph's value written to it. then:
//   - the value written in the graph: the file written, only if it still holds what the mirror
//     last read or wrote (no value: the file left as it is)
//   - the file changed: read, and when its bytes are not what the mirror last read or wrote,
//     decoded and written into the graph at the root (one patch, the whole value)
// echo: the mirror knows the bytes the file holds as far as it knows (held). its own write to the
// file is heard back by the watch with the same bytes, and nothing is done; its own write into the
// graph is told back by watchAll with a value of the same bytes, and nothing is written
//
// the mirror never writes over bytes it has not seen:
//   - the file changed since it last looked (a save not heard yet): not written; the file read in
//     at once, as a hand edit (the graph's value stays in its history): changed-not-written
//   - a write that throws (cant-write): tried again after retry ms, then twice as long each time,
//     up to a minute, and on every new value; meanwhile a hand edit is read in over the value not
//     written: changed-while-failing
//   - the file gone (deleted, or renamed: the mirror can't follow): gone; nothing written until a
//     file is there again (gone-not-written), which is read in
//   - a file that doesn't decode (not UTF-8, for text): cant-decode; nothing written until it is
//     edited into one that does (cant-decode-not-written), which is read in
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/core/places/upsert"
import type { Process } from "@ermine/processes/start"
import { alike, type FileAccess } from "./access.ts"
import {
	type Code,
	FILE,
	MIRRORS,
	type Refused,
	type Running,
	type Shown,
	startShown,
	UNWRITTEN,
} from "./status.ts"

// a value as a file's bytes, and back. decode throws: not a value. name: what the file is read as
export type Codec = {
	readonly name: string
	encode(value: unknown): Uint8Array
	decode(bytes: Uint8Array): unknown
}

// a string as UTF-8 text: a file a person edits. a value not a string is written as its JSON
export const text: Codec = {
	name: "text",
	encode: (v) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)),
	decode: (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
}

// any value, as canonical CBOR
export const cbor: Codec = {
	name: "CBOR",
	encode: (v) => encode(v as Value),
	decode: (bytes) => decode(bytes),
}

export type MirrorSetup = Running & {
	node: string
	file: FileAccess
	codec: Codec
	// where its process is; none: /system/mirrors/<the file's name>
	at?: readonly string[]
	// ms before a write that threw is tried again (default 1000)
	retry?: number
}

export type Mirror = {
	// its process: its node holds its state and records
	readonly process: Process
	// done when nothing is waiting to be read or written (a write tried again later is not)
	idle(): Promise<void>
	// its process stopped: watching stopped, its node gone
	stop(): void
}

const LONGEST = 60_000
const why = (e: unknown) => e instanceof Error ? e.message : String(e)

export async function openMirror(setup: MirrorSetup): Promise<Mirror | Refused> {
	const { scheduler, table, places, processes, node, file, codec } = setup
	const at = setup.at ?? ["system", "mirrors", encodeURIComponent(file.name)]
	let unwritten = 0
	// the bytes the file holds as far as the mirror knows: what it last read or wrote. none: no file
	let held: Uint8Array | undefined
	// why nothing is written over the file now: it is gone, or holds bytes that don't decode
	let hold: "gone" | "unreadable" | undefined
	let stops: (() => void)[] = []
	let shown!: Shown
	const started = startShown(
		setup,
		at,
		{ [FILE]: file.name, [MIRRORS]: node, [UNWRITTEN]: unwritten },
		(given) => {
			shown = given
			return () => {
				stops.forEach((f) => f())
				stops = []
			}
		},
	)
	if ("refused" in started) return started
	const p = started
	const say = (code: Code, because?: string) => {
		shown.record({ [UNWRITTEN]: unwritten })
		shown.state(code, because)
	}

	// a write that threw, tried again
	const first = setup.retry ?? 1000
	let wait = first
	let timer: ReturnType<typeof setTimeout> | undefined
	function later() {
		if (timer !== undefined) return
		timer = setTimeout(() => {
			timer = undefined
			serial(out)
		}, wait)
		wait = Math.min(wait * 2, LONGEST)
	}
	function owed() {
		const was = timer !== undefined
		clearTimeout(timer)
		timer = undefined
		wait = first
		return was
	}
	stops.push(owed)

	// one at a time, in the order asked
	let queue: Promise<void> = Promise.resolve()
	const serial = (f: () => Promise<void>) =>
		queue = queue.then(f).catch((e) => say("cant-read", why(e)))

	// bytes the file holds now, taken: written into the graph when new and decoded. refused: found
	// when a write was not made
	function take(now: Uint8Array | undefined, refused = false) {
		if (alike(now, held)) return
		const owing = owed()
		held = now
		if (now === undefined) {
			hold = "gone"
			return say("gone")
		}
		let value: unknown
		try {
			value = codec.decode(now)
		} catch (e) {
			hold = "unreadable"
			return say("cant-decode", `as ${codec.name}: ${why(e)}`)
		}
		hold = undefined
		scheduler.runWithScope(p.scope, () => {
			const header = createChangeHeader(scheduler)
			places.commit(upsert(table, "value", node, [], value, header))
		})
		say(refused ? "changed-not-written" : owing ? "changed-while-failing" : "in-step")
	}

	// the graph's value, as it is when this runs, written to the file, if the file still holds what
	// the mirror last read or wrote
	async function out() {
		const value = table.get("value", node)?.value
		if (value === undefined) return
		let bytes: Uint8Array
		try {
			bytes = codec.encode(value)
		} catch (e) {
			return say("cant-encode", `as ${codec.name}: ${why(e)}`)
		}
		if (hold === undefined && alike(bytes, held)) return
		if (hold !== undefined) {
			// came back, or edited into what decodes, unheard: taken now
			const now = await file.read()
			if (!alike(now, held)) return take(now)
			unwritten++
			return say(hold === "gone" ? "gone-not-written" : "cant-decode-not-written")
		}
		let wrote: boolean
		try {
			wrote = await file.write(bytes, { holds: held })
		} catch (e) {
			later()
			return say("cant-write", why(e))
		}
		owed()
		if (wrote) {
			held = bytes
			return say("in-step")
		}
		unwritten++
		take(await file.read(), true)
	}

	const into = async () => take(await file.read())

	try {
		const there = await file.read()
		if (there === undefined) await out()
		else take(there)
	} catch (e) {
		say("cant-read", why(e))
	}
	// nothing to do: no file and no value
	if (shown.now().code === "opening") say("in-step")

	stops.push(places.watchAll((fact) => {
		if (fact.id === node && fact.part === "value") serial(out)
	}))
	stops.push(file.watch(() => serial(into)))

	return {
		process: p,
		async idle() {
			let last
			while (last !== queue) await (last = queue)
		},
		stop: () => processes.stop(p),
	}
}
