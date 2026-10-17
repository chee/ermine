// layout: from the graph as the store's records give it, where each node is shown, under what
// names, and the plan from the old layout to the new. pure but for probe (names taken on disk) and
// ino (a folder's file id)
//
// homes: kept while the slot holds it and its holder kept its own; else the first slot holding it,
//   breadth first over homes, slots in code point order, union ids in slot order. held by no
//   shown node: away
// stems: new ones in code point order of slot names, clear of the probe and the store's .ermine;
//   kept while a slot keeps its shape (one id, or a union); new for a pending id that arrives, a
//   change of shape, or a slot in left
// files: keep their name while the home's stem and the form do; a new form, a new extension
// plan: entries known by what they are, not where; steps numbered from 1. first, deepest first,
//   each leaving entry (and each moving out of a leaving folder) renamed into
//   .ermine/tmp/<time>.<number>; then, shallowest first, each made, renamed in, or written again
//   (one in the way that moves waits in tmp/). a form change or a renamed link: removed, made again

import * as manifest from "./manifest.ts"
import * as names from "./names.ts"
import { byCodePoint } from "./names.ts"
import type { Found, Graph, Hash, Home, Id, Info, Laid, Layout, Node, Step } from "./types.ts"

/** Every entry's name in a folder on disk, the store's own and others'; [] for a folder that is not there. */
export type Probe = (folder: string) => readonly string[]

/** A batch's layout: every record, those the batch changed, with was, and its plan. */
export type Laying = { layout: Map<Id, Layout>; changed: Map<Id, Layout>; plan: Step[] }

/**
 * What lay may also be given: the graph the old layout was laid out from,
 * the graph itself if not given, as when laying out again; a folder's file
 * id by its path now, for the steps that rename or remove it; and whether an
 * entry the old layout does not put at a path is still the store's own, as
 * a link it laid whose target the files program's changes to the layout no
 * longer give, so its name is not taken.
 */
export type More = {
	before?: Graph
	ino?: (path: string) => number | null | undefined
	own?: (path: string) => boolean
}

const NULL: Hash = manifest.NULL
const ERMINE = ".ermine"
const TMP = ".ermine/tmp"

const join = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`)
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** A path from the folder from to to, both from the store's folder: what a link in from holds. */
export function relative(from: string, to: string): string {
	const a = from === "" ? [] : from.split("/")
	const b = to === "" ? [] : to.split("/")
	let i = 0
	while (i < a.length && i < b.length && a[i] === b[i]) i++
	const out = [...a.slice(i).map(() => ".."), ...b.slice(i)]
	return out.length ? out.join("/") : "."
}

/**
 * The path of a node's folder, shown or not, "" for the root's; undefined
 * for a node that is away or whose home does not lead to the root.
 */
export function dir(layout: ReadonlyMap<Id, Layout>, id: Id): string | undefined {
	const seen = new Set<Id>()
	const up = (id: Id): string | undefined => {
		const r = layout.get(id)
		if (!r || r.away) return undefined
		if (!r.home) return ""
		if (seen.has(id)) return undefined
		seen.add(id)
		const at = room(layout, r.home, up)
		if (at === undefined) return undefined
		const e = layout.get(r.home[0])!.entries!.get(r.home[1])!
		const stem = typeof e === "string" ? e : e[r.home[2] + 1]
		return stem === undefined ? undefined : join(at, stem)
	}
	return up(id)
}

/** The folder a home's entries are in: its holder's folder, or the union's in it. */
function room(
	layout: ReadonlyMap<Id, Layout>,
	[holder, name]: Home,
	up: (id: Id) => string | undefined = (id) => dir(layout, id),
): string | undefined {
	const h = layout.get(holder)
	const e = h?.folder ? h.entries?.get(name) : undefined
	if (e === undefined) return undefined
	const at = up(holder)
	if (at === undefined) return undefined
	return typeof e === "string" ? at : join(at, e[0])
}

/** Whether a record shows its node at home in that slot. */
const home = (r: Layout | undefined, holder: Id, name: string) =>
	!!r && !r.away && !!r.home && r.home[0] === holder && r.home[1] === name

/** Every entry the layout puts on disk, left ones included. */
function walk(graph: Graph, layout: ReadonlyMap<Id, Layout>, pass: readonly string[]) {
	const out = new Map<string, Laid>()
	const root = graph.root
	const dirs = new Map<Id, string | undefined>()
	const at = (id: Id) => {
		if (!dirs.has(id)) dirs.set(id, dir(layout, id))
		return dirs.get(id)
	}
	const rr = layout.get(root)
	const rn = graph.nodes.get(root)
	if (rr?.file !== undefined && rn) {
		const hash = rr.laid ?? rn.kept[0]
		out.set(`${ERMINE}/${rr.file}`, {
			kind: "file",
			id: root,
			form: rn.kept[1],
			hash,
			info: rn.info,
		})
	}
	// each node at its home: its file and its folder
	for (const [id, r] of layout) {
		if (id === root || r.away || !r.home) continue
		const n = graph.nodes.get(id)
		const where = n ? room(layout, r.home, at) : undefined
		if (!n || where === undefined) continue
		const h: Home = [...r.home]
		if (r.file !== undefined) {
			const hash = r.laid ?? n.kept[0]
			out.set(join(where, r.file), {
				kind: "file",
				id,
				home: h,
				form: n.kept[1],
				hash,
				info: n.info,
			}) // its sides, beside it
			;(r.sides ?? []).forEach((name, i) => {
				const s = n.sides[i]
				if (!s) return
				out.set(join(where, name), {
					kind: "side",
					id,
					home: h,
					side: i + 1,
					form: s[1],
					hash: s[0],
				})
			})
		}
		const d = r.folder ? at(id) : undefined
		if (d !== undefined) out.set(d, { kind: "folder", id, home: h, info: n.info })
	}
	// in each shown folder: unions' folders and links
	for (const [h, r] of layout) {
		if (r.away || !r.folder || !r.entries || (h !== root && !r.home)) continue
		const d = at(h)
		const n = graph.nodes.get(h)
		if (d === undefined || !n) continue
		for (const [name, e] of r.entries) {
			const ids = n.directory.get(name) ?? []
			const union = typeof e !== "string"
			if (union) out.set(join(d, e[0]), { kind: "union", holder: h, name })
			if (!ids.length || (ids.length > 1) !== union) continue
			const folder = union ? join(d, e[0]) : d
			ids.forEach((id, i) => {
				const stem = union ? e[i + 1] : e
				const x = layout.get(id)
				if (stem === undefined || (id !== root && home(x, h, name))) return
				const slot: Home = [h, name, i]
				const node = graph.nodes.get(id)
				if (!node) {
					const target = relative(folder, `${ERMINE}/id/${names.percent(id)}`)
					out.set(join(folder, stem), {
						kind: "link",
						id,
						home: slot,
						target,
						half: "pending",
					})
					return
				}
				let file: string | undefined
				let fold: string | undefined
				if (id === root) {
					if (x?.file !== undefined) file = `${ERMINE}/${x.file}`
					fold = ""
				} else if (x && !x.away && x.home) {
					const w = room(layout, x.home, at)
					if (w !== undefined && x.file !== undefined) file = join(w, x.file)
					if (x.folder) fold = at(id)
				}
				if (file !== undefined) {
					const s = names.split(name, node.kept[1], node.head, pass)
					const ext = s.added ? names.extension(base(file)) ?? s.ext : s.ext
					const target = relative(folder, file)
					out.set(join(folder, `${stem}.${ext}`), {
						kind: "link",
						id,
						home: slot,
						target,
						half: "file",
					})
				}
				if (fold !== undefined) {
					const target = relative(folder, fold)
					out.set(join(folder, stem), { kind: "link", id, home: slot, target, half: "folder" })
				}
			})
		}
	}
	return out
}

/** Whether a path, or a folder it is in, is in the set. */
function under(path: string, set: ReadonlySet<string>): boolean {
	for (let p = path;; p = parent(p)) {
		if (set.has(p)) return true
		if (p === "") return false
	}
}

/** Every path in some record's left. */
function lefts(layout: ReadonlyMap<Id, Layout>): Set<string> {
	const out = new Set<string>()
	for (const r of layout.values()) for (const p of r.left ?? []) out.add(p)
	return out
}

/**
 * Every entry the layout puts on disk, by path, links and the root's
 * .ermine/root.<ext> included; an entry in some record's left, and what is
 * in it, is not. pass is the store's, which names the links to files.
 */
export function disk(
	graph: Graph,
	layout: ReadonlyMap<Id, Layout>,
	pass: readonly string[] = names.PASS,
): Map<string, Laid> {
	return laid(walk(graph, layout, pass), lefts(layout))
}

/** What a walk gives, less what is left and what is in it; the walk's own if nothing is left. */
function laid(all: Map<string, Laid>, left: ReadonlySet<string>): Map<string, Laid> {
	if (!left.size) return all
	const out = new Map(all)
	for (const p of all.keys()) if (under(p, left)) out.delete(p)
	return out
}

/**
 * The records that fit the graph: one of an id the graph does not have, or
 * with a home in a slot that does not hold its node, or under a holder that
 * is dropped, or whose holder has no stem for the slot, is dropped. A record
 * that is away fits while the graph has its node.
 */
export function prune(graph: Graph, layout: ReadonlyMap<Id, Layout>): Map<Id, Layout> {
	const root = graph.root
	const fits = new Map<Id, boolean>()
	const fit = (id: Id): boolean => {
		const known = fits.get(id)
		if (known !== undefined) return known
		fits.set(id, false)
		const r = layout.get(id)
		let ok = !!r && (id === root || graph.nodes.has(id))
		if (ok && id === root) ok = !r!.home && !r!.away
		else if (ok && !r!.away) {
			const [h, name, pos] = r!.home ?? ["", "", 0]
			const ids = graph.nodes.get(h)?.directory.get(name) ?? []
			const e = layout.get(h)?.entries?.get(name)
			ok = !!r!.home && ids.includes(id) && fit(h) && !layout.get(h)!.away &&
				!!layout.get(h)!.folder && e !== undefined &&
				(typeof e === "string"
					? ids.length === 1
					: e.length === ids.length + 1 && pos < ids.length)
		}
		fits.set(id, ok)
		return ok
	}
	const out = new Map<Id, Layout>()
	for (const [id, r] of layout) if (fit(id)) out.set(id, r)
	return out
}

/** Each shown node's home, and every shown node in the order homes were settled, the root first. */
function settle(graph: Graph, old: ReadonlyMap<Id, Layout>) {
	const root = graph.root
	const kept = new Map<Id, boolean>()
	const keeps = (id: Id): boolean => {
		if (id === root) return true
		const known = kept.get(id)
		if (known !== undefined) return known
		kept.set(id, false)
		const r = old.get(id)
		let k = false
		if (r && !r.away && r.home && graph.nodes.has(id)) {
			const [h, name] = r.home
			k = !!graph.nodes.get(h)?.directory.get(name)?.includes(id) && keeps(h)
		}
		kept.set(id, k)
		return k
	}
	const homes = new Map<Id, Home>()
	const order: Id[] = [root]
	const shown = new Set<Id>([root])
	for (let i = 0; i < order.length; i++) {
		const h = order[i]
		const n = graph.nodes.get(h)!
		for (const name of [...n.directory.keys()].sort(byCodePoint)) {
			n.directory.get(name)!.forEach((id, pos) => {
				if (shown.has(id) || !graph.nodes.has(id)) return
				if (keeps(id)) {
					const [oh, on] = old.get(id)!.home!
					if (oh !== h || on !== name) return
				}
				homes.set(id, [h, name, pos])
				shown.add(id)
				order.push(id)
			})
		}
	}
	return { homes, order }
}

const FINALS = /(\.FINAL)+$/

/**
 * Lays a graph out from the old layout: each changed file's laid the new
 * value and was the old, entries in left tried again, and the plan's steps
 * numbered from 1, temporary entries at .ermine/tmp/<time>.<number>. A file
 * whose laid is already the value is not laid again. A name the probe gives
 * that the old layout did not put there is taken.
 */
export function lay(
	graph: Graph,
	old: ReadonlyMap<Id, Layout>,
	probe: Probe,
	time: number,
	pass: readonly string[],
	{ before = graph, ino, own }: More = {},
): Laying {
	const root = graph.root
	if (!graph.nodes.has(root)) return { layout: new Map(old), changed: new Map(), plan: [] }
	// what the old layout was laid out from: the old graph, and the nodes the files program made
	// since, which it has records for
	const view: Graph = { root: before.root, nodes: new Map(before.nodes) }
	for (const [id, n] of graph.nodes) {
		if (!view.nodes.has(id) && old.has(id)) (view.nodes as Map<Id, typeof n>).set(id, n)
	}
	const all = walk(view, old, pass)
	const left = lefts(old)
	const was = laid(all, left)
	// the slots with an entry in left, to lay again under a new name
	const relay = new Set<string>()
	for (const p of left) {
		const l = all.get(p)
		if (l?.kind === "union") relay.add(`${l.holder}\0${l.name}`)
		else if (l?.home) relay.add(`${l.home[0]}\0${l.home[1]}`)
	}
	// the old layout's names in each folder; the rest the probe gives are others'
	const ours = new Map<string, Set<string>>()
	for (const p of was.keys()) {
		let s = ours.get(parent(p))
		if (!s) ours.set(parent(p), s = new Set())
		s.add(base(p))
	}

	const { homes, order } = settle(graph, old)
	const layout = new Map<Id, Layout>()

	/** A node's file's extension in a slot of that name: the name's, if it fits, else its own. */
	const extOf = (name: string, id: Id) => {
		const x = graph.nodes.get(id)
		return x ? names.split(name, x.kept[1], x.head, pass).ext : undefined
	}
	/** The stem the old layout gave a node at its home. */
	const stemWas = (id: Id) => {
		const r = old.get(id)
		if (!r?.home) return undefined
		const e = old.get(r.home[0])?.entries?.get(r.home[1])
		return typeof e === "string" ? e : e?.[r.home[2] + 1]
	}
	/** A node's position in a slot by the old layout: at home, its home's; else the old graph's. */
	const posWas = (h: Id, name: string, id: Id) => {
		const r = old.get(id)
		if (home(r, h, name)) return r!.home![2]
		const i = view.nodes.get(h)?.directory.get(name)?.indexOf(id) ?? -1
		return i < 0 ? undefined : i
	}

	// each shown folder's names, by the key they compare by, once its stems are found: its
	// holder's id, or a union's holder and slot; the sides are named against them
	const taken = new Map<string, Set<string>>()
	/** The old layout's sides' names of the nodes at home in a holder's slot, which no new stem takes. */
	const sidesOf = (h: Id, s: string, ids: readonly Id[], into: (name: string) => void) => {
		for (const id of ids) {
			const r = old.get(id)
			if (home(r, h, s)) { for (const name of r!.sides ?? []) into(name) }
		}
	}

	/** The stems of a shown holder's slots. */
	function entries(h: Id): Map<string, string | string[]> {
		const n = graph.nodes.get(h)!
		const r = old.get(h)
		const prior = r?.entries
		const now = h === root ? "" : r && !r.away && r.folder ? dir(old, h) : undefined
		const used = new Set<string>()
		// an entry's name, and the stem it has as a file; a stem is whole, never a file's name
		const take = (name: string) => {
			used.add(names.key(name))
			const e = names.extension(name)
			if (e) used.add(names.key(name.slice(0, -e.length - 1)))
		}
		const others = (folder: string | undefined, into: (name: string) => void) => {
			if (folder === undefined) return
			const mine = ours.get(folder)
			for (const name of probe(folder)) {
				if (!mine?.has(name) && !own?.(join(folder, name))) into(name)
			}
		}
		if (h === root) take(ERMINE)
		// others' entries here, by the key their whole names compare by
		const foreign = new Set<string>()
		others(now, (name) => {
			take(name)
			foreign.add(names.key(name))
		})
		/** Whether a kept stem's entries, as the node it shows now needs them, would land on another's. */
		const clash = (s: string, stem: string, id: Id) => {
			const x = graph.nodes.get(id)
			if (!x) return foreign.has(names.key(stem))
			const r = old.get(id)
			const folder = [...x.directory.values()].some((l) => l.length > 0) ||
				(!!r?.folder && !r.away)
			const file = !(x.kept[0] === NULL && folder)
			return (folder && foreign.has(names.key(stem))) ||
				(file && foreign.has(names.key(`${stem}.${extOf(s, id)}`)))
		}
		const slots = [...n.directory.keys()].filter((s) => n.directory.get(s)!.length)
			.sort(byCodePoint)
		// the sides laid here: a new stem does not take one, though a side may move for a stem kept
		const sided = new Set<string>()
		for (const s of slots) {
			const ids = n.directory.get(s)!
			if (ids.length === 1) {
				sidesOf(h, s, ids, (name) => {
					sided.add(names.key(name))
					const e = names.extension(name)
					if (e) sided.add(names.key(name.slice(0, -e.length - 1)))
				})
			}
		}
		const free = (c: string) => used.has(names.key(c)) || sided.has(names.key(c))
		const out = new Map<string, string | string[]>()
		const fresh: string[] = []
		for (const s of slots) {
			const ids = n.directory.get(s)!
			const e = prior?.get(s)
			const union = ids.length > 1
			const held = view.nodes.get(h)?.directory.get(s)
			const arrived = !union && held?.length === 1 && held[0] === ids[0] &&
				!view.nodes.has(ids[0]) && graph.nodes.has(ids[0])
			if (
				e === undefined || (typeof e !== "string") !== union || arrived ||
				relay.has(`${h}\0${s}`) || (!union && clash(s, e as string, ids[0]))
			) {
				fresh.push(s)
				continue
			}
			const stem = typeof e === "string" ? e : e[0]
			out.set(s, stem)
			used.add(names.key(stem))
			const ext = union ? undefined : extOf(s, ids[0])
			if (ext) take(`${stem}.${ext}`)
			const f = home(old.get(ids[0]), h, s) ? old.get(ids[0])!.file : undefined
			if (!union && f !== undefined) take(f)
		}
		for (const s of fresh) {
			const ids = n.directory.get(s)!
			let stem = s
			let ext: string | undefined
			if (ids.length > 1) {
				const e = names.extension(s)
				if (e && !names.passes(s, pass)) stem = s.slice(0, -e.length - 1)
			} else if (graph.nodes.has(ids[0])) {
				const x = graph.nodes.get(ids[0])!
				;({ stem, ext } = names.split(s, x.kept[1], x.head, pass))
			}
			stem = names.cut(names.write(stem, pass), ext ?? "")
			stem = names.free(
				stem,
				(c) => free(c) || (ext !== undefined && free(`${c}.${ext}`)),
			)
			used.add(names.key(stem))
			if (ext) take(`${stem}.${ext}`)
			out.set(s, stem)
		}
		taken.set(h, used)
		// a union's members: their numbers in slot order, with a person's words
		for (const s of slots) {
			const ids = n.directory.get(s)!
			if (ids.length < 2) continue
			const e = prior?.get(s)
			const folder = out.get(s) as string
			const inner = new Set<string>()
			const mark = (name: string) => {
				inner.add(names.key(name))
				const x = names.extension(name)
				if (x) inner.add(names.key(name.slice(0, -x.length - 1)))
			}
			if (now !== undefined && Array.isArray(e)) others(join(now, e[0]), mark)
			const msided = new Set<string>()
			sidesOf(h, s, ids, (name) => {
				msided.add(names.key(name))
				const x = names.extension(name)
				if (x) msided.add(names.key(name.slice(0, -x.length - 1)))
			})
			const mfree = (c: string) => inner.has(names.key(c)) || msided.has(names.key(c))
			const stems = [folder]
			ids.forEach((id, i) => {
				let words = ""
				if (Array.isArray(e)) {
					const p = posWas(h, s, id)
					const m = p === undefined ? undefined : e[p + 1]
					words = (m === undefined ? undefined : names.number(m)?.[1])?.replace(FINALS, "") ??
						""
				}
				const ext = extOf(s, id)
				let m = names.cut(names.member(i + 1, words), ext ?? "")
				m = names.free(m, (c) => mfree(c) || (ext !== undefined && mfree(`${c}.${ext}`)))
				mark(m)
				if (ext) mark(`${m}.${ext}`)
				stems.push(m)
			})
			out.set(s, stems)
			taken.set(`${h}\0${s}`, inner)
		}
		return out
	}

	for (const id of order) {
		const x = graph.nodes.get(id)!
		const r = old.get(id)
		const back = r && !r.away ? r : undefined
		const rec: Layout = {}
		const h = homes.get(id)
		if (h) rec.home = h
		const folder = id === root || [...x.directory.values()].some((ids) => ids.length > 0) ||
			!!back?.folder
		if (folder) {
			rec.folder = true
			const e = entries(id)
			if (e.size) rec.entries = e
		}
		const [hash, form] = x.kept
		if (!(hash === NULL && folder)) {
			if (id === root) rec.file = `root.${names.suffix(form, x.head)}`
			else {
				const [holder, name, pos] = h!
				const e = layout.get(holder)!.entries!.get(name)!
				const stem = typeof e === "string" ? e : e[pos + 1]
				const same = back?.file !== undefined && home(back, holder, name) &&
					stemWas(id) === stem && (view.nodes.get(id)?.kept[1] ?? form) === form
				rec.file = same ? back!.file : `${stem}.${names.split(name, form, x.head, pass).ext}`
			}
			rec.laid = hash
			const w = back?.laid
			if (w !== undefined && w !== hash && was.get(fileOf(id, old))?.kind === "file") rec.was = w
			if (x.sides.length) rec.sides = sides(x, rec.file!, h)
		}
		layout.set(id, rec)
	}
	/**
	 * A node's sides' names, beside its file: its file's stem with one more
	 * .FINAL each, clear of the folder's names, each with the extension its
	 * slot's name gives it, or its own.
	 */
	function sides(x: Node, file: string, h: Home | undefined): string[] {
		const key = h === undefined
			? ERMINE
			: typeof layout.get(h[0])!.entries!.get(h[1]) === "string"
			? h[0]
			: `${h[0]}\0${h[1]}`
		let set = taken.get(key)
		if (!set) taken.set(key, set = new Set([names.key(file)]))
		const used = set
		const ext = names.extension(file)
		let stem = ext === undefined ? file : file.slice(0, -ext.length - 1)
		return x.sides.map(([, form, head]) => {
			const e = h === undefined
				? names.suffix(form, head)
				: names.split(h[1], form, head, pass).ext
			stem = names.free(
				stem + ".FINAL",
				(c) => used.has(names.key(c)) || used.has(names.key(`${c}.${e}`)),
			)
			used.add(names.key(stem))
			used.add(names.key(`${stem}.${e}`))
			return `${stem}.${e}`
		})
	}

	for (const [id, r] of old) {
		if (layout.has(id)) continue
		const { was: _w, left: _l, ...rest } = r
		layout.set(id, { ...rest, away: true })
	}

	const changed = new Map<Id, Layout>()
	for (const [id, r] of layout) {
		const o = old.get(id)
		if (!o || !alike(o, r)) changed.set(id, r)
	}
	const plan = diff(was, disk(graph, layout, pass), time, ino)
	return { layout, changed, plan }
}

/** The path of a node's file by a layout, "" if it has none. */
function fileOf(id: Id, layout: ReadonlyMap<Id, Layout>): string {
	const r = layout.get(id)
	if (r?.file === undefined || r.away) return ""
	if (!r.home) return `${ERMINE}/${r.file}`
	const at = room(layout, r.home)
	return at === undefined ? "" : join(at, r.file)
}

/** Whether two records say the same. */
function alike(a: Layout, b: Layout): boolean {
	const list = (x?: readonly unknown[], y?: readonly unknown[]) =>
		x === y || (!!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]))
	if (
		a.file !== b.file || a.laid !== b.laid || a.was !== b.was || !a.folder !== !b.folder ||
		!a.away !== !b.away || !list(a.home, b.home) || !list(a.left, b.left) ||
		!list(a.sides ?? [], b.sides ?? [])
	) return false
	const x = a.entries ?? new Map(), y = b.entries ?? new Map()
	if (x.size !== y.size) return false
	for (const [k, v] of x) {
		const w = y.get(k)
		if (typeof v === "string" ? v !== w : typeof w === "string" || !list(v, w)) return false
	}
	return true
}

/** What an entry is, wherever it is. */
function which(l: Laid): string {
	switch (l.kind) {
		case "file":
			return `f\0${l.id}`
		case "side":
			return `s\0${l.id}\0${l.side}`
		case "folder":
			return `d\0${l.id}`
		case "union":
			return `u\0${l.holder}\0${l.name}`
		case "link":
			return `l\0${l.home[0]}\0${l.home[1]}\0${l.id}\0${l.half}`
	}
}

/** What a step names besides: a node's id, a union's holder and slot, a file's form, a side's number. */
function named(l: Laid): Pick<Step, "id" | "slot" | "form" | "side"> {
	switch (l.kind) {
		case "file":
			return { id: l.id, form: l.form }
		case "side":
			return { id: l.id, form: l.form, side: l.side }
		case "union":
			return { slot: [l.holder, l.name] }
		default:
			return { id: l.id }
	}
}

/** Where an entry is: the folder it is in, an entry's key or "#" and a fixed path, and its name. */
type At = { up: string; name: string }

/** The steps that take the disk from one layout's entries to another's. */
function diff(
	from: ReadonlyMap<string, Laid>,
	to: ReadonlyMap<string, Laid>,
	time: number,
	ino?: (path: string) => number | null | undefined,
): Step[] {
	const tmp = (n: number) => `${TMP}/${time}.${n}`
	const was = new Map<string, { path: string; laid: Laid }>()
	for (const [path, laid] of from) was.set(which(laid), { path, laid })
	const now = new Map<string, { path: string; laid: Laid }>()
	for (const [path, laid] of to) now.set(which(laid), { path, laid })
	const where = (all: ReadonlyMap<string, { path: string }>) => {
		const byPath = new Map<string, string>()
		for (const [k, { path }] of all) byPath.set(path, k)
		const out = new Map<string, At>()
		for (const [k, { path }] of all) {
			out.set(k, { up: byPath.get(parent(path)) ?? `#${parent(path)}`, name: base(path) })
		}
		return out
	}
	const at = where(was)
	const want = where(now)
	const pathOf = (up: string): string => {
		if (up.startsWith("#")) return up.slice(1)
		const a = at.get(up)!
		return join(pathOf(a.up), a.name)
	}
	const path = (k: string) => {
		const a = at.get(k)!
		return join(pathOf(a.up), a.name)
	}
	// what each folder holds now, by the key its name compares by
	const kids = new Map<string, Map<string, string>>()
	const put = (k: string) => {
		const a = at.get(k)!
		let m = kids.get(a.up)
		if (!m) kids.set(a.up, m = new Map())
		m.set(names.key(a.name), k)
	}
	const out = (k: string) => {
		const a = at.get(k)!
		const m = kids.get(a.up)
		if (m?.get(names.key(a.name)) === k) m.delete(names.key(a.name))
	}
	for (const k of was.keys()) put(k)

	const found = (k: string): Found => {
		const { laid, path } = was.get(k)!
		if (laid.kind === "file" || laid.kind === "side") return { file: laid.hash }
		if (laid.kind === "link") return { link: laid.target }
		return { folder: ino?.(path) ?? null }
	}
	const made = (l: Laid): Found =>
		l.kind === "file" || l.kind === "side"
			? { file: l.hash }
			: l.kind === "link"
			? { link: l.target }
			: { folder: null }

	const gone = new Set<string>()
	const make = new Set<string>()
	const moved = new Set<string>()
	for (const [k, o] of was) {
		const w = now.get(k)
		if (!w) {
			gone.add(k)
			continue
		}
		const a = at.get(k)!, b = want.get(k)!
		const moves = a.up !== b.up || a.name !== b.name
		const reform = (o.laid.kind === "file" || o.laid.kind === "side") &&
			(w.laid.kind === "file" || w.laid.kind === "side") && o.laid.form !== w.laid.form
		if (reform || (o.laid.kind === "link" && moves)) {
			gone.add(k)
			make.add(k)
		} else if (moves) moved.add(k)
	}
	for (const k of now.keys()) if (!was.has(k)) make.add(k)

	const steps: Step[] = []
	const step = (s: Omit<Step, "number">) => {
		const number = steps.length + 1
		steps.push({ number, ...s })
		return number
	}
	/** Renames an entry into .ermine/tmp/ to wait there. */
	const away = (k: string) => {
		const f = found(k)
		const n = steps.length + 1
		step({
			what: "rename",
			from: path(k),
			to: tmp(n),
			before: f,
			after: f,
			...named(was.get(k)!.laid),
		})
		out(k)
		at.set(k, { up: `#${TMP}`, name: `${time}.${n}` })
	}
	const doomed = (k: string) => {
		for (let up = at.get(k)!.up; !up.startsWith("#"); up = at.get(up)!.up) {
			if (gone.has(up)) return true
		}
		return false
	}
	const depth = (p: string) => (p === "" ? 0 : p.split("/").length)
	const deepest = (a: [string, string], b: [string, string]) =>
		depth(b[1]) - depth(a[1]) || byCodePoint(a[1], b[1])

	// first, what goes, and what moves out of a folder that goes, deepest first
	const first = [...was.keys()].filter((k) => gone.has(k) || (moved.has(k) && doomed(k)))
		.map((k): [string, string] => [k, path(k)]).sort(deepest)
	for (const [k] of first) {
		if (!gone.has(k)) {
			away(k)
			continue
		}
		const n = step({
			what: "remove",
			from: path(k),
			before: found(k),
			after: null,
			...named(was.get(k)!.laid),
		})
		out(k)
		at.set(k, { up: `#${TMP}`, name: `${time}.${n}` })
	}

	// then each entry of the new layout, shallowest first
	const then = [...now].map(([k, { path }]): [string, string] => [k, path])
		.sort((a, b) => depth(a[1]) - depth(b[1]) || byCodePoint(a[1], b[1]))
	for (const [k] of then) {
		const w = now.get(k)!
		const b = want.get(k)!
		if (make.has(k) || moved.has(k)) {
			const occupant = kids.get(b.up)?.get(names.key(b.name))
			if (occupant !== undefined && occupant !== k && moved.has(occupant)) away(occupant)
			const to = join(pathOf(b.up), b.name)
			if (make.has(k)) {
				const l = w.laid
				const what = l.kind === "union" ? "folder" : l.kind === "side" ? "file" : l.kind
				const info = l.kind === "file" || l.kind === "folder" ? { info: l.info } : {}
				step({ what, to, before: null, after: made(l), ...named(l), ...info })
			} else {
				const f = found(k)
				step({ what: "rename", from: path(k), to, before: f, after: f, ...named(w.laid) })
				out(k)
			}
			at.set(k, b)
			put(k)
		}
		const o = was.get(k)?.laid
		if (!o || make.has(k)) continue
		const l = w.laid
		if (o.kind === "file" && l.kind === "file" && o.hash !== l.hash) {
			step({
				what: "file",
				to: path(k),
				before: { file: o.hash },
				after: { file: l.hash },
				id: l.id,
				form: l.form,
				info: l.info,
			})
		} else if (o.kind === "side" && l.kind === "side" && o.hash !== l.hash) {
			step({
				what: "file",
				to: path(k),
				before: { file: o.hash },
				after: { file: l.hash },
				...named(l),
			})
		} else if (
			(o.kind === "file" && l.kind === "file" || o.kind === "folder" && l.kind === "folder") &&
			!sameInfo(o.info, l.info)
		) {
			const f = l.kind === "file" ? { file: l.hash } : found(k)
			step({ what: "info", to: path(k), before: f, after: f, id: l.id, info: l.info })
		} else if (o.kind === "link" && l.kind === "link" && o.target !== l.target) {
			step({
				what: "link",
				to: path(k),
				before: { link: o.target },
				after: { link: l.target },
				id: l.id,
			})
		}
	}
	return steps
}

/** Whether two infos are the same names with the same values, in the same order. */
export function sameInfo(a: Info, b: Info): boolean {
	return a.length === b.length &&
		a.every(([n, h, f], i) => b[i][0] === n && b[i][1] === h && b[i][2] === f)
}
