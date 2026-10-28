// tie: an ermine's shared folder kept in a tippet log (experiments/tippet), so every ermine tied to
// one room holds the same nodes. tippet's history runs on the ermine's own table: a kept write is a
// step, and a step from elsewhere is written into the table as it lands. steps name nodes by id, a
// node's place being its folder's names (that folder's children, kept as the rest are), so a rename
// is the same node at another name. kept: the value, attributes and children of every node the
// folder reaches, but the local ones (paths each ermine writes for itself: a clock's)
//
// the server ties the folder its setup made, and what is there is written as steps first; a page
// ties its empty ermine to the server's folder by its id, placed at the same path before anything
// lands, and starts its processes once it has caught up
//
//   const t = await createTie(ermine, { at: "/shared", local: ["/shared/beat-step"] })   // server
//   const t = await createTie(ermine, { at: "/shared", id, local })                       // a page
//   t.sync.link(socket(ws))
import { ensureNode, type Ermine, patchChildren, pulse } from "@ermine/system"
import { get } from "@ermine/core/places/lib"
import type { Places } from "@ermine/core/places"
import type { Key } from "@ermine/core/table"
import { createHistory, createLog, createSync } from "@ermine/tippet"

type Fact = Parameters<Parameters<Places["watchAll"]>[0]>[0]
type Recorder = (f: Fact) => void

const PARTS = ["value", "attributes", "children"]
// the deepest a folder is looked for, walking up
const DEEPEST = 64
const pathOf = (p: string) => p.split("/").filter(Boolean)
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)

// a room's websocket closed with this: not the room the page was rendered from (room.ts), so the
// page loads again
export const OTHER_ROOM = 4000

export type Tie = Awaited<ReturnType<typeof createTie>>
// what carries a room's bytes (tippet's carriers)
export type Link = Parameters<Tie["sync"]["link"]>[0]

export async function createTie(ermine: Ermine, o: {
	// the folder's path
	at: string
	// a page's: the server's folder, by id. none: the folder this ermine has at at
	id?: string
	// paths in it each ermine writes for itself
	local?: string[]
	// the device's key (32 bytes); none: a new device
	seed?: Uint8Array
}) {
	const at = pathOf(o.at)
	const host = <T>(f: () => T) => ermine.within(f)
	if (o.id) {
		const id = o.id
		const folder = at.slice(0, -1)
		host(() => {
			if (folder.length) ensureNode(`/${folder.join("/")}`)
			patchChildren(`/${folder.join("/")}`, [{
				path: [at.at(-1)!],
				value: ermine.handleOf({ id, part: "value" } as never),
			}])
		})
	}
	const root = o.id ?? get(ermine.places, at)
	if (typeof root !== "string") throw new Error(`nothing at ${o.at}`)

	// each node's folder, as the names that reached it last said; the local paths' ids, as they are
	const folder = new Map<string, string>()
	let local = new Set<unknown>()
	function learn(f: Fact) {
		if (f.part !== "children" || typeof f.id !== "string") return
		const at = f.id
		const names = ermine.table.get("children" as Key, f.id)?.value
		if (isMap(names)) {
			Object.values(names).forEach((id) => typeof id === "string" && folder.set(id, at))
		}
		local = new Set(
			(o.local ?? []).map((p) => get(ermine.places, pathOf(p))).filter((x) =>
				typeof x === "string"
			),
		)
	}
	const under = (id: string, n = 0): boolean =>
		id === root || (n < DEEPEST && folder.has(id) && under(folder.get(id)!, n + 1))
	const kept = (id: string, part: string) => PARTS.includes(part) && !local.has(id) && under(id)
	// a process's write said by its process's path ("/visitors/<id>"), which its step carries (who):
	// where it lands, explain's change.actor says it (its writer there is "outside")
	const said = (f: Fact): Fact => {
		const process = (f.change?.metadata as { process?: unknown } | undefined)?.process
		if (!f.change || typeof f.change.actor === "string" || !Array.isArray(process)) return f
		return { ...f, change: { ...f.change, actor: `/${process.join("/")}` } }
	}

	// the recorder is told a commit's facts once the commit is over: a node's value comes before its
	// folder's names do, and it isn't known to be in the folder till then. what history writes as a
	// step lands is told to nobody
	const recorders: Recorder[] = []
	let landing = 0
	let held: Fact[] = []
	// steps landed are written into the table as they are, so what read them is run once they all
	// have (a write through @ermine/system's functions pulses by itself)
	let pulsing = false
	const settle = () => {
		if (pulsing) return
		pulsing = true
		queueMicrotask(() => {
			pulsing = false
			host(() => pulse())
		})
	}
	const tell = () => {
		const facts = held
		held = []
		facts.forEach((f) => recorders.forEach((r) => r(said(f))))
	}
	const unwatch = ermine.places.watchAll((f) => {
		if (typeof f.id !== "string") return
		learn(f)
		if (landing) return
		if (held.push(f) === 1) queueMicrotask(tell)
	})

	const log = createLog({ writes: true, seed: o.seed })
	await log.load()
	const history = createHistory({
		log,
		table: ermine.table,
		places: {
			commit: (changed) => ermine.places.commit(changed),
			watchAll(fn: Recorder) {
				recorders.push(fn)
				return () => void recorders.splice(recorders.indexOf(fn), 1)
			},
		} as Pick<Places, "commit" | "watchAll">,
		run: <T>(f: () => T): T => {
			landing++
			try {
				return host(f)
			} finally {
				landing--
				settle()
			}
		},
		kept,
	})
	const sync = createSync({ log })

	// the server's: what the folder holds now, each entry a whole step
	if (!o.id) {
		const walk = (id: string) =>
			PARTS.forEach((part) => {
				const e = ermine.table.get(part as Key, id)
				if (e?.value === undefined) return
				const f = {
					part,
					id,
					patches: [{ path: [], value: e.value }],
					change: e.change,
					entry: e,
				}
				learn(f as Fact)
				if (kept(id, part)) recorders.forEach((r) => r(f as Fact))
				if (part === "children" && isMap(e.value)) {
					Object.values(e.value).forEach((kid) => typeof kid === "string" && walk(kid))
				}
			})
		walk(root)
	}

	return {
		// the folder's id
		root,
		// what is held for the recorder, told now (before a log's have is read)
		flush: tell,
		log,
		sync,
		history,
		stop() {
			unwatch()
			history.stop()
		},
	}
}
