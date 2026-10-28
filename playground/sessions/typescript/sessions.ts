// sessions: one world opened on an install's root: a tab, a worker, one run. each session has a key
// of its own, made at its start and never stored, and is called by it: its id is "ermine:ed01" and
// the key's hex, as an install's is. so two sessions of one install (two tabs) never sign as one,
// and a restart is a new session. the install vouches for each of its sessions once, at its start:
// the install's signature over the two keys (vouch), so whoever trusts the install's key can trust
// what the session signs. what is signed: "ermine/v1/session", the install's key, the session's key
//
//   const session = await startSession(install, ed25519)   // ed25519: @ermine/core/ed25519, or the
//   // host's; { id, install, key, secret, vouch }
//   await vouched(session, ed25519)                          // true: the install vouched for it
//
// a session is here at a node while it beats there: its entry in the node's "online" part,
// { [session]: { install, until } }, each written as a patch at its own key, so two sessions' beats
// never write over each other. online(node) is the entries whose until is still ahead; a sweep
// takes the rest out, so whoever read them is told. online is for now only: nothing here saves it,
// and a host's save should leave the part out
//
//   beat(world, session, den, now + 10_000)      // again before until, on the host's timer
//   online(world, den, now)                      // [{ session, install, until }], tracked
//   sweep(world, den, now)                       // the host's, on its timer
//   leave(world, session, den)                   // at the session's end
//
// a beat is not signed: it says a session is here, not proves it (a beat carried is the carrier's
// to check, by the session's key)
import { bytes, kind, text } from "@ermine/ids"
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Patch } from "@ermine/core/changeable/apply"
import type { Id, Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/upsert"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Table } from "@ermine/core/table"

declare module "@ermine/core/table" {
	interface Tables {
		online: Record<string, Beat>
	}
}

export const ONLINE = "online"

export type Session = {
	readonly id: string
	readonly install: string
	// the session's public key and secret (32 bytes each); the install's signature over the keys
	readonly key: Uint8Array
	readonly secret: Uint8Array
	readonly vouch: Uint8Array
}
// what a session needs of Ed25519 (@ermine/core/ed25519 is one)
export type Signing = {
	publicKeyOf: (secret: Uint8Array) => Uint8Array | Promise<Uint8Array>
	sign: (secret: Uint8Array, message: Uint8Array) => Uint8Array | Promise<Uint8Array>
}
export type Verifying = {
	verify: (
		key: Uint8Array,
		message: Uint8Array,
		signature: Uint8Array,
	) => boolean | Promise<boolean>
}
// a session's entry at a node; until: ms, the host's clock
export type Beat = { readonly install: string; readonly until: number }
export type Here = Beat & { readonly session: string }

export type World = {
	table: Table
	places: Pick<Places, "commit" | "readValue">
	scheduler: Pick<Scheduler, "getCurrentScope" | "getRun" | "runWithScope">
	// the scope beats are written in (their header's actor)
	scope: Scope
}

const DOMAIN = new TextEncoder().encode("ermine/v1/session")

// what an install signs for a session: the domain, then the two keys (each 32 bytes)
const vouching = (install: Uint8Array, session: Uint8Array) =>
	new Uint8Array([...DOMAIN, ...install, ...session])

// a key id's raw key; none: not a key id
const keyOf = (id: string): Uint8Array | undefined =>
	kind(id) === "key" ? bytes(id)!.subarray(2) : undefined

// a new session of the install: a fresh key, and the install's vouch for it
export async function startSession(
	install: { readonly id: string; readonly secret: Uint8Array },
	ed: Signing,
): Promise<Session> {
	const installKey = keyOf(install.id)
	if (installKey === undefined) throw new TypeError("an install's id is its key's")
	const secret = crypto.getRandomValues(new Uint8Array(32))
	const key = await ed.publicKeyOf(secret)
	const vouch = await ed.sign(install.secret, vouching(installKey, key))
	return { id: text(Uint8Array.of(0xed, 0x01, ...key))!, install: install.id, key, secret, vouch }
}

// whether install vouched for the session id: its signature over the two keys. ids that are no
// key ids: false
export async function vouched(
	s: { readonly id: string; readonly install: string; readonly vouch: Uint8Array },
	ed: Verifying,
): Promise<boolean> {
	const install = keyOf(s.install), session = keyOf(s.id)
	if (install === undefined || session === undefined) return false
	return await ed.verify(install, vouching(install, session), s.vouch)
}

// the session's entry at node, made or renewed
export function beat(w: World, session: Session, node: Id, until: number) {
	const entry: Beat = { install: session.install, until }
	write(w, (header) => upsert(w.table, ONLINE, node, [session.id], entry, header))
}

// the session's entry at node, out
export function leave(w: World, session: Session, node: Id) {
	remove(w, node, [session.id])
}

// the sessions here at node now, in no order (key order is not part of a value). tracked
export function online(w: World, node: Id, now: number): Here[] {
	const all = w.places.readValue(ONLINE, node)
	if (!isMap(all)) return []
	const here: Here[] = []
	for (const [session, b] of Object.entries(all)) {
		if (isBeat(b) && b.until > now) here.push({ session, install: b.install, until: b.until })
	}
	return here
}

// every entry at node whose until is not ahead of now, out; and any that is no beat (a until that
// is no finite number among them)
export function sweep(w: World, node: Id, now: number) {
	const all = w.table.get(ONLINE, node)?.value
	if (!isMap(all)) return
	remove(w, node, Object.keys(all).filter((k) => !isBeat(all[k]) || !(all[k].until > now)))
}

function remove(w: World, node: Id, sessions: string[]) {
	const there = w.table.get(ONLINE, node)
	if (there === undefined || !isMap(there.value)) return
	const value = there.value
	const gone = sessions.filter((s) => Object.hasOwn(value, s))
	if (gone.length === 0) return
	const patches = gone.map((s): Patch => ({ path: [s] }))
	write(w, (header) => {
		update(there, patches, header)
		return [there]
	})
}

// a write made with the world's scope open: the entries f changed, committed
const write = (w: World, f: (header: ChangeHeader) => readonly Entry<unknown>[]) =>
	w.scheduler.runWithScope(w.scope, () => w.places.commit(f(createChangeHeader(w.scheduler))))

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

// an entry a session wrote: an install, and a finite until (a carrier may bring anything)
const isBeat = (v: unknown): v is Beat =>
	isMap(v) && typeof v.install === "string" && Number.isFinite(v.until)
