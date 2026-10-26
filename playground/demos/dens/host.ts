/// <reference lib="dom" />
// the host: one world (a scheduler, a table, places with processes, away and children), one den in
// it, software (experiments/software) running what the den runs, and tippet (experiments/tippet)
// tying the world to the room's log. made in a page. software has no policy and no asking: what
// decides who may ask this den for what is its inbox, a program the den runs at /system/inbox
//
//   const h = await createHost({ seed, name: "ada", device: "browser", room: "KAYA", server })
//   h.software.run("/system/den/runners/button", "/things/button", "/home/button-1a2b")
//   const n = await h.ask(other, { op: "start", ... })   // into its inbox; its answer beside it
//   h.answer(other, n)                                    // tracked; undefined until it lands
//   await h.pair(other)                                   // a pair ask; h.onPair told its answer
//   h.answerPair(n, true)                                 // yes to a pair ask in this den's inbox
//   await h.unpair(other)                                 // out of both dens' keys
//
// ---- the contract: what a den is, as the cardputer's C (playground/cardputer) does it too ----
//
// a den is an install. its key: ed25519, from the seed (32 bytes). its id: the key's 64 hex. its
// node: "ermine:ed01" + id. the room's log signs with the same key: the den and its tippet device
// are one. a room: tippet's room "dens-" + CODE (4 of LETTERS), at <server>/littlesync/tippet/dens-CODE
//
// what syncs (history's kept): a den's own nodes, as steps in the room's log, each written by its
// den alone. CBOR throughout, maps with string keys
//   <node>                   attributes { "ermine.type": "ermine.den", "ermine.den.id": id,
//                            "ermine.den.name": name, "ermine.den.device": "browser" | "cardputer",
//                            "ermine.den.parts"?: { <kind>: a few words }: the parts the den starts
//                            itself, each a plain process (the cardputer's; a browser has none) }
//                            children { things: <node>/things, inbox: <node>/inbox,
//                            authorized_keys: <node>/authorized_keys, files: <node>/files }, and
//                            runners: <node>/runners (a browser's software offers; nobody else
//                            reads them)
//   <node>/things            children { <process id>: <node>/things<its path> }, one a thing
//   <node>/things<path>      attributes: the thing's process's, as it runs, and "thing.at"
//                            "/home/<kind>-<4 hex>" (its path in its den). what another den reads:
//                              "thing.kind": its kind (a part's); else
//                              "ermine.process.runner" { id, at: [steps] }: at's last step is the kind
//                              "ermine.process.args" [strings]: what it reads, as triples
//                                <input> <den id> <path> (things.ts' parse), and "name=value"s
//                                (a setting's name is never empty). a triple reading an outlet
//                                other than the first has "=<outlet>" just after it, its path
//                                ("/home/keys") then "=typed": it reads "thing.typed". none:
//                                "thing.out". a reader before outlets takes "=typed" for a
//                                setting with no name, one nobody asks for: its triples the same
//                              "thing.out": what it gives, its first outlet (a number, text, a
//                                map, a picture)
//                              "thing.<outlet>": each other outlet's (things.ts' OUTLETS): the
//                                keys' "typed" { key, n }, the pigs' "says" { pig, text, n }
//                              "thing.state": a timer's, a pad's, a sound's extra
//                              "ermine.computer.status": "pending" | { failed: words }, when so
//                            and the rest software and processes write ("ermine.type"
//                            "ermine.process", "ermine.process.program" { id, at?, hash? },
//                            "ermine.process.folder")
//   <node>/files             children { <8 hex>: <node>/files/<8 hex> }: every node a person made
//                            here (made.ts), placed or not
//   <node>/files/<8 hex>     a made node. a folder: children { <name>: <node>/files/<8 hex> } and
//                            attributes { "ermine.type": "dens.folder" }; else value: what was typed
//                            (a number, true, false, text). one at the top or in /home has
//                            attributes "file.at": its path ("/notes", "/home/notes"), and is placed
//                            there in every den's tree; taken out (unplaced): file.at gone, or its
//                            name gone from its folder's children
//   <node>/authorized_keys   value { <node>: { name } }: the dens this den does asks for, its own
//                            node among them from the start. only steps of the den's own count:
//                            a step another device wrote there is not believed
//   <node>/inbox             value { <ask id>: { ask, claim, sig, answer? } }: an asker writes a
//                            patch at [<ask id>]; the den writes the answer at [<ask id>, "answer"].
//                            a den may take answered asks out (a delete at [<ask id>]) to stay
//                            small: the cardputer, past 12 answered, the oldest, 6 left; never one
//                            waiting, nor a menu item's
//
// an ask, written into the asked den's inbox:
//   ask    { op, id, from: the asker's node, to: the asked den's node, ...the op's fields }
//          id: "<the asker's id's first 8 hex>-<its clock in ms, base 36>-<a count>"
//   claim  { session, install: from, vouch }: this page's session (@ermine/sessions: its id
//          "ermine:ed01" + the session key's hex, vouch the install's signature for it)
//   sig    ed25519, by the session's key, over the ask's canonical CBOR
// the ops, each with its answer:
//   start   a browser den (software): { runner: "/system/den/runners/<kind>", program: { id, code,
//           hash?, type?, api? }, at: "/home/<kind>-<4 hex>", args?: [strings] }
//           → { id: <process id>, at: [steps] }, or software's refusal: { refused: "taken", at }
//           | { refused: "not-a-runner", runner } | { refused: "not-there", program }
//           | { refused: "wrong-form", program, runner }
//           a den that says its parts (ermine.den.parts): { kind, at: "/home/<kind>-<4 hex>",
//           args?: [strings] } (its speaker's at: "/system/speaker") → { id, at: [steps] }
//           | { refused: "taken", at } | { refused: "not-a-kind", kind }
//           | { refused: "not-here", why } (a part only starts in /home); a runner-and-program
//           start there → { error: <words> }
//   stop    { process: <process id>, reason? } → {} | { refused: "not-there", process }
//   pair    { name: the asker's name } → { pair: "yes" } | { pair: "no" }: a person's answer (the
//           cardputer: tab yes, esc no), none until then; from a den in authorized_keys already:
//           { pair: "yes" } at once
//   unpair  {} → {}
//   menu    { name: 1 to 24 printable ASCII, no "/", handler?: a start or a stop, as above (its op
//           and the op's fields) } → {} | { refused: "taken", name } (the den's own item, or another
//           den's) | { error: <words> }. the cardputer's G0 menu (/system/menu): an item named name,
//           from the asker. picked: handler done as if the asker asked it then (not-in-keys once
//           unpaired). no handler: its item taken out. its {}-answered menu asks put in again at
//           each boot, in the order they were made. (no browser page asks it yet)
// and to any: { refused: "not-trusted", who: <the asker's name>, why } or { error: <words> }
// the inbox's checks, in order, the first that fails its why:
//   to is not this den's node, or claim.install is not from              "not-for-here"
//   pair: trusted({ [from]: {} }, claim, cbor(ask), sig) is false         "bad-signature"
//   the rest: from not in authorized_keys                                 "not-in-keys"
//             trusted(authorized_keys, claim, cbor(ask), sig) is false    "bad-signature"
// (trusted: @ermine/trust: the install in keys, its vouch for the session good, the session's
// signature over the bytes good)
//
// pairing: A asks B pair. B's screen: "<A's name> wants to pair", yes or no. yes: B puts A in its
// authorized_keys ({ name }) and answers { pair: "yes" }; A, seeing that answer and itself in B's
// authorized_keys, puts B in its own. no: { pair: "no" }, nothing else changes. unpair: A takes B
// out of its authorized_keys and asks B unpair; B takes A out of its. paired: each in the other's
// authorized_keys. until then neither reaches the other's ins and outs
//
// who's here: no step (steps last forever) but tippet's live (sync.live), CBOR { den: id } every
// 2 s, and { den: id, bye: true } as the page goes. a den not heard for 6 s is grey, its things
// still drawn. a den shows once it has been heard on this page
//
// never kept: the page's own nodes (the root, the programs at /things and /programs, /sync), and a
// process's own node (its status, PENDING, is no value a step can hold)
import { createScheduler, PENDING, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { children, createPlaces, type Path, PlacesError } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { STATUS } from "@ermine/core/places/status"
import { addLeaf, addProcess, PROCESS, processes, removeLeaf, trie } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import type { Process } from "@ermine/processes/start"
import { type Address, inside } from "@ermine/boxes"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import apply, { type Patch } from "@ermine/core/op/apply"
import { blake3 } from "@ermine/core/blake3"
import * as ed25519 from "@ermine/core/ed25519"
import { openInstall } from "@ermine/installs"
import { startSession } from "@ermine/sessions"
import { trusted } from "@ermine/trust"
import { createHistory, createLog, createSync, show } from "@ermine/tippet"
import { socket } from "@ermine/tippet/carriers/websocket"
// the log's own index of its records, as tippet's stores use it (its package doesn't export it)
import { createIndex, type Store } from "../../../experiments/tippet/typescript/log.ts"
import { decodeStep } from "../../../experiments/tippet/typescript/step.ts"
import { bus } from "@ermine/tippet/carriers/broadcastchannel"
import {
	ATTRIBUTE,
	createSoftware,
	hashOf,
	type Place,
	type Program,
	PROGRAM_API,
	type Refused,
	type Runner,
	type Software,
	TAKES,
} from "@ermine/software"
import { RUNNERS, withDen } from "./things.ts"
import { bytesOf, createWrites } from "./writes.ts"
import { createMade, MADE, type Made, placements } from "./made.ts"

export const ROOT = "root"

// a den's node's attributes
export const NAME = "ermine.den.name"
export const DEVICE = "ermine.den.device"
const DEN_ID = "ermine.den.id"
// where dens are in this tree: each at /system/dens/<id>, this one at /system/den too; its inbox
// runs at /system/inbox
export const DENS: Path = ["system", "dens"]
export const HERE: Path = ["system", "den"]
const INBOX_AT: Path = ["system", "inbox"]
// the other dens' nodes and things, placed in this tree: a trie of their own, as processes' is
const AWAY = "away" as string as Key

// a room: who meets. its code is a few letters a person can read off a screen and type (no I, L,
// O, B, G, Q, S, U, V, Z: none that look like another). its tippet room: "dens-" + the code, the
// galaxy room /littlesync/tippet/dens-CODE. roomId is the old id (the cardputer's den.c made the
// same from the same code): "ermine://" + hex(blake3("party.chee.ermine.dens.room:" + CODE))
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
// a thing's path in its den, on its shared node: "/home/button-1a2b"
export const AT = "thing.at"
export const TYPE = (kind: string) => `thing.${kind}`
// the kinds you can add; the cardputer's hardware (keys, screen, pigs) runs on three more
export const KINDS = ["button", "pad", "counter", "timer", "chart", "sound"] as const
export type Kind = typeof KINDS[number] | "keys" | "screen" | "pigs" | "speaker"
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

// the fields that are not undefined (what encodes)
const defined = (o: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// ---- the log's store: in memory, and kept in this browser ----

// tippet's mod.ts names neither type: they are worked out from what it gives
type Sync = ReturnType<typeof createSync>

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
// and said (kept false). the records as tippet's log gives them (a run message, or a step not yet
// in a closed run), held in memory too and found again by tippet's own index, as its stores do.
// name: a new one for each new form of record, so an old one is never half read
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
	let records: Uint8Array[] = []
	const index = createIndex<Uint8Array>((r) => r)
	const store: Store = {
		async load(read) {
			if (db) records = await asked(db.transaction("records").objectStore("records").getAll())
			index.clear()
			for (const r of records) {
				const at = read(r)
				if (at) index.hold(at, r)
			}
			return undefined
		},
		append(r, at) {
			records.push(r)
			if (at) index.hold(at, r)
			if (!db) return Promise.resolve()
			const t = db.transaction("records", "readwrite")
			t.objectStore("records").add(r)
			return done(t)
		},
		run: index.run,
		get: index.get,
		drop: index.drop,
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

// what an ask carries beside op's own: id, from and to are the host's
export type Request =
	| { op: "start"; runner: string; program: Program; at: string; args?: readonly string[] }
	// a den that says its parts (ermine.den.parts, the cardputer): one started by kind
	| { op: "start"; kind: string; at: string; args?: readonly string[] }
	| { op: "stop"; process: string; reason?: unknown }
	| { op: "pair"; name: string }
	| { op: "unpair" }
// an ask arriving for this den: who asked what (from: the asker's id), and whether it was done.
// wants: a pair ask's id, waiting for a person's yes or no (answerPair); name: the name it gave
export type Heard = {
	from: string
	op: string
	runner?: unknown
	refused?: Refusal
	wants?: string
	name?: string
}
// why the inbox didn't do an ask: who asked (a name), and what was wrong
export type Refusal = {
	refused: "not-trusted"
	who: string
	why: "not-in-keys" | "bad-signature" | "not-for-here"
}
// an ask's answer: a start's { id, at }, a stop's or an unpair's {}, a pair's, software's refusal,
// what the ask threw, or the inbox's refusal
export type Answer =
	| { readonly id: Id; readonly at: Path }
	| Record<never, never>
	| Refused
	| { readonly refused: "not-there"; readonly process: string }
	// a part's start, refused (a den that says its parts): no such kind; not a part's place
	| { readonly refused: "not-a-kind"; readonly kind: string }
	| { readonly refused: "not-here"; readonly why: string }
	| { readonly pair: "yes" | "no" }
	| { readonly error: string }
	| Refusal
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
	// what runs here: things, and the inbox
	software: Software
	// the nodes a person makes here, and takes out (made.ts)
	made: Made
	host: Scope
	hosted: <T>(f: () => T) => T
	// the things this den runs (its processes but the inbox), in start order; one by its id
	things: () => readonly Process[]
	find: (id: string) => Process | undefined
	// the inbox's process, and its program's path
	inbox: () => Process | undefined
	// the other dens heard on this page, by name
	others: () => Other[]
	// an ask written into another den's inbox, signed by this session: its id, or why not
	ask: (to: string, ask: Request) => Promise<string | { problem: string }>
	// tracked; undefined until it lands
	answer: (to: string, ask: string) => Answer | undefined
	// a node of the den's (an address from its root) as an ask's program, its code with it
	carry: (program: Address) => Program
	// pairing, through the inbox: a pair ask to another den (onPair told its answer); a yes or no to
	// one in this den's inbox; another den out of this one's keys, and asked to take this one out
	pair: (who: string) => Promise<string | { problem: string }>
	answerPair: (ask: string, yes: boolean) => void
	unpair: (who: string) => Promise<string | { problem: string }>
	// whether this den has another in its keys; another has this one in its (as its own steps say);
	// both
	trusts: (who: string) => boolean
	trustedBy: (who: string) => boolean
	paired: (who: string) => boolean
	// whether a pair ask to another is waiting for its answer
	pairing: (who: string) => boolean
	// a pulse soon (after what arrived or was written outside one)
	soon: () => void
	onPulse: (f: () => void) => void
	onAsked: (f: (h: Heard) => void) => void
	// a pair ask of this den's answered: who, and the answer
	onPair: (f: (who: string, a: Answer) => void) => void
	// the server's state as it changes (told the last at once)
	onServer: (f: (state: string) => void) => void
	// what went wrong in tippet, in words: a step that wouldn't apply, a write not kept
	onTrouble: (f: (words: string) => void) => void
}

// the inbox's program, at /programs/inbox: words, as the things' are; the inbox's runner is the
// function
const INBOX_PROGRAM =
	"the inbox: each ask written into this den's inbox node checked with trusted() against its authorized_keys, then done, or refused in words; pair asks shown to a person"
const INBOX_TYPE = "dens.inbox"

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
	const FILES = `${node}/files`

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
		contributors: [
			processes(ROOT),
			trie(AWAY, ROOT, "away"),
			trie(MADE, ROOT, "made"),
			children,
		],
	})
	s.onTrackingEnd((key) => places.release(key))
	// whatever made something due (a write here, a step landing): a pulse soon
	s.onMark((_, __, due) => due.length > 0 && soon())
	const scopes = createScopeNodes({ scheduler: s, table })
	const host = s.createRootScope({ actor: id })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	// put: a whole value, written only when it is another; a write's site is its caller's line
	const { header, commit, put, patch, drop } = createWrites({
		scheduler: s,
		table,
		places,
		scope: host,
	})

	// troubles, in words: each listener told those before it too
	const troubles: ((words: string) => void)[] = [], said: string[] = []
	const trouble = (words: string) => (said.push(words), troubles.forEach((f) => f(words)))

	// ---- tippet: the log (the den's key), its history (what is kept), its sync ----
	const { store, kept: stored } = await browserStore(`ermine-dens-runs:${roomName(o.room)}:${id}`)
	const log = createLog({ store, seed: o.seed })
	const kept = (n: string, part: string) =>
		(n === node && (part === "attributes" || part === "children")) ||
		(n === THINGS && part === "children") ||
		(n.startsWith(`${THINGS}/`) && part === "attributes") ||
		(n === KEYS && part === "value") ||
		(n === FILES && part === "children") ||
		(n.startsWith(`${FILES}/`) && part !== "process") ||
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

	// each den's keys as only its own steps make them: history lands any device's step on any node,
	// so a step another wrote there is not believed. this den's own among them. marked as they change
	const keysBy = new Map<string, unknown>()
	const keysChanged = {}
	const into = (device: string, part: string, n: string, patches: readonly Patch[]) => {
		if (n !== `${installOf(device)}/authorized_keys` || part !== "value") return
		try {
			keysBy.set(device, apply(keysBy.get(device) ?? {}, patches))
			s.mark([keysChanged])
		} catch {
			// not a value it can be: as it was
		}
	}
	for (const d of Object.keys(log.have())) {
		for (const b of log.steps(d)) {
			// decoded by tippet, so a node written relative to its device comes back whole
			const st = decodeStep(b)
			into(d, st.part, st.node, st.patches as Patch[])
		}
	}
	log.on((device, steps) => {
		for (const st of steps) into(device, st.part, st.node, st.patches)
	})
	// whether den has another's node in its keys (tracked)
	const has = (den: string, other: string) => {
		s.track(keysChanged)
		const k = keysBy.get(den)
		return isMap(k) && Object.hasOwn(k, other)
	}

	// ---- the den: its node, placed at /system/den and /system/dens/<id> ----
	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes. the
	// inbox's at /programs/inbox. /sync: tippet's own state (nodes.ts' show)
	const all = Object.keys(RUNNERS) as Kind[]
	put("children", ROOT, { things: "things", programs: "programs", sync: "sync" })
	put("children", "things", Object.fromEntries(all.map((k) => [k, `things/${k}`])))
	for (const k of all) {
		put("value", `things/${k}`, RUNNERS[k].program)
		put("attributes", `things/${k}`, { [ATTRIBUTE]: TYPE(k) })
	}
	put("children", "programs", { inbox: "programs/inbox" })
	put("value", "programs/inbox", INBOX_PROGRAM)
	put("attributes", "programs/inbox", { [ATTRIBUTE]: INBOX_TYPE })

	put("attributes", node, {
		[ATTRIBUTE]: "ermine.den",
		[DEN_ID]: id,
		[NAME]: o.name,
		[DEVICE]: o.device,
	})
	for (const path of [HERE, [...DENS, id]]) commit(addProcess(table, ROOT, path, node, header()))
	// its shared nodes, under it; it trusts itself from the start
	for (const name of ["things", "inbox", "authorized_keys", "files"]) {
		patch("children", node, [name], `${node}/${name}`)
	}
	if (table.get("value", INBOX_) === undefined) put("value", INBOX_, {})
	if (!has(id, node)) patch("value", KEYS, [node], { name: o.name })

	// what runs here, on software: the den's node the owner its runners are offered under, stored
	// (what is offered stays on the node; only the live functions go with the page)
	const software = createSoftware({
		scheduler: s,
		table,
		places,
		scopes,
		scope: host,
		schedule: (f) => setTimeout(f, 0),
	})
	const owner: Place = { id: node, at: HERE, scope: host, stored: true }
	hosted(() => {
		for (const k of all) {
			software.offer(
				owner,
				"runners",
				k,
				{ [TAKES]: TYPE(k) },
				withDen(RUNNERS[k].run, { scheduler: s, table }),
			)
		}
		software.offer(owner, "runners", "inbox", { [TAKES]: INBOX_TYPE }, inboxRun)
	})
	const isInbox = (p: Process) => p.at.join("/") === INBOX_AT.join("/")
	const things = () => software.running().filter((p) => !isInbox(p))

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
			} else if (bytesOf(x) !== undefined) out[k] = x
		}
		return out
	}

	// a map written as only its keys that are another, one patch each (a key gone: dropped); whole
	// when there is none yet
	const sameBytes = (a: unknown, b: unknown) => {
		const x = bytesOf(a), y = bytesOf(b)
		return x !== undefined && y !== undefined && x.length === y.length &&
			x.every((n, i) => n === y[i])
	}
	function putKeys(part: Key, id: Id, v: Record<string, unknown>) {
		const was = table.get(part, id)?.value
		if (!isMap(was)) return put(part, id, v)
		for (const k of Object.keys(was)) if (!Object.hasOwn(v, k)) drop(part, id, [k])
		for (const [k, x] of Object.entries(v)) {
			if (!Object.hasOwn(was, k) || !sameBytes(was[k], x)) patch(part, id, [k], x)
		}
	}

	// what the den runs, shared: each thing's attributes on <den>/things<its path> (the same node
	// each load, and short: /things/home/keys-1a2b), as they change
	function publish(seen: Map<string, Record<string, unknown>>) {
		const want: Record<string, string> = {}
		for (const [p, attributes] of seen) {
			const shared = `${THINGS}${attributes[AT]}`
			want[p] = shared
			putKeys("attributes", shared, attributes)
		}
		const was = table.get("children", THINGS)?.value
		put("children", THINGS, want)
		// a shared node gone: none of the running things' (started again at the same path: another
		// process id, the same node)
		const kept = new Set(Object.values(want))
		for (const shared of Object.values(isMap(was) ? was : {})) {
			if (typeof shared === "string" && !kept.has(shared) && table.get("attributes", shared)) {
				hosted(() => table.del("attributes", shared))
			}
		}
	}
	hosted(() =>
		s.createEffect(() => {
			const seen = new Map<string, Record<string, unknown>>()
			for (const p of things()) {
				seen.set(String(p.id), { ...shown(p.id), [AT]: `/${p.at.join("/")}` })
			}
			return seen
		}, (seen) => hosted(() => publish(seen)))
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
				// the nodes a person made there, at the top or in /home
				for (const { path, id } of placements(places, `${n}/files`).values()) leaf(path, id)
			}
			return want
		}, (want) => hosted(() => place(want)))
	)

	// ---- asks: into the asked den's inbox, signed by this session; answered beside them ----
	const asks: ((h: Heard) => void)[] = []
	const pairs: ((who: string, a: Answer) => void)[] = []
	const nameOf = (install: string) => {
		const n = table.get("attributes", install)?.value?.[NAME]
		return typeof n === "string" ? n : `${denOf(install)?.slice(0, 6) ?? install}…`
	}

	let count = 0
	async function ask(to: string, r: Request): Promise<string | { problem: string }> {
		const inbox = `${installOf(to)}/inbox`
		if (table.get("value", inbox) === undefined) {
			return { problem: "its inbox hasn't reached this page yet" }
		}
		const fields = r.op === "start" && "program" in r
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

	// ---- the inbox: a program the den runs at /system/inbox, the one place that decides who may.
	// each ask in this den's inbox node checked (for here; in its keys, its session vouched for by
	// its install, the ask signed by that session: trusted()), then done on software, or refused; the
	// answer written beside it. a pair ask is shown to a person, whose yes puts the asker in this
	// den's keys; this den's own pair asks' yeses put the other in them. its writes are its own, its
	// scope open ----
	type Inbox = {
		answerPair: (ask: string, yes: boolean) => void
		// a pair ask of this den's, to who, followed until its answer lands
		follow: (who: string, ask: string) => void
		// who out of this den's keys
		forget: (who: string) => void
		waiting: (who: string) => boolean
	}
	let inbox: Inbox | undefined
	function inboxRun(_code: unknown, start: Parameters<Runner["start"]>[1]) {
		const w = createWrites({ scheduler: s, table, places, scope: start.scope })
		// the asks answered (or being answered) this page; the pair asks waiting for a person, by id;
		// this den's pair asks waiting for an answer, by who
		const answered = new Set<string>()
		const wanting = new Map<string, { from: string; name: string }>()
		const following = new Map<string, string>()
		const followed = {}
		const keep = (from: string, name: string) => w.patch("value", KEYS, [from], { name })

		// an ask's fields as software takes them; none: not one
		function done(a: Record<string, unknown>): Answer {
			const isAddress = (x: unknown): x is Address => typeof x === "string" || Array.isArray(x)
			const names = (x: unknown): x is string[] =>
				Array.isArray(x) && x.every((y) => typeof y === "string")
			if (a.op === "start") {
				if (!isAddress(a.runner) || !isMap(a.program) || !isAddress(a.at)) {
					return { error: "not a start: it needs a runner, a program and an at" }
				}
				if (a.args !== undefined && !names(a.args)) return { error: "its args aren't words" }
				const r = software.run(a.runner, a.program as Program, a.at, defined({ args: a.args }))
				return "refused" in r ? r : { id: r.id, at: r.at }
			}
			if (a.op === "stop" && typeof a.process === "string") {
				const p = things().find((x) => x.id === a.process)
				if (p === undefined) return { refused: "not-there", process: a.process }
				software.stop(p, a.reason)
				return {}
			}
			if (a.op === "unpair") {
				w.drop("value", KEYS, [String(a.from)])
				return {}
			}
			return { error: `not an ask: ${String(a.op)}` }
		}

		// one ask in this den's inbox: checked, then done, refused, or (a pair) put to a person
		async function answering(n: string, e: Record<string, unknown>) {
			const a = isMap(e.ask) ? e.ask : {}, c = isMap(e.claim) ? e.claim : {}
			const from = String(a.from), who = nameOf(from)
			const refuse = (why: Refusal["why"]): Refusal => ({ refused: "not-trusted", who, why })
			const claim = { session: String(c.session), install: from, vouch: c.vouch as Uint8Array }
			const signed = (keys: unknown) =>
				trusted(keys, claim, encode(a as Value), e.sig as Uint8Array, ed25519)
			const told: Heard = { from: denOf(from) ?? from, op: String(a.op), runner: a.runner }
			let out: Answer
			if (
				a.to !== node || c.install !== from || typeof c.session !== "string" ||
				!(c.vouch instanceof Uint8Array) || !(e.sig instanceof Uint8Array)
			) out = refuse("not-for-here")
			else if (a.op === "pair") {
				// anyone may ask: it is checked only to be from whom it says
				if (!(await signed({ [from]: {} }))) out = refuse("bad-signature")
				else if (has(id, from)) out = { pair: "yes" }
				else {
					const name = typeof a.name === "string" ? a.name : who
					wanting.set(n, { from, name })
					for (const f of asks) f({ ...told, wants: n, name })
					return
				}
			} else if (!has(id, from)) out = refuse("not-in-keys")
			else if (!(await signed(keysBy.get(id)))) out = refuse("bad-signature")
			else {
				try {
					out = s.runWithScope(start.scope, () => done(a))
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
			w.patch("value", INBOX_, [n, "answer"], out)
			soon()
			if ("refused" in out && out.refused === "not-trusted") told.refused = out
			for (const f of asks) f(told)
		}

		s.runWithScope(start.scope, () => {
			s.createEffect(() => places.readValue("value", INBOX_), (v) => {
				for (const [n, e] of Object.entries(isMap(v) ? v : {})) {
					if (answered.has(n) || !isMap(e) || e.answer !== undefined) continue
					answered.add(n)
					void answering(n, e)
				}
			})
			// this den's pair asks: a yes, once the other has this den in its own keys, puts the other
			// in this den's; a no, or a refusal, told
			s.createEffect(() => {
				s.track(followed)
				return [...following].map(([who, n]) => ({
					who,
					a: places.readValue("value", `${installOf(who)}/inbox`, [n, "answer"]),
					back: has(who, node),
				}))
			}, (list) => {
				for (const { who, a, back } of list) {
					if (!isMap(a) || (a.pair === "yes" && !back)) continue
					following.delete(who)
					if (a.pair === "yes") keep(installOf(who), nameOf(installOf(who)))
					for (const f of pairs) f(who, a as Answer)
				}
			})
		})

		inbox = {
			answerPair(n, yes) {
				const e = wanting.get(n)
				if (e === undefined) return
				wanting.delete(n)
				if (yes) keep(e.from, e.name)
				w.patch("value", INBOX_, [n, "answer"], { pair: yes ? "yes" : "no" })
				soon()
			},
			follow(who, n) {
				following.set(who, n)
				s.mark([followed])
			},
			forget: (who) => w.drop("value", KEYS, [installOf(who)]),
			waiting: (who) => following.has(who),
		}
		return { stop: () => void (inbox = undefined) }
	}
	// the nodes a person makes: this den's own, placed by their file.at
	const made = createMade({
		scheduler: s,
		table,
		places,
		scope: host,
		root: ROOT,
		node,
		owner: (n) => {
			const d = denOf(n.split("/")[0])
			return d === undefined ? undefined : nameOf(installOf(d))
		},
		running: (pid) => things().some((p) => p.id === pid),
	})

	// the inbox, started
	const started = hosted(() =>
		software.run(`/${HERE.join("/")}/runners/inbox`, "/programs/inbox", INBOX_AT)
	)
	if ("refused" in started) trouble(`The inbox didn't start: ${started.refused}.`)
	const running = (): Inbox | { problem: string } =>
		inbox ?? { problem: "this den's inbox isn't running" }

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
		software,
		made,
		host,
		hosted,
		things,
		find: (pid) => things().find((p) => p.id === pid),
		inbox: () => software.running().find(isInbox),
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
		async pair(who) {
			const i = running()
			if ("problem" in i) return i
			const n = await ask(who, { op: "pair", name: o.name })
			if (typeof n === "string") i.follow(who, n)
			return n
		},
		answerPair: (n, yes) => inbox?.answerPair(n, yes),
		async unpair(who) {
			const i = running()
			if ("problem" in i) return i
			i.forget(who)
			soon()
			return await ask(who, { op: "unpair" })
		},
		trusts: (who) => has(id, installOf(who)),
		trustedBy: (who) => has(who, node),
		paired: (who) => has(id, installOf(who)) && has(who, node),
		pairing: (who) => inbox?.waiting(who) ?? false,
		soon,
		onPulse: (f) => void pulsed.push(f),
		onAsked: (f) => void asks.push(f),
		onPair: (f) => void pairs.push(f),
		onServer: (f) => (servers.push(f), f(state)),
		onTrouble: (f) => (troubles.push(f), said.forEach(f)),
	}
}
