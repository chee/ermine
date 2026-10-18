// away: the other dens of one root (or of a mounted one) as rows, and asks to them. each den's row:
// a presence row at the anchor "dens:<topic>", under its channel's name (= its den's id): its
// nodes() (processes: false, none), set whole as they change (a tracked effect) and at each beat,
// lapsing at until (a host's sweep), cleared at stop. each other row, while it lives, mirrored
// here: the away trie (a part of its own, processes.ts' trie) gets the den's node id at
// under + /system/dens/<who> and each process's id at under + its at (a leaf there already, not
// a name, or in a local process's way: at or under its leaf, or on a level of the process trie:
// passed over); each node named that is the row's own (its den's id, a process's, or one under
// them: "<id>/...") is written as given (attributes; children, each name to an id it may write;
// never a value; status "pending" | { failed } as PENDING | an Error). no row writes an id that is
// this den's (its node, a process it runs, or under them), nor one with entries here that this
// link did not write for that who (nor is its leaf put in). a row gone (cleared, swept): its
// leaves and entries out
// asks: CBOR on "<anchor>/ask/<to>": { n, op, who: { actor, reader? }, ... }; the asked den: who +
// device (the sender's name), den.ask; the answer on "<anchor>/answer/<from>": { n, answer }
// (den.ask threw: { error: its code, or its message }). answer(n) is tracked: undefined until it
// lands, from the den it was sent to; the first kept
//
//   const link = connect(den, channel, { topic: M, under: ["mnt", "pi"] })    // a scope open
//   const n = link.ask("card", { op: "start", runner: "/system/den/runners/driver",
//     program: link.carry("/apps/blink.c", { code: true }), at: "/work/blink" })
//   link.answer(n)        // { id, at } | {} | a refusal | undefined
//
// connect, a scope open: a scope { dens: "away", topic } under it, the link's: its effects, its
// writes (rows, mirrors, asks answered). channel.name not den.id: Error. topic: none, the places'
// root. publish: none, whether topic is the root. under: none, []. ttl: none, 10 s. now: none,
// Date.now. world, anchor: the presence world it writes in and its anchor (presence.ts' calls)
// stop: its row cleared (when it published), mirrors out, listeners off, its scope torn down;
// twice: nothing. the den's close stops it. its scope torn down from above: the same, its row left
// to lapse (presence writes need its scope open)
// a message that does not decode, or is no ask or answer: dropped, as presence drops one
// open: patches; timeouts; boxed processes; /system/den of another den
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import createEntry, { type Entry } from "@ermine/node/entry"
import { type Address, inside } from "@ermine/boxes"
import { type Contributor, type Id, type Path, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeBase, createChangeHeader } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { addLeaf, PROCESS, removeLeaf, trie } from "@ermine/processes"
import {
	clear,
	connect as listen,
	type Live,
	readPresence,
	setPresence,
	sweep,
	type World,
} from "@ermine/presence"
import type { Channel } from "@ermine/presence/channel"
import { PENDING, type Scope } from "@ermine/scheduler"
import type { Key } from "@ermine/table"
import {
	type Ask,
	type Asked,
	ATTRIBUTE,
	type Den,
	DENS,
	hashOf,
	type Nodes,
	type Program,
	PROGRAM_API,
} from "./dens.ts"

export const AWAY = "away" as string as Key
export const away = (root: Id): Contributor => trie(AWAY, root, "away")
export const anchorOf = (topic: Id): string => `dens:${String(topic)}`
export type Remote =
	| {
		readonly op: "start"
		readonly runner: Address
		readonly program: Program
		readonly at: Address
		readonly args?: readonly string[]
		readonly cwd?: Address
	}
	| { readonly op: "stop"; readonly process: Id; readonly reason?: unknown }
export type Options = {
	topic?: Id
	under?: Path
	publish?: boolean
	processes?: boolean
	ttl?: number
	now?: () => number
}
// what an ask got back: the den's answer, or what its ask threw
export type Answered = Asked | { readonly error: string }
export type Link = {
	readonly anchor: Id
	readonly world: World
	// n, from 1; who: the scope open's { actor, reader? }. stopped: Error
	ask: (to: string, ask: Remote) => number
	// tracked; undefined until it lands
	answer: (n: number) => Answered | undefined
	// a node of the den's (an address from its root, or an id) as an ask's program: id, hash, type
	// (ermine.type), api (ermine.program.api); code too when asked. no node or no value: PlacesError
	// nothing-there
	carry: (program: Address | { readonly id: Id }, options?: { code?: boolean }) => Program
	announce: () => void
	// the row set again, until = now + ttl
	beat: () => void
	sweep: () => { anchor: Id; who: string }[]
	stop: () => void
}

const TTL = 10_000
const PARTS = ["attributes", "children"] as const
type Part = typeof PARTS[number]

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const isAddress = (x: unknown): x is Address => typeof x === "string" || Array.isArray(x)

// whether id is one of ids, or under one (a step at a "/")
function among(id: string, ids: ReadonlySet<string>): boolean {
	if (ids.has(id)) return true
	for (let i = id.indexOf("/"); i !== -1; i = id.indexOf("/", i + 1)) {
		if (ids.has(id.slice(0, i))) return true
	}
	return false
}

// a value's encoding; none: undefined
function bytesOf(v: unknown): Uint8Array | undefined {
	try {
		return encode(v as Value)
	} catch {
		return undefined
	}
}

function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined || a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

// the fields that are not undefined (what encodes)
function defined(o: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
	return out
}

// a message as sent; none: it does not decode, or is no map with a number n
function read(bytes: Uint8Array): Record<string, unknown> & { n: number } | undefined {
	let m: unknown
	try {
		m = decode(bytes)
	} catch {
		return undefined
	}
	return isMap(m) && typeof m.n === "number"
		? m as Record<string, unknown> & { n: number }
		: undefined
}

// a mirrored node's attributes: the status as this side holds it ("pending": PENDING, { failed }:
// an Error, anything else left out)
function attributesOf(v: Record<string, unknown>): Record<string, unknown> {
	if (!Object.hasOwn(v, STATUS)) return v
	const { [STATUS]: st, ...rest } = v
	if (st === "pending") return { ...rest, [STATUS]: PENDING }
	if (isMap(st) && typeof st.failed === "string") return { ...rest, [STATUS]: new Error(st.failed) }
	return rest
}

// the ask an ask message says, who given; none: not one
function askOf(m: Record<string, unknown>, who: Record<string, unknown>): Ask | undefined {
	if (m.op === "start") {
		const a: Record<string, unknown> = {
			op: "start",
			who,
			runner: m.runner,
			program: m.program,
			at: m.at,
		}
		if (m.args !== undefined) a.args = m.args
		if (m.cwd !== undefined) a.cwd = m.cwd
		return isAddress(m.runner) && isMap(m.program) && typeof m.program.id === "string" &&
				isAddress(m.at)
			? a as Ask
			: undefined
	}
	if (m.op === "stop") {
		if (typeof m.process !== "string") return undefined
		const a: Record<string, unknown> = { op: "stop", who, process: m.process }
		if (m.reason !== undefined) a.reason = m.reason
		return a as Ask
	}
	return undefined
}

// what one other den's row put here: its leaves (by path), the ids it wrote
type Mirror = { leaves: Map<string, { path: Path; id: Id }>; ids: Set<Id> }

export function connect(den: Den, channel: Channel, options: Options = {}): Link {
	if (channel.name !== den.id) throw new Error("a den's channel is named its id")
	const { scheduler: s, table, places } = den
	const topic = options.topic ?? places.root
	const anchor = anchorOf(topic)
	const under = [...(options.under ?? [])]
	const publish = options.publish ?? topic === places.root
	const processes = options.processes ?? true
	const ttl = options.ttl ?? TTL
	const scope = s.createScope({ dens: "away", topic })
	const world: World = { table, places, scheduler: s, scope, now: options.now ?? Date.now }
	// f with the link's scope open; torn down from above (its own teardown): open, as it is
	const within = <T>(f: () => T): T => scope.state === "alive" ? s.runWithScope(scope, f) : f()

	// the mirrors, by who; which who wrote each id; each id's entries as last written, as CBOR
	const mirrors = new Map<string, Mirror>()
	const owners = new Map<Id, string>()
	const written = new Map<Id, Partial<Record<Part, Uint8Array>>>()

	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => {
		if (changed.length) places.commit(changed)
	}

	// the den's own ids (its node, its processes'): no row writes them, or under them
	let mine: ReadonlySet<string> = new Set()
	const own = () => new Set([den.node, ...den.processes().map((p) => p.id)].map(String))
	// whether who may write id here: not the den's own; it wrote it, or nothing is there and no
	// other who wrote it
	const writable = (who: string, id: Id) =>
		!among(String(id), mine) &&
		(owners.get(id) === who || (!owners.has(id) && table.get(id).length === 0))

	// whether a leaf at path is in a local process's way: at or under its leaf, or on a level of
	// the process trie (addLeaf's rule, on the process part)
	function shadowed(path: Path): boolean {
		let v: unknown = table.get(PROCESS, places.root)?.value
		for (let i = 0; i < path.length && isMap(v); i++) {
			v = Object.hasOwn(v, path[i]) ? v[path[i]] : undefined
			if (typeof v === "string") return true
		}
		return isMap(v) && Object.keys(v).length > 0
	}

	// a mirrored node's children: each name to an id (a string) who may write
	const kids = (who: string, v: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(v).filter(([, x]) => typeof x === "string" && writable(who, x)),
		)

	// one part of a mirrored node as wanted (none: taken out), written only when it changed
	function write(id: Id, part: Part, v: Record<string, unknown> | undefined) {
		let was = written.get(id)
		if (v === undefined) {
			if (was?.[part] === undefined) return
			delete was[part]
			if (table.get(part, id) !== undefined) table.del(part, id)
			return
		}
		const bytes = bytesOf(v)
		if (was?.[part] !== undefined && same(was[part], bytes)) return
		const value = part === "attributes" ? attributesOf(v) : v
		table.sub(part, id, createEntry<Record<string, unknown>>(value, header()))
		if (was === undefined) written.set(id, was = {})
		was[part] = bytes ?? new Uint8Array()
	}

	// an id this link wrote, out
	function unwrite(id: Id) {
		for (const part of PARTS) write(id, part, undefined)
		written.delete(id)
		owners.delete(id)
	}

	function unleaf(path: Path) {
		try {
			commit(removeLeaf(table, AWAY, places.root, path, header()))
		} catch (e) {
			if (!(e instanceof PlacesError)) throw e
		}
	}

	// who's row gone: its leaves and entries out
	function drop(who: string) {
		const m = mirrors.get(who)
		if (m === undefined) return
		mirrors.delete(who)
		for (const { path } of m.leaves.values()) unleaf(path)
		for (const id of m.ids) unwrite(id)
	}

	// who's row as it is now: what it no longer names out, then what it names in
	function mirror(who: string, value: unknown) {
		let m = mirrors.get(who)
		if (m === undefined) mirrors.set(who, m = { leaves: new Map(), ids: new Set() })
		const row = isMap(value) ? value : {}
		const nodes = isMap(row.nodes) ? row.nodes : {}
		mine = own()
		// the row's own ids: its den's and its processes' (each one who may write)
		const bases = new Set<string>()
		const base = (id: unknown) => {
			if (typeof id === "string" && writable(who, id)) bases.add(id)
		}
		base(row.den)
		if (Array.isArray(row.processes)) {
			for (const p of row.processes) if (isMap(p)) base(p.id)
		}
		const wanted = new Map<Id, Record<string, unknown>>()
		for (const [id, seen] of Object.entries(nodes)) {
			if (isMap(seen) && among(id, bases) && writable(who, id)) wanted.set(id, seen)
		}
		const leaves = new Map<string, { path: Path; id: Id }>()
		const leaf = (at: unknown, id: unknown) => {
			if (!Array.isArray(at) || !at.every((x) => typeof x === "string")) return
			if (typeof id !== "string" || !bases.has(id)) return
			const path = [...under, ...at]
			if (!shadowed(path)) leaves.set(JSON.stringify(path), { path, id })
		}
		leaf([...DENS, who], row.den)
		if (Array.isArray(row.processes)) {
			for (const p of row.processes) if (isMap(p)) leaf(p.at, p.id)
		}
		for (const [k, l] of [...m.leaves]) {
			if (leaves.get(k)?.id === l.id) continue
			m.leaves.delete(k)
			unleaf(l.path)
		}
		for (const id of [...m.ids]) {
			if (wanted.has(id)) continue
			m.ids.delete(id)
			unwrite(id)
		}
		for (const [id, seen] of wanted) {
			owners.set(id, who)
			m.ids.add(id)
			write(id, "attributes", isMap(seen.attributes) ? seen.attributes : undefined)
			write(id, "children", isMap(seen.children) ? kids(who, seen.children) : undefined)
		}
		for (const [k, l] of leaves) {
			if (m.leaves.has(k)) continue
			try {
				commit(addLeaf(table, AWAY, places.root, l.path, l.id, header()))
				m.leaves.set(k, l)
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
		}
	}

	function reconcile(rows: readonly Live[]) {
		const live = new Map(rows.map((r) => [r.who, r.value]))
		for (const who of [...mirrors.keys()]) if (!live.has(who)) drop(who)
		for (const [who, value] of live) mirror(who, value)
	}

	// my row, as last set (beat sets it again)
	let last: Nodes | undefined
	const shown = (a: Nodes, b: Nodes) => same(bytesOf(a), bytesOf(b))
	s.runWithScope(scope, () => {
		if (publish) {
			s.createEffect(() => den.nodes({ processes }), (v) => {
				last = v
				setPresence(world, anchor, channel.name, v, ttl)
			}, shown)
		}
		s.createEffect(
			() => readPresence(world, anchor).filter((r) => r.who !== channel.name),
			(rows) => within(() => reconcile(rows)),
		)
	})
	const heard = listen(world, channel, { topic: anchor })

	// asks to this den: answered on the asker's answer topic
	const offAsk = channel.on(`${anchor}/ask/${channel.name}`, (from, bytes) => {
		const m = read(bytes)
		if (m === undefined) return
		const who: Record<string, unknown> = {}
		if (isMap(m.who) && m.who.actor !== undefined) who.actor = m.who.actor
		if (isMap(m.who) && typeof m.who.reader === "string") who.reader = m.who.reader
		who.device = from
		const a = askOf(m, who)
		if (a === undefined) return
		let answer: unknown
		try {
			answer = within(() => den.ask(a))
		} catch (e) {
			answer = {
				error: e instanceof PlacesError ? e.code : e instanceof Error ? e.message : String(e),
			}
		}
		channel.send(`${anchor}/answer/${from}`, encode({ n: m.n, answer } as Value))
	})

	// answers to this den's asks: kept from the den each was sent to, the first
	let count = 0
	const sent = new Map<number, string>()
	const answers = new Map<number, Answered>()
	const keys = new Map<number, object>()
	const keyOf = (n: number) => {
		let k = keys.get(n)
		if (k === undefined) keys.set(n, k = {})
		return k
	}
	const offAnswer = channel.on(`${anchor}/answer/${channel.name}`, (from, bytes) => {
		const m = read(bytes)
		if (m === undefined || sent.get(m.n) !== from || answers.has(m.n)) return
		if (!isMap(m.answer)) return
		answers.set(m.n, m.answer as Answered)
		s.mark([keyOf(m.n)])
	})

	let stopped = false

	function ask(to: string, r: Remote): number {
		if (stopped) throw new Error("the link is stopped")
		const base = createChangeBase(s)
		const who: Record<string, unknown> = {}
		if (base?.actor !== undefined) who.actor = base.actor
		if (base?.reader !== undefined) who.reader = base.reader
		const fields = r.op === "start"
			? defined({ ...r, program: defined({ ...r.program }) })
			: defined({ ...r })
		const n = count + 1
		const bytes = encode({ n, ...fields, who } as Value)
		count = n
		sent.set(n, to)
		channel.send(`${anchor}/ask/${to}`, bytes)
		return n
	}

	function answer(n: number): Answered | undefined {
		s.track(keyOf(n))
		return answers.get(n)
	}

	function carry(program: Address | { readonly id: Id }, o: { code?: boolean } = {}): Program {
		const id = isAddress(program) ? places.peep(() => get(places, inside(program))) : program.id
		const entry = id === undefined ? undefined : table.get("value", id)
		if (id === undefined || entry === undefined) {
			const at = isAddress(program) ? inside(program).join("/") : String(program.id)
			throw new PlacesError("nothing-there", at)
		}
		const attrs = table.get("attributes", id)?.value
		const out: Record<string, unknown> = { id }
		const digest = hashOf(entry.value)
		if (digest !== undefined) out.hash = digest
		if (isMap(attrs) && typeof attrs[ATTRIBUTE] === "string") out.type = attrs[ATTRIBUTE]
		if (isMap(attrs) && typeof attrs[PROGRAM_API] === "string") out.api = attrs[PROGRAM_API]
		if (o.code) out.code = entry.value
		return out as Program
	}

	function beat() {
		if (!stopped && last !== undefined) setPresence(world, anchor, channel.name, last, ttl)
	}

	// every step runs; the first error is thrown after
	function stop() {
		if (stopped) return
		stopped = true
		let failed: { error: unknown } | undefined
		const step = (f: () => unknown) => {
			try {
				f()
			} catch (error) {
				failed ??= { error }
			}
		}
		if (publish && scope.state === "alive") step(() => clear(world, anchor, channel.name))
		step(() => within(() => [...mirrors.keys()].forEach(drop)))
		step(heard.stop)
		step(offAsk)
		step(offAnswer)
		if (tie !== undefined) step(() => s.teardown(tie))
		step(() => s.teardown(scope))
		if (failed) throw failed.error
	}

	heard.announce()
	s.registerTeardown(scope, stop)
	// the den's close stops it: a scope of the link's under the den's owner, torn down at its stop
	// (so a link stopped leaves nothing on the owner). the den closed: stopped now
	const tie: Scope | undefined = den.scope.state === "alive"
		? s.createScope({ dens: "link" }, den.scope)
		: undefined
	s.registerTeardown(tie ?? den.scope, stop)
	return {
		anchor,
		world,
		ask,
		answer,
		carry,
		announce: () => void (stopped || heard.announce()),
		beat,
		sweep: () => stopped ? [] : sweep(world),
		stop,
	}
}
