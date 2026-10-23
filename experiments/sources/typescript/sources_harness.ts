// sources on the line protocol: one JSON request per line in, one answer per line out, in order.
// everything lives for the run, by the name given it. a graph (world.ts) is a scheduler, table and
// places with a history, its device's actor its name; where a holder is asked for, a graph's name
// means its history. files are in memory (access.ts's fake): "edit" is another process writing one
//
// { op: "graph", name }                         → {}
// { op: "memory", name, lists?, refuse? }       → {}   lists false: no since. refuse: a node it
//    won't hold ("not-here")
// { op: "file", name, file }                    → {}   a holder over the file named (made empty)
// { op: "link", name, a, b, limit?, live? }     → {}   live: started, synced whenever poked
// { op: "sync", link } | { op: "round", link }   → { ab, ba }   each: { sent, taken, passed,
//    refused: [why], behind }; sync until nothing moves, round one batch each way
// { op: "fetch", link, node }                   → { ab, ba }   asked by node, with get
// { op: "status", link }                        → { known: { a, b }, refused: [why] }
// { op: "set", graph, node, value, path? }      → {}   a write in the graph, by its device
// { op: "value", graph, node }                  → { value } | {}
// { op: "heads", graph, node }                  → { count }   the value part's
// { op: "writes", holder, node? }               → { count, nodes }   all it lists (since), or a
//    node's (get); nodes: the node of each, in order
// { op: "drop", holder, node }                  → {}
// { op: "forge", holder }                       → { outcome }   a write whose name is not its own
// { op: "mirror", graph, node, file, actor }    → {}   the node's value mirrored to the file as
//    text, by a device of its own
// { op: "edit", file, text }                    → {}   another process writes the file
// { op: "text", file }                          → { text } | {}
// { op: "fail", file, on }                      → {}   on: the file's writes throw
// { op: "settle" }                              → {}   every watch heard, every live link idle
// { op: "same", graphs, node }                  → { same }   every graph's value at node alike
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createFakeFile, type FakeFile } from "./access.ts"
import { openFile } from "./file.ts"
import type { Holder } from "./holder.ts"
import { createLink, type Leg, type Link } from "./link.ts"
import { createMemory } from "./memory.ts"
import { type Mirror, openMirror, text } from "./mirror.ts"
import { name, same } from "./write.ts"
import { createWorld, type World } from "./world.ts"

const graphs = new Map<string, World>()
const holders = new Map<string, Holder>()
const links = new Map<string, { link: Link; live: boolean }>()
const files = new Map<string, FakeFile>()
const mirrors: Mirror[] = []

function find<T>(map: Map<string, T>, key: unknown, what: string): T {
	const got = map.get(String(key))
	if (got === undefined) throw new Error(`no ${what} ${key}`)
	return got
}

const graph = (key: unknown) => find(graphs, key, "graph")
const holder = (key: unknown) =>
	graphs.has(String(key)) ? graph(key).history : find(holders, key, "holder")
const link = (key: unknown) => find(links, key, "link").link
function file(key: unknown) {
	let f = files.get(String(key))
	if (f === undefined) files.set(String(key), f = createFakeFile())
	return f
}

const leg = (l: Leg) => ({
	sent: l.sent,
	taken: l.taken,
	passed: l.passed,
	refused: l.refused.map((r) => r.why.split(":")[0]),
	behind: l.behind,
})

// a few turns, so every watch is heard and every live link and mirror has run
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0))
		for (const { link, live } of links.values()) if (live) await link.idle()
		for (const m of mirrors) await m.idle()
	}
}

export async function answer(r: Request): Promise<Record<string, unknown>> {
	switch (r.op) {
		case "graph":
			graphs.set(String(r.name), createWorld(String(r.name)))
			return {}
		case "memory": {
			const refuse = r.refuse === undefined
				? undefined
				: (w: { node: string }) => w.node === r.refuse ? "not-here" : undefined
			holders.set(String(r.name), createMemory({ lists: r.lists, refuse }))
			return {}
		}
		case "file":
			holders.set(String(r.name), await openFile(file(r.file)))
			return {}
		case "link": {
			const made = createLink(holder(r.a), holder(r.b), { limit: r.limit })
			links.set(String(r.name), { link: made, live: r.live === true })
			if (r.live) made.start()
			return {}
		}
		case "sync":
		case "round": {
			const round = await (r.op === "sync" ? link(r.link).sync() : link(r.link).round())
			return { ab: leg(round.ab), ba: leg(round.ba) }
		}
		case "fetch": {
			const round = await link(r.link).fetch(String(r.node))
			return { ab: leg(round.ab), ba: leg(round.ba) }
		}
		case "status": {
			const s = link(r.link).status()
			return { known: s.known, refused: s.refused.map((x) => x.why.split(":")[0]) }
		}
		case "set":
			graph(r.graph).set(String(r.node), r.value, r.path)
			return {}
		case "value": {
			const v = graph(r.graph).value(String(r.node))
			return v === undefined ? {} : { value: v }
		}
		case "heads":
			return { count: graph(r.graph).history.heads(String(r.node), "value").length }
		case "writes": {
			const h = holder(r.holder)
			const ws = r.node === undefined ? (await h.since!()).writes : await h.get!(String(r.node))
			return { count: ws.length, nodes: ws.map((w) => w.node) }
		}
		case "drop":
			await holder(r.holder).drop(String(r.node))
			return {}
		case "forge": {
			const real = name({
				node: "N",
				part: "value",
				parents: [],
				patches: [{ path: [], value: 1 }],
				change: { time: 0, actor: "nobody" },
			})
			const [outcome] = await holder(r.holder).put([{ ...real, name: "0".repeat(64) }])
			return { outcome }
		}
		case "mirror": {
			const g = graph(r.graph)
			const scope = g.scheduler.createRootScope({ actor: r.actor })
			mirrors.push(
				await openMirror({
					...g,
					scope,
					node: String(r.node),
					file: file(r.file),
					codec: text,
				}),
			)
			return {}
		}
		case "edit":
			file(r.file).edit(new TextEncoder().encode(String(r.text)))
			return {}
		case "text": {
			const bytes = file(r.file).bytes
			return bytes === undefined ? {} : { text: new TextDecoder().decode(bytes) }
		}
		case "fail":
			file(r.file).fail = r.on === true
			return {}
		case "settle":
			await settle()
			return {}
		case "same": {
			const values = (r.graphs as string[]).map((g) => graph(g).value(String(r.node)))
			return { same: values.every((v) => same(v, values[0])) }
		}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
