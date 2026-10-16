// the files program (program.ts) on the line protocol (conformance/typescript/harness.ts). A host's
// view of the program: a store, the graph of today (graph.ts) holding what the store read, the
// program started as the host starts it, and a watcher whose passes the scenario runs itself (no
// disk events, no timing). It works on a temp folder of the run's own (disk.ts): the store at
// @Store, its Trash @Trash (a fake), a test home @Home, so the real Trash and home are never used;
// the harness makes the edits a scenario asks for and looks at the folder and the Trash itself, as
// disk.ts has it. Values are in their JSON form (conformance/typescript/form.ts). Another
// implementation joins by speaking this (HARNESS): a C harness on the C graph and the C store.
//
// A node is named by a path: a list of slot names from the root, each a string (the slot's first
// item) or [name, index] (its item at index, from 0). [] is the root. Ids: the harness mints every
// id, "i1", "i2", ... in the order they are asked for, through the whole process (a second open
// does not start again), and every answer shows them as disk.ts does: "id1" for the first met,
// "id2" for the next, ...; the temp folder in a path is "@".
//
//   {op: "open", refuse?, aliases?}
//                    -> {root}  a store on @Store (files: true, the files program's store); read;
//                       a graph holding what it read (or a root "r" holding nothing); no program
//                       yet. An earlier open's program is stopped. refuse: slot names the host's
//                       protect refuses to place; aliases: {path: target}, the Finder aliases the
//                       host knows: the file at path (from the store's folder) is an alias to the
//                       entry at target
//   {op: "place", path, slot, value?, at?}
//                    -> {id}  a node made holding value (none: no value), by the host, and placed
//                       in the slot of the node at path, at position at (from 0; the end)
//   {op: "mount", path, slot, to, at?}
//                    -> {}  the node at path `to` placed in that slot too
//   {op: "write", path, value}
//                    -> {}  the value of the node at path written whole, by the host
//   {op: "remove", path}
//                    -> {}  the node at path unplaced from the slot it is shown by
//   {op: "save"}     -> {}  the graph written to the store, as the host does after a change
//   {op: "start"}    -> {}  the files program started, with a watcher whose actor is "tester";
//                       the watcher saves after a pass that made changes
//   {op: "pass", touched?}
//                    -> {called, settled}  one pass of the watcher now: over the folders touched
//                       (paths from the store's folder, "" its own), every folder if none are
//                       given. called: edit was called; settled: the store finds no differences
//                       between the folder and the layout afterwards
//   {op: "graph"}    -> {root, nodes}  the graph from the root, ephemeral nodes left out: a node
//                       {id, value: [{content, actor}], slots: [[name, [node]]]}, slots by name in
//                       code point order, each item of the slot (a slot holding only ephemeral
//                       nodes is left out); a node met before is {id, again: true}; an id nothing
//                       is loaded for is {id, unloaded: true}. actor: the change's actor
//   {op: "listed"}   -> {listed: [{path, why}]}  what the program wrote to its listed node since
//                       the last asked, in order; why as a code (WHY below)
//   {op: "edit", edit, ...}
//                    -> {}  the edit made on the disk (disk.ts)
//   {op: "observe"}  -> {folder, trash, listed}  disk.ts's snapshot, listed as the listed request
//                       answers
//   a failure        -> {error: message}
import { createGraph, type Graph } from "./graph.ts"
import { type Files, files } from "./program.ts"
import createNode from "./saved.ts"
import { type Store, store } from "./store.ts"
import { fake, type Sys, system } from "./sys.ts"
import type { Foundation } from "./foundation.ts"
import { byCodePoint } from "./names.ts"
import { type Watcher, watcher } from "./watch.ts"
import { Disk, IDS, programSnapshot } from "./disk.ts"
import { no, type Policy, yes } from "@ermine/protect"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

type Item = string | [string, number]
type Path = Item[]

// why the program lists an entry, as a code: its own fixed texts, by how they start
const WHY: [string, string][] = [
	["refused: ", "refused"],
	["an edit to the root's file met a change", "root-met"],
	["an edit to a side whose version changed since it was laid", "side-changed"],
	["a side renamed: the store lays it again", "side-renamed"],
	["a side removed: the store lays it again", "side-removed"],
	["a link that leads nowhere in the store", "link-nowhere"],
	["does not read: ", "unread"],
]
const code = (why: string) => WHY.find(([start]) => why.startsWith(start))?.[1] ?? "other"

const disk = await Disk.make("ermine-program-conf-", IDS)

// a counter for the whole process: the ids the harness mints
let minted = 0
const mint = () => `i${++minted}`

type Host = {
	t: Store
	g: Graph
	w: Watcher
	running?: Files
	told: number
}
let at: Host | undefined
const it = () => {
	if (!at) throw new Error("no store: open one first")
	return at
}

// no Foundation: nothing is in iCloud, there are no bookmarks, a coordinated write is just made
const plain: Foundation = {
	coordinate: (_path, _writing, fn) => fn(),
	bookmark: () => undefined,
	resolve: () => undefined,
	ubiquitous: () => false,
	alias: () => undefined,
}

async function open(r: Request) {
	at?.running?.stop()
	const sys: Sys = {
		...system(),
		sync: () => Promise.resolve(),
		trash: () => Promise.reject(new Error("the harness never uses the real Trash")),
	}
	const folder = disk.store
	const t = store(folder, {
		sys,
		trash: fake(disk.trash),
		files: true,
		home: disk.home,
		foundation: plain,
		coordinate: false,
	})
	const restored = await t.read()
	const root = restored?.root ?? "r"
	const clock = { time: restored?.time ?? 0 }
	const refuse = (r.refuse ?? []) as string[]
	const may: Policy | undefined = refuse.length
		? (ask) =>
			ask.op === "place" && refuse.includes(String(ask.target.field?.[0])) ? no("refused") : yes
		: undefined
	const g = createGraph({ root, may, ids: mint })
	if (restored) {
		for (const n of restored.nodes) g.intro(n)
		for (const n of restored.others) g.intro(n)
	} else g.intro(createNode(root, {}, { header: { time: 0 } }))
	// a change's time is the wall clock's, in whole seconds: a batch is no earlier than any
	const save = () => {
		clock.time = Math.max(clock.time, Math.floor(Date.now() / 1000))
		return t.write({ root, get: g.get, time: clock.time, ephemeral: g.ephemeral })
	}
	const aliases = (r.aliases ?? {}) as Record<string, string>
	const w = watcher({
		store: t,
		events: false,
		save,
		actor: "tester",
		alias: (p) => {
			const rel = p.slice(folder.length + 1)
			return rel in aliases ? `${folder}/${aliases[rel]}` : undefined
		},
	})
	at = { t, g, w, told: 0 }
	return { root }
}

// ---- nodes by path

const named = (e: Item): [string, number] => typeof e === "string" ? [e, 0] : e
function find(path: Path): string {
	const { g } = it()
	const api = g.api("host")
	let cur = g.root
	for (const e of path) {
		const [name, i] = named(e)
		const next = api.ids(cur, name)[i]
		if (next === undefined) throw new Error(`nothing at ${JSON.stringify(path)}`)
		cur = next
	}
	return cur
}

function actorOf(change: unknown) {
	const a = (change as { actor?: unknown } | undefined)?.actor
	return a !== null && typeof a === "object" ? (a as { actor?: unknown }).actor : a
}

function graph() {
	const { g } = it()
	const seen = new Set<string>()
	const show = (id: string): unknown => {
		const n = g.get(id)
		if (!n) return { id, unloaded: true }
		if (seen.has(id)) return { id, again: true }
		seen.add(id)
		const slots = [...n.children].flatMap(([name, vs]) => {
			const ids = (vs[0]?.content ?? []).filter((x): x is string => typeof x === "string")
			const shown = ids.filter((x) => !g.ephemeral(x))
			// a slot of nothing but ephemeral nodes, as the program's, is not the graph's
			return ids.length > 0 && shown.length === 0 ? [] : [[name, shown.map(show)] as const]
		}).sort(([a], [b]) => byCodePoint(a, b))
		return {
			id,
			value: n.value.map((v) => ({ content: toJson(v.content), actor: actorOf(v.change) })),
			slots,
		}
	}
	return { root: g.root, nodes: show(g.root) }
}

/** what the program listed since last asked */
function listed() {
	const h = it()
	const all = (h.running ? h.g.api().value(h.running.listed) ?? [] : []) as {
		path: string
		why: string
	}[]
	const out = all.slice(h.told).map((x) => ({ path: x.path, why: code(x.why) }))
	h.told = all.length
	return out
}

async function run(r: Request): Promise<Answer> {
	switch (r.op) {
		case "open":
			return await open(r)
		case "place": {
			const { g } = it()
			const api = g.api("host")
			const holder = find(r.path as Path)
			const id = "value" in r ? api.create(fromJson(r.value)) : api.create()
			api.insert(holder, r.slot as string, id, r.at as number | undefined)
			return { id }
		}
		case "mount": {
			const { g } = it()
			g.api("host").insert(
				find(r.path as Path),
				r.slot as string,
				find(r.to as Path),
				r.at as number | undefined,
			)
			return {}
		}
		case "write": {
			const { g } = it()
			g.api("host").write(find(r.path as Path), [{ path: [], value: fromJson(r.value) }])
			return {}
		}
		case "remove": {
			const { g } = it()
			const path = r.path as Path
			const [name, i] = named(path.at(-1)!)
			g.api("host").remove(find(path.slice(0, -1)), name, i)
			return {}
		}
		case "save": {
			const { t, g } = it()
			await t.write({
				root: g.root,
				get: g.get,
				time: Math.floor(Date.now() / 1000),
				ephemeral: g.ephemeral,
			})
			return {}
		}
		case "start": {
			const h = it()
			h.running = files({ store: h.t, watch: h.w, graph: h.g })
			return {}
		}
		case "pass": {
			const h = it()
			const done = await h.w.pass(r.touched as string[] | undefined)
			return { called: done !== undefined, settled: (await h.t.differences()).length === 0 }
		}
		case "graph":
			return graph()
		case "listed":
			return { listed: listed() }
		case "edit":
			await disk.edit(r, disk.store)
			return {}
		case "observe":
			return await programSnapshot(disk, disk.deep(listed()))
		default:
			return { error: `unknown op ${r.op}` }
	}
}

async function answer(r: Request): Promise<Answer> {
	let a: unknown
	try {
		a = await run(r)
	} catch (e) {
		a = { error: String((e as Error)?.message ?? e) }
	}
	return disk.deep(a) as Answer
}

if (import.meta.main) {
	try {
		await serve(answer)
	} finally {
		at?.running?.stop()
		await disk.remove()
	}
	Deno.exit(0)
}
