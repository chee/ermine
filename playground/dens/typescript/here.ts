// here: the den's own node. a den is an install's: its node's id is the install's id
// (setup.install; none: a fresh one, a den new each start), the same every start, so a room can
// name it and an ask can wait for it. what it is (attributes), what it offers and its on folder are
// stored there, written each start and left at the end: only the live values (runners, methods) go
// with the session. the session's running den is a process of its own, at /system/session. where
// it is: /system/dens/<name>, and /system/den inside it, both the den's node. which question:
// where am i
//
// createDen, a scope open: an owner scope { den: name } under it; processes' start at
// /system/session under the owner, attributes { ermine.type: ermine.process, ermine.process.den:
// { id: the den's node, at: /system/dens/<name> } } (its status: gone at the first pulse); in its
// body: the den's node's attributes { ermine.type: ermine.den, ermine.den.id, .name?, .device? }
// written over what was there, its children { on }, the folder on { start, stop } (handlers'), and
// the leaves /system/dens/<name> and /system/den. name not a name: PlacesError not-a-name;
// /system/session, /system/dens/<name> or /system/den taken: already-there
// the den's offers are scopes under its process's, so what runs on them is under it: its going
// takes them, then its loads, then here's leaves
// close(reason = "den-stopped"): the reason the den's, then each process's scope torn down, newest
// first (start order: a user of a process's runner before it, as it is newer), each handle given
// reason; then the owner torn down: the session's process and the leaves last. the den's node stays
// with what is stored on it. after it: start, load, ask, offer refused stopped
// stop(reason): the den's own stopped as any process is asked (stop, its node); then close(reason)
// nodes({ processes }): what others see, tracked; status as "pending" | { failed: message }, an
// attribute with no encoding left out; children: only those dens wrote
// unplace or move never stops a process: its row is in the process part, not in children
// writes: with the owner's scope open (the den, its offers) or the process's
// open: a promise never settling; /system/den inside a box; boxed processes in nodes(); two
// sessions of one install at once (both write the den's node, both answer its asks)
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { STATUS } from "@ermine/places/status"
import { addProcess, removeProcess } from "@ermine/processes"
import type { Process, Processes } from "@ermine/processes/start"
import { createChangeBase, NODE } from "@ermine/places/header"
import type { Answer, Target } from "@ermine/protect"
import { PENDING, type Scope } from "@ermine/scheduler"
import { fresh, text } from "@ermine/ids"
import createEntry from "@ermine/node/entry"
import { get } from "@ermine/places/lib"
import { ATTRIBUTE, type Ctx, holder, isMap, ours, type Owner, REASONS, TYPE } from "./common.ts"
import { ON } from "./common.ts"
import { refuse } from "./policy.ts"
import type { Setup } from "./dens.ts"
import { DEN, type NoPermission } from "./start.ts"

ours.add(import.meta.url)

// where dens are, and here: the one place each path is said
export const DENS: Path = ["system", "dens"]
export const HERE: Path = ["system", "den"]
export const SESSION: Path = ["system", "session"]

export const ID = "ermine.den.id"
export const NAME = "ermine.den.name"
export const DEVICE = "ermine.den.device"

// a den's description as others see it (away.ts publishes it)
export type Seen = {
	readonly attributes?: Readonly<Record<string, unknown>>
	readonly children?: Readonly<Record<string, Id>>
}
export type Nodes = {
	readonly den: Id
	readonly nodes: Readonly<Record<Id, Seen>>
	// none: left out
	readonly processes?: readonly { readonly id: Id; readonly at: Path }[]
}

// whether a value has an encoding (what travels)
function encodes(v: unknown): boolean {
	try {
		encode(v as Value)
		return true
	} catch (e) {
		if (e instanceof CborError) return false
		throw e
	}
}

export type Deps = {
	readonly processes: Processes
	// the den's children { on }, the methods: handlers'
	readonly methods: (node: Id, scope: Scope) => void
	readonly permit: (who: unknown, op: string, target: Target, remote: boolean) => Answer
}

export function createHere(c: Ctx, setup: Setup, { processes, methods, permit }: Deps) {
	const { s, table, places, scopes, createScope, home, commit, headerOf, changed } = c

	// the den's node, and what it says of itself
	const node: Id = setup.install?.id ?? text(fresh())!
	c.node = node
	const attributes: Record<string, unknown> = { [ATTRIBUTE]: TYPE.den, [ID]: setup.id }
	if (setup.name !== undefined) attributes[NAME] = setup.name
	if (setup.device !== undefined) attributes[DEVICE] = setup.device
	const at = [...DENS, setup.id]
	const taken = [at, HERE].find((path) => places.peep(() => get(places, path)) !== undefined)
	if (taken !== undefined) {
		s.teardown(c.owner)
		throw new PlacesError("already-there", taken.join("/"))
	}

	// the session's process: in its body the den's node written and placed
	let made: Process | { refused: "taken" }
	try {
		made = processes.start(home, SESSION, {
			attributes: { [ATTRIBUTE]: TYPE.process, [DEN]: { id: node, at } },
		}, (inside) => {
			c.mine = {
				id: node,
				at,
				scope: inside.scope,
				under: inside.scope,
				box: home,
				args: inside.args,
				cwd: inside.cwd,
				folders: new Map(),
				offers: [],
				loads: [],
			}
			holder(s, c.mine)
			// a den with no install: its node goes with the session
			if (!c.stored) scopes.give(createScope({ den: "node", [NODE]: node }, inside.scope), node)
			table.sub("attributes", node, createEntry(attributes, headerOf()))
			methods(node, inside.scope)
			commit(addProcess(table, home.root, at, node, headerOf()))
			commit(addProcess(table, home.root, HERE, node, headerOf()))
			// its status gone at the first pulse
			const first = s.createEffect(() => true, () => s.teardown(first))
			inside.give(first)
			return () => ended()
		})
	} catch (e) {
		s.teardown(c.owner)
		throw e
	}
	if ("refused" in made) {
		s.teardown(c.owner)
		throw new PlacesError("already-there", SESSION.join("/"))
	}
	const self = made

	// the session's process going, what is under it gone already (its offers' live values and what
	// ran on them, its loads): the leaves out; the den's node stays
	function ended() {
		c.closed = true
		try {
			for (const path of [HERE, at]) {
				try {
					commit(removeProcess(table, c.home.root, path, headerOf()))
				} catch (e) {
					if (!(e instanceof PlacesError && e.code === "nothing-there")) throw e
				}
			}
		} finally {
			changed()
		}
	}

	// each process's scope torn down, newest first (what it goes with is its scope's, its reason
	// the den's: start's); then the owner (the session's process, the leaves). every step runs; the
	// first error is thrown after
	function close(reason: unknown = REASONS.den) {
		if (c.closed) return
		c.closed = true
		c.pending = reason
		let failed: { error: unknown } | undefined
		for (const p of [...c.running].reverse()) {
			try {
				s.teardown(p.under)
			} catch (error) {
				failed ??= { error }
			}
		}
		try {
			s.teardown(c.owner)
		} catch (error) {
			failed ??= { error }
		}
		if (failed) throw failed.error
	}

	function stop(reason?: unknown): NoPermission | undefined {
		if (c.closed) return
		const a = permit(createChangeBase(s), "stop", { id: c.node, path: [...c.mine.at] }, false)
		if (a.answer !== "yes") return refuse("stop", a)
		close(reason)
	}

	// the attributes as they travel: the status as "pending" | { failed }, no other with no
	// encoding. none: undefined. tracked
	function shown(id: Id): Record<string, unknown> | undefined {
		const v = places.readValue("attributes", id)
		if (!isMap(v)) return undefined
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) {
			if (k === STATUS) {
				if (x === PENDING) out[k] = "pending"
				else if (x instanceof Error) out[k] = { failed: x.message }
			} else if (encodes(x)) out[k] = x
		}
		return out
	}

	function nodes(options: { processes?: boolean } = {}): Nodes {
		s.track(c.version)
		const out: Record<Id, Seen> = {}
		const seen = (id: Id, kids: Record<string, Id>) => {
			const attributes = shown(id)
			const n: { attributes?: Record<string, unknown>; children?: Record<string, Id> } = {}
			if (attributes !== undefined) n.attributes = attributes
			if (Object.keys(kids).length > 0) n.children = kids
			out[id] = n
		}
		const offered = (o: Owner, kids: Record<string, Id>) => {
			for (const [kind, folder] of o.folders) kids[kind] = folder.id
			seen(o.id, kids)
			for (const [kind, folder] of o.folders) {
				const names: Record<string, Id> = {}
				for (const x of o.offers) if (x.kind === kind) names[x.name] = x.id
				out[folder.id] = { children: names }
			}
			for (const x of o.offers) seen(x.id, {})
		}
		const on: Id = `${String(c.node)}/${ON}`
		offered(c.mine, { [ON]: on })
		out[on] = { children: { start: `${String(on)}/start`, stop: `${String(on)}/stop` } }
		if (options.processes === false) return { den: c.node, nodes: out }
		const list: { id: Id; at: Path }[] = []
		for (const p of c.running) {
			if (p.box.root !== places.root) continue
			list.push({ id: p.id, at: p.at })
			offered(p, {})
		}
		return { den: c.node, nodes: out, processes: list }
	}

	return { self, close, stop, nodes }
}
