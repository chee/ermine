// a store: a folder holding one graph, as a host saves it. the manifest is exact; the folder
// around it shows the graph and takes edits
//
// write({root, get, time}): every node reachable from root (any version of any list, as pack.ts
//   walks it), less ephemeral; the batch is the records that differ, and meta, in three steps:
//   kept (a frame: it, the changed layout records, the plan); laid out; done (a frame: store, the
//   layout records less was, plan null). rejects if not kept, or if the layout failed not by the
//   file system, as a crash. what cannot be laid out: told to options.list, recorded in left.
//   a node no longer reached keeps its record, unshown
// read(): the frames; each value from its kept file; an unfinished plan carried out again; tmp/
//   cleared of what no plan names; records that do not fit dropped and laid out again. gives new
//   node objects for the host to introduce; differences found then kept in missed (with no files
//   program, laid out again, each edit to the Trash)
// shown: a node's first value version is its file, later ones sides (its stem, one more .FINAL
//   each); info's first versions are xattrs party.chee.ermine.info.<name> where they fit; a child
//   name's first list is the slot
// steps judged the same laying out and loading: a file by its value's hash in its form, a link by
//   target, a folder by file id (or a step's id or slot attribute). what a swap or rename leaves:
//   the store's removed with tmp/, a person's edit to a file put back, else the Trash. tmp/ never
//   keeps what is not the store's

import { decode, encode } from "@ermine/encoding/cbor"
import type { Node as Saved } from "./saved.ts"
import { disk, lay, type Laying, type Probe, prune } from "./layout.ts"
import * as manifest from "./manifest.ts"
import { type Manifest, META, NODE, PLAN, SHOWN, STORE } from "./manifest.ts"
import * as names from "./names.ts"
import { byCodePoint } from "./names.ts"
import * as ext from "./external.ts"
import { system as foundation, WRITING } from "./foundation.ts"
import { attr, type Sys, system } from "./sys.ts"
import {
	type Difference,
	type Entry,
	type Form,
	FormError,
	type Found,
	type Graph,
	type Hash,
	type Id,
	type Info,
	type Kept,
	type Laid,
	type Layout,
	type Node,
	type Options,
	type State,
	type Step,
	StoreError,
	type Value,
} from "./types.ts"

/** What a host saves: the graph from its root, as its table gives each node, at the last time given. */
export type Saving = {
	root: Id
	/** a node by its id, or none if it is not loaded; table.ts's get */
	get: (id: Id) => Saved<unknown, unknown> | undefined
	time: number
	/** an ephemeral node: never saved, and left out of every list */
	ephemeral?: (id: Id) => boolean
	/** the host's own records, saved in the same frame; null removes one */
	records?: ReadonlyMap<string, Uint8Array | null>
}

/**
 * What loading gives: the root, the last time given, the nodes reachable from
 * the root, in the order walked, and every other node the store keeps, new
 * objects, none introduced; missing, ids in a list with no record.
 */
export type Restored = {
	root: Id
	time: number
	nodes: Saved<unknown, unknown>[]
	others: Saved<unknown, unknown>[]
	missing: Id[]
}

/** A store, and what it shares with the files program. */
export type Store = {
	/** the folder, absolute, as the system has it */
	readonly folder: string
	readonly sys: Sys
	readonly manifest: Manifest
	/** the layout, which the files program sets as the disk now is when it takes an edit in */
	readonly layout: Map<Id, Layout>
	/** the names passed over, as the store record keeps them */
	readonly pass: readonly string[]
	/** the differences loading found: edits made while nothing watched */
	readonly missed: readonly Difference[]
	/**
	 * Loads the store, or makes it: undefined for a new one, whose graph the
	 * host makes. Read again, it gives the graph as last written.
	 */
	read(): Promise<Restored | undefined>
	/** Saves the graph: a batch of what changed since the last write, laid out. */
	write(saving: Saving): Promise<void>
	/** The graph as the last batch, or loading, left it. */
	graph(): Graph
	/** The host's records: every one but meta, the nodes', the layout's, store and plan. */
	others(): ReadonlyMap<string, Uint8Array>
	/**
	 * Compares the folders touched, every folder if none are given, and the
	 * root's file, with the layout. A file whose size, time and file id are as
	 * the store laid it is not read; one that reads as its laid is no
	 * difference. A folder that is not the one laid there is listed, not
	 * walked into. Takes no lock.
	 */
	differences(touched?: readonly string[]): Promise<Difference[]>
	/** Runs fn while no batch is written; a batch waits for it, and it for a batch. */
	lock<T>(fn: () => Promise<T> | T): Promise<T>
	/**
	 * Lays the paths out again as the graph has them, every path that differs
	 * if none are given, sending what is there to the Trash unless it is what
	 * the layout has. Takes no lock; a caller outside a pass takes it.
	 */
	mend(paths?: readonly string[]): Promise<void>
	/** Sends an entry to the Trash and lists it, with why. */
	trash(path: string, why: string): Promise<void>
}

/** What became of a step: laid; a person's file left in its place; its place emptied by a person; not laid. */
type Result = "done" | "kept" | "gone" | "left"

/** A file as the store laid it: its size, time and file id, and the value it holds. */
type Stat = { size: number; mtime: number; ino: number; hash: Hash }

const TMP = ".ermine/tmp"
const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true })

const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`)
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const depth = (path: string) => (path === "" ? 0 : path.split("/").length)

/** Whether an error is the file system's, which a step lists, rather than one that stops the batch. */
function fault(e: unknown): boolean {
	if (!(e instanceof Error)) return false
	if (typeof (e as { code?: unknown }).code === "string") return true
	return Object.values(Deno.errors).some((kind) => e instanceof kind)
}

/** Text from an attribute, or undefined if it is not UTF-8. */
function textOf(bytes: Uint8Array): string | undefined {
	try {
		return strict.decode(bytes)
	} catch {
		return undefined
	}
}

/** Whether two records hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * The nodes reachable from root, by any version of any list, as pack.ts
 * walks them, less the ephemeral; and the ids reached with no node.
 */
function reach(s: Saving): { nodes: Saved<unknown, unknown>[]; missing: Id[] } {
	const skip = s.ephemeral ?? (() => false)
	const first = s.get(s.root)
	if (first === undefined) throw new StoreError(`the root ${s.root} is not loaded`)
	const nodes = [first], missing: Id[] = []
	const seen = new Set([s.root])
	for (let i = 0; i < nodes.length; i++) {
		for (const versions of nodes[i].children.values()) {
			for (const v of versions) {
				for (const id of v.content) {
					if (typeof id !== "string" || seen.has(id) || skip(id)) continue
					seen.add(id)
					const n = s.get(id)
					if (n === undefined) missing.push(id)
					else nodes.push(n)
				}
			}
		}
	}
	return { nodes, missing }
}

/** A store, or a mirror: one engine, which a mirror runs with no saved graph and no kept values. */
function build(folder: string, options: Options, mirror: boolean) {
	const sys = options.sys ?? system()
	const bin = options.trash ?? sys.trash
	const slack = options.slack === undefined ? {} : { slack: options.slack }
	// the manifest's folder, in the store's folder until loading finds where it is (FILES.tex, The manifest)
	let ermine = `${folder}/.ermine`
	let man = manifest.manifest(ermine, sys, slack)
	let loc: ext.Located | undefined
	const files = !!options.files
	const where: ext.Where = {
		...(options.home === undefined ? {} : { home: options.home }),
		...(options.outside === undefined ? {} : { places: options.outside }),
		...(options.foundation === undefined ? {} : { foundation: options.foundation }),
	}
	const native = options.foundation ?? foundation
	const coordinating = options.coordinate ?? true
	/**
	 * A path from the store's folder, as the system has it: .ermine is the manifest's folder,
	 * wherever it is. One that could reach out of the folder (absolute, or ".." in it) is refused.
	 */
	const abs = (path: string) => {
		if (!names.isPath(path)) {
			throw new StoreError(`${JSON.stringify(path)} is not a path in the store's folder`)
		}
		return path === ""
			? folder
			: path === ".ermine"
			? ermine
			: path.startsWith(".ermine/")
			? ermine + path.slice(7)
			: `${folder}/${path}`
	}
	/**
	 * A path to write at, as abs has it, with no link on the way: a folder made a link (by a person,
	 * or a plan) is not followed out of the store's folder. One is NotADirectory, which a step lists.
	 */
	const into = (path: string) => {
		const steps = path.split("/")
		for (let i = 1; i < steps.length; i++) {
			const p = steps.slice(0, i).join("/")
			if (p === ".ermine") continue
			let link = false
			try {
				link = Deno.lstatSync(abs(p)).isSymlink
			} catch {
				// nothing there: the write says so
			}
			if (link) throw new Deno.errors.NotADirectory(`a link on the way to ${path}: ${p}`)
		}
		return abs(path)
	}

	// writes of entries a person sees go through NSFileCoordinator; those in tmp, id and values are
	// no one's. fn is made at once, as foundation.ts says, so a sys call's effect is made inside
	const seen = (p: string) => !/^\.ermine\/(tmp|id|values)(\/|$)/.test(p)
	function guard<T>(path: string, how: number, fn: () => T): T {
		if (!coordinating || !seen(path)) return fn()
		return native.coordinate(abs(path), true, fn, how)
	}
	const swap = (a: string, b: string) =>
		guard(b, WRITING.replacing, () => sys.swap(into(a), into(b)))
	const move = (a: string, b: string) =>
		guard(a, WRITING.moving, () => guard(b, WRITING.merging, () => sys.rename(into(a), into(b))))

	// the manifest's records, each node's shape, the graph they give, the layout
	let records = new Map<string, Uint8Array>()
	let nodes = new Map<Id, Node>()
	let root = ""
	let time = 0
	const layout = new Map<Id, Layout>()
	let state: State = { format: 1, done: 0, pass: [...(options.pass ?? names.PASS)] }
	let missed: Difference[] = []
	// a bin value's first bytes, by its hash; each file as the store laid it
	const heads = new Map<Hash, Uint8Array>()
	const stats = new Map<string, Stat>()
	// each link as the store last laid it, by path, its target: the files program's changes to the
	// layout move where a link should lead before the store lays it again, and what the store laid
	// is still its own
	const pointed = new Map<string, string>()
	// each content's kept, from the last write, so a value is hashed once
	let hashes = new Map<unknown, Kept>()
	// a mirror's values, by hash, from the graph the host last gave
	let held = new Map<Hash, Value>()
	let opened: Promise<Restored | undefined> | undefined
	let marked = false
	let chain: Promise<unknown> = Promise.resolve()

	const graph = (): Graph => ({ root, nodes })
	const list = (path: string, why: string) => options.list?.({ path, why })

	function lock<T>(fn: () => Promise<T> | T): Promise<T> {
		const run = chain.then(() => fn())
		chain = run.catch(() => {})
		return run
	}

	/** A kept value; a mirror's is the graph's, which the host gave. */
	async function valueOf(hash: Hash, form: Form): Promise<Value> {
		if (!mirror) return await man.get(hash, form)
		if (hash === manifest.NULL) return null
		const v = held.get(hash)
		if (v === undefined) {
			throw new Deno.errors.NotFound(`the graph the host gave has no value ${hash}`)
		}
		return v
	}

	/** A node's shape from its record. */
	const shapeOf = (record: Uint8Array | manifest.Fields) =>
		manifest.shape(record, (h) => heads.get(h))

	function apply(frame: ReadonlyMap<string, Uint8Array | null>) {
		for (const [k, v] of frame) v === null ? records.delete(k) : records.set(k, v)
	}

	const probe: Probe = (f) => {
		try {
			return [...Deno.readDirSync(abs(f))].map((e) => e.name)
		} catch {
			return []
		}
	}
	const ino = (path: string) => {
		try {
			return Deno.lstatSync(abs(path)).ino
		} catch {
			return null
		}
	}

	// looking at entries ---------------------------------------------------------

	async function stat(path: string): Promise<Deno.FileInfo | undefined> {
		try {
			return await Deno.lstat(abs(path))
		} catch (e) {
			if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory) return
			throw e
		}
	}

	async function empty(path: string): Promise<boolean> {
		for await (const _ of Deno.readDir(abs(path))) return false
		return true
	}

	/** The hash of the value a file holds, read in its form; undefined if it does not read. */
	async function hashOf(path: string, form: Form): Promise<Hash | undefined> {
		try {
			return manifest.hash(manifest.parse(await Deno.readFile(abs(path)), form))
		} catch (e) {
			if (e instanceof FormError || fault(e)) return undefined
			throw e
		}
	}

	/** Whether an entry carries the id or the slot a step sets. */
	async function carries(path: string, s: Step): Promise<boolean> {
		if (s.slot) {
			const b = await sys.get(abs(path), attr.slot)
			if (!b) return false
			try {
				const v = decode(b)
				return Array.isArray(v) && v[0] === s.slot[0] && v[1] === s.slot[1]
			} catch {
				return false
			}
		}
		if (s.id === undefined) return false
		const b = await sys.get(abs(path), attr.id)
		return !!b && textOf(b) === s.id
	}

	/** Whether a link, now at out, is the one the store last laid at path, leading where it last pointed. */
	async function laidLink(out: string, path: string, st: Deno.FileInfo): Promise<boolean> {
		const to = pointed.get(path)
		return to !== undefined && st.isSymlink && (await Deno.readLink(abs(out))) === to
	}

	/** Whether an entry the layout does not put at a path is still the store's own: a link it laid there. */
	const own = (path: string) => {
		const to = pointed.get(path)
		if (to === undefined) return false
		try {
			return Deno.readLinkSync(abs(path)) === to
		} catch {
			return false
		}
	}

	/** The links a layout lays, as the store laid them: on loading, the folder is taken to be as it says. */
	function point(want: ReadonlyMap<string, Laid>) {
		pointed.clear()
		for (const [p, l] of want) if (l.kind === "link") pointed.set(p, l.target)
	}

	/** Whether what is at a path is what a step expects there: nothing, a file's value, a link's target, a folder. */
	async function fits(path: string, st: Deno.FileInfo | undefined, f: Found, s: Step) {
		if (f === null) return !st
		if (!st) return false
		if ("file" in f) return st.isFile && (await hashOf(path, s.form ?? "bin")) === f.file
		if ("link" in f) return st.isSymlink && (await Deno.readLink(abs(path))) === f.link
		if (!st.isDirectory) return false
		return f.folder !== null ? st.ino === f.folder : await carries(path, s)
	}

	// writing entries ------------------------------------------------------------

	async function mark(path: string, id: Id) {
		try {
			await sys.set(into(path), attr.id, utf8.encode(id))
		} catch (e) {
			// Linux allows no attribute on a link
			if (!(e instanceof Deno.errors.NotSupported)) throw e
		}
	}

	/** Sets a node's info on an entry, as party.chee.ermine.info.<name>, and removes what it no longer has; one that does not fit is listed at shown. */
	async function inform(path: string, info: Info, shown = path) {
		let had: string[]
		try {
			had = await sys.names(abs(path))
		} catch (e) {
			if (e instanceof Deno.errors.NotSupported) return
			throw e
		}
		const now = new Set(info.map(([name]) => attr.info + name))
		for (const n of had) {
			if (n.startsWith(attr.info) && !now.has(n)) await sys.unset(into(path), n)
		}
		for (const [name, h, f] of info) {
			try {
				const v = await valueOf(h, f)
				await sys.set(into(path), attr.info + name, manifest.render(v, f))
			} catch (e) {
				if (!fault(e)) throw e
				list(
					shown,
					`the info ${JSON.stringify(name)} does not fit an extended attribute: ${
						(e as Error).message
					}`,
				)
			}
		}
	}

	/** Copies the extended attributes that are not ermine's, as Finder's tags, from the entry a new one replaces. */
	async function carry(from: string, to: string) {
		try {
			for (const n of await sys.names(abs(from))) {
				if (n.startsWith(attr.own)) continue
				const v = await sys.get(abs(from), n)
				if (v) await sys.set(into(to), n, v)
			}
		} catch (e) {
			if (!fault(e)) throw e
		}
	}

	/** A value's file: a clone of its kept file, or, for cbor, its diagnostic notation, or, for a mirror, written from the graph's value; null, which a node with no value shows, is kept nowhere. A new file, never through one there (a link is not followed). */
	async function render(path: string, hash: Hash, form: Form) {
		const make = { createNew: true }
		if (hash === manifest.NULL) {
			await Deno.writeFile(into(path), manifest.render(null, "cbor"), make)
		} else if (form === "cbor" || mirror) {
			await Deno.writeFile(into(path), manifest.render(await valueOf(hash, form), form), make)
		} else await sys.clone(`${ermine}/values/${hash}`, into(path))
	}

	/**
	 * Sends an entry to the Trash, listed under the path it was shown at; from
	 * there, so Put Back returns it there, unless that place is taken.
	 */
	async function toss(path: string, shown: string, why: string) {
		let from = path
		if (path !== shown) {
			try {
				if ((await move(path, shown)) === "done") from = shown
			} catch (e) {
				if (!fault(e)) throw e
			}
		}
		await bin(into(from))
		list(shown, why)
	}

	/** Empties a place in tmp: the store's own is removed, a folder holding more goes to the Trash. */
	async function clear(path: string, shown: string) {
		const st = await stat(path)
		if (!st) return
		if (st.isDirectory && !(await empty(path))) {
			await toss(path, shown, "left in the store's tmp holding entries")
		} else await Deno.remove(into(path))
	}

	/** Keeps a file's size, time and id as the store laid it, so a pass need not read it. */
	async function note(path: string, hash: Hash) {
		const st = await stat(path)
		if (!st?.isFile || st.ino === null) return stats.delete(path)
		stats.set(path, { size: st.size, mtime: st.mtime?.getTime() ?? 0, ino: st.ino, hash })
	}

	// carrying out a plan --------------------------------------------------------

	const place = (t: number, s: Step) => `${TMP}/${t}.${s.number}`

	/** Carries a step out, as laying out does: what it expects before is taken to be there. */
	async function run(s: Step, t: number): Promise<Result> {
		const tp = place(t, s)
		switch (s.what) {
			case "file":
			case "link": {
				await clear(tp, s.to!)
				const after = s.after as { file: Hash } | { link: string }
				if ("file" in after) await render(tp, after.file, s.form!)
				else await Deno.symlink(after.link, into(tp))
				if (s.id !== undefined) await mark(tp, s.id)
				if (s.side !== undefined) {
					await sys.set(into(tp), attr.side, utf8.encode(String(s.side)))
				}
				if (s.info) await inform(tp, s.info, s.to!)
				if ("file" in after) {
					if (s.before !== null) await carry(s.to!, tp)
					await sys.sync(abs(tp))
				}
				return s.before === null ? await settle(s, tp) : await exchange(s, tp)
			}
			case "folder": {
				await clear(tp, s.to!)
				await Deno.mkdir(into(tp))
				if (s.id !== undefined) await mark(tp, s.id)
				if (s.slot) await sys.set(into(tp), attr.slot, encode([s.slot[0], s.slot[1]]))
				if (s.info) await inform(tp, s.info, s.to!)
				return await settle(s, tp)
			}
			case "info": {
				const st = await stat(s.to!)
				if (!st) return "gone"
				if (!(await fits(s.to!, st, s.before, s))) return "kept"
				await inform(s.to!, s.info ?? [])
				return "done"
			}
			case "rename": {
				let r: "done" | "taken"
				try {
					r = await move(s.from!, s.to!)
				} catch (e) {
					// a person moved it away: the files program takes that in
					if (e instanceof Deno.errors.NotFound && !(await stat(s.from!))) return "gone"
					throw e
				}
				if (r === "done") {
					// a file that became another node's, as an edit that met a change does, takes its id
					const into = !s.to!.startsWith(`${TMP}/`)
					if (into && s.id !== undefined && !(await carries(s.to!, s))) await mark(s.to!, s.id)
					if (s.before && "file" in s.before) await note(s.to!, s.before.file)
					return "done"
				}
				const there = await fits(s.to!, await stat(s.to!), s.after, s)
				await wait(s, tp)
				if (there) return "done"
				list(s.to!, "another entry is where the store lays one")
				return "left"
			}
			case "remove": {
				await clear(tp, s.from!)
				try {
					await move(s.from!, tp)
				} catch (e) {
					if (e instanceof Deno.errors.NotFound) return "done"
					throw e
				}
				return await judge(s, tp, s.from!)
			}
		}
	}

	/** An entry a rename could not place waits in tmp; there it goes to the Trash if it is not all the store's. */
	async function wait(s: Step, tp: string) {
		let at = s.from!
		if (!at.startsWith(`${TMP}/`)) {
			await clear(tp, at)
			if ((await move(at, tp)) === "done") at = tp
		}
		const st = await stat(at)
		if (!st) return
		const ours = st.isDirectory ? await empty(at) : await fits(at, st, s.before, s)
		if (!ours) await toss(at, s.from!, "an entry the store could not lay out held others' work")
	}

	/** Renames a new entry into a place that should be empty; if something is there, ours waits in tmp. */
	async function settle(s: Step, tp: string): Promise<Result> {
		if ((await move(tp, s.to!)) === "done") {
			if (s.after && "file" in s.after) await note(s.to!, s.after.file)
			return "done"
		}
		if (await fits(s.to!, await stat(s.to!), s.after, s)) return "done"
		list(s.to!, "another entry is where the store lays one")
		return "left"
	}

	/** Swaps a new entry in over the one there, then looks at what came out. */
	async function exchange(s: Step, tp: string): Promise<Result> {
		try {
			await swap(tp, s.to!)
		} catch (e) {
			// a person removed it: the store lays nothing there, for the files program to take in
			if (e instanceof Deno.errors.NotFound && !(await stat(s.to!))) return "gone"
			throw e
		}
		const r = await judge(s, tp, s.to!)
		if (r === "done" && s.after && "file" in s.after) await note(s.to!, s.after.file)
		return r
	}

	/**
	 * Looks at what came out of a swap or a rename away, now at out, from back:
	 * the store's stays for tmp to be cleared, or a folder holding more goes to
	 * the Trash; what is already what the store lays is swapped back; a
	 * person's file is put back; anything else goes to the Trash.
	 */
	async function judge(s: Step, out: string, back: string): Promise<Result> {
		const st = await stat(out)
		if (!st) return "done"
		if ((await fits(out, st, s.before, s)) || (await laidLink(out, back, st))) {
			if (st.isDirectory && !(await empty(out))) {
				await toss(out, back, "a folder the store removed held others' entries")
			}
			return "done"
		}
		if (s.what !== "remove" && (await fits(out, st, s.after, s))) {
			await swap(out, back)
			return "done"
		}
		if (st.isFile && s.before !== null && !("folder" in s.before)) {
			// a person's edit, or a file an editor saved through a link: for the files program
			if (s.what !== "remove") await swap(out, back)
			else if ((await move(out, back)) === "taken") {
				await toss(out, back, "an edit whose place was taken")
			}
			return "kept"
		}
		await toss(out, back, "not what the store laid")
		return "done"
	}

	/**
	 * Carries a step out again, as loading does: judged by what is found before
	 * and after. then is a later step that writes the entry a rename moves,
	 * whose after found there means the rename was done.
	 */
	async function redo(s: Step, t: number, then?: Step): Promise<Result> {
		const tp = place(t, s)
		switch (s.what) {
			case "remove": {
				if (await stat(tp)) return await judge(s, tp, s.from!)
				const st = await stat(s.from!)
				if (st && (await fits(s.from!, st, s.before, s))) return await run(s, t)
				return "done"
			}
			case "rename": {
				const there = await stat(s.to!)
				if (await fits(s.to!, there, s.after, s)) return "done"
				if (then && (await fits(s.to!, there, then.after, then))) return "done"
				const st = await stat(s.from!)
				if (st && (await fits(s.from!, st, s.before, s))) return await run(s, t)
				if (s.to !== tp) {
					const w = await stat(tp)
					if (w && (await fits(tp, w, s.before, s))) return await settle(s, tp)
					if (w) await wait({ ...s, from: tp }, tp)
				}
				if (s.to!.startsWith(`${TMP}/`)) return "done"
				list(s.to!, "what the store was moving here is not where it was")
				return "left"
			}
			case "file":
			case "link": {
				const st = await stat(s.to!)
				const w = await stat(tp)
				const stray = async () =>
					!!w && !(await fits(tp, w, s.before, s)) && !(await fits(tp, w, s.after, s))
				if (await fits(s.to!, st, s.after, s)) {
					// what came out of a swap and was never looked at
					if (s.before !== null && (await stray())) return await judge(s, tp, s.to!)
					if (s.info) await inform(s.to!, s.info)
					return "done"
				}
				if (await fits(s.to!, st, s.before, s)) return await run(s, t)
				if (await stray()) await toss(tp, s.to!, "not what the store laid")
				if (!st) return "gone"
				if (st.isFile && s.before !== null) return "kept"
				list(s.to!, "another entry is where the store lays one")
				return "left"
			}
			case "folder": {
				const st = await stat(s.to!)
				if (await fits(s.to!, st, s.after, s)) {
					if (s.info) await inform(s.to!, s.info)
					return "done"
				}
				if (!st) return await run(s, t)
				list(s.to!, "another entry is where the store lays one")
				return "left"
			}
			case "info":
				return await run(s, t)
		}
	}

	/** Keeps where a step done leaves the store's links: a link laid, or one removed or laid over. */
	function pointing(s: Step) {
		if (s.what === "link" && s.after && "link" in s.after) pointed.set(s.to!, s.after.link)
		else if (s.what === "remove" || s.what === "rename") pointed.delete(s.from!)
		if (s.what !== "link" && s.what !== "info" && s.to !== undefined) pointed.delete(s.to)
	}

	/** Clears tmp: every entry, or a batch's, <time>.<number>. */
	async function sweep(t?: number) {
		let all: Deno.DirEntry[]
		try {
			all = await Array.fromAsync(Deno.readDir(`${ermine}/tmp`))
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) return
			throw e
		}
		for (const e of all) {
			const m = /^(.*)\.([0-9]+)$/.exec(e.name)
			if (t === undefined || m?.[1] === String(t)) {
				await clear(`${TMP}/${e.name}`, `${TMP}/${e.name}`)
			}
		}
	}

	/**
	 * Lays a batch out and then writes it done: each file left as a person
	 * had it keeps was as its laid, each entry not laid is in its holder's
	 * left, and tmp is cleared of the batch's.
	 */
	async function finish(plan: readonly Step[], t: number, again: boolean) {
		const results = new Map<number, Result>()
		const folders = new Set<string>()
		// the last step writing each entry, for a rename before it carried out again
		const writes = new Map<string, Step>()
		for (const s of plan) if (s.what === "file" || s.what === "link") writes.set(s.to!, s)
		for (const s of plan) {
			let r: Result
			try {
				const then = s.what === "rename" ? writes.get(s.to!) : undefined
				r = again
					? await redo(s, t, then && then.number > s.number ? then : undefined)
					: await run(s, t)
			} catch (e) {
				if (!fault(e)) throw e
				list(s.to ?? s.from!, (e as Error).message)
				r = "left"
			}
			results.set(s.number, r)
			if (r === "done") pointing(s)
			for (const p of [s.from, s.to]) if (p !== undefined) folders.add(parent(p))
		}
		for (const f of [...folders].sort(byCodePoint)) {
			try {
				await sys.sync(abs(f))
			} catch (e) {
				if (!fault(e)) throw e
			}
		}
		const want = disk(graph(), layout, state.pass)
		const changed = new Set<Id>()
		for (const s of plan) {
			const r = results.get(s.number)!
			if (r === "done" || s.what === "info") continue
			if (s.what === "file" && s.id !== undefined && s.side === undefined) {
				const rec = layout.get(s.id)
				if (rec?.was !== undefined) {
					rec.laid = rec.was
					changed.add(s.id)
				}
				stats.delete(s.to!)
			}
			if (r !== "left" || s.what === "remove" || !s.to || s.to.startsWith(`${TMP}/`)) continue
			const l = want.get(s.to)
			const owner = !l ? undefined : l.kind === "union" ? l.holder : l.home?.[0] ?? root
			const rec = owner === undefined ? undefined : layout.get(owner)
			if (rec && !rec.left?.includes(s.to)) {
				rec.left = [...(rec.left ?? []), s.to]
				changed.add(owner!)
			}
		}
		for (const [id, rec] of layout) {
			if (rec.was === undefined) continue
			delete rec.was
			changed.add(id)
		}
		state = { ...state, done: t }
		if (mirror) time = t
		const frame = new Map<string, Uint8Array | null>([[STORE, manifest.state.encode(state)]])
		for (const id of changed) frame.set(SHOWN + id, manifest.shown.encode(layout.get(id)!))
		if (records.has(PLAN)) frame.set(PLAN, null)
		await man.append(frame)
		apply(frame)
		await sweep(t)
		if (man.grown()) await man.fold(records)
	}

	// writing a batch ------------------------------------------------------------

	/** The layout records a batch changes, with those the files program set since the last, which lay sees as the old layout. */
	function relaid(laying: Laying): Map<Id, Layout> {
		const changed = new Map(laying.changed)
		for (const [id, rec] of laying.layout) {
			if (changed.has(id)) continue
			const had = records.get(SHOWN + id)
			if (!had || !same(had, manifest.shown.encode(rec))) changed.set(id, rec)
		}
		return changed
	}

	/** Sets the root's id in the folder, once, unless it is there. */
	async function marking() {
		if (marked) return
		const id = await sys.get(folder, attr.id)
		if (!id || textOf(id) !== root) await mark("", root)
		marked = true
	}

	async function batch(given: Saving) {
		const { nodes: reached } = reach(given)
		const skip = given.ephemeral ?? (() => false)
		// kept: each value, then one frame with the batch, the layout it changes and the plan
		const frame = new Map<string, Uint8Array | null>()
		const after = new Map(nodes)
		const next = new Map<unknown, Kept>()
		const kept = (content: unknown): Kept | undefined => {
			let k = hashes.get(content)
			if (!k) {
				k = manifest.keptOf(content)
				if (!k) return
			}
			next.set(content, k)
			return k
		}
		for (const n of reached) {
			const s = manifest.save(n, skip, kept)
			const had = records.get(NODE + n.id)
			if (had && same(had, s.record)) continue
			for (const [h, v] of s.values) {
				await man.put(v, h)
				if (v instanceof Uint8Array) heads.set(h, v.slice(0, names.HEAD))
			}
			frame.set(NODE + n.id, s.record)
			after.set(n.id, s.shape)
		}
		for (const [k, v] of given.records ?? []) {
			if (k === META || k === STORE || k === PLAN || k.startsWith(NODE) || k.startsWith(SHOWN)) {
				throw new StoreError(`a host's record ${JSON.stringify(k)} is the store's own`)
			}
			frame.set(k, v)
		}
		const r = given.root, t = given.time
		if (r !== root || t !== time) frame.set(META, manifest.meta.encode({ root: r, time: t }))
		if (!frame.size) {
			hashes = next
			return
		}
		const before: Graph = { root: r, nodes }
		const laying = lay({ root: r, nodes: after }, layout, probe, t, state.pass, {
			before,
			ino,
			own,
		})
		for (const [id, rec] of relaid(laying)) frame.set(SHOWN + id, manifest.shown.encode(rec))
		const steps = laying.plan
		const done: State = { ...state, done: t }
		if (steps.length) frame.set(PLAN, manifest.plan.encode(steps))
		else frame.set(STORE, manifest.state.encode(done))
		await man.append(frame)
		// the batch is kept
		apply(frame)
		hashes = next
		nodes = after
		root = r
		time = t
		layout.clear()
		for (const [id, rec] of laying.layout) layout.set(id, rec)
		await marking()
		if (!steps.length) {
			state = done
			if (man.grown()) await man.fold(records)
			return
		}
		await finish(steps, t, false)
	}

	/**
	 * A mirror's batch (FILES.tex, A folder that is not a store): the graph is
	 * the host's, so the frame holds only the layout records and the plan, and
	 * its time is the one after the last done. Each value is read from the graph.
	 */
	async function mirrored(given: Saving) {
		if (given.records?.size) throw new StoreError("a mirror keeps no records of the host's")
		const g = snapshot(given)
		const r = given.root
		const t = time + 1
		const before: Graph = { root, nodes }
		const laying = lay({ root: r, nodes: g.after }, layout, probe, t, state.pass, {
			before,
			ino,
			own,
		})
		const frame = new Map<string, Uint8Array | null>()
		for (const [id, rec] of relaid(laying)) frame.set(SHOWN + id, manifest.shown.encode(rec))
		const steps = laying.plan
		held = g.known
		hashes = g.next
		if (!frame.size && !steps.length) {
			nodes = g.after
			root = r
			return
		}
		if (steps.length) frame.set(PLAN, manifest.plan.encode(steps))
		else frame.set(STORE, manifest.state.encode({ ...state, done: t }))
		await man.append(frame)
		// the batch is kept
		apply(frame)
		nodes = g.after
		root = r
		layout.clear()
		for (const [id, rec] of laying.layout) layout.set(id, rec)
		await marking()
		if (!steps.length) {
			state = { ...state, done: t }
			time = t
			if (man.grown()) await man.fold(records)
			return
		}
		await finish(steps, t, false)
	}

	// loading --------------------------------------------------------------------

	/** A folder with no manifest: a new store, if it holds nothing a host could lose. */
	async function fresh(): Promise<undefined> {
		let found: string[] = []
		try {
			found = (await Array.fromAsync(Deno.readDir(folder))).map((e) => e.name)
		} catch (e) {
			if (!(e instanceof Deno.errors.NotFound)) throw e
		}
		const others = found.filter((n) => n !== ".ermine" && !names.passes(n, state.pass))
		if (others.length && !files) {
			throw new StoreError(
				`${folder} holds ${others.length} entries and no store: only a host running the files program takes them in`,
			)
		}
		await Deno.mkdir(folder, { recursive: true })
		// a copy's manifest is another store's: it goes to the Trash, and the copy is a store of its own
		if (loc?.copy && (await stat(".ermine"))) {
			await bin(`${folder}/.ermine`)
			list(".ermine", "the manifest of the store this folder is a copy of")
		}
		await man.make(!mirror)
		if (loc?.set || !(await sys.get(folder, attr.store))) {
			await sys.set(folder, attr.store, utf8.encode(loc?.uuid ?? crypto.randomUUID()))
		}
		missed = others.length ? await differences() : []
		return undefined
	}

	/** The graph the records keep, each value read from its kept file; StoreError if it is not one. */
	async function restored(
		all: ReadonlyMap<string, Uint8Array>,
		opened = new Map<string, manifest.Fields>(),
	): Promise<Restored> {
		const m = all.get(META)
		if (!m) throw new StoreError("the store holds nodes and no meta")
		const { root: r, time: t } = manifest.meta.decode(m)
		const values = new Map<Hash, Value>()
		const byId = new Map<Id, Saved<unknown, unknown>>()
		for (const [k, v] of all) {
			if (!k.startsWith(NODE)) continue
			const r = manifest.opened(v)
			opened.set(k, r)
			for (const [h, f] of manifest.kepts(r)) {
				if (!values.has(h)) values.set(h, await man.get(h, f))
			}
			const n = manifest.restore(r, (h) => values.get(h)!)
			if (n.id !== k.slice(NODE.length)) throw new StoreError(`the record ${k} holds ${n.id}`)
			const late = (time?: number) => time !== undefined && time > t
			const changes = [
				...n.value,
				...[...n.attributes.values()].flat(),
				...[...n.children.values()].flat(),
			]
			if (
				late(n.change.time) || changes.some((c) => late((c.change as { time?: number })?.time))
			) {
				throw new StoreError(`the node ${n.id} holds a change later than meta's time`)
			}
			byId.set(n.id, n)
		}
		if (!byId.has(r)) throw new StoreError(`the store has no root: ${r}`)
		for (const [h, v] of values) {
			if (v instanceof Uint8Array) heads.set(h, v.slice(0, names.HEAD))
		}
		const { nodes: reached, missing } = reach({ root: r, get: (id) => byId.get(id), time: t })
		const shown = new Set(reached.map((n) => n.id))
		const others = [...byId.values()].filter((n) => !shown.has(n.id))
		return { root: r, time: t, nodes: reached, others, missing }
	}

	/** The graph a mirror's host gives: each node's shape, and each value by its hash. */
	function snapshot(given: Saving) {
		const { nodes: reached } = reach(given)
		const skip = given.ephemeral ?? (() => false)
		const after = new Map<Id, Node>()
		const next = new Map<unknown, Kept>()
		const known = new Map<Hash, Value>()
		const kept = (content: unknown): Kept | undefined => {
			let k = hashes.get(content)
			if (!k) {
				k = manifest.keptOf(content)
				if (!k) return
			}
			next.set(content, k)
			return k
		}
		for (const n of reached) {
			const s = manifest.save(n, skip, kept)
			after.set(n.id, s.shape)
			for (const [h, v] of s.values) known.set(h, v)
		}
		return { after, next, known }
	}

	/** Finds the manifest, and loads; the store is then in the list of the host's stores. */
	async function open(given?: Saving): Promise<Restored | undefined> {
		loc = await ext.locate(folder, sys, where)
		ermine = loc.dir
		man = manifest.manifest(ermine, sys, slack)
		const out = await load(given)
		if (loc.uuid !== undefined) {
			try {
				await ext.note(loc.uuid, folder, where)
			} catch (e) {
				// a list that cannot be written is no reason for a store not to load
				if (!fault(e)) throw e
			}
		}
		return out
	}

	async function load(given?: Saving): Promise<Restored | undefined> {
		if (loc?.copy || !(await man.exists())) return await fresh()
		if (loc?.set) await sys.set(folder, attr.store, utf8.encode(loc.uuid))
		if (mirror) return await loadMirror(given!)
		// the store is checked before anything changes
		const all = await man.read()
		const s = all.get(STORE)
		const p = all.get(PLAN)
		const plan = p ? manifest.plan.decode(p) : undefined
		const shown = new Map<Id, Layout>()
		for (const [k, v] of all) {
			if (k.startsWith(SHOWN)) shown.set(k.slice(SHOWN.length), manifest.shown.decode(v))
		}
		if (s) state = manifest.state.decode(s)
		const hasNodes = [...all.keys()].some((k) => k.startsWith(NODE))
		const opened = new Map<string, manifest.Fields>()
		const out = hasNodes || all.has(META) ? await restored(all, opened) : undefined
		if (out) ({ root, time } = out)
		records = all
		for (const [id, r] of shown) layout.set(id, r)
		nodes = new Map()
		for (const [k, v] of all) {
			if (k.startsWith(NODE)) nodes.set(k.slice(NODE.length), shapeOf(opened.get(k) ?? v))
		}
		// the last batch, if it was not laid out; then what no plan names in tmp
		if (plan || state.done < time) await finish(plan ?? [], time, true)
		await sweep()
		if (root) point(disk(graph(), layout, state.pass))
		if (root) await refit()
		missed = await differences()
		if (!files && missed.length) {
			await mend(missed.map((d) => d.path))
			missed = []
		}
		return out
	}

	/**
	 * Loads a mirror: the layout records, and the graph the host gives to carry
	 * out again the last batch's plan if it was not done, its time the one after
	 * done, as it had no meta.
	 */
	async function loadMirror(given: Saving): Promise<undefined> {
		const all = await man.read()
		const s = all.get(STORE)
		const p = all.get(PLAN)
		if (s) state = manifest.state.decode(s)
		records = all
		for (const [k, v] of all) {
			if (k.startsWith(SHOWN)) layout.set(k.slice(SHOWN.length), manifest.shown.decode(v))
		}
		const g = snapshot(given)
		nodes = g.after
		held = g.known
		hashes = g.next
		root = given.root
		time = state.done
		if (p) await finish(manifest.plan.decode(p), state.done + 1, true)
		await sweep()
		point(disk(graph(), layout, state.pass))
		await refit()
		missed = await differences()
		if (!files && missed.length) {
			await mend(missed.map((d) => d.path))
			missed = []
		}
		return undefined
	}

	/** Drops the layout records that do not fit the graph, lays it out again, and sends to the Trash what they laid. */
	async function refit() {
		const g = graph()
		const tick = mirror ? time + 1 : time
		const fit = prune(g, layout)
		const dropped = [...layout.keys()].filter((id) => !fit.has(id))
		const was = dropped.length ? disk(g, layout, state.pass) : undefined
		const laying = lay(g, fit, probe, tick, state.pass, { before: g, ino })
		if (!dropped.length && !laying.changed.size && !laying.plan.length) return
		const frame = new Map<string, Uint8Array | null>()
		for (const id of dropped) frame.set(SHOWN + id, null)
		for (const [id, r] of laying.changed) frame.set(SHOWN + id, manifest.shown.encode(r))
		if (laying.plan.length) frame.set(PLAN, manifest.plan.encode(laying.plan))
		await man.append(frame)
		apply(frame)
		layout.clear()
		for (const [id, r] of laying.layout) layout.set(id, r)
		await finish(laying.plan, tick, false)
		if (!was) return
		const now = disk(g, layout, state.pass)
		const old = [...was.keys()].filter((p) => !now.has(p)).sort((a, b) => depth(a) - depth(b))
		for (const p of old) {
			if (await stat(p)) {
				await toss(p, p, "laid out by a layout record that did not fit the graph")
			}
		}
	}

	// comparing ------------------------------------------------------------------

	/** What is at a path, read in the form the layout has for it, or its name gives. */
	async function inspect(
		path: string,
		was: Laid | undefined,
		g: Graph,
	): Promise<{ entry: Entry; st: Deno.FileInfo } | undefined> {
		const st = await stat(path)
		if (!st) return
		const a = abs(path)
		const raw = await sys.get(a, attr.id)
		const id = raw ? textOf(raw) : undefined
		const ided = id === undefined ? {} : { id }
		const ino = st.ino ?? 0
		if (st.isSymlink) {
			return { st, entry: { kind: "link", ...ided, target: await Deno.readLink(a) } }
		}
		if (st.isDirectory) {
			let slot: [Id, string] | undefined
			const b = await sys.get(a, attr.slot)
			try {
				const v = b ? decode(b) : undefined
				if (
					Array.isArray(v) && v.length === 2 && typeof v[0] === "string" &&
					typeof v[1] === "string"
				) {
					slot = [v[0], v[1]]
				}
			} catch {
				// not a slot
			}
			return { st, entry: { kind: "folder", ...ided, ...(slot ? { slot } : {}), ino } }
		}
		// a pipe, a socket or a device is no one's value
		if (!st.isFile) return
		const form: Form | undefined = was?.kind === "file" || was?.kind === "side"
			? was.form
			: was?.kind === "link" && was.half === "file"
			? g.nodes.get(was.id)?.kept[1]
			: names.take(base(path)).form
		if (was?.kind === "file" || was?.kind === "side") {
			const c = stats.get(path)
			if (
				c && c.hash === was.hash && c.size === st.size && c.ino === ino &&
				c.mtime === (st.mtime?.getTime() ?? 0)
			) return { st, entry: { kind: "file", ...ided, ino, form: was.form, hash: was.hash } }
		}
		const bytes = await Deno.readFile(a)
		const f = form ?? "txt"
		try {
			const value = manifest.parse(bytes, f)
			return {
				st,
				entry: { kind: "file", ...ided, ino, form: f, value, hash: manifest.hash(value) },
			}
		} catch (e) {
			if (!(e instanceof FormError)) throw e
			if (f === "txt") {
				const value = bytes
				return {
					st,
					entry: {
						kind: "file",
						...ided,
						ino,
						form: "bin",
						value,
						hash: manifest.hash(value),
					},
				}
			}
			return { st, entry: { kind: "file", ...ided, ino, form: f, why: e.message } }
		}
	}

	/** Whether what is found is what the layout has there; a missing id or slot does not count. */
	function alike(was: Laid, now: Entry): boolean {
		if (now.id !== undefined && (was.kind === "union" || now.id !== was.id)) return false
		switch (was.kind) {
			case "file":
			case "side":
				return now.kind === "file" && now.hash === was.hash
			case "folder":
				return now.kind === "folder"
			case "union":
				return now.kind === "folder" &&
					(!now.slot || (now.slot[0] === was.holder && now.slot[1] === was.name))
			case "link":
				return now.kind === "link" && now.target === was.target
		}
	}

	/** An entry found as laid: its id or slot set again if an app dropped it, its stat kept. */
	async function settled(path: string, was: Laid, now: Entry, st: Deno.FileInfo) {
		if (was.kind === "union") {
			if (now.kind === "folder" && !now.slot) {
				await sys.set(into(path), attr.slot, encode([was.holder, was.name]))
			}
		} else if (now.id === undefined) await mark(path, was.id)
		if ((was.kind === "file" || was.kind === "side") && st.ino !== null) {
			stats.set(path, {
				size: st.size,
				mtime: st.mtime?.getTime() ?? 0,
				ino: st.ino,
				hash: was.hash,
			})
		}
	}

	async function differences(touched?: readonly string[]): Promise<Difference[]> {
		const g = graph()
		const want = disk(g, layout, state.pass)
		const left = new Set<string>()
		for (const r of layout.values()) for (const p of r.left ?? []) left.add(p)
		const kids = new Map<string, Map<string, Laid>>()
		for (const [p, l] of want) {
			if (p.startsWith(".ermine/")) continue
			let m = kids.get(parent(p))
			if (!m) kids.set(parent(p), m = new Map())
			m.set(base(p), l)
		}
		const out: Difference[] = []
		const seen = new Set<string>()
		const found = (path: string, was: Laid | undefined, now: Entry | undefined) =>
			out.push({ path, ...(was ? { was } : {}), ...(now ? { now } : {}) })
		const compare = async (f: string, deep: boolean): Promise<void> => {
			if (seen.has(f)) return
			seen.add(f)
			// nothing in .ermine is an edit, but the root's file, compared below
			if (f === ".ermine" || f.startsWith(".ermine/")) return
			if (f !== "" && !(await stat(f))?.isDirectory) return
			let here: string[]
			try {
				here = (await Array.fromAsync(Deno.readDir(abs(f)))).map((e) => e.name).sort(
					byCodePoint,
				)
			} catch (e) {
				if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.NotADirectory) return
				throw e
			}
			const expect = kids.get(f) ?? new Map<string, Laid>()
			for (const name of here) {
				const p = join(f, name)
				if ((f === "" && name === ".ermine") || names.passes(name, state.pass) || left.has(p)) {
					continue
				}
				const was = expect.get(name)
				const it = await inspect(p, was, g)
				if (it === undefined) continue
				if (was && alike(was, it.entry)) {
					await settled(p, was, it.entry, it.st)
					if (deep && it.entry.kind === "folder") await compare(p, true)
					continue
				}
				found(p, was, it.entry)
			}
			const on = new Set(here)
			for (const [name, was] of expect) {
				if (!on.has(name) && !left.has(join(f, name))) found(join(f, name), was, undefined)
			}
		}
		if (touched) { for (const f of touched) await compare(f, false) }
		else await compare("", true)
		// the root's file and its sides, in .ermine
		let inside: string[] = []
		try {
			inside = (await Array.fromAsync(Deno.readDir(ermine))).map((e) => e.name)
				.filter((n) => n.startsWith("root."))
		} catch (e) {
			if (!(e instanceof Deno.errors.NotFound)) throw e
		}
		for (const name of inside) {
			const p = `.ermine/${name}`
			const was = want.get(p)
			const it = await inspect(p, was, g)
			if (it === undefined) continue
			if (was && alike(was, it.entry)) await settled(p, was, it.entry, it.st)
			else found(p, was, it.entry)
		}
		for (const [p, was] of want) {
			if (p.startsWith(".ermine/") && !inside.includes(base(p))) found(p, was, undefined)
		}
		return out
	}

	// mending --------------------------------------------------------------------

	async function mend(paths?: readonly string[]) {
		const g = graph()
		const want = disk(g, layout, state.pass)
		const todo = paths ? [...paths] : (await differences()).map((d) => d.path)
		const changed = new Set<Id>()
		let n = 0
		const fix = async (p: string): Promise<void> => {
			let w = want.get(p)
			// a file is laid with the graph's value, whatever its laid says
			if (w?.kind === "file") {
				const x = g.nodes.get(w.id)
				if (x) w = { ...w, hash: x.kept[0], form: x.kept[1] }
			}
			const it = await inspect(p, w, g)
			if (it !== undefined && w && alike(w, it.entry)) {
				await settled(p, w, it.entry, it.st)
				return
			}
			// the store's own link, leading where it last pointed, is removed; anything else is trashed
			if (it !== undefined && own(p)) await Deno.remove(into(p))
			else if (it !== undefined) {
				await toss(p, p, w ? "not what the store laid" : "not in the graph")
			}
			if (!w) return
			const tp = `${TMP}/mend.${++n}`
			await clear(tp, p)
			if (w.kind === "file" || w.kind === "side") {
				await render(tp, w.hash, w.form)
				await mark(tp, w.id)
				if (w.kind === "side") await sys.set(into(tp), attr.side, utf8.encode(String(w.side)))
				else await inform(tp, w.info, p)
				await sys.sync(abs(tp))
			} else if (w.kind === "link") {
				await Deno.symlink(w.target, into(tp))
				await mark(tp, w.id)
			} else {
				await Deno.mkdir(into(tp))
				if (w.kind === "folder") {
					await mark(tp, w.id)
					await inform(tp, w.info, p)
				} else await sys.set(into(tp), attr.slot, encode([w.holder, w.name]))
			}
			if ((await move(tp, p)) === "taken") {
				await clear(tp, p)
				list(p, "another entry is where the store lays one")
				return
			}
			await sys.sync(abs(parent(p)))
			if (w.kind === "link") pointed.set(p, w.target)
			else pointed.delete(p)
			if (w.kind === "file" || w.kind === "side") {
				await note(p, w.hash)
				const rec = layout.get(w.id)
				if (w.kind === "file" && rec && rec.laid !== w.hash) {
					rec.laid = w.hash
					changed.add(w.id)
				}
			} else if (w.kind !== "link") {
				for (const q of [...want.keys()].sort(byCodePoint)) if (parent(q) === p) await fix(q)
			}
		}
		for (const p of todo.sort((a, b) => depth(a) - depth(b) || byCodePoint(a, b))) await fix(p)
		if (!changed.size) return
		const frame = new Map<string, Uint8Array | null>()
		for (const id of changed) frame.set(SHOWN + id, manifest.shown.encode(layout.get(id)!))
		await man.append(frame)
		apply(frame)
	}

	// what a store gives ---------------------------------------------------------------

	return {
		folder,
		sys,
		manifest: man,
		layout,
		get pass() {
			return state.pass
		},
		get missed() {
			return missed
		},
		graph,
		differences,
		lock,
		mend,
		trash: (path: string, why: string) => toss(path, path, why),
		others(): ReadonlyMap<string, Uint8Array> {
			const out = new Map<string, Uint8Array>()
			for (const [k, v] of records) {
				const own = k === META || k === STORE || k === PLAN || k.startsWith(NODE) ||
					k.startsWith(SHOWN)
				if (!own) out.set(k, v)
			}
			return out
		},
		async read(given?: Saving): Promise<Restored | undefined> {
			if (mirror) {
				if (!given) throw new StoreError("a mirror is read with the graph the host gives")
				await (opened ??= lock(() => open(given)))
				return
			}
			if (!opened) return await (opened = lock(() => open()))
			await opened
			return await lock(async () => (root ? await restored(records) : undefined))
		},
		async write(saving: Saving): Promise<void> {
			await (opened ??= lock(() => open(saving)))
			await lock(() => mirror ? mirrored(saving) : batch(saving))
		},
	}
}

/** The store in folder, made if the folder has none: empty, or, for a host running the files program, holding others' entries. */
export function store(folder: string, options: Options = {}): Store {
	return build(folder, options, false) as unknown as Store
}

/**
 * A folder that is not a store (FILES.tex, A folder that is not a store): a
 * host that keeps its graph elsewhere has a node's subtree laid out in the
 * folder. Its manifest holds only the layout records and store, no saved graph
 * and no kept values; the values are read from the graph the host gives, and
 * each frame has a time of its own counting up. read takes the graph, to carry
 * out again a batch that was not done; write takes it with each batch.
 */
export type Mirror = Omit<Store, "read"> & {
	read(given: Saving): Promise<void>
}

/** The mirror in folder, made if the folder has none, as store is, with the given node as its root. */
export function mirror(folder: string, options: Options = {}): Mirror {
	return build(folder, options, true) as unknown as Mirror
}

export { find, stores } from "./external.ts"
export type { Stored } from "./external.ts"
