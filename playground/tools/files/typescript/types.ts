// The shapes the store and its layout share (FILES.tex). A hash is BLAKE3 as
// 64 lowercase hex digits in memory, and 32 bytes in a record. Paths are from
// the store's folder, "/"-separated, with no leading "/"; "" is the store's
// folder, and a path starting ".ermine/" is in the manifest's folder.

import type { Value } from "@ermine/encoding/cbor"

export type { Value }

/** A node's id. */
export type Id = string

/** A hash, as 64 lowercase hex digits: bytewise order is string order. */
export type Hash = string

/** Each typed array's kind, and its class; no uint8: a Uint8Array is bytes. */
export const KINDS = {
	int8: Int8Array,
	int16: Int16Array,
	uint16: Uint16Array,
	int32: Int32Array,
	uint32: Uint32Array,
	int64: BigInt64Array,
	uint64: BigUint64Array,
	float32: Float32Array,
	float64: Float64Array,
} as const
export type Kind = keyof typeof KINDS

/** A typed array's kind; undefined for anything else, other views included. */
export function kindOf(value: unknown): Kind | undefined {
	if (!ArrayBuffer.isView(value)) return
	for (const kind in KINDS) if (value.constructor === KINDS[kind as Kind]) return kind as Kind
}

/** How a value is held in its kept file and its node's file: text, bytes, a typed array's kind, or CBOR. */
export type Form = "txt" | "bin" | Kind | "cbor"

/** A kept value: its hash and form. */
export type Kept = [hash: Hash, form: Form]

/** A node's info as shown: each name with its first version's kept value, in the node's order. */
export type Info = readonly (readonly [name: string, hash: Hash, form: Form])[]

/** A slot a node is shown in: its holder, the slot's name, and the node's position there. */
export type Home = [holder: Id, name: string, position: number]

/** A node's layout record, "shown:" + its id (FILES.tex, The manifest). */
export type Layout = {
	/** the slot it is shown in; the root has none */
	home?: Home
	/** its value file's name, in its home's folder, or in .ermine for the root; none when not shown */
	file?: string
	/** the value its file was last laid with */
	laid?: Hash
	/** while a batch is laid out, the value before it */
	was?: Hash
	/** its sides' file names, beside its file, in version order: the second version's first */
	sides?: string[]
	/** its folder is shown */
	folder?: true
	/** each of its slots' stem; for a union, the folder's, then each member's in slot order */
	entries?: Map<string, string | string[]>
	/** paths that could not be laid out */
	left?: string[]
	/** no longer shown; the rest is how it last was */
	away?: true
}

/** What a plan step expects at a place: a file by its hash, a link by its target, a folder by its file id (null: any, for one the step makes), or nothing. */
export type Found =
	| { file: Hash }
	| { link: string }
	| { folder: number | null }
	| null

/** One step of a batch's plan (FILES.tex, Writing). */
export type Step = {
	/** its number in the batch; its entry in .ermine/tmp/ is <time>.<number> */
	number: number
	/** writes a file, makes a link or a folder, renames an entry, removes one, or sets an entry's info */
	what: "file" | "link" | "folder" | "rename" | "remove" | "info"
	/** where a rename or a removal takes the entry from */
	from?: string
	/** where it lays the entry */
	to?: string
	/** what it expects before, at from, or at to when it has no from */
	before: Found
	/** what it expects after, at to, or at from when it has no to */
	after: Found
	/** the id it sets in party.chee.ermine.id */
	id?: Id
	/** a union's folder's holder and slot, which it sets in party.chee.ermine.slot */
	slot?: [holder: Id, name: string]
	/** a file's form, to write it from its kept file */
	form?: Form
	/** the info it sets on a node's file or folder, as party.chee.ermine.info.<name>; the rest it removes */
	info?: Info
	/** for a side's file, which version it is, from 1, which it sets in party.chee.ermine.side */
	side?: number
}

/** What the layout puts at a path. A side is a version after the first, beside its node's file. */
export type Laid =
	| { kind: "file"; id: Id; home?: Home; form: Form; hash: Hash; info: Info }
	| { kind: "side"; id: Id; home?: Home; side: number; form: Form; hash: Hash }
	| { kind: "folder"; id: Id; home?: Home; info: Info }
	| { kind: "union"; holder: Id; name: string }
	| { kind: "link"; id: Id; home: Home; target: string; half: "file" | "folder" | "pending" }

/**
 * What is found at a path. A file is read in the form the layout has for it,
 * or, for one it does not know, the form its name gives; why says why it does
 * not read. No field is ever undefined.
 */
export type Entry =
	| { kind: "file"; id?: Id; ino: number; form: Form; value?: Value; hash?: Hash; why?: string }
	| { kind: "folder"; id?: Id; slot?: [holder: Id, name: string]; ino: number }
	| { kind: "link"; id?: Id; target: string }

/** Where the folder and the layout differ: what the layout has at a path, and what is there now. */
export type Difference = { path: string; was?: Laid; now?: Entry }

/** An entry left out, sent to the Trash, or not taken in, with why. */
export type Listed = { path: string; why: string }

/**
 * A node as the layout needs it: its first value's hash and form (null's when
 * it has no value), a bin value's first bytes, each later version's, its info,
 * and its slots: each child name's first list, only ids, none empty.
 */
export type Node = {
	kept: Kept
	head?: Uint8Array
	sides: readonly (readonly [hash: Hash, form: Form, head?: Uint8Array])[]
	info: Info
	directory: ReadonlyMap<string, readonly Id[]>
}

/** The graph as the store's records give it. An id in a slot with no node is pending. */
export type Graph = { root: Id; nodes: ReadonlyMap<Id, Node> }

/** The "store" record: its format, the time of the last batch laid out, and the names passed over. */
export type State = { format: 1; done: number; pass: string[] }

/** How a store is made. */
export type Options = {
	/** the platform's calls; system() if not given */
	sys?: import("./sys.ts").Sys
	/** sends an entry to the Trash; sys.trash if not given. A test always gives one */
	trash?: import("./sys.ts").Trash
	/** the host runs the files program, so a folder holding others' entries may become a store, and edits found loading are kept for it */
	files?: boolean
	/** names to pass over, each a whole name, * any run; PASS (names.ts) for a new store */
	pass?: readonly string[]
	/** bytes past four times what it holds the manifest may grow before it is folded; 1 MiB */
	slack?: number
	/** told of each entry left out or sent to the Trash */
	list?: (item: Listed) => void
	/** the home folder whose ~/.ermine/external holds outside manifests and the list of stores; the person's HOME if not given. A test always gives one */
	home?: string
	/** places whose folders keep their manifests outside, as a place a service syncs; on the home folder's volume */
	outside?: readonly string[]
	/** the calls into macOS's Foundation; foundation.ts's system if not given */
	foundation?: import("./foundation.ts").Foundation
	/** writes of entries a person sees go through NSFileCoordinator, on macOS; true if not given */
	coordinate?: boolean
}

/** A store that is invalid (FILES.tex, Loading), a folder that cannot become one, or a node that cannot be saved. */
export class StoreError extends Error {
	override name = "StoreError"
}

/** A file that does not read as its form; at is where in it, for diagnostic notation. */
export class FormError extends Error {
	override name = "FormError"
	constructor(message: string, readonly at?: number) {
		super(message)
	}
}
