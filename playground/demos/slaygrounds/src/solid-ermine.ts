/// <reference lib="dom" />
// ermine state as Solid signals, and Solid's actions back as ermine changes. the world is the
// program's (what host.ts put in globalThis.ermine: { table, places, s, host, moments }).
//
// a signal is fed by an ermine effect in a scope of its own under the host's: ermine tracks what
// the read touched (places.readValue, places.readChange), so a Solid update comes from ermine's
// own tracking at the pulse that changed it, never a timer. the scope goes with the Solid owner.
//
// no glitch: a pulse is synchronous and acts only once its runs are done, and Solid 2.0 holds its
// writes until its flush (a microtask), so every signal one pulse sets is seen in one flush, never
// half a pulse. early: set in the round's early queue, before ermine's other effects act. what
// crosses back (write, act) pulses at once, so Solid's next flush has what ermine made of it too
import { createMemo, createRoot, createSignal, getOwner, onCleanup } from "@solidjs/signals"
import { PENDING } from "@ermine/core/scheduler"

// deno-lint-ignore no-explicit-any
type Any = any
export type World = Any

const WAIT = Symbol("wait")
type Fed<T> = { v: T | undefined } | { wait: Promise<T> }

// an accessor of what read() returns, updated when anything it read changes. read pending (it
// gives or throws the scheduler's PENDING): the accessor is Solid-pending, a read throws
// NotReadyError (what a <Loading> catches; an effect holds) until ermine has a value. call
// inside a Solid owner. frame: what ermine says is handed on once a frame at most, the latest (a
// view of the whole graph, while something writes many times a frame); the first at once
export function feed<T>(
	world: World,
	read: () => T,
	options: { frame?: boolean } = {},
): () => T | undefined {
	const [fed, setFed] = createSignal<Fed<T>>({ v: undefined }, { equals: false })
	let settle: ((v: T) => void) | undefined
	const take = (): T | typeof WAIT => {
		try {
			const v = read()
			return v === PENDING ? WAIT : v
		} catch (e) {
			if (e === PENDING) return WAIT
			throw e
		}
	}
	const set = (v: T | typeof WAIT) => {
		if (v === WAIT) {
			if (!settle) setFed({ wait: new Promise<T>((r) => (settle = r)) })
			return
		}
		const was = settle
		settle = undefined
		was?.(v)
		setFed({ v })
	}
	// the latest, waiting for the next frame; a window out of sight (behind another, where frames
	// stop) has it by a timer instead
	let next: { v: T | typeof WAIT } | undefined
	let frame = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	const flush = () => {
		cancelAnimationFrame(frame), clearTimeout(timer)
		frame = 0, timer = undefined
		const n = next
		next = undefined
		if (n) set(n.v)
	}
	const give = (v: T | typeof WAIT) => {
		if (!options.frame || !acted) return set(v)
		next = { v }
		if (frame) return
		frame = requestAnimationFrame(flush)
		timer = setTimeout(flush, 100)
	}
	const { s, host } = world
	const scope = s.createScope({ via: "solid" }, host)
	let acted = false
	s.runWithScope(
		scope,
		() =>
			s.createEffect(take, (v: T | typeof WAIT) => (give(v), acted = true), undefined, {
				early: true,
			}),
	)
	// its first run stopped on a writer due: the pulse it waits for
	if (!acted) s.pulse()
	onCleanup(() => (cancelAnimationFrame(frame), clearTimeout(timer), s.teardown(scope)))
	return createMemo(() => {
		const f = fed()
		return "wait" in f ? f.wait : f.v
	}) as () => T | undefined
}

// the ids placed in a children value, with their names, in order. places.readValue tells the read of
// the whole entry: a name placed, taken out or moved reruns what read it
// path given: the processes running there too (the root's process rows, @ermine/processes), each
// in place of what is saved at its name while it runs
function members(world: World, id: unknown, path?: string[]): { name: string; id: unknown }[] {
	const v = world.places.readValue("children", id)
	const out: { name: string; id: unknown }[] = []
	if (v !== null && typeof v === "object" && !Array.isArray(v)) {
		for (const [name, k] of Object.entries(v as Record<string, unknown>)) {
			if (typeof k === "string" || typeof k === "symbol") out.push({ name, id: k })
		}
	}
	const rows = path ? world.places.readValue("process", "root", path) : undefined
	if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return out
	for (const [name, x] of Object.entries(rows as Record<string, unknown>)) {
		// a process with processes under it is a level holding its own id under "" (never a name)
		if (name === "") continue
		const k = x !== null && typeof x === "object" && !Array.isArray(x)
			? (x as Record<string, unknown>)[""]
			: x
		if (typeof k !== "string") continue
		const at = out.findIndex((m) => m.name === name)
		if (at === -1) out.push({ name, id: k })
		else out[at] = { name, id: k }
	}
	return out
}

// the item at names from the root: its id, name and path; none there: undefined. an item is what
// the inspector holds of a node, never the node itself
function itemAt(world: World, names: string[]): Item | undefined {
	let id: unknown = "root"
	for (const [i, name] of names.entries()) {
		const k = members(world, id, names.slice(0, i)).find((m) => m.name === name)
		if (!k) return undefined
		id = k.id
	}
	return { id, name: names.at(-1), path: names }
}
export type Item = { id: unknown; name: string | undefined; path: string[] }

// the node at an address (names from the root): its item, value and change; pending: its computation is out
// (the host's pending says which ids: a read of the computation's status node)
export function node(world: World, address: string[]) {
	const { places } = world
	return feed(world, () => {
		const item = itemAt(world, address)
		if (!item) return undefined
		return {
			item,
			value: places.readValue("value", item.id),
			change: places.readChange("value", item.id),
			pending: !!world.pending?.(item.id),
		}
	})
}

// a folder's names and members, in order
export function children(world: World, address: string[]) {
	return feed(world, () => {
		const item = itemAt(world, address)
		if (!item) return undefined
		const ms = members(world, item.id, address).map((m) => ({ ...m, path: [...address, m.name] }))
		return { item, names: ms.map((m) => m.name), members: ms }
	})
}

// a card of the whole tree from the root: what the map and the tree draw
export type Card = {
	// root, then name down: the pick the tree, the map and the detail share
	key: string
	// one per node: a mount is one card
	id: string
	name: string
	item: Item
	depth: number
	up?: Card
	value: unknown
	change: unknown
	// this node's compute is out (or failed): its status node says so
	pending: boolean
	// the inspector reads with no rules asked, so a card is never refused (the views still show it)
	refused: boolean
	// what sync says stands on top of the node while ephemeral commits do (its "ephemeral" part):
	// { under: { [table]: the stored value }, on: [{ by, name, tables, lamport }] }, the one shown
	// last; nothing on top: undefined
	ephemeral: Ephemeral | undefined
}
export type Ephemeral = {
	under?: Record<string, unknown>
	on?: { by?: string; name?: string; tables?: string[]; lamport?: number }[]
}
export type Tree = {
	cards: Card[]
	// name: the name the child is placed under there (a mount keeps its own)
	edges: { from: Card; to: Card; mount: boolean; name: string }[]
	cut: boolean
}

// every node from the root, its value and change read, so any of them changing updates this.
// a node met again (a mount) is not walked again: an edge to its first card, mount: true. the
// views have it once a frame at most: a drag writes a frame, but sync may write many times one
export function tree(world: World, limit = 800) {
	const { places } = world
	return feed(world, (): Tree => {
		const cards: Card[] = []
		const edges: Tree["edges"] = []
		const byId = new Map<string, Card>()
		let cut = false
		const walk = (item: Item, key: string, depth: number, up?: Card): Card => {
			const id = String(item.id)
			const card: Card = {
				key,
				id,
				name: item.name ?? "/",
				item,
				depth,
				up,
				pending: !!world.pending?.(item.id),
				refused: false,
				value: places.readValue("value", item.id),
				change: places.readChange("value", item.id),
				ephemeral: places.readValue("ephemeral", item.id) as Ephemeral | undefined,
			}
			byId.set(id, card)
			cards.push(card)
			if (depth >= 10) return card
			for (const k of members(world, item.id, item.path)) {
				const was = byId.get(String(k.id))
				if (was) edges.push({ from: card, to: was, mount: true, name: k.name })
				else if (cards.length >= limit) cut = true
				else {edges.push({
						from: card,
						to: walk(
							{ id: k.id, name: k.name, path: [...(item.path ?? []), k.name] },
							`${key}/${k.name}`,
							depth + 1,
							card,
						),
						mount: false,
						name: k.name,
					})}
			}
			return card
		}
		walk({ id: "root", name: undefined, path: [] }, "root", 0)
		return { cards, edges, cut }
	}, { frame: true })
}

// what each part's latest run read: computation -> its node (the host's parts map) and the nodes
// its read keys are on, from the runs table (the process api's runs: each record's reads, named
// { part, id, path } by places). the parts map is not tracked, so the reading is made again
// when it has grown
export type Where = { part: string; id: unknown; path: unknown }
export type Reads = Map<Any, { entry: Any; reads: Where[] }>

// the scheduler's moments as signals, with no timer: the host's moments.push is wrapped. tick goes
// up after each batch of moments; reads is the latest run's reads of each part, read from the
// runs table (other computers' records: this reader is not one of the parts)
export function moments(world: World) {
	const [tick, setTick] = createSignal(0)
	const [feeding, setFeeding] = createSignal<(() => Reads | undefined) | undefined>(undefined)
	const list: Any[] = world.moments
	const push = list.push
	let queued = false
	let tickTimer = 0
	let known = -1
	let stop: (() => void) | undefined
	const owner = getOwner()
	const remake = () => {
		stop?.()
		stop = createRoot((dispose) => {
			setFeeding(() =>
				feed(world, (): Reads => {
					const out: Reads = new Map()
					for (const [comp, part] of world.parts as Map<Any, Any>) {
						const read = world.runs(part.entry.id, "reads") as Any[] | undefined
						if (!read) continue
						const seen = new Set<string>()
						const reads: Where[] = []
						for (const w of read) {
							if (!("part" in w)) continue
							const id = `${String(w.id)}:${w.part}`
							if (!seen.has(id)) (seen.add(id), reads.push(w))
						}
						out.set(comp, { entry: part.entry, reads })
					}
					return out
				}, { frame: true })
			)
			return dispose
		}, owner ?? undefined)
	}
	const take = () => {
		queued = false
		if (world.parts.size !== known) (known = world.parts.size, remake())
		// the tick (what the scheduler column shows) at most twice a second: a clock writing
		// forty times a second is not forty updates of a list
		if (!tickTimer) tickTimer = setTimeout(() => ((tickTimer = 0), setTick((x) => x + 1)), 500)
	}
	list.push = function (...a: Any[]) {
		const r = push.apply(this, a)
		if (!queued) (queued = true, queueMicrotask(take))
		return r
	}
	queueMicrotask(take)
	onCleanup(() => (clearTimeout(tickTimer), stop?.(), void (list.push = push)))
	return { tick, reads: () => feeding()?.() }
}

// a change from outside: patches written to a node as an ordinary change, in a scope under the
// host's saying who and how, then a pulse so what reads it reruns. update is the frame's own
// (apply tells maps by prototype, so it must run in the realm of the value)
export function write(
	world: World,
	where: { id: unknown; part: string },
	patches: Any[],
	update: Any,
	via = "inspector",
) {
	const { s, places, table, host } = world
	const scope = s.createScope({ via, "trusted-event": true }, host)
	try {
		s.runWithScope(scope, () => {
			const n = table.get(where.part, where.id)
			update(n, patches, world.header())
			places.commit([n])
		})
		s.pulse()
	} finally {
		s.teardown(scope)
	}
}

// what act's fn is handed: the host's writes (place, unplace, move: plain functions on a children
// entry, the host's own, so they run in the realm of the values they change), and the children
// entry of a node by its id
export type Writes = {
	place: Any
	unplace: Any
	move: Any
	rename: Any
	entry: (id: unknown) => Any
}

// a change from outside by way of the writes (move, place, unplace): run in a scope under the
// host's saying who and how, then a pulse. fn is handed the writes and a fresh header; it gives
// back the entries it changed
export function act(world: World, fn: (w: Writes, header: Any) => Any[], via = "inspector") {
	const { s, places, host, table } = world
	const scope = s.createScope({ via, "trusted-event": true }, host)
	try {
		s.runWithScope(scope, () => {
			const w: Writes = { ...world.writes, entry: (id) => table.get("children", id) }
			places.commit(fn(w, world.header()))
		})
		s.pulse()
	} finally {
		s.teardown(scope)
	}
}
