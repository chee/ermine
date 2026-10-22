// presence: who is here, and where their cursor is, anchored on a node. rows live in the part
// "presence" at the anchor's id: { [who]: { value, until } }, one row a device or person, each
// written as a patch (so tracked, watched, drawn). a row is about the node wherever it is mounted.
//   - until: now + ttl, renewed by the row's owner (a heartbeat). readers see rows with until > now
//   - a sweeper removes the rows past until, as patches, so readers rerun
//   - a channel (channel.ts) sends my rows on topic = the anchor and applies the rows it receives
//     under the sender's name. "gone" is until lapsing, never the transport
//   - never saved, unless the host says so (save, below): saving is a side's choice
import { decode, encode } from "@ermine/encoding/cbor"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createChangeHeader } from "@ermine/places/header"
import { upsert } from "@ermine/places/upsert"
import type { Id, Places } from "@ermine/places"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Table } from "@ermine/table"
import type { Channel } from "./channel.ts"

export type Row = { value: unknown; until: number }
export type Live = { who: string; value: unknown; until: number }

declare module "@ermine/table" {
	interface Tables {
		presence: Record<string, Row>
	}
}

export const PART = "presence"

export type World = {
	table: Table
	places: Pick<Places, "commit" | "readValue">
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun" | "runWithScope" | "pulse">
	// the scope the presence writes are made in (their header's actor)
	scope: Scope
	// ms; default Date.now
	now?: () => number
	// whether this side keeps presence in a save. default never. see keep()
	save?: boolean
}

// row: my row after the write (none: gone). patches: the edit that made it, relative to the row's value
type Event = { who: string; row: Row | undefined; patches?: Patch[] }
type State = {
	anchors: Set<Id>
	mine: Map<Id, Set<string>>
	heard: Map<Id, Set<(e: Event) => void>>
	// the last n taken from each sender, by anchor (connect, patches)
	last: Map<Id, Map<string, number>>
}
const states = new WeakMap<object, State>()
function state(w: World): State {
	let s = states.get(w)
	if (s === undefined) {
		states.set(w, s = { anchors: new Set(), mine: new Map(), heard: new Map(), last: new Map() })
	}
	return s
}
const now = (w: World) => (w.now ?? Date.now)()

// a write made as the world's scope
const as = <T>(w: World, f: () => T): T => w.scheduler.runWithScope(w.scope, f)

function put(w: World, anchor: Id, who: string, row: Row) {
	as(w, () => {
		const header = createChangeHeader(w.scheduler)
		w.places.commit(upsert(w.table, PART, anchor, [who], row, header))
	})
	state(w).anchors.add(anchor)
}

function take(w: World, anchor: Id, whos: string[]): string[] {
	const there = w.table.get(PART, anchor)
	const gone = whos.filter((x) => there?.value !== undefined && Object.hasOwn(there.value, x))
	if (there === undefined || gone.length === 0) return []
	as(w, () => {
		update(there, gone.map((x): Patch => ({ path: [x] })), createChangeHeader(w.scheduler))
		w.places.commit([there])
	})
	return gone
}

function tell(w: World, anchor: Id, e: Event) {
	for (const f of [...(state(w).heard.get(anchor) ?? [])]) f(e)
}

// my row at the anchor: made or replaced, until = now + ttl (ms). told to a connected channel
export function setPresence(w: World, anchor: Id, who: string, value: unknown, ttl: number) {
	const row = { value, until: now(w) + ttl }
	put(w, anchor, who, row)
	const s = state(w)
	let m = s.mine.get(anchor)
	if (m === undefined) s.mine.set(anchor, m = new Set())
	m.add(who)
	tell(w, anchor, { who, row })
}

// the heartbeat: until = now + ttl, the value as it was. no such row: false
export function renew(w: World, anchor: Id, who: string, ttl: number): boolean {
	const row = w.table.get(PART, anchor)?.value?.[who]
	if (row === undefined) return false
	setPresence(w, anchor, who, row.value, ttl)
	return true
}

// patches applied to the value of the row `who` has at the anchor, with until, as one write. the
// paths are relative to the row's value. an invalid patch throws (apply's) and changes nothing
function edit(w: World, anchor: Id, who: string, patches: Patch[], until: number) {
	const there = w.table.get(PART, anchor)!
	const ps: Patch[] = patches.map((p) => ({
		...p,
		path: [who, "value", ...p.path],
		...(p.move === undefined
			? {}
			: { move: { ...p.move, path: [who, "value", ...p.move.path] } }),
	}))
	ps.push({ path: [who, "until"], value: until })
	as(w, () => {
		update(there, ps, createChangeHeader(w.scheduler))
		w.places.commit([there])
	})
}

// my row's value changed by patches (the op Patch shape, paths relative to the value), as one
// write, until = now + ttl. no such row: false, like renew. an invalid patch throws and changes
// nothing. told to a connected channel as the patches (connect's patches: true) or the whole row
export function editPresence(
	w: World,
	anchor: Id,
	who: string,
	patches: Patch[],
	ttl: number,
): boolean {
	const row = w.table.get(PART, anchor)?.value?.[who]
	if (row === undefined) return false
	edit(w, anchor, who, patches, now(w) + ttl)
	const s = state(w)
	let m = s.mine.get(anchor)
	if (m === undefined) s.mine.set(anchor, m = new Set())
	m.add(who)
	tell(w, anchor, { who, row: w.table.get(PART, anchor)!.value![who], patches })
	return true
}

// my row taken out, and told, so the others do not wait for its until
export function clear(w: World, anchor: Id, who: string) {
	const mine = state(w).mine.get(anchor)?.delete(who) === true
	if (take(w, anchor, [who]).length === 0) return
	if (mine) tell(w, anchor, { who, row: undefined })
}

// the live rows at an anchor (until > now), by name. tracked: a reader reruns when any row
// arrives, changes or leaves. rows past until that are not swept yet are not shown
export function readPresence(w: Pick<World, "places" | "now">, anchor: Id): Live[] {
	const t = (w.now ?? Date.now)()
	const all = w.places.readValue(PART, anchor) as Record<string, Row> | undefined
	if (all === undefined || all === null) return []
	return Object.entries(all).filter(([, r]) => r.until > t).map(([who, r]) => ({
		who,
		value: r.value,
		until: r.until,
	}))
}

// one row, tracked at its own spot: a reader reruns only when that row changes
export function readRow(
	w: Pick<World, "places" | "now">,
	anchor: Id,
	who: string,
): Live | undefined {
	const r = w.places.readValue(PART, anchor, [who]) as Row | undefined
	if (r === undefined || r === null || r.until <= (w.now ?? Date.now)()) return undefined
	return { who, value: r.value, until: r.until }
}

// removes every row past until, at any anchor this world has written or received, as patches (one
// write an anchor). gives back what it removed. the host says when: sweep, or startSweeper
export function sweep(w: World, at: number = now(w)): { anchor: Id; who: string }[] {
	const out: { anchor: Id; who: string }[] = []
	for (const anchor of [...state(w).anchors]) {
		const rows = w.table.get(PART, anchor)?.value
		if (rows === undefined) continue
		const old = Object.entries(rows).filter(([, r]) => r.until <= at).map(([x]) => x)
		for (const who of take(w, anchor, old)) {
			state(w).mine.get(anchor)?.delete(who)
			out.push({ anchor, who })
		}
	}
	return out
}

// a timer the host owns: sweep each ms, a pulse after any removal (so readers rerun). gives back
// the stop
export function startSweeper(w: World, ms = 1000): () => void {
	const id = setInterval(() => {
		if (sweep(w).length) w.scheduler.pulse()
	}, ms)
	return () => clearInterval(id)
}

// saving: a host's pack takes the triples it is given, so it filters them: keep(world, part) says
// whether this side keeps that part. presence is not kept unless world.save is true:
//   for (const [part, id] of triples) if (keep(world, part)) pack(part, id)
export const keep = (w: Pick<World, "save">, part: string) => part !== PART || w.save === true

type Message = {
	who?: string
	ttl?: number
	value?: unknown
	gone?: true
	patches?: Patch[]
	n?: number
	same?: true
	hello?: true
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
	a !== undefined && a.length === b.length && a.every((x, i) => x === b[i])

// the rows at an anchor, over the channel on topic (default: the anchor). what is sent: my rows,
// whole, as they are written, with the time left (not a time: devices' clocks differ). what is
// received lands under the sender's name, from outside, and is never sent back. none of it is
// saved. gives back stop, and announce: send all my rows now (to someone new; or as the heartbeat)
//   patches: true (default false): an edit (editPresence) goes as { ttl, patches, n }, not the whole
//   row, and every row sent carries n, a count up by one each send of a who on this connection.
//   a receiver takes a whole row always, a patch message only when its n follows the last it took
//   from that sender and the row is there: else it is dropped, and the row stays as it was until the
//   next whole row (a set, an announce). a message without n is taken as it comes
// same: a row sent again with the value it was last sent with (a renew; a set of the same value) goes
// as { ttl, same: true }, no value and no n: a receiver holding the sender's row moves its until.
// hello: { hello: true }, sent by a receiver given a same or a patch for a row it doesn't hold, or a
// patch after a missed one (once a sender, till a whole row from it lands): whoever hears one
// announces. so a late joiner has every row by the next beat, and a missed patch heals at once
export function connect(
	w: World,
	channel: Channel,
	opts: { topic: Id; anchor?: Id; patches?: boolean },
): { stop: () => void; announce: () => void } {
	const anchor = opts.anchor ?? opts.topic
	const topic = String(opts.topic)
	const s = state(w)
	const counts = new Map<string, number>()
	// the value last sent for each who, encoded: what a same stands for
	const sent = new Map<string, Uint8Array>()
	// the senders a hello has gone out for, till a whole row from them lands
	const asked = new Set<string>()
	const send = (e: Event, whole = false) => {
		let m: Message
		if (e.row === undefined) m = { gone: true }, sent.delete(e.who)
		else {
			m = { ttl: e.row.until - now(w) }
			const value = encode(e.row.value as never)
			const same = !whole && !e.patches && sameBytes(sent.get(e.who), value)
			sent.set(e.who, value)
			if (same) m.same = true
			else if (opts.patches) {
				const n = (counts.get(e.who) ?? 0) + 1
				counts.set(e.who, n)
				if (e.patches) m.patches = e.patches
				else m.value = e.row.value
				m.n = n
			} else m.value = e.row.value
		}
		channel.send(topic, encode(m as never))
	}
	const hello = (from: string) => {
		if (asked.has(from)) return
		asked.add(from)
		channel.send(topic, encode({ hello: true }))
	}
	const announce = () => {
		for (const who of s.mine.get(anchor) ?? []) {
			const row = w.table.get(PART, anchor)?.value?.[who]
			if (row) send({ who, row }, true)
		}
	}
	let set = s.heard.get(anchor)
	if (set === undefined) s.heard.set(anchor, set = new Set())
	set.add(send)
	const off = channel.on(topic, (from, bytes) => {
		let m: Message
		try {
			m = decode(bytes) as Message
		} catch {
			return
		}
		if (m.hello) return announce()
		if (m.gone) return void take(w, anchor, [from])
		const until = now(w) + (m.ttl ?? 0)
		let last = s.last.get(anchor)
		if (last === undefined) s.last.set(anchor, last = new Map())
		const held = w.table.get(PART, anchor)?.value?.[from]
		if (m.same) {
			if (held === undefined) return hello(from)
			return put(w, anchor, from, { value: held.value, until })
		}
		if (m.patches !== undefined) {
			if (typeof m.n === "number" && m.n !== (last.get(from) ?? NaN) + 1) return hello(from)
			if (held === undefined) return hello(from)
			try {
				edit(w, anchor, from, m.patches, until)
			} catch {
				return
			}
		} else put(w, anchor, from, { value: m.value, until }), asked.delete(from)
		if (typeof m.n === "number") last.set(from, m.n)
	})
	return { stop: () => (off(), set.delete(send)), announce }
}

// an entry for the anchor, so a path (a mounted node) can be watched before any row is there
export function ensure(w: World, anchor: Id) {
	if (w.table.get(PART, anchor) !== undefined) return
	as(
		w,
		() =>
			w.table.add(
				PART,
				anchor,
				createEntry<Record<string, Row>>({}, createChangeHeader(w.scheduler)) as never,
			),
	)
	state(w).anchors.add(anchor)
}
