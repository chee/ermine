// here: the den's own node. where a den is (/system/dens/<id>, and /system/den inside it: the same
// id, a second leaf), what it says of itself (id, name, device), how it closes, and what others
// see of it. which question: where am i
//
// createDen, a scope open: an owner scope { den: id } under it; processes' start at
// /system/dens/<id> under the owner, attributes { ermine.type: ermine.den, ermine.den.id,
// .name?, .device? }; in its body: its children { on }, the folder on { start, stop }, and
// /system/den (addProcess, the same id). its status: gone at the first pulse. id not a name:
// PlacesError not-a-name; /system/dens/<id> or /system/den taken: already-there
// the den's offers are scopes under its node's, so what runs on them is under it: its going takes
// them, then its loads, then here and its row
// close(reason = "den-stopped"): the reason the den's, then each process's scope torn down, newest
// first (start order: a user of a process's runner before it, as it is newer), each handle given
// reason; then the owner torn down: the den's own and its rows last. after it: start, load, ask,
// offer refused stopped
// stop(reason): the den's own stopped as any process is asked (stop, its node); then close(reason)
// nodes({ processes }): what others see, tracked; status as "pending" | { failed: message }, an
// attribute with no encoding left out; children: only those dens wrote
// unplace or move never stops a process: its row is in the process part, not in children
// writes: with the owner's scope open (the den, its offers) or the process's
// open: a promise never settling; /system/den inside a box; boxed processes in nodes()
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { type Id, type Path, PlacesError } from "@ermine/places"
import { STATUS } from "@ermine/places/status"
import { addProcess, removeProcess } from "@ermine/processes"
import type { Inside, Process, Processes } from "@ermine/processes/start"
import { createChangeBase } from "@ermine/places/header"
import type { Answer, Target } from "@ermine/protect"
import { PENDING } from "@ermine/scheduler"
import { ATTRIBUTE, type Ctx, holder, isMap, ours, type Owner, REASONS, TYPE } from "./common.ts"
import { ON } from "./handlers.ts"
import { refuse } from "./policy.ts"
import type { Setup } from "./dens.ts"
import type { NoPermission } from "./start.ts"

ours.add(import.meta.url)

// where dens are, and here: the one place each path is said
export const DENS: Path = ["system", "dens"]
export const HERE: Path = ["system", "den"]

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
	readonly methods: (inside: Inside) => void
	readonly permit: (who: unknown, op: string, target: Target, remote: boolean) => Answer
}

export function createHere(c: Ctx, setup: Setup, { processes, methods, permit }: Deps) {
	const { s, table, places, home, commit, headerOf, changed } = c

	// the den's own node as an owner: its folders and offers
	const attributes: Record<string, unknown> = { [ATTRIBUTE]: TYPE.den, [ID]: setup.id }
	if (setup.name !== undefined) attributes[NAME] = setup.name
	if (setup.device !== undefined) attributes[DEVICE] = setup.device
	const at = [...DENS, setup.id]
	let made: Process | { refused: "taken" }
	try {
		made = processes.start(home, at, { attributes }, (inside) => {
			c.mine = {
				id: inside.id,
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
			methods(inside)
			commit(addProcess(table, home.root, HERE, inside.id, headerOf()))
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
		throw new PlacesError("already-there", setup.id)
	}
	const self = made
	c.node = self.id

	// the den's own process going, what is under it gone already (its offers and what ran on them,
	// its loads): here out
	function ended() {
		c.closed = true
		try {
			commit(removeProcess(table, c.home.root, HERE, headerOf()))
		} catch (e) {
			if (!(e instanceof PlacesError && e.code === "nothing-there")) throw e
		} finally {
			changed()
		}
	}

	// each process's scope torn down, newest first (what it goes with is its scope's, its reason
	// the den's: start's); then the owner (the den's own, here, its row). every step runs; the
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
