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
// ephemeral: paths whose nodes' values and attributes are never kept, only sent as they are
// written (the node there and every node under it; their names are kept, so every ermine holds the
// same nodes). a page sends its writes to the server, which sends every one on to every page, its
// own and a page's (the page that wrote it too, so a page ends on what the server has), as tippet's
// live messages; a page linking is sent them all first, as they are now (started)
//
//   const t = await createTie(ermine, { at: "/shared", local: ["/shared/beat-step"] })   // server
//   const t = await createTie(ermine, { at: "/shared", id, local })                       // a page
//   t.link(socket(ws))
import { ensureNode, type Ermine, patchChildren, pulse } from "@ermine/system"
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import { get } from "@ermine/core/places/lib"
import type { Places } from "@ermine/core/places"
import type { Key } from "@ermine/core/table"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { createHistory, createLog, createSync } from "@ermine/tippet"

type Fact = Parameters<Parameters<Places["watchAll"]>[0]>[0]
type Recorder = (f: Fact) => void
// an ephemeral write: its node, its part, its patches. whole: every one there is, as it is now
type Write = [node: string, part: string, patches: Patch[]]
type Said = { whole?: boolean; writes: Write[] }

const PARTS = ["value", "attributes", "children"]
// the parts of an ephemeral node that are only sent
const SENT = ["value", "attributes"]
// a tippet live message's id (WIRE.md)
const LIVE_ID = 8
// the deepest a folder is looked for, walking up
const DEEPEST = 64
const pathOf = (p: string) => p.split("/").filter(Boolean)
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
// a patch as cbor carries it: no field undefined
const clean = (p: Patch): Patch => ({
	path: p.path,
	...(p.range && { range: p.range }),
	...(p.value !== undefined && { value: p.value }),
	...(p.move && { move: clean(p.move as Patch) }),
})

// a room's websocket closed with this: not the room the page was rendered from (room.ts), so the
// page loads again
export const OTHER_ROOM = 4000

export type Tie = Awaited<ReturnType<typeof createTie>>
// what carries a room's bytes (tippet's carriers)
export type Link = Parameters<ReturnType<typeof createSync>["link"]>[0]

export async function createTie(ermine: Ermine, o: {
	// the folder's path
	at: string
	// a page's: the server's folder, by id. none: the folder this ermine has at at
	id?: string
	// paths in it each ermine writes for itself
	local?: string[]
	// paths in it whose values are sent, never kept (above)
	ephemeral?: string[]
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

	// each node's folder, as the names that reached it last said; the local and ephemeral paths'
	// ids, as they are
	const folder = new Map<string, string>()
	const ids = (paths: string[] = []) =>
		new Set<unknown>(
			paths.map((p) => get(ermine.places, pathOf(p))).filter((x) => typeof x === "string"),
		)
	let local = new Set<unknown>()
	let ephemeral = new Set<unknown>()
	function learn(f: Fact) {
		if (f.part !== "children" || typeof f.id !== "string") return
		const at = f.id
		const names = ermine.table.get("children" as Key, f.id)?.value
		if (isMap(names)) {
			Object.values(names).forEach((id) => typeof id === "string" && folder.set(id, at))
		}
		local = ids(o.local)
		ephemeral = ids(o.ephemeral)
	}
	const under = (id: string, n = 0): boolean =>
		id === root || (n < DEEPEST && folder.has(id) && under(folder.get(id)!, n + 1))
	// id is one of these, or under one
	const inside = (id: string, these: Set<unknown>, n = 0): boolean =>
		these.has(id) ||
		(id !== root && n < DEEPEST && folder.has(id) && inside(folder.get(id)!, these, n + 1))
	const sent = (id: string, part: string) =>
		SENT.includes(part) && !local.has(id) && under(id) && inside(id, ephemeral)
	const kept = (id: string, part: string) =>
		PARTS.includes(part) && !local.has(id) && under(id) && !sent(id, part)
	// a process's write said by its process's path ("/visitors/<id>"), which its step carries (who):
	// where it lands, explain's change.actor says it (its writer there is "outside")
	const written = (f: Fact): Write => [f.id as string, String(f.part), f.patches.map(clean)]
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
		const writes = facts.filter((f) => sent(f.id as string, String(f.part))).map(written)
		if (writes.length) sync.live(encode({ writes } as unknown as Value))
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

	// ephemeral writes taken: a page's from the server, as they land (told to nobody); the
	// server's from a page, as its own writes (so sent on to every page), those it sends alone
	let begin: () => void
	const started = new Promise<void>((r) => (begin = r))
	const header = () => ({ time: Math.floor(Date.now() / 1000) }) as Parameters<typeof update>[2]
	function take({ whole, writes }: Said) {
		const go = () =>
			writes.filter(([node, part]) => o.id || sent(node, part)).forEach(([node, part, ps]) => {
				const e = ermine.table.get(part as Key, node)
				if (e) return void (update(e, ps, header()), ermine.places.commit([e]))
				const v = apply(undefined, ps)
				if (v !== undefined) {
					ermine.table.add(part as Key, node, createEntry(v as never, header()))
				}
			})
		if (o.id) landing++
		try {
			host(go)
		} finally {
			if (o.id) landing--
			settle()
		}
		if (whole) begin()
	}
	sync.onLive((data) => {
		try {
			take(decode(data) as unknown as Said)
		} catch {
			// not one of the tie's: passed over
		}
	})
	// every ephemeral write there is, as it is now
	const whole = (id: string): Write[] => [
		...SENT.flatMap((part): Write[] => {
			const v = ermine.table.get(part as Key, id)?.value
			return v !== undefined && sent(id, part) ? [[id, part, [{ path: [], value: v }]]] : []
		}),
		...Object.values(ermine.table.get("children" as Key, id)?.value ?? {})
			.filter((kid): kid is string => typeof kid === "string")
			.flatMap(whole),
	]
	if (!o.id || !o.ephemeral?.length) begin!()

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
		// a link to the room; the server's sends it every ephemeral write first, as it is now
		link(l: Link) {
			const off = sync.link(l)
			if (!o.id && o.ephemeral?.length) {
				const id = crypto.getRandomValues(new Uint8Array(LIVE_ID))
				l.send(
					encode(
						[
							"live",
							id,
							encode({ whole: true, writes: whole(root) } as unknown as Value),
						] as Value,
					),
				)
			}
			return off
		},
		// a page's: once it holds every ephemeral write (at once, with none)
		started,
		stop() {
			unwatch()
			history.stop()
		},
	}
}
