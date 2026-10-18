// the world a sync example runs in: this page is one device, a whole ermine (a table, places, a
// scheduler) with sync beside it (@ermine/sync over Subduction), joined to wss://galaxy.observer.
// an example's host.ts makes one, adds what is its own, and hands the program its tools:
//
//   import { createSyncWorld } from "@ermine/slaygrounds/sync-world"
//   import { render } from "ermine-h"
//   const world = await createSyncWorld({ render, room: "ermine://…" })
//   world.join(() => ({ pointer }))           // my row at the room: what else it says
//   export const reload = (mod) => world.reload(mod, tools)
//
// a program is a module whose default export is given the host's tools (not the process api); its
// return is drawn with render. a reload: the last run's scope taken down, the program run again.
//   ?server=wss://… another server (ws://localhost:… for a local subduction_cli), ?server=none none
//   ?service=… the server's service name, when it isn't its host (a local subduction_cli: ermine)
//   ?room=ermine://… another room
//
// what this device has, as nodes (local, never synced): /me, who this device is ({name, colour,
// server} and what about adds), and whatever the host puts with local
//
// presence: my row at the room (presence's rows, on the channel's topic = the room), sent over
// sync's ephemeral messages, never kept, renewed by a heartbeat; taken out on pagehide, so the
// others don't wait for it to lapse
//
// globalThis.ermine (the inspector): table, places, s, header, statuses, moments (last 600), host,
// sync, and the rest of the world's names, empty
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces, place } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { createStatus } from "@ermine/places/status"
import {
	clear,
	connect,
	ensure,
	readPresence,
	setPresence,
	startSweeper,
	type World as Presence,
} from "@ermine/presence"
import { createScheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { trace } from "@ermine/scheduler/trace"
import { createTable, type Key } from "@ermine/table"
import { createChannel } from "@ermine/sync/channel"
import { createSigner } from "@ermine/sync/seal"
import { createSync, type Options as SyncOptions } from "@ermine/sync/sync"

// the page's, reached loosely: the world names no DOM types (the editor's type checker has no dom lib)
// deno-lint-ignore no-explicit-any
const page = globalThis as any

export type Patch = { path: unknown[]; range?: [number, number]; value?: unknown }
export const put = (value: unknown): Patch[] => [{ path: [], value }]

// ermine-h's render, handed in (the world imports no view library)
export type Render = (into: unknown, view: unknown, viewer: unknown) => unknown

export type Options = {
	render: Render
	// the room everyone opening this example shares, unless ?room=
	room: string
	// sync's merge rules this device knows (none: none), and which writes go out ephemeral
	merges?: SyncOptions["merges"]
	ephemeral?: SyncOptions["ephemeral"]
	// css for the page, after the world's own (body, button)
	style?: string
	// ms a row lasts unless renewed (6000), and how often it is renewed when nothing changes (2000)
	ttl?: number
	renew?: number
}

const NAMES = ["otter", "newt", "wren", "moth", "vole", "finch", "toad", "hare", "mole", "kiwi"]
const COLOURS = ["#d1495b", "#2e86ab", "#3b8b5a", "#c27c0e", "#8e44ad", "#16a085", "#e4572e"]
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

export async function createSyncWorld(o: Options) {
	const search = new URL(page.parent.location.href).searchParams
	const server = search.get("server") === "none"
		? undefined
		: search.get("server") ?? "wss://galaxy.observer"
	const service = search.get("service") ?? undefined
	// galaxy stores an id only when its last 16 bytes are zero (until Keyhive)
	const zeros = server !== undefined && !/^wss?:\/\/(localhost|127\.)/.test(server)
	const room = search.get("room") ?? o.room
	const ttl = o.ttl ?? 6000
	const every = o.renew ?? 2000
	let state = server ? "joining" : "none"

	const name = pick(NAMES) + "-" + Math.floor(Math.random() * 100)
	const colour = pick(COLOURS)

	// ---- the device: the graph, and sync beside it ----
	const signer = await createSigner()
	const me = Array.from(signer.key, (x) => x.toString(16).padStart(2, "0")).join("")
	const s = createScheduler()
	const moments: unknown[] = []
	trace(s, (m) => (moments.length > 600 && moments.splice(0, 300), moments.push(m)))
	// what sync writes, and what is heard, comes outside a run: a pulse soon lets the views see it
	let due = false
	const soon = () => {
		if (due) return
		due = true
		setTimeout(() => (due = false, s.pulse()), 0)
	}
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
		soon()
	})
	const places = createPlaces({ root: "root", table, paths: createPaths(), scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const sync = createSync({
		table,
		signer,
		zeros,
		merges: o.merges,
		ephemeral: o.ephemeral,
		commit: (entries) => (places.commit(entries), soon()),
	})
	const device = sync.device
	const host = s.createRootScope({ actor: name })
	const header = () => createChangeHeader(s)

	// patches to the entry under (part, id), made whole first if none: told to places, then sync
	function write(part: Key, id: string, patches: Patch[]) {
		s.runWithScope(host, () => {
			let e = table.get(part, id)
			if (e === undefined) {
				table.add(part, id, createEntry(patches[0].value as never, header()))
				patches = patches.slice(1)
				e = table.get(part, id)!
			}
			if (patches.length) {
				update(e, patches as never, header())
				places.commit([e])
				sync.wrote([e])
			}
		})
		s.pulse()
	}
	// a local node at a name under the root, and its value replaced
	function local(at: string, value: unknown) {
		s.runWithScope(host, () => {
			table.add("value", at, createEntry(value as never, header()))
			places.commit(place(table.get("children", "root")!, at, at, header()))
		})
	}
	function set(at: string, value: unknown) {
		s.runWithScope(host, () => {
			const e = table.get("value", at)!
			update(e, put(value) as never, header())
			places.commit([e])
		})
		s.pulse()
	}

	s.runWithScope(host, () => {
		table.add("value", "root", createEntry(undefined, header()))
		table.add("children", "root", createEntry({}, header()))
	})
	// /me: who this device is, the server as last heard, and what the host adds
	const more: Record<string, unknown> = {}
	local("me", { name, colour, server: state })
	let shownMe = ""
	function about(add: Record<string, unknown> = {}) {
		Object.assign(more, add)
		const v = { name, colour, server: state, ...more }
		const q = JSON.stringify(v)
		if (q !== shownMe) (shownMe = q, set("me", v))
	}

	// kept nodes followed: each once
	const followed = new Set<string>()
	function follow(id: string): boolean {
		if (followed.has(id)) return false
		followed.add(id)
		sync.follow(id).catch((e) => console.error("follow", id, e))
		return true
	}

	// ---- the wire: sync's channel. a row or a message heard comes outside any run: a pulse soon ----
	const wire = createChannel(device, signer.key)
	const channel = {
		...wire,
		on: (topic: string, fn: (from: string, bytes: Uint8Array) => void) =>
			wire.on(topic, (from, bytes) => (fn(from, bytes), soon())),
	}
	// messages beside presence: JSON on a topic, stored nowhere, not heard by its sender
	type Hearing = { topic: string; fn: (from: string, value: unknown) => void; off: () => void }
	const hearings = new Set<Hearing>()
	const listen = (h: Hearing) =>
		channel.on(h.topic, (from, bytes) => {
			try {
				h.fn(from, JSON.parse(new TextDecoder().decode(bytes)))
			} catch { /* not JSON: not one of ours */ }
		})
	function send(topic: string, value: unknown) {
		wire.send(topic, new TextEncoder().encode(JSON.stringify(value)))
	}
	// each message on the topic: fn(the sender's key, its value), outside any run. gives back the stop
	function hear(topic: string, fn: (from: string, value: unknown) => void) {
		const h: Hearing = { topic, fn, off: () => {} }
		h.off = listen(h)
		hearings.add(h)
		return () => (h.off(), hearings.delete(h))
	}

	// ---- the room, and my row at it ----
	const presence: Presence = { table, places, scheduler: s, scope: host }
	let link: { stop(): void; announce(): void } | undefined
	let row: () => Record<string, unknown> = () => ({})
	let dirty = true
	let last = 0
	// a key whose value is undefined is left out: CBOR has no undefined (a cursor gone, say)
	const beat = () => {
		const v = Object.entries({ name, colour, ...row() }).filter(([, x]) => x !== undefined)
		setPresence(presence, room, me, Object.fromEntries(v), ttl)
		last = Date.now(), dirty = false
	}
	// my row is due: sent at the heartbeat's next look (a quarter second at most)
	const touch = () => void (dirty = true)
	// my row is due, sent next frame at most (a moving pointer)
	let framed = false
	const frame = () => {
		dirty = true
		if (framed) return
		framed = true
		page.requestAnimationFrame(() => (framed = false, dirty && beat()))
	}

	// ---- the server ----
	const told = new Set<(state: string) => void>()
	const changed = () => {
		about()
		for (const f of told) f(state)
	}
	async function connectServer() {
		if (!server) return
		for (;;) {
			try {
				await device.connectDiscover(server, service)
				state = "online"
				// a listen made before the connection is not subscribed on it: listen again
				link?.stop()
				link = connect(presence, channel, { topic: room })
				link.announce()
				for (const h of hearings) h.off(), h.off = listen(h)
				changed()
				return
			} catch (e) {
				state = "offline: " + String(e)
				changed()
				await new Promise((r) => setTimeout(r, 5000))
			}
		}
	}

	// in the room: my row says name, colour and what says gives, renewed; the server joined
	function join(says: () => Record<string, unknown> = () => ({})) {
		row = says
		ensure(presence, room)
		link = connect(presence, channel, { topic: room })
		startSweeper(presence, 1000)
		page.setInterval(() => (dirty || Date.now() - last >= every) && beat(), 250)
		page.addEventListener("pagehide", () => clear(presence, room, me))
		connectServer()
	}

	// ---- what ermine-h is handed: this device's places, read from its root ----
	const viewer = {
		name,
		where: () => [],
		find(address: string[]) {
			const path = address.filter((a) => a !== "/" && a !== "")
			const id = lib.get(places, path)
			return id === undefined ? [] : [{ id, name: path[path.length - 1], path }]
		},
		get: (item: { id: unknown }) => places.readValue("value", item.id as string),
		call: () => undefined,
		effect: (read: () => unknown, act: (v: unknown, before: unknown) => void) =>
			s.createEffect(read, act),
	}

	const style = page.document.createElement("style")
	style.textContent = `
	body { margin: 0; font: 13px/1.4 ui-monospace, Menlo, monospace; background: #fffbe8; color: #111; }
	button { font: inherit; border: 1px solid #111; background: #fff; padding: 0 6px; cursor: pointer; }
	button:hover { background: #ffe066; }
${o.style ?? ""}`
	page.document.head.append(style)
	const box = page.document.body.appendChild(page.document.createElement("div"))
	page.ermine = {
		table,
		places,
		s,
		header: (extra?: unknown) => createChangeHeader(s, extra as never),
		writes: {},
		parts: new Map(),
		statusIds: new Map(),
		statuses: createStatus({ places, table, scheduler: s }),
		pending: () => false,
		moments,
		host,
		call: () => undefined,
		defined: new Map(),
		binds: new WeakMap(),
		sync,
	}

	// a reload: the old view goes with its scope, the program runs again on tools
	let run: Scope | undefined
	function reload<T>(mod: { default: (tools: T) => unknown }, tools: T) {
		if (run) s.teardown(run)
		run = s.createScope({ run: Date.now() }, host)
		s.runWithScope(run, () => {
			const made = mod.default(tools)
			if (made !== undefined) o.render(box, made, viewer)
		})
		s.pulse()
	}

	return {
		// this device: its key, name and colour, the room, the server as last heard
		me,
		name,
		colour,
		room,
		server: () => state,
		// the graph and sync
		s,
		table,
		places,
		sync,
		device,
		host,
		header,
		presence,
		soon,
		write,
		local,
		set,
		about,
		follow,
		// a node's versions made one, keeping the one shown
		settle: (id: string) => s.runWithScope(host, () => sync.settle(id, header())),
		// the live rows at the room, tracked
		rows: () => readPresence(presence, room),
		join,
		touch,
		frame,
		// told each time the server is joined or lost
		onserver: (f: (state: string) => void) => void told.add(f),
		send,
		hear,
		// f called when this run of the program goes (a reload)
		teardown(f: () => void) {
			const scope = s.getCurrentScope()
			if (scope) s.registerTeardown(scope, f)
		},
		reload,
	}
}

export type SyncWorld = Awaited<ReturnType<typeof createSyncWorld>>
