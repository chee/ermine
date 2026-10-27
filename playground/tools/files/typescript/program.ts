// the files program: takes the edits people and tools make in a store's folder in as changes on
// graph.ts's graph
//
//   files({store, watch, graph})   starts the watcher, and an ephemeral node, listed, of what it
//                                  could not take in. a second for one store throws. stops with
//                                  its scope or stop()
//
// edit: each difference a pass found (watch.ts) made into its own changes, so one refused does not
// stop the others; cause: the path. nodes acted on by id, never by a walk of names
// edit sets the layout as the disk now is, so the next batch lays out only what is left. it
// returns at once, answering what the watcher must do on disk: ids to set, entries to remove, to
// trash, to lay again
// a move across folders: the one place it renames on disk itself (the other half brought beside)

import type { Patch } from "@ermine/core/changeable/apply"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Api, Graph } from "./graph.ts"
import { dir, disk } from "./layout.ts"
import * as manifest from "./manifest.ts"
import * as names from "./names.ts"
import type { Store } from "./store.ts"
import type { Difference, Entry, Hash, Id, Laid, Layout, Listed, Value } from "./types.ts"

/** A difference, and for a new folder the differences of what is in it, all the way down. */
export type Edit = Difference & { inside?: Edit[] }

/** What each change of an edit carries as its cause: the path that made it, from the store's folder, and a move's from. */
export type Cause = { file: string; from?: string }

/** What edit answers: what the watcher does on disk once the changes are made. */
export type Done = {
	/** entries taken in as a node's: the id set in party.chee.ermine.id */
	marks: [path: string, id: Id][]
	/** unions' folders renamed: the holder and slot set in party.chee.ermine.slot */
	slots: [path: string, holder: Id, slot: string][]
	/** copies of a side, taken in as new nodes: party.chee.ermine.side removed */
	unside: string[]
	/** entries removed, so the store lays its own in their place: a person's link, a file saved through a link, an alias */
	clear: string[]
	/** entries sent to the Trash, with why */
	trash: Listed[]
	/** paths laid out again as the graph has them, after the rest */
	mend: string[]
	/** everything not taken in or sent to the Trash, with why */
	listed: Listed[]
}

/** What the program starts and stops: the host's watcher on the store's folder. */
export type Watch = {
	/** edit takes the differences a pass found in, as the actor; what it answers is done on disk after */
	start(at: { edit: (differences: Edit[], actor?: unknown) => Done }): void
	stop(): void
}

/** The files program: what a host holds while it runs. */
export type Files = {
	/** the scope it runs in: tear it down and the watcher stops */
	readonly scope: Scope
	/** the node its refusals and everything it could not take in are listed on, as a list */
	readonly listed: Id
	/** takes differences in as changes by the actor, as the watcher does */
	edit(differences: readonly Edit[], actor?: unknown): Done
	/** stops the watcher and lets the store go: another program may then watch it */
	stop(): void
}

// each store watched, and the program watching it
const watched = new Map<Store, Files>()

/**
 * Starts the files program for a store: it takes the watcher's passes in as
 * changes. A store has one: a second's start throws, naming the store already
 * watched. Its scope is made under the scheduler's; tearing it down stops it.
 * What core had as a process node with handlers (a program placed in the
 * graph, edit and listed beneath it) is left out: edit is a function here, and
 * listed an ephemeral node of the graph.
 */
export function files(
	o: { store: Store; watch: Watch; graph: Graph; scheduler?: Scheduler },
): Files {
	const { store, watch, graph } = o
	const scheduler = o.scheduler ?? graph.scheduler
	if (watched.has(store)) {
		throw new Error(`the store ${store.folder} is already watched`)
	}
	const scope = scheduler.createRootScope({ program: "files" })
	const listed = graph.api().create([], { ephemeral: true })
	let stopped = false
	const program: Files = {
		scope,
		listed,
		edit: (differences, actor) => edit(store, graph.api(actor), listed, differences),
		stop() {
			if (stopped) return
			stopped = true
			watch.stop()
			if (watched.get(store) === program) watched.delete(store)
			scheduler.teardown(scope)
		},
	}
	watched.set(store, program)
	scheduler.registerTeardown(scope, () => program.stop())
	watch.start({ edit: program.edit })
	return program
}

// paths ------------------------------------------------------------------------

const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`)
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const depth = (path: string) => (path === "" ? 0 : path.split("/").length)
const under = (path: string, folder: string) => path.startsWith(folder + "/")

/** An entry's stem: its name less its last extension, if it has one. */
export function stemOf(name: string): string {
	const e = names.extension(name)
	return e ? name.slice(0, -e.length - 1) : name
}

/** A link's target from the folder it is in, as a path from the store's folder; undefined if it leads out. */
function resolve(store: string, folder: string, target: string): string | undefined {
	let parts: string[]
	if (target.startsWith("/")) {
		if (target === store) return ""
		if (!under(target, store)) return undefined
		parts = target.slice(store.length + 1).split("/")
	} else parts = [...(folder === "" ? [] : folder.split("/")), ...target.split("/")]
	const out: string[] = []
	for (const p of parts) {
		if (p === "" || p === ".") continue
		if (p === "..") {
			if (!out.length) return undefined
			out.pop()
		} else out.push(p)
	}
	return out.join("/")
}

// values -----------------------------------------------------------------------

const hashOf = (v: unknown): Hash | undefined => manifest.keptOf(v)?.[0]

type Typed = ArrayBufferView & ArrayLike<number | bigint> & { slice(a: number, b: number): Typed }

/**
 * The patches that make from into to: for two strings, or two typed arrays of
 * one kind, one splice of the part between what is alike at the start and at
 * the end; a snapshot for anything else. Bytes are a snapshot: one whole
 * value, never spliced (MUTATE.tex). A null written whole takes the value
 * away: the node has none (today's core keeps a null as a value, so this says
 * so; c/program.c's patch_of does the same).
 */
export function patches(from: unknown, to: Value): Patch[] {
	if (to === null) return [{ path: [] }]
	const splice = <T>(a: ArrayLike<T>, b: ArrayLike<T>, same: (x: T, y: T) => boolean) => {
		let p = 0
		while (p < a.length && p < b.length && same(a[p], b[p])) p++
		let s = 0
		while (
			s < a.length - p && s < b.length - p && same(a[a.length - 1 - s], b[b.length - 1 - s])
		) s++
		return [p, a.length - s, b.length - s] as const
	}
	if (typeof from === "string" && typeof to === "string") {
		const a = Array.from(from), b = Array.from(to)
		const [p, x, y] = splice(a, b, (m, n) => m === n)
		return [{ path: [], range: [p, x], value: b.slice(p, y).join("") }]
	}
	if (
		ArrayBuffer.isView(from) && ArrayBuffer.isView(to) && !(from instanceof DataView) &&
		!(from instanceof Uint8Array) && from.constructor === to.constructor
	) {
		const a = from as unknown as Typed, b = to as unknown as Typed
		const [p, x, y] = splice(a, b, (m, n) => Object.is(m, n))
		return [{ path: [], range: [p, x], value: b.slice(p, y) }]
	}
	return [{ path: [], value: to }]
}

// edit -------------------------------------------------------------------------

/** Where a new entry goes: the node whose folder it is in, and for a union's folder its slot. */
type Target = { holder: Id; slot?: string }

/**
 * Takes a pass's differences in as changes, made through given: each on its
 * own, a refused one listed, its entry sent to the Trash and laid out again.
 * What it lists is also written to the node listed.
 */
export function edit(
	store: Store,
	given: Api,
	listed: Id,
	differences: readonly Edit[],
): Done {
	// the interface each unit's changes are made through, carrying the unit's cause
	let api = given
	const done: Done = {
		marks: [],
		slots: [],
		unside: [],
		clear: [],
		trash: [],
		mend: [],
		listed: [],
	}
	const graph = store.graph()
	const root = graph.root
	const layout = store.layout
	const want = disk(graph, layout, store.pass)
	const abs = (path: string) => (path === "" ? store.folder : `${store.folder}/${path}`)
	const list = (path: string, why: string) => done.listed.push({ path, why })

	// each folder's laid entries, by name
	const kids = new Map<string, Map<string, Laid>>()
	for (const [p, l] of want) {
		let m = kids.get(parent(p))
		if (!m) kids.set(parent(p), m = new Map())
		m.set(base(p), l)
	}
	// new folders made in this pass: the node each is
	const made = new Map<string, Id>()
	// where entries moved or were made in this pass: the node each is, for a link made to one
	const landed = new Map<string, Id>()
	// the nodes a folder back from the Trash shows again, as the graph kept them: what it holds that
	// carries one of their ids is that node's own entry, not new
	const returned = new Set<Id>()

	// the layout ------------------------------------------------------------------

	const rec = (id: Id): Layout => {
		let r = layout.get(id)
		if (!r) layout.set(id, r = {})
		return r
	}
	const shown = (id: Id) => {
		const r = layout.get(id)
		return !!r && !r.away && (id === root || !!r.home)
	}
	/** A node's stem at its home, which its file and folder share. */
	const stemAt = (id: Id): string | undefined => {
		const h = layout.get(id)?.home
		const e = h ? layout.get(h[0])?.entries?.get(h[1]) : undefined
		return typeof e === "string" ? e : e?.[h![2] + 1]
	}
	/** The folder a node's file is in. */
	const roomOf = (id: Id): string | undefined => {
		if (id === root) return ".ermine"
		const h = layout.get(id)?.home
		const e = h ? layout.get(h[0])?.entries?.get(h[1]) : undefined
		const at = h ? dir(layout, h[0]) : undefined
		if (e === undefined || at === undefined) return undefined
		return typeof e === "string" ? at : join(at, e[0])
	}
	/** A holder's entries, its folder shown. */
	const entries = (holder: Id) => {
		const r = rec(holder)
		r.folder = true
		return r.entries ??= new Map()
	}

	// the graph -------------------------------------------------------------------

	/** A node's versions, read by its id. */
	function reach(id: Id) {
		if (!api.loaded(id)) throw new Error("the node is not loaded")
		// core keeps one version of a value: a side, a second, is never there
		const v = api.value(id)
		return { versions: v === undefined ? [] : [{ content: v }] }
	}
	/** The ids of a holder's slot, as the graph has them now, with each one's position in the list. */
	function slotOf(holder: Id, slot: string): { id: Id; at: number }[] {
		return api.ids(holder, slot).map((id, at) => ({ id, at }))
	}
	const positionOf = (holder: Id, slot: string, id: Id, near?: number) => {
		const all = slotOf(holder, slot)
		const hit = (near !== undefined && all[near]?.id === id)
			? all[near]
			: all.find((x) => x.id === id)
		if (!hit) throw new Error(`the slot ${JSON.stringify(slot)} no longer holds the node`)
		return hit.at
	}
	/** A node's value as the graph has it now: its first version. */
	const value = (id: Id) => reach(id).versions[0]?.content
	/** Writes a value whole to a node, by patches from what it has; at: the version, from 0. */
	function write(id: Id, to: Value, at = 0) {
		const from = reach(id).versions[at]?.content
		api.write(id, patches(from, to), at)
	}

	/** A union's members' stems again, from the graph's order: each at home keeps its own, one given takes its. */
	function restem(holder: Id, slot: string, give?: [Id, string]) {
		const e = layout.get(holder)?.entries?.get(slot)
		if (!Array.isArray(e)) return
		const ids = slotOf(holder, slot).map((x) => x.id)
		const stems = [e[0]]
		ids.forEach((id, i) => {
			const r = layout.get(id)
			let stem = give && give[0] === id ? give[1] : undefined
			if (
				stem === undefined && r?.home && !r.away && r.home[0] === holder && r.home[1] === slot
			) {
				stem = e[r.home[2] + 1]
			}
			stems.push(stem ?? String(i + 1))
			if (r?.home && !r.away && r.home[0] === holder && r.home[1] === slot) {
				r.home = [holder, slot, i]
			}
		})
		entries(holder).set(slot, stems)
	}

	/** Where a new entry in a folder goes. */
	function target(folder: string): Target | undefined {
		if (folder === "") return { holder: root }
		const w = waiting.get(folder)
		if (w && !made.has(folder)) take(w)
		const m = made.get(folder)
		if (m !== undefined) return { holder: m }
		// a union's folder that a node back from the Trash held
		const u = w?.now.kind === "folder" ? w.now.slot : undefined
		if (u && returned.has(u[0])) return { holder: u[0], slot: u[1] }
		const l = want.get(folder)
		if (l?.kind === "folder") return { holder: l.id }
		if (l?.kind === "union") return { holder: l.holder, slot: l.name }
	}
	/** An entry's slot and place in a target: a union's, at the position its number gives, or a slot of its own at the end. */
	function spot(t: Target, slot: string, name: string): { slot: string; at: number } {
		const all = slotOf(t.holder, t.slot ?? slot)
		const end = all.length ? all.at(-1)!.at + 1 : 0
		if (t.slot === undefined) return { slot, at: end }
		const n = names.number(stemOf(name))
		if (!n) return { slot: t.slot, at: end }
		const i = Math.max(0, Math.min(n[0] - 1, all.length))
		return { slot: t.slot, at: i < all.length ? all[i].at : end }
	}
	/** Sets a new or returning node's entry in the layout: its home, its stem in its holder's entries. */
	function home(id: Id, t: Target, slot: string, stem: string) {
		const all = slotOf(t.holder, slot)
		const i = Math.max(0, all.findIndex((x) => x.id === id))
		const r = rec(id)
		r.home = [t.holder, slot, i]
		delete r.away
		const es = entries(t.holder)
		const e = es.get(slot)
		if (Array.isArray(e)) restem(t.holder, slot, [id, stem])
		else if (e === undefined || all.length === 1) es.set(slot, stem)
	}

	// failing -------------------------------------------------------------------

	/** A refused edit: listed with its error, its entry to the Trash, the graph laid out again there. */
	function refused(e: unknown, paths: { trash?: string; mend: string[] }) {
		const why = e instanceof Error ? e.message : String(e)
		if (paths.trash !== undefined) done.trash.push({ path: paths.trash, why: `refused: ${why}` })
		done.mend.push(...paths.mend)
	}
	/** One edit made into changes, each carrying cause: the path that made it, and a move's from. */
	function unit(paths: { trash?: string; mend: string[] }, cause: Cause, f: () => void) {
		api = given.as({ cause })
		try {
			f()
		} catch (e) {
			refused(e, paths)
		} finally {
			api = given
		}
	}

	// sorting the differences ---------------------------------------------------

	type Made = { path: string; now: Entry; inside?: Edit[] }
	const gone = new Map<string, Laid>()
	const fresh: Made[] = []
	const changed: { path: string; was: Laid; now: Entry }[] = []
	for (const d of differences) {
		if (d.was && d.now) {
			const w = d.was, n = d.now
			const same = n.id === undefined || ("id" in w && n.id === w.id)
			if (
				((w.kind === "file" || w.kind === "side") && n.kind === "file" && same) ||
				(w.kind === "link" && n.kind === "link") ||
				(w.kind === "link" && w.half === "file" && n.kind === "file" &&
					(n.id === undefined || n.id === w.id)) ||
				(w.kind === "file" && w.home === undefined)
			) {
				changed.push({ path: d.path, was: w, now: n })
				continue
			}
			gone.set(d.path, w)
			fresh.push({ path: d.path, now: n, inside: d.inside })
		} else if (d.was) gone.set(d.path, d.was)
		else if (d.now) fresh.push({ path: d.path, now: d.now, inside: d.inside })
	}

	// moves: an entry gone from one place and found at another, by its id or a union's slot
	type Move = { id: Id; file?: [string, string]; folder?: [string, string] }
	const moves = new Map<Id, Move>()
	const unions: { holder: Id; slot: string; from: string; to: string }[] = []
	const links: { id: Id; was: Laid & { kind: "link" }; from: string; to: string; now: Entry }[] =
		[]
	const sides: { from: string; to: string }[] = []
	const goneBy = new Map<string, string>()
	const keyOf = (l: Laid) =>
		l.kind === "file"
			? `f\0${l.id}`
			: l.kind === "folder"
			? `d\0${l.id}`
			: l.kind === "union"
			? `u\0${l.holder}\0${l.name}`
			: l.kind === "link"
			? `l\0${l.id}`
			: `s\0${l.id}\0${l.hash}`
	for (const [p, l] of gone) if (!goneBy.has(keyOf(l))) goneBy.set(keyOf(l), p)
	const taken = (key: string) => {
		const p = goneBy.get(key)
		if (p === undefined) return undefined
		goneBy.delete(key)
		const l = gone.get(p)!
		gone.delete(p)
		return { path: p, laid: l }
	}
	/** Whether a new entry is one gone from elsewhere: a move, found by its id or a union's slot. */
	function match(m: Made): boolean {
		const n = m.now
		let hit: ReturnType<typeof taken>
		if (n.kind === "folder" && n.slot) {
			hit = taken(`u\0${n.slot[0]}\0${n.slot[1]}`)
			if (hit) {
				unions.push({ holder: n.slot[0], slot: n.slot[1], from: hit.path, to: m.path })
				return true
			}
		}
		if (n.id === undefined) return false
		const key = n.kind === "file"
			? `f\0${n.id}`
			: n.kind === "folder"
			? `d\0${n.id}`
			: `l\0${n.id}`
		hit = taken(key)
		if (!hit && n.kind === "file" && n.hash) hit = taken(`s\0${n.id}\0${n.hash}`)
		if (!hit) return false
		const l = hit.laid
		if (l.kind === "side") sides.push({ from: hit.path, to: m.path })
		else if (l.kind === "link") {
			links.push({ id: n.id, was: l, from: hit.path, to: m.path, now: n })
		} else {
			const mv = moves.get(n.id) ?? { id: n.id }
			if (l.kind === "file") mv.file = [hit.path, m.path]
			else mv.folder = [hit.path, m.path]
			moves.set(n.id, mv)
		}
		return true
	}
	const rest = fresh.filter((m) => !match(m))
	// what is in a new folder, all the way down, may be an entry moved in from elsewhere in the
	// store: a move into the new folder's node, not new
	const movedIn = new Set<string>()
	const into = (ms: readonly Edit[] | undefined) => {
		for (const i of ms ?? []) {
			if (!i.now || i.was) continue
			if (match({ path: i.path, now: i.now, inside: i.inside })) movedIn.add(i.path)
			else into(i.inside)
		}
	}
	for (const m of rest) into(m.inside)
	// a moved folder's own contents, found where it went, are its node's, not new
	const went = [...moves.values()].flatMap((m) => (m.folder ? [m.folder[1]] : []))
		.concat(unions.map((u) => u.to))
	const news = rest.filter((m) => !went.some((f) => under(m.path, f)))

	// a node's value file edited ------------------------------------------------

	/** The three cases of an edit to a node's file whose value differs from its laid. */
	function meet(id: Id, laid: Hash, path: string, now: Entry & { kind: "file" }, via?: "link") {
		const graphs = hashOf(value(id))
		if (graphs === now.hash) return "same"
		if (graphs === laid) {
			write(id, now.value!)
			return "written"
		}
		if (id === root) {
			done.trash.push({ path, why: "an edit to the root's file met a change" })
			done.mend.push(path)
			return "trashed"
		}
		// the two meet: a new node holding the edit, right after the one it met
		const [holder, slot, near] = layout.get(id)!.home!
		const at = positionOf(holder, slot, id, near)
		const nid = api.create(now.value)
		api.insert(holder, slot, nid, at + 1)
		if (via === "link") return "met"
		// the edited file is the new node's; the met node's is laid again
		const r = rec(id)
		const file = r.file
		delete r.file
		delete r.laid
		layout.set(nid, { home: [holder, slot, near + 1], file, laid: now.hash })
		// in a union, the edited file's stem is the new node's, so the store renames it to the
		// new node's place and lays the met node's where it was
		restem(holder, slot, file === undefined ? undefined : [nid, stemOf(file)])
		done.marks.push([path, nid])
		return "met"
	}

	for (const { path, was, now } of changed) {
		if (was.kind === "link" && now.kind === "link") {
			// a link pointed somewhere else: the id it led to unplaced, the one it leads to mounted
			unit({ mend: [path] }, { file: path }, () => {
				const to = linked(parent(path), now.target)
				if (to === undefined) return list(path, "a link that leads nowhere in the store")
				const [holder, slot, near] = was.home
				const at = positionOf(holder, slot, was.id, near)
				api.insert(holder, slot, to, [at, at + 1])
				done.clear.push(path)
			})
		} else if (was.kind === "link" && now.kind === "file") {
			// a file saved through a link: a write to its node, as if made at its home
			unit({ trash: path, mend: [path] }, { file: path }, () => {
				if (now.why !== undefined) return list(path, `does not read: ${now.why}`)
				const laid = layout.get(was.id)?.laid ?? graph.nodes.get(was.id)?.kept[0]
				const r = meet(was.id, laid ?? "", path, now, "link")
				if (r !== "trashed") {
					done.clear.push(path)
					done.mend.push(path)
				}
			})
		} else if (was.kind === "side" && now.kind === "file") {
			// sides are writable: an edit to a side's file writes that version
			unit({ trash: path, mend: [path] }, { file: path }, () => {
				if (now.why !== undefined) return list(path, `does not read: ${now.why}`)
				const v = reach(was.id).versions[was.side]?.content
				const h = hashOf(v)
				if (h === now.hash) return
				if (h !== was.hash) {
					done.trash.push({
						path,
						why: "an edit to a side whose version changed since it was laid",
					})
					done.mend.push(path)
					return
				}
				write(was.id, now.value!, was.side)
			})
		} else if (was.kind === "file" && now.kind === "file") {
			unit({ trash: path, mend: [path] }, { file: path }, () => {
				if (now.why !== undefined) return list(path, `does not read: ${now.why}`)
				const r = meet(was.id, was.hash, path, now)
				if (r === "same" || r === "written") rec(was.id).laid = now.hash
				// a new form is a new file, which the store makes; the person's, taken in, goes
				if (r === "written" && now.form !== was.form) done.clear.push(path)
				if (now.id === undefined) done.marks.push([path, was.id])
			})
		} else if (was.kind === "file") {
			// the root's file replaced by something else
			gone.set(path, was)
			news.push({ path, now })
		}
	}

	// the new entries, a new folder's contents included but for what moved into it: shallowest
	// first, so a new folder's node is there for what is in it; in one folder, folders first, so a
	// file beside one with its stem is its node's, and links last, so what they lead to is there
	const queue: Made[] = [...news]
	const all: Made[] = []
	for (let at = 0; at < queue.length; at++) {
		const m = queue[at]
		all.push(m)
		for (const i of m.inside ?? []) {
			if (i.now && !i.was && !movedIn.has(i.path)) {
				queue.push({ path: i.path, now: i.now, inside: i.inside })
			}
		}
	}
	const rank = (m: Made) => (m.now.kind === "folder" ? 0 : m.now.kind === "file" ? 1 : 2)
	all.sort((a, b) => depth(a.path) - depth(b.path) || rank(a) - rank(b))
	// new folders, which a move into one takes in first; and each new entry once taken in
	const waiting = new Map(all.filter((m) => m.now.kind === "folder").map((m) => [m.path, m]))
	const took = new Set<string>()

	// moves -------------------------------------------------------------------------

	/** The slot a renamed node's entry gives: a file's new name less the extension the store added, a folder's plus the one its slot's name had. */
	function renamed(id: Id, name: string, folder: boolean): string {
		const h = layout.get(id)!.home!
		const slot = h[1]
		const node = graph.nodes.get(id)
		const form = node?.kept[1] ?? "cbor"
		const s = names.split(slot, form, node?.head, store.pass)
		if (folder) return names.renamed(name, s.added ? undefined : s.ext, true)
		const file = layout.get(id)?.file
		const ext = file ? names.extension(file) : undefined
		const added = ext !== undefined && !(slot.endsWith(`.${ext}`))
		return names.renamed(name, added ? ext : undefined, false)
	}

	/** An entry moved on disk, with a free name beside another: renamed only if nothing is there. */
	function follow(from: string, to: string): string | undefined {
		let at = to
		const there = new Set<string>()
		try {
			for (const e of Deno.readDirSync(abs(parent(to)))) there.add(names.key(e.name))
		} catch {
			return undefined
		}
		const ext = names.extension(base(to))
		const stem = ext ? stemOf(base(to)) : base(to)
		const free = names.free(stem, (c) => there.has(names.key(ext ? `${c}.${ext}` : c)))
		at = join(parent(to), ext ? `${free}.${ext}` : free)
		try {
			Deno.renameSync(abs(from), abs(at))
		} catch {
			return undefined
		}
		return at
	}

	// unions renamed or moved: each id moved to the slot its new name gives, the layout rekeyed
	for (const u of unions) {
		unit({ trash: u.to, mend: [u.from] }, { file: u.to, from: u.from }, () => {
			const t = target(parent(u.to))
			if (!t) throw new Error("moved into a folder that is no node's")
			const ext = names.extension(u.slot)
			const keep = ext !== undefined && !names.passes(u.slot, store.pass)
			const slot = t.slot ?? names.renamed(base(u.to), keep ? ext : undefined, true)
			const ids = slotOf(u.holder, u.slot)
			const was = layout.get(u.holder)?.entries?.get(u.slot)
			const into = t.slot !== undefined || slotOf(t.holder, slot).length > 0
			if (t.holder !== u.holder || slot !== u.slot) {
				for (const _ of ids) api.move(u.holder, u.slot, 0, t.holder, slot)
			}
			if (into || !Array.isArray(was)) return
			done.slots.push([u.to, t.holder, slot])
			layout.get(u.holder)!.entries!.delete(u.slot)
			entries(t.holder).set(slot, [base(u.to), ...was.slice(1)])
			for (const [i, x] of ids.entries()) {
				const r = layout.get(x.id)
				if (r?.home && r.home[0] === u.holder && r.home[1] === u.slot) {
					r.home = [t.holder, slot, i]
				}
			}
		})
	}

	// a union's members renamed in its folder: placed by their numbers, then names
	const reorder = new Map<
		string,
		{ holder: Id; slot: string; folder: string; moved: Map<Id, string> }
	>()

	for (
		const mv of [...moves.values()].sort((a, b) =>
			depth((a.file ?? a.folder)![1]) - depth((b.file ?? b.folder)![1])
		)
	) {
		const lead = (mv.file ?? mv.folder)!
		const isFile = mv.file !== undefined
		unit({ trash: lead[1], mend: [lead[0]] }, { file: lead[1], from: lead[0] }, () => {
			const r = layout.get(mv.id)
			if (!r?.home || r.away) throw new Error("moved a node that is not shown")
			const [h, s, near] = r.home
			const t = target(parent(lead[1]))
			if (!t) throw new Error("moved into a folder that is no node's")
			const from = parent(lead[0])
			const stay = from === parent(lead[1])
			const oldUnion = Array.isArray(layout.get(h)?.entries?.get(s))
			if (stay && oldUnion && t.slot === s && t.holder === h) {
				// within a union's folder: its members placed again by number
				const key = `${h}\0${s}`
				const g = reorder.get(key) ??
					{ holder: h, slot: s, folder: parent(lead[1]), moved: new Map() }
				g.moved.set(mv.id, base(lead[1]))
				if (mv.file && mv.folder) g.moved.set(mv.id, base(mv.file[1]))
				reorder.set(key, g)
				return
			}
			const slot = t.slot ?? renamed(mv.id, base(lead[1]), !isFile)
			let at: number | undefined
			if (t.slot !== undefined) at = spot(t, slot, base(lead[1])).at
			if (t.holder !== h || slot !== s) {
				api.move(h, s, positionOf(h, s, mv.id, near), t.holder, slot, at)
			}
			if (stay && !oldUnion && t.slot === undefined) {
				// within one folder: the entries where the person put them, the store renames the rest
				if (mv.file) r.file = base(mv.file[1])
				const folded = mv.folder && parent(mv.folder[1]) === from
				if (slot === s) {
					if (folded) entries(h).set(s, base(mv.folder![1]))
				} else {
					// its home is the slot it moved to, so a mount in a slot sorting first does not
					// take it; the other half, and a file whose name its slot's would not give, are
					// renamed here to its stem, so the layout is as the disk now is
					const node = graph.nodes.get(mv.id)
					const ext = names.split(slot, node?.kept[1] ?? "cbor", node?.head, store.pass).ext
					const room = roomOf(mv.id)
					const where = folded ? mv.folder![1] : r.folder ? dir(layout, mv.id) : undefined
					let stem = folded ? base(mv.folder![1]) : stemAt(mv.id) ?? slot
					if (mv.file) {
						// the file decides
						const want = names.write(
							names.split(slot, node?.kept[1] ?? "cbor", node?.head, store.pass).stem,
							store.pass,
						)
						const put = r.file === `${want}.${ext}`
							? mv.file[1]
							: follow(mv.file[1], join(from, `${want}.${ext}`))
						if (put !== undefined) {
							r.file = base(put)
							landed.set(put, mv.id)
							stem = stemOf(base(put))
						} else stem = stemOf(r.file!)
						if (where !== undefined && base(where) !== stem) {
							const moved = follow(where, join(from, stem))
							if (moved !== undefined) landed.set(moved, mv.id)
							if (moved !== undefined) stem = base(moved)
							else stem = base(where)
						}
					} else if (folded && r.file !== undefined && room !== undefined) {
						const put = r.file === `${stem}.${ext}`
							? join(room, r.file)
							: follow(join(room, r.file), join(from, `${stem}.${ext}`))
						if (put !== undefined) {
							r.file = base(put)
							landed.set(put, mv.id)
						}
					}
					const es = layout.get(h)?.entries
					if (es && !slotOf(h, s).length) es.delete(s)
					home(mv.id, t, slot, stem)
				}
				for (const p of [mv.file?.[1], mv.folder?.[1]]) {
					if (p !== undefined) landed.set(p, mv.id)
				}
				return
			}
			// across folders: the other half brought beside the one that decides
			const to = parent(lead[1])
			let stem = isFile ? stemOf(base(lead[1])) : base(lead[1])
			if (isFile && r.folder) {
				const where = mv.folder ? mv.folder[1] : dir(layout, mv.id)
				if (where !== undefined) {
					const put = parent(where) === to ? where : follow(where, join(to, stem))
					if (put !== undefined) stem = base(put)
					if (put !== undefined) landed.set(put, mv.id)
				}
			} else if (!isFile && r.file !== undefined) {
				const room = roomOf(mv.id)
				const where = mv.file ? mv.file[1] : room === undefined ? undefined : join(room, r.file)
				if (where !== undefined) {
					const put = parent(where) === to ? where : follow(where, join(to, base(where)))
					if (put !== undefined) r.file = base(put)
					if (put !== undefined) landed.set(put, mv.id)
				}
			}
			if (isFile) r.file = base(lead[1])
			landed.set(lead[1], mv.id)
			const es = layout.get(h)?.entries
			if (es && !slotOf(h, s).length) es.delete(s)
			else if (Array.isArray(es?.get(s))) restem(h, s)
			home(mv.id, t, slot, stem)
		})
	}

	for (const g of reorder.values()) {
		// its cause: the union's folder, where the members were renamed
		unit({ mend: [] }, { file: g.folder }, () => {
			const all = slotOf(g.holder, g.slot)
			const e = layout.get(g.holder)!.entries!.get(g.slot) as string[]
			const named = new Map<Id, string>()
			for (const x of all) {
				const r = layout.get(x.id)
				const mine = r?.home && r.home[0] === g.holder && r.home[1] === g.slot
				named.set(x.id, g.moved.get(x.id) ?? (mine ? r!.file ?? e[r!.home![2] + 1] : ""))
			}
			const order = all.map((x) => x.id).sort((a, b) => {
				const x = names.number(stemOf(named.get(a)!)), y = names.number(stemOf(named.get(b)!))
				if (x && y && x[0] !== y[0]) return x[0] - y[0]
				if (!x !== !y) return x ? -1 : 1
				return names.byCodePoint(named.get(a)!, named.get(b)!)
			})
			const now = all.map((x) => x.id)
			order.forEach((id, i) => {
				const j = now.indexOf(id)
				if (j === i) return
				api.move(g.holder, g.slot, j, g.holder, g.slot, i)
				now.splice(j, 1)
				now.splice(i, 0, id)
			})
			const stems = [e[0]]
			order.forEach((id, i) => {
				const r = layout.get(id)
				const name = named.get(id)!
				const moved = g.moved.has(id)
				if (r?.home && r.home[0] === g.holder && r.home[1] === g.slot) {
					stems.push(moved ? stemOf(name) : e[r.home[2] + 1])
					if (moved && r.file !== undefined) r.file = name
					r.home = [g.holder, g.slot, i]
				} else stems.push(String(i + 1))
			})
			entries(g.holder).set(g.slot, stems)
		})
	}

	// links moved: the id moved to the slot the link's new name gives; the store lays it again
	for (const l of links) {
		unit({ mend: [l.from] }, { file: l.to, from: l.from }, () => {
			const t = target(parent(l.to))
			if (!t) throw new Error("moved into a folder that is no node's")
			const [h, s, near] = l.was.home
			const node = graph.nodes.get(l.id)
			const sp = names.split(s, node?.kept[1] ?? "cbor", node?.head, store.pass)
			const slot = t.slot ??
				(l.was.half === "folder"
					? names.renamed(base(l.to), sp.added ? undefined : sp.ext, true)
					: names.renamed(base(l.to), sp.added ? sp.ext : undefined, false))
			const at = t.slot !== undefined ? spot(t, slot, base(l.to)).at : undefined
			if (t.holder !== h || slot !== s) {
				api.move(h, s, positionOf(h, s, l.id, near), t.holder, slot, at)
			}
			done.clear.push(l.to)
		})
	}

	// a side renamed: laid again, and listed
	for (const s of sides) {
		done.trash.push({ path: s.to, why: "a side renamed: the store lays it again" })
		done.mend.push(s.from)
	}

	// new entries ---------------------------------------------------------------

	/** The id a link leads to: a node's file or folder in the store, or .ermine/id/ and an id; undefined for anywhere else. */
	function linked(folder: string, to: string): Id | undefined {
		const p = resolve(store.folder, folder, to)
		if (p === undefined) return undefined
		if (p.startsWith(".ermine/id/")) {
			const seg = p.slice(".ermine/id/".length)
			return seg && !seg.includes("/") ? names.unpercent(seg) : undefined
		}
		if (p === "") return root
		if (landed.has(p)) return landed.get(p)
		const l = want.get(p) ??
			(made.has(p) ? { kind: "folder" as const, id: made.get(p)! } : undefined)
		if (l?.kind === "file" || l?.kind === "folder") return l.id
	}

	/** A shown node beside a new entry, whose other half it is: a folder for a file, a file for a folder. */
	function beside(folder: string, name: string, kind: "file" | "folder"): Id | undefined {
		const here = kids.get(folder)
		const k = names.key(kind === "file" ? stemOf(name) : name)
		// a folder made or back in this pass, its node with no file
		if (kind === "file") {
			for (const [p, id] of made) {
				if (
					parent(p) === folder && names.key(base(p)) === k &&
					layout.get(id)?.file === undefined
				) {
					return id
				}
			}
		}
		if (!here) return undefined
		for (const [n, l] of here) {
			if (kind === "file" && l.kind === "folder" && names.key(n) === k) {
				if (layout.get(l.id)?.file === undefined) return l.id
			}
			if (kind === "folder" && l.kind === "file" && l.home) {
				const stem = stemAt(l.id)
				if (stem !== undefined && names.key(stem) === k && !layout.get(l.id)?.folder) {
					return l.id
				}
			}
		}
	}

	/** Whether a node is one the graph keeps that no shown node holds now. */
	function away(id: Id) {
		return id !== root && graph.nodes.has(id) && !shown(id)
	}

	/** A node back in a folder: it, and what its kept layout shows under it, shown again. */
	function back(id: Id) {
		const on = new Set([id])
		for (let grew = true; grew;) {
			grew = false
			for (const [x, r] of layout) {
				if (!r.away || !r.home || on.has(x) || !on.has(r.home[0])) continue
				if (!graph.nodes.get(r.home[0])?.directory.get(r.home[1])?.includes(x)) continue
				delete r.away
				on.add(x)
				returned.add(x)
				grew = true
			}
		}
	}

	function take(m: Made) {
		const { path, now } = m
		if (took.has(path)) return
		took.add(path)
		const folder = parent(path), name = base(path)
		if (folder === ".ermine") {
			// the root's file made
			if (now.kind !== "file") return
			return unit({ trash: path, mend: [path] }, { file: path }, () => {
				if (now.why !== undefined) return list(path, `does not read: ${now.why}`)
				write(root, now.value!)
				Object.assign(rec(root), { file: name, laid: now.hash })
			})
		}
		const t = target(folder)
		if (!t) return
		if (now.kind === "link") {
			// a link a folder back from the Trash held: the store's, which it lays again
			if (returned.has(t.holder)) return
			return unit({ mend: [] }, { file: path }, () => {
				const to = linked(folder, now.target)
				if (to === undefined) return list(path, "a link that leads nowhere in the store")
				const { slot, at } = spot(t, names.take(name).slot, name)
				api.insert(t.holder, slot, to, at)
				done.clear.push(path)
			})
		}
		if (now.kind === "file" && now.why !== undefined) {
			return list(path, `does not read: ${now.why}`)
		}
		// a union's folder a folder back from the Trash held: its members are taken in as its slot's
		if (now.kind === "folder" && now.slot && returned.has(now.slot[0])) return
		const own = now.id !== undefined && returned.has(now.id) ? layout.get(now.id) : undefined
		if (
			own?.home && own.home[0] === t.holder && (t.slot === undefined || own.home[1] === t.slot)
		) {
			// what a folder back from the Trash held, as the graph kept it: its value compared
			const id = now.id!
			return unit({ trash: path, mend: [path] }, { file: path }, () => {
				if (now.kind === "folder") {
					own.folder = true
					made.set(path, id)
				} else {
					if (hashOf(value(id)) !== now.hash) write(id, now.value!)
					Object.assign(own, { file: name, laid: now.hash })
				}
				landed.set(path, id)
			})
		}
		unit({ trash: path, mend: [] }, { file: path }, () => {
			// the other half of a node beside it
			const half = beside(folder, name, now.kind)
			if (half !== undefined) {
				if (now.kind === "file") {
					if (hashOf(value(half)) !== now.hash) write(half, now.value!)
					Object.assign(rec(half), { file: name, laid: now.hash })
				} else {
					const r = rec(half)
					r.folder = true
					r.entries ??= new Map()
					const h = r.home!
					const e = layout.get(h[0])?.entries?.get(h[1])
					if (typeof e === "string") entries(h[0]).set(h[1], name)
					made.set(path, half)
				}
				done.marks.push([path, half])
				landed.set(path, half)
				return
			}
			let slotName = now.kind === "file" ? names.take(name).slot : names.read(name)
			const stem = now.kind === "file" ? stemOf(name) : name
			// a node the graph keeps, back from the Trash
			if (now.id !== undefined && away(now.id)) {
				const id = now.id
				// its name read back less the extension the store adds for its value
				const node = graph.nodes.get(id)!
				const ext = names.suffix(node.kept[1], node.head)
				if (now.kind === "file" && names.extension(name) === ext) {
					slotName = names.read(name).slice(0, -ext.length - 1)
				}
				const was = layout.get(id)
				const { slot } = spot(t, slotName, name)
				let at = spot(t, slotName, name).at
				if (was?.home && was.home[0] === t.holder && was.home[1] === slot) {
					const all = slotOf(t.holder, slot)
					at = was.home[2] < all.length ? all[was.home[2]].at : at
				}
				api.insert(t.holder, slot, id, at)
				if (now.kind === "folder") {
					back(id)
					const r = rec(id)
					delete r.file
					delete r.laid
					r.folder = true
					made.set(path, id)
				} else {
					const r = rec(id)
					r.file = name
					delete r.folder
					delete r.entries
				}
				home(id, t, slot, stem)
				if (now.kind === "file") {
					if (hashOf(value(id)) !== now.hash) write(id, now.value!)
					rec(id).laid = now.hash
				}
				done.marks.push([path, id])
				landed.set(path, id)
				return
			}
			// a new node, or a copy, which is new nodes
			const { slot, at } = spot(t, slotName, name)
			const id = api.create(now.kind === "file" ? now.value : null)
			api.insert(t.holder, slot, id, at)
			const r = rec(id)
			if (now.kind === "file") Object.assign(r, { file: name, laid: now.hash })
			else {
				r.folder = true
				r.entries = new Map()
				made.set(path, id)
			}
			home(id, t, slot, stem)
			done.marks.push([path, id])
			landed.set(path, id)
			if (now.kind === "file") done.unside.push(path)
		})
	}

	for (const m of all) take(m)

	// removals ----------------------------------------------------------------

	/** What the layout showed in a folder now gone is shown nowhere: a node still held elsewhere is laid again there. */
	function vanish(folder: string) {
		for (const [p, l] of want) {
			if (l.kind === "link" && l.half !== "pending") {
				const to = resolve(store.folder, parent(p), l.target)
				if (to !== undefined && (to === folder || under(to, folder))) done.clear.push(p)
			}
			if (p !== folder && !under(p, folder)) continue
			const r = l.kind === "file" || l.kind === "folder" ? layout.get(l.id) : undefined
			if (!r) continue
			if (l.kind === "file") {
				delete r.file
				delete r.laid
			} else delete r.folder
		}
	}

	type Gone = { file?: string; folder?: string }
	const nodes = new Map<Id, Gone>()
	const seen = new Set<string>()
	for (const [path, l] of [...gone].sort((a, b) => depth(a[0]) - depth(b[0]))) {
		if (l.kind === "file" || l.kind === "folder") {
			const g = nodes.get(l.id) ?? {}
			g[l.kind] = path
			nodes.set(l.id, g)
		} else if (l.kind === "union") {
			unit({ mend: [path] }, { file: path }, () => {
				const n = slotOf(l.holder, l.name)
				if (n.length) api.remove(l.holder, l.name, [n[0].at, n.at(-1)!.at + 1])
				vanish(path)
			})
		} else if (l.kind === "link") {
			const key = `${l.home[0]}\0${l.home[1]}\0${l.id}`
			if (seen.has(key)) continue
			seen.add(key)
			unit({ mend: [path] }, { file: path }, () => {
				api.remove(l.home[0], l.home[1], positionOf(l.home[0], l.home[1], l.id, l.home[2]))
			})
		} else if (l.kind === "side") {
			done.mend.push(path)
			list(path, "a side removed: the store lays it again")
		}
	}
	for (const [id, g] of nodes) {
		const paths = [g.file, g.folder].filter((p): p is string => p !== undefined)
		unit({ mend: paths }, { file: paths[0] }, () => {
			const r = layout.get(id)!
			if (id === root) {
				// the root's file removed: its folder is the store's, always shown
				if (g.file) {
					write(root, null)
					delete r.file
					delete r.laid
				}
				return
			}
			const folderShown = !!r.folder
			if (g.file && !g.folder && folderShown) {
				write(id, null)
				delete r.file
				delete r.laid
				return
			}
			if (g.folder && !g.file && r.file !== undefined) {
				for (const slot of api.slots(id)) {
					const n = slotOf(id, slot)
					if (n.length) api.remove(id, slot, [n[0].at, n.at(-1)!.at + 1])
				}
				vanish(g.folder)
				delete r.folder
				delete r.entries
				return
			}
			const [h, s, near] = r.home!
			api.remove(h, s, positionOf(h, s, id, near))
			// shown elsewhere still, it is laid again there
			for (const p of paths) vanish(p)
		})
	}

	// links the layout now shows that it did not, or to elsewhere: to a half back, a new folder
	// beside a file, a folder renamed
	for (const [p, l] of disk(graph, layout, store.pass)) {
		const w = want.get(p)
		if (l.kind === "link" && (w?.kind !== "link" || w.target !== l.target)) done.mend.push(p)
	}

	// listed ------------------------------------------------------------------

	const items = [...done.trash, ...done.listed]
	if (items.length) {
		try {
			const had = (given.value(listed) ?? []) as unknown[]
			given.write(listed, [{ path: [], range: [had.length, had.length], value: items }])
		} catch {
			// listed is the program's own: nothing stops it but the program going
		}
	}
	return done
}
