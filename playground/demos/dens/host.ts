/// <reference lib="dom" />
// the host: one world (a scheduler, a table, places with processes, away and children), one den in
// it, and tippet (experiments/tippet) tying the world to the room's log. dens_test.ts' world(), made
// in a page. the den is its install: its node's id is the install's ("ermine:ed01" + its key's
// hex), its name under /system/dens is the key's hex, and the key is the tab's seed, the one the log
// signs with: the den and its tippet device are one
//
//   const h = await createHost({ seed, name: "ada", device: "browser", room: "KAYA", server })
//   h.den.start("/system/den/runners/button", "/things/button", "/work/button-1")
//   const ask = await h.ask(other, { op: "start", ... })   // into its inbox; its answer beside it
//   h.answer(other, ask)                                    // tracked; undefined until it lands
//   h.trust(other)                                          // into this den's authorized_keys
//
// what syncs (history's kept): this den's own nodes, as steps in the room's log
//   <den>                   attributes (its name, device), children { on, things, inbox, authorized_keys }
//   <den>/things            children: each thing's process id → <den>/things/<process id>
//   <den>/things/<process>  attributes: the process's, as den.nodes() shows them, and thing.at
//   <den>/inbox             value: { <ask id>: { ask, claim, sig, answer? } }: anyone writes an ask
//   <den>/authorized_keys   value: { <install id>: { name } }: who this den does asks for
// and the asks this den writes into another's inbox. never the page's own nodes (the root, the
// programs at /things, /sync) nor a process's own node (its status, PENDING, is no value a step can
// hold: history keeps no later patch to an entry with one write it couldn't keep)
//
// who's here: no step (steps last forever) but tippet's live, every 2 s: { den }. a den not heard
// for 6 s is grey, its things still drawn. a den shows once it has been heard on this page
//
// the old path, before tippet: each den's nodes() as a presence row (away's connect,
// playground/dens/typescript/away.ts) on together's channel through wss://galaxy.observer, a 6 s
// ttl, and asks as channel messages (link.ask). the cardputer (playground/cardputer/main/den.c)
// still speaks that, so it is not in a tippet room until it is moved over too
import createEntry, { type Entry } from "@ermine/node/entry"
import { createScheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces, type Path, PlacesError } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { get } from "@ermine/places/lib"
import { upsert } from "@ermine/places/upsert"
import { addLeaf, PROCESS, processes, removeLeaf } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { type Address, inside } from "@ermine/boxes"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import apply, { type Patch } from "@ermine/op/apply"
import { blake3 } from "@ermine/blake3"
import * as ed25519 from "@ermine/ed25519"
import { openInstall } from "@ermine/installs"
import { startSession } from "@ermine/sessions"
import { trusted } from "@ermine/trust"
import { createHistory, createLog, createSync, show } from "@ermine/tippet"
import { socket } from "@ermine/tippet/carriers/websocket"
import { bus } from "@ermine/tippet/carriers/broadcastchannel"
import {
	type Asked,
	ATTRIBUTE,
	createDen,
	type Den,
	DENS,
	hashOf,
	NAME,
	type Nodes,
	type Program,
	PROGRAM_API,
	TAKES,
} from "@ermine/dens"
import { AWAY, away, type Remote } from "@ermine/dens/away"
import { RUNNERS } from "./things.ts"

export const ROOT = "root"

// a room: who meets. its code is a few letters a person can read off a screen and type (no I, L,
// O, B, G, Q, S, U, V, Z: none that look like another). its tippet room: "dens-" + the code, the
// galaxy room /littlesync/tippet/dens-CODE. roomId is the old id (away's anchor, the cardputer's
// den.c makes the same from the same code): "ermine://" + hex(blake3("party.chee.ermine.dens.room:"
// + CODE))
export const LETTERS = "ACDEFHJKMNPRTWXY"
export const roomCode = (typed: string): string | undefined => {
	const c = typed.toUpperCase().replace(/[^A-Z]/g, "")
	return c.length === 4 && [...c].every((x) => LETTERS.includes(x)) ? c : undefined
}
export const newCode = (): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => LETTERS[b % 16]).join("")
export const roomId = (code: string): string =>
	"ermine://" + hex(blake3(new TextEncoder().encode(`party.chee.ermine.dens.room:${code}`)))
export const roomName = (code: string) => `dens-${code}`
export const OUT = "thing.out"
// a thing's path in its den, on its shared node: "/work/button-1a2b"
export const AT = "thing.at"
export const TYPE = (kind: string) => `thing.${kind}`
// the kinds you can add; the cardputer's hardware (keys, screen, pigs) runs on three more
export const KINDS = ["button", "pad", "counter", "timer", "chart", "sound"] as const
export type Kind = typeof KINDS[number] | "keys" | "screen" | "pigs"
// how often a den says it is here, and how long until one not heard is grey
export const BEAT = 2000, QUIET = 6000

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
// a den's node: its install's id, from its key's hex
export const installOf = (den: string) => `ermine:ed01${den}`
const INSTALL = /^ermine:ed01([0-9a-f]{64})$/
const INBOX = /^ermine:ed01[0-9a-f]{64}\/inbox$/
// the key's hex back from an install's id; none: not one
export const denOf = (install: unknown): string | undefined =>
	typeof install === "string" ? INSTALL.exec(install)?.[1] : undefined

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// a value's encoding; none: undefined
function bytesOf(v: unknown): Uint8Array | undefined {
	try {
		return encode(v as Value)
	} catch {
		return undefined
	}
}
const same = (a?: Uint8Array, b?: Uint8Array) =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i])
// the fields that are not undefined (what encodes)
const defined = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// ---- the log's store: in memory, and kept in this browser ----

// tippet's mod.ts names neither type: they are worked out from what it gives
type Sync = ReturnType<typeof createSync>
type Store = NonNullable<NonNullable<Parameters<typeof createLog>[0]>["store"]>
type At = [device: string, n: number]

const asked = <T>(r: IDBRequest<T>) =>
	new Promise<T>((ok, no) => (r.onsuccess = () => ok(r.result), r.onerror = () => no(r.error)))
const done = (t: IDBTransaction) =>
	new Promise<void>((ok, no) => {
		t.oncomplete = () => ok()
		t.onerror = t.onabort = () => no(t.error)
	})

// a log's store: its records in memory, and in this browser's IndexedDB (a database per den and
// room), so a reload is the same den going on from its own last step. one that forgets (tippet's
// memory store) starts the den at step 1 again, a step 1 the room holds already: the room passes
// over every step after, and the den stands still. none to be had (a private window): memory only,
// and said (kept false)
async function browserStore(name: string): Promise<{ store: Store; kept: boolean }> {
	let db: IDBDatabase | undefined
	try {
		const open = indexedDB.open(name, 1)
		open.onupgradeneeded = () => {
			open.result.createObjectStore("records", { autoIncrement: true })
			open.result.createObjectStore("key")
		}
		db = await asked(open)
	} catch {
		db = undefined
	}
	let records: Uint8Array[] = [], steps = new Map<string, Uint8Array[]>()
	const hold = (r: Uint8Array, [d, n]: At) => {
		let list = steps.get(d)
		if (!list) steps.set(d, list = [])
		list[n - 1] = r
	}
	const store: Store = {
		async load(read) {
			if (db) records = await asked(db.transaction("records").objectStore("records").getAll())
			steps = new Map()
			for (const r of records) {
				const at = read(r)
				if (at) hold(r, at)
			}
			return undefined
		},
		append(r, at) {
			records.push(r)
			if (at) hold(r, at)
			if (!db) return Promise.resolve()
			const t = db.transaction("records", "readwrite")
			t.objectStore("records").add(r)
			return done(t)
		},
		get: (d, n) => steps.get(d)![n - 1],
		// history's snapshot is never asked for here: the records are the den
		snapshot: () => Promise.resolve(),
		async key(seed) {
			if (!db) return seed
			const was = await asked(db.transaction("key").objectStore("key").get("key"))
			if (was instanceof Uint8Array) return was
			const t = db.transaction("key", "readwrite")
			t.objectStore("key").put(seed, "key")
			await done(t)
			return seed
		},
	}
	return { store, kept: db !== undefined }
}

// ---- the room's carrier ----

// a websocket to the server's galaxy, at /littlesync/tippet/<room>, linked again 5 s after it
// closes; none: a BroadcastChannel between this browser's tabs. told the state as it changes
function carry(sync: Sync, room: string, server: string | undefined, told: (s: string) => void) {
	if (server === undefined) {
		sync.link(bus(`ermine-dens:${room}`))
		return told("tabs only")
	}
	const at = new URL(server).host
	const url = `${server.replace(/\/$/, "")}/littlesync/tippet/${encodeURIComponent(room)}`
	const open = () => {
		told(`joining ${at}`)
		const ws = new WebSocket(url)
		ws.addEventListener("open", () => told(`on ${at}`))
		ws.addEventListener("close", () => {
			told(`${at}: offline, again in 5 s`)
			setTimeout(open, 5000)
		})
		sync.link(socket(ws))
	}
	open()
}

// ---- what the page is told ----

// an ask arriving for this den: who asked what, and whether it was done
export type Heard = { from: string; op: string; runner?: unknown; refused?: Refusal }
// why an ask wasn't done before it reached the den: who asked (a name), and what was wrong
export type Refusal = {
	refused: "not-trusted"
	who: string
	why: "not-in-keys" | "bad-signature" | "not-for-here"
}
// an ask's answer: the den's (a start's { id, at }, a stop's {}, its refusal), what its ask threw,
// or the inbox's refusal
export type Answer = Asked | { readonly error: string } | Refusal
// another den, as this page has it: alive while heard lately; its things as its shared nodes say
export type Other = {
	who: string
	node: string
	alive: boolean
	attributes: Record<string, unknown>
	things: { id: string; process: string; at: string[]; attributes: Record<string, unknown> }[]
}

export type Host = {
	// the den's name (its key's hex) and node (its install's id)
	id: string
	node: string
	room: string
	s: ReturnType<typeof createScheduler>
	table: ReturnType<typeof createTable>
	places: ReturnType<typeof createPlaces>
	den: Den
	host: Scope
	hosted: <T>(f: () => T) => T
	// the other dens heard on this page, by name
	others: () => Other[]
	// an ask written into another den's inbox, signed by this session: its id, or why not
	ask: (to: string, ask: Remote) => Promise<string | { problem: string }>
	// tracked; undefined until it lands
	answer: (to: string, ask: string) => Answer | undefined
	// a node of the den's (an address from its root) as an ask's program, its code with it
	carry: (program: Address) => Program
	// another den put in this den's keys; whether it is (as this den's own steps say); whether
	// another den's keys have this one
	trust: (who: string) => void
	trusts: (who: string) => boolean
	trustedBy: (who: string) => boolean
	// a pulse soon (after what arrived or was written outside one)
	soon: () => void
	onPulse: (f: () => void) => void
	onAsked: (f: (h: Heard) => void) => void
	// the server's state as it changes (told the last at once)
	onServer: (f: (state: string) => void) => void
	// what went wrong in tippet, in words: a step that wouldn't apply, a write not kept
	onTrouble: (f: (words: string) => void) => void
}

// seed: the device key's 32 bytes. server: none, tabs only
export async function createHost(
	o: { seed: Uint8Array; name: string; device: string; room: string; server?: string },
): Promise<Host> {
	// who: the install (the seed its secret: the same key the log signs with), and this page's
	// session, vouched for by it
	const install = await openInstall({
		read: (name) => name === "secret" ? o.seed : undefined,
		write: () => {},
	}, ed25519.publicKeyOf)
	const session = await startSession(install, ed25519)
	const id = hex(install.key), node = install.id
	const THINGS = `${node}/things`, INBOX_ = `${node}/inbox`, KEYS = `${node}/authorized_keys`

	const s = createScheduler()
	let due = false
	const soon = () => {
		if (due) return
		due = true
		setTimeout(() => {
			due = false
			s.pulse()
		}, 0)
	}
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({
		root: ROOT,
		table,
		paths,
		scheduler: s,
		contributors: [processes(ROOT), away(ROOT), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	// whatever made something due (a write here, a step landing): a pulse soon
	s.onMark((_, __, due) => due.length > 0 && soon())
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: id })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) =>
		changed.length > 0 && places.commit(changed)
	// a whole value, written only when it is another (as its encoding)
	const put = (part: Key, id: Id, v: unknown) => {
		const was = table.get(part, id)?.value
		if (was !== undefined && same(bytesOf(was), bytesOf(v))) return
		hosted(() => table.sub(part, id, createEntry(v as never, header())))
	}
	const patch = (part: Key, id: Id, path: string[], v: unknown) =>
		hosted(() => commit(upsert(table, part, id, path, v, header())))

	// troubles, in words: each listener told those before it too
	const troubles: ((words: string) => void)[] = [], said: string[] = []
	const trouble = (words: string) => (said.push(words), troubles.forEach((f) => f(words)))

	// ---- tippet: the log (the den's key), its history (what is kept), its sync ----
	const { store, kept: stored } = await browserStore(`ermine-dens:${roomName(o.room)}:${id}`)
	const log = createLog({ store, seed: o.seed })
	const kept = (n: string, part: string) =>
		(n === node && (part === "attributes" || part === "children")) ||
		(n === THINGS && part === "children") ||
		(n.startsWith(`${THINGS}/`) && part === "attributes") ||
		(n === KEYS && part === "value") ||
		(INBOX.test(n) && part === "value")
	const history = createHistory({ log, table, places, run: hosted, kept })
	await history.load()
	const sync = createSync({ log })
	let failed = 0, unkept = 0
	history.onChange(() => {
		for (const f of history.failed.slice(failed)) {
			trouble(`A step from ${f.device.slice(0, 6)}… to ${f.node} wouldn't apply: ${f.why}`)
		}
		for (const u of history.unkept.slice(unkept)) {
			trouble(`A write to ${u.node} wasn't kept, so it stays here: ${u.why}`)
		}
		failed = history.failed.length
		unkept = history.unkept.length
	})
	if (!stored) trouble("This browser won't keep the den's steps: a reload starts it over.")

	// the other dens: each device the log has steps of, marked when a new one comes
	const devices = {}
	const others = new Set<string>()
	const learn = (device: string) => {
		if (device === id || others.has(device)) return
		others.add(device)
		s.mark([devices])
	}
	for (const d of Object.keys(log.have())) learn(d)
	log.on((device) => learn(device))

	// this den's keys as only its own steps make them: history lands any device's step on any node,
	// so a step another wrote there is not believed
	let keys: unknown = {}
	const into = (part: string, n: string, patches: readonly Patch[]) => {
		if (n !== KEYS || part !== "value") return
		try {
			keys = apply(keys, patches)
		} catch {
			// not a value it can be: as it was
		}
	}
	for (const b of log.steps(id)) {
		const step = decode(b) as unknown[]
		into(String(step[4]), String(step[3]), step[5] as Patch[])
	}
	log.on((device, steps) => {
		if (device === id) { for (const st of steps) into(st.part, st.node, st.patches) }
	})

	// ---- the den ----
	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes. /sync:
	// tippet's own state (nodes.ts' show)
	const all = Object.keys(RUNNERS) as Kind[]
	put("children", ROOT, { things: "things", sync: "sync" })
	put("children", "things", Object.fromEntries(all.map((k) => [k, `things/${k}`])))
	for (const k of all) {
		put("value", `things/${k}`, RUNNERS[k].program)
		put("attributes", `things/${k}`, { "ermine.type": TYPE(k) })
	}
	const den = hosted(() =>
		createDen({
			scheduler: s,
			table,
			places,
			scopes,
			// a start made outside a pulse (a click, an ask) asks for one: ours
			schedule: () => soon(),
			id,
			install,
			name: o.name,
			device: o.device,
			// yes to every ask that gets here: the inbox has checked who asked first
			may: () => ({ answer: "yes" }),
		})
	)
	for (const k of all) {
		hosted(() => den.offer("runners", k, { [TAKES]: TYPE(k) }, RUNNERS[k].run))
	}
	// its shared nodes, under it; it trusts itself from the start
	for (const name of ["things", "inbox", "authorized_keys"]) {
		patch("children", node, [name], `${node}/${name}`)
	}
	if (table.get("value", INBOX_) === undefined) put("value", INBOX_, {})
	if (!isMap(keys) || !Object.hasOwn(keys, node)) patch("value", KEYS, [node], { name: o.name })

	// what the den runs, shared: each thing's attributes on a node of the den's, as they change
	function publish(seen: Nodes) {
		const want: Record<string, string> = {}
		for (const p of seen.processes ?? []) {
			const shared = `${THINGS}/${String(p.id)}`
			want[String(p.id)] = shared
			put("attributes", shared, { ...seen.nodes[p.id]?.attributes, [AT]: `/${p.at.join("/")}` })
		}
		const was = table.get("children", THINGS)?.value
		put("children", THINGS, want)
		for (const [p, shared] of Object.entries(isMap(was) ? was : {})) {
			if (!(p in want) && typeof shared === "string" && table.get("attributes", shared)) {
				hosted(() => table.del("attributes", shared))
			}
		}
	}
	hosted(() =>
		s.createEffect(() => den.nodes({ processes: true }), (seen) => hosted(() => publish(seen)))
	)

	// ---- the other dens, placed in this tree (the away trie, this page's alone): each den's node
	// at /system/dens/<name>, each thing's shared node at its path ----
	type Leaf = { path: Path; id: Id }
	const placed = new Map<string, Leaf>()
	// whether a leaf at path is in a local process's way: at or under its leaf, or on a level of the
	// process trie (addLeaf's rule, on the process part)
	function shadowed(path: Path): boolean {
		let v: unknown = table.get(PROCESS, ROOT)?.value
		for (let i = 0; i < path.length && isMap(v); i++) {
			v = Object.hasOwn(v, path[i]) ? v[path[i]] : undefined
			if (typeof v === "string") return true
		}
		return isMap(v) && Object.keys(v).length > 0
	}
	function place(want: Map<string, Leaf>) {
		for (const [k, l] of [...placed]) {
			if (want.get(k)?.id === l.id) continue
			placed.delete(k)
			try {
				commit(removeLeaf(table, AWAY, ROOT, l.path, header()))
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
		}
		for (const [k, l] of want) {
			if (placed.has(k) || shadowed(l.path)) continue
			try {
				commit(addLeaf(table, AWAY, ROOT, l.path, l.id, header()))
				placed.set(k, l)
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
		}
	}
	hosted(() =>
		s.createEffect(() => {
			s.track(devices)
			const want = new Map<string, Leaf>()
			const leaf = (path: Path, id: Id) => want.set(JSON.stringify(path), { path, id })
			for (const d of others) {
				const n = installOf(d)
				if (places.readValue("attributes", n) === undefined) continue
				leaf([...DENS, d], n)
				const kids = places.readValue("children", `${n}/things`)
				for (const shared of Object.values(isMap(kids) ? kids : {})) {
					if (typeof shared !== "string") continue
					const at = places.readValue("attributes", shared, [AT])
					if (typeof at === "string") leaf(inside(at), shared)
				}
			}
			return want
		}, (want) => hosted(() => place(want)))
	)

	// ---- asks: into the asked den's inbox, signed by this session; answered beside them ----
	const asks: ((h: Heard) => void)[] = []
	const nameOf = (install: string) => {
		const n = table.get("attributes", install)?.value?.[NAME]
		return typeof n === "string" ? n : `${denOf(install)?.slice(0, 6) ?? install}…`
	}

	// an ask's fields as den.ask takes them, who given; none: not one
	function askOf(a: Record<string, unknown>, who: Record<string, unknown>) {
		const isAddress = (x: unknown) => typeof x === "string" || Array.isArray(x)
		if (a.op === "start") {
			if (!isAddress(a.runner) || !isMap(a.program) || !isAddress(a.at)) return undefined
			return defined({
				op: "start",
				who,
				runner: a.runner,
				program: a.program,
				at: a.at,
				args: a.args,
				cwd: a.cwd,
			})
		}
		if (a.op === "stop" && typeof a.process === "string") {
			return defined({ op: "stop", who, process: a.process, reason: a.reason })
		}
		return undefined
	}

	// one ask in this den's inbox: who asked checked (in this den's keys, its session vouched for
	// by its install, the ask signed by that session), then done, or not; the answer written beside it
	async function answering(ask: string, e: Record<string, unknown>) {
		const a = isMap(e.ask) ? e.ask : {}, c = isMap(e.claim) ? e.claim : {}
		const from = String(a.from), who = nameOf(from)
		const refuse = (why: Refusal["why"]): Refusal => ({ refused: "not-trusted", who, why })
		let out: Answer
		if (
			a.to !== node || c.install !== from || typeof c.session !== "string" ||
			!(c.vouch instanceof Uint8Array) || !(e.sig instanceof Uint8Array)
		) out = refuse("not-for-here")
		else if (!isMap(keys) || !Object.hasOwn(keys, from)) out = refuse("not-in-keys")
		else if (
			!(await trusted(
				keys,
				{ session: c.session, install: from, vouch: c.vouch },
				encode(a as Value),
				e.sig,
				ed25519,
			))
		) out = refuse("bad-signature")
		else {
			const d = denOf(from) ?? from
			const asked = askOf(a, { actor: d, device: d })
			try {
				out = asked === undefined
					? { error: "not an ask" }
					: hosted(() => den.ask(asked as Parameters<Den["ask"]>[0]))
			} catch (e) {
				out = {
					error: e instanceof PlacesError
						? e.code
						: e instanceof Error
						? e.message
						: String(e),
				}
			}
			if (bytesOf(out) === undefined) out = { error: "its answer has no encoding" }
		}
		patch("value", INBOX_, [ask, "answer"], out)
		soon()
		const told: Heard = { from: denOf(from) ?? from, op: String(a.op), runner: a.runner }
		if ("refused" in out && out.refused === "not-trusted") told.refused = out
		for (const f of asks) f(told)
	}
	const answered = new Set<string>()
	hosted(() =>
		s.createEffect(() => places.readValue("value", INBOX_), (v) => {
			for (const [ask, e] of Object.entries(isMap(v) ? v : {})) {
				if (answered.has(ask) || !isMap(e) || e.answer !== undefined) continue
				answered.add(ask)
				void answering(ask, e)
			}
		})
	)

	let count = 0
	async function ask(to: string, r: Remote): Promise<string | { problem: string }> {
		const inbox = `${installOf(to)}/inbox`
		if (table.get("value", inbox) === undefined) {
			return { problem: "its inbox hasn't reached this page yet" }
		}
		const fields = r.op === "start"
			? defined({ ...r, program: defined({ ...r.program }) })
			: defined({ ...r })
		const n = `${id.slice(0, 8)}-${Date.now().toString(36)}-${++count}`
		const a = { ...fields, id: n, from: node, to: installOf(to) }
		const sig = await ed25519.sign(session.secret, encode(a as Value))
		const claim = { session: session.id, install: install.id, vouch: session.vouch }
		patch("value", inbox, [n], { ask: a, claim, sig })
		soon()
		return n
	}

	function carryOf(program: Address): Program {
		const at = inside(program)
		const pid = places.peep(() => get(places, at))
		const entry = pid === undefined ? undefined : table.get("value", pid)
		if (pid === undefined || entry === undefined) {
			throw new PlacesError("nothing-there", at.join("/"))
		}
		const attrs = table.get("attributes", pid)?.value
		const out: Record<string, unknown> = { id: pid, code: entry.value }
		const digest = hashOf(entry.value)
		if (digest !== undefined) out.hash = digest
		if (isMap(attrs) && typeof attrs[ATTRIBUTE] === "string") out.type = attrs[ATTRIBUTE]
		if (isMap(attrs) && typeof attrs[PROGRAM_API] === "string") out.api = attrs[PROGRAM_API]
		return out as Program
	}

	// ---- who's here: a live every 2 s; bye as the page goes ----
	const heard = new Map<string, number>()
	sync.onLive((data) => {
		try {
			const m = decode(data)
			if (!isMap(m) || typeof m.den !== "string" || m.den === id) return
			heard.set(m.den, m.bye ? 0 : Date.now())
			soon()
		} catch {
			// not one
		}
	})
	const beat = () => sync.live(encode({ den: id }))

	// the carrier, and the server's state
	let state = ""
	const servers: ((state: string) => void)[] = []
	carry(sync, roomName(o.room), o.server, (x) => {
		state = x
		for (const f of servers) f(x)
	})

	// tippet's state, at /sync: a node whose writes aren't kept, so it never feeds itself
	show({
		sync,
		log,
		history,
		write: (v) => (put("value", "sync", v), soon()),
	})

	const pulsed: (() => void)[] = []
	s.onAfterPulse(() => {
		for (const f of pulsed) f()
	})
	// the heartbeat; and a draw, so a den gone quiet goes grey
	beat()
	setInterval(() => {
		beat()
		soon()
		for (const f of pulsed) f()
	}, BEAT)
	addEventListener("pagehide", () => sync.live(encode({ den: id, bye: true })))
	soon()

	return {
		id,
		node,
		room: o.room,
		s,
		table,
		places,
		den,
		host,
		hosted,
		others: () => {
			const now = Date.now()
			const out: Other[] = []
			for (const [who, when] of heard) {
				const n = installOf(who)
				const attributes = table.get("attributes", n)?.value
				if (!isMap(attributes)) continue
				const kids = table.get("children", `${n}/things`)?.value
				const things: Other["things"] = []
				for (const [process, shared] of Object.entries(isMap(kids) ? kids : {})) {
					const a = typeof shared === "string"
						? table.get("attributes", shared)?.value
						: undefined
					if (!isMap(a) || typeof a[AT] !== "string") continue
					things.push({ id: shared as string, process, at: inside(a[AT]), attributes: a })
				}
				out.push({ who, node: n, alive: now - when < QUIET, attributes, things })
			}
			return out.sort((a, b) => a.who < b.who ? -1 : 1)
		},
		ask,
		answer: (to, n) => {
			const v = places.readValue("value", `${installOf(to)}/inbox`, [n, "answer"])
			return isMap(v) ? v as Answer : undefined
		},
		carry: carryOf,
		trust: (who) => patch("value", KEYS, [installOf(who)], { name: nameOf(installOf(who)) }),
		trusts: (who) => isMap(keys) && Object.hasOwn(keys, installOf(who)),
		trustedBy: (who) => {
			const theirs = table.get("value", `${installOf(who)}/authorized_keys`)?.value
			return isMap(theirs) && Object.hasOwn(theirs, node)
		},
		soon,
		onPulse: (f) => void pulsed.push(f),
		onAsked: (f) => void asks.push(f),
		onServer: (f) => (servers.push(f), f(state)),
		onTrouble: (f) => (troubles.push(f), said.forEach(f)),
	}
}
