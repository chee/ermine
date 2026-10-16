// the store (store.ts) on the line protocol (conformance/typescript/harness.ts). One store object at
// a time, made by open, on a temp folder of the run's own (disk.ts): the harness makes the edits a
// scenario asks for and looks at the folder and the Trash itself, as disk.ts has it, never through
// the store. Nodes in pack's JSON form: {id, value, info, children, header?}, every content, change
// and because a value in its JSON form (conformance/typescript/form.ts). Hashes are 64 lowercase
// hex digits; bytes lowercase hex. Every answer is shown as disk.ts shows it: the temp folder "@",
// each store's uuid "uuid", "uuid2", ... in the order met; a request's uuid label is the uuid.
//   {op: "open", folder?, mirror?, files?, pass?, slack?}
//                         -> {}  a new store object on folder (a "@" path; none: @Store), its
//                            Trash @Trash (sys.ts's fake: an entry moved in under its name, or
//                            "stem 2.ext", "stem 3.ext", ...), the real Trash never asked;
//                            nothing read yet. Every later request is to it, and an edit's plain
//                            path is from its folder. Its home is @Home, whose .ermine/external
//                            holds outside manifests and the list of stores, so the person's own
//                            is never touched; @Outside the one place whose folders keep their
//                            manifests outside, on home's volume. The platform's Foundation is
//                            not asked: no folder is in iCloud, there are no bookmarks (a store is
//                            found again by its path, if the folder there carries its uuid),
//                            nothing is coordinated. mirror: a folder that is not a store
//                            (FILES.tex, A folder that is not a store), its root the given graph's
//   {op: "read"}          -> {restored: null} for a new store | {restored: {root, time, nodes,
//                            others, missing}}
//   {op: "read", root, time, nodes, ephemeral?}
//                         -> {}  for a mirror: read(saving), the graph the host has now, as write
//                            takes it (no records)
//   {op: "stores"}        -> {stores: [{uuid, path}]}  stores(): every store home's list has, by
//                            path
//   {op: "find", uuid}    -> {path: path | null}  find(uuid): where the store is now
//   {op: "write", root, time, nodes, ephemeral?, records?}
//                         -> {}  write({root, get, time, ephemeral, records}): get gives the
//                            node of nodes with that id, or none; ephemeral the ids that are;
//                            records {key: hex | null}
//   {op: "graph"}         -> {root, nodes: [{id, kept, head?, sides, info, directory}]}  graph(),
//                            nodes by id in code point order; kept [hash, form]; head hex; sides
//                            [[hash, form, head?]]; info [[name, hash, form]]; directory [[name,
//                            [ids]]]
//   {op: "others"}        -> {others: {key: hex}}  others(), keys in code point order
//   {op: "differences", touched?}
//                         -> {differences: [{path, was?, now?}]}  differences(touched), by path
//                            in code point order; was a Laid as types.ts has it; now an Entry less
//                            its ino, its value in JSON form, its why (a FormError's text) as true
//   {op: "mend", paths?}  -> {}
//   {op: "trash", path, why}
//                         -> {}
//   {op: "lock", run}     -> run's answer, run (differences, mend, trash, graph, others) inside
//                            lock()
//   {op: "listed"}        -> {listed: [{path, why}]}  what options.list was told since the last
//                            listed, in order; why as a code (WHY below), or as given to a trash
//                            request
//   {op: "edit", edit, ...}
//                         -> {}  the edit made on the disk (disk.ts)
//   {op: "observe", attrs?, folder?, at?}
//                         -> {folder, trash, listed, at?}  disk.ts's snapshot, listed as the
//                            listed request answers
//   a StoreError          -> {error: "store"}
//   anything else thrown  -> {error: "other", message}
// Another implementation joins by speaking this (HARNESS).
import createNode, {
	type ChangeHeader as Header,
	type List,
	type Node,
	type Side as Version,
} from "./saved.ts"
import { type Restored, type Saving, type Store, store } from "./store.ts"
import { fake, system } from "./sys.ts"
import type { Foundation } from "./foundation.ts"
import { find, type Mirror, mirror, stores } from "./store.ts"
import { byCodePoint } from "./names.ts"
import { StoreError } from "./types.ts"
import { Disk, storeSnapshot, UUIDS } from "./disk.ts"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

type V = Version<unknown, unknown>
type N = Node<unknown, unknown>
type Shown = {
	id: string
	value?: V[]
	info?: [string, V[]][]
	children?: [string, V[]][]
	header?: Header
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// why a store lists an entry, as a code: its own fixed texts, by how they start; anything else
// is a file system's error text, "fault", unless a trash request gave it
const WHY: [string, string][] = [
	["left in the store's tmp holding entries", "tmp-held"],
	["the info ", "info-too-big"],
	["an entry the store could not lay out held others' work", "others-work"],
	["another entry is where the store lays one", "taken"],
	["a folder the store removed held others' entries", "folder-held"],
	["an edit whose place was taken", "edit-taken"],
	["not what the store laid", "not-laid"],
	["what the store was moving here is not where it was", "moved-away"],
	["laid out by a layout record that did not fit the graph", "unfit"],
	["not in the graph", "not-in-graph"],
	["the manifest of the store this folder is a copy of", "copied"],
]
const given = new Set<string>()
const code = (why: string) =>
	given.has(why) ? why : WHY.find(([start]) => why.startsWith(start))?.[1] ?? "fault"

// ---- nodes, in and out
const versions = (vs: V[] = []): V[] =>
	vs.map((v) => {
		const out: V = { content: fromJson(v.content), change: fromJson(v.change) }
		if ("because" in v) out.because = fromJson(v.because)
		return out
	})
const lists = (vs: V[] = []): Version<List, unknown>[] =>
	vs.map((v) => {
		const out: Version<List, unknown> = {
			content: v.content as string[],
			change: fromJson(v.change),
		}
		if ("because" in v) out.because = fromJson(v.because)
		return out
	})
const header = (h: Header, f: (x: unknown) => unknown): Header => {
	const out: Header = { ...h }
	if ("actor" in h) out.actor = f(h.actor)
	if ("cause" in h) out.cause = f(h.cause)
	return out
}
const node = (s: Shown): N =>
	createNode(s.id, {
		value: versions(s.value),
		attributes: (s.info ?? []).map(([name, vs]) => [name, versions(vs)] as const),
		children: (s.children ?? []).map(([name, vs]) => [name, lists(vs)] as const),
	}, { header: header(s.header ?? {}, fromJson) })

const json = (vs: V[]): V[] =>
	vs.map((v) => {
		const out: V = { content: toJson(v.content), change: toJson(v.change) }
		if ("because" in v) out.because = toJson(v.because)
		return out
	})
const show = (n: N): Shown => ({
	id: n.id,
	value: json(n.value),
	info: [...n.attributes].map(([name, vs]) => [name, json(vs)]),
	children: [...n.children].map(([name, vs]) => [
		name,
		vs.map((v) => {
			const out: V = { content: [...v.content], change: toJson(v.change) }
			if ("because" in v) out.because = toJson(v.because)
			return out
		}),
	]),
	header: header(n.change, toJson),
})
const restored = (r: Restored | undefined) =>
	r === undefined ? null : {
		root: r.root,
		time: r.time,
		nodes: r.nodes.map(show),
		others: r.others.map(show),
		missing: r.missing,
	}

// ---- the store
const disk = await Disk.make("ermine-store-conf-", UUIDS)
// the folder the store was last opened on, which edits' plain paths and the snapshot follow
let folder = disk.store
let at: Store | Mirror | undefined
let home: string | undefined
let isMirror = false
let listed: { path: string; why: string }[] = []
const it = () => {
	if (!at) throw new Error("no store: open one first")
	return at as Store
}

// no Foundation: nothing is in iCloud, there are no bookmarks, a coordinated write is just made
const plain: Foundation = {
	coordinate: (_path, _writing, fn) => fn(),
	bookmark: () => undefined,
	resolve: () => undefined,
	ubiquitous: () => false,
	alias: () => undefined,
}

/** What a write and a mirror's read are given. */
function saving(r: Request): Saving {
	const table = new Map((r.nodes as Shown[]).map((s) => [s.id, node(s)]))
	const ephemeral = new Set((r.ephemeral ?? []) as string[])
	const records = r.records === undefined ? undefined : new Map(
		Object.entries(r.records as Record<string, string | null>).map((
			[k, v],
		) => [k, v === null ? null : unhex(v)]),
	)
	return {
		root: r.root as string,
		time: r.time as number,
		get: (id) => table.get(id),
		ephemeral: (id) => ephemeral.has(id),
		...(records ? { records } : {}),
	}
}

function open(given: Request) {
	folder = typeof given.folder === "string" ? disk.path(given.folder, disk.store) : disk.store
	const r: Request = {
		...given,
		folder,
		trash: disk.trash,
		home: disk.home,
		outside: [disk.outside],
	}
	const sys = {
		...system(),
		trash: () => Promise.reject(new Error("the harness never uses the real Trash")),
	}
	const options: Parameters<typeof store>[1] = {
		sys,
		trash: fake(r.trash as string),
		list: (item) => listed.push({ path: item.path, why: code(item.why) }),
		home: r.home as string,
		foundation: plain,
		coordinate: false,
	}
	if (r.outside !== undefined) options.outside = r.outside as string[]
	if (r.files !== undefined) options.files = r.files as boolean
	if (r.pass !== undefined) options.pass = r.pass as string[]
	if (r.slack !== undefined) options.slack = r.slack as number
	home = r.home as string
	isMirror = r.mirror === true
	at = isMirror ? mirror(r.folder as string, options) : store(r.folder as string, options)
}

function graph() {
	const g = it().graph()
	const nodes = [...g.nodes].sort(([a], [b]) => byCodePoint(a, b)).map(([id, n]) => {
		const out: Record<string, unknown> = { id, kept: n.kept }
		if (n.head) out.head = hex(n.head)
		out.sides = n.sides.map(([h, f, head]) => head ? [h, f, hex(head)] : [h, f])
		out.info = n.info
		out.directory = [...n.directory]
		return out
	})
	return { root: g.root, nodes }
}

async function run(r: Request): Promise<Answer> {
	switch (r.op) {
		case "open":
			open(r)
			return {}
		case "read":
			if (isMirror) {
				await (at as Mirror).read(saving(r))
				return {}
			}
			return { restored: restored(await it().read()) }
		case "write":
			await it().write(saving(r))
			return {}
		case "stores":
			return {
				stores: (await stores({ home, foundation: plain })).map(({ uuid, path }) => ({
					uuid,
					path,
				}))
					.sort((a, b) => byCodePoint(a.path, b.path)),
			}
		case "find":
			return {
				path: (await find(disk.raw(r.uuid as string), { home, foundation: plain })) ?? null,
			}
		case "graph":
			return graph()
		case "others":
			return {
				others: Object.fromEntries(
					[...it().others()].sort(([a], [b]) => byCodePoint(a, b)).map((
						[k, v],
					) => [k, hex(v)]),
				),
			}
		case "differences": {
			const d = await it().differences(r.touched as string[] | undefined)
			return {
				differences: d.sort((a, b) => byCodePoint(a.path, b.path)).map(({ path, was, now }) => {
					const out: Record<string, unknown> = { path }
					if (was) out.was = was
					if (now) {
						const { ino: _, ...rest } = now as typeof now & { ino?: number }
						const e: Record<string, unknown> = { ...rest }
						if ("value" in e) e.value = toJson(e.value)
						if ("why" in e) e.why = true
						out.now = e
					}
					return out
				}),
			}
		}
		case "mend":
			await it().mend(r.paths as string[] | undefined)
			return {}
		case "trash":
			given.add(r.why as string)
			await it().trash(r.path as string, r.why as string)
			return {}
		case "lock":
			return await it().lock(() => run(r.run as Request))
		case "listed":
			return { listed: took() }
		case "edit":
			await disk.edit(r, folder)
			return {}
		case "observe": {
			const shown = r.folder === undefined ? folder : disk.path(r.folder as string, disk.store)
			return await storeSnapshot(disk, shown, disk.deep(took()), r)
		}
		default:
			return { error: "other", message: `unknown op ${r.op}` }
	}
}

/** what options.list was told since last asked */
function took() {
	const out = listed
	listed = []
	return out
}

async function answer(r: Request): Promise<Answer> {
	let a: unknown
	try {
		a = await run(r)
	} catch (e) {
		a = e instanceof StoreError
			? { error: "store" }
			: { error: "other", message: String((e as Error)?.message ?? e) }
	}
	return disk.deep(a) as Answer
}

if (import.meta.main) {
	try {
		await serve(answer)
	} finally {
		await disk.remove()
	}
	Deno.exit(0)
}
