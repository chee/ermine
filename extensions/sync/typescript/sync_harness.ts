// whole hosts (sync.ts) on the line protocol (conformance/typescript/harness.ts): each a table,
// places, a scheduler and sync over its own device and storage, as sync_test.ts builds them, joined
// by in-memory pipes. state lasts for the process. another implementation joins by speaking this
// (HARNESS). conventions: extensions/sync/conformance/README.md
//
// deterministic: a host's random is the harness's (each call's bytes the first of BLAKE3 of
// "<host>/<k>", k counting the host's calls from 0, across restarts), so its nonces and minted ids
// are; a write's change is the request's, or { time: 1760000000, actor: <host>, external:
// [{ file: "scenario", line: 1 }] }; what sync stamps with the time now (a removal, a settle with
// no change) has the request's time, default 1760000000
//
// { op: "host", name, seed, zeros?, tables?, merges?, merge?, ephemeral? } → { key }   a host
//                                                            signing with the seed's key; zeros,
//                                                            tables, merge: createSync's options;
//                                                            merges: the names of the rules it
//                                                            knows (of "eg-walker"), default
//                                                            [merge] or none; ephemeral: the
//                                                            tables whose changes go out
//                                                            ephemerally, at any id (default none)
// { op: "ephemeral", host, tables }     → {}                the host's ephemeral tables from now
// { op: "advance", ms }                 → {}                the hosts' clock (sync's now, from
//                                                            1760000000000, moved only so) moved
//                                                            on, then every host ticked
// { op: "restart", host }               → {}                closed (its pipes cut), and made again
//                                                            over the same storage
// { op: "close", host }                 → {}                closed, its pipes cut, gone
// { op: "use", host, merge? }           → {}                sync.use: the rule it merges by from
//                                                            now (one it knows), or none
// { op: "connect", a, b }               → {}                a pipe, the handshake done (a starts)
// { op: "disconnect", a, b }            → {}                each lets the other go, the pipe cut
// { op: "follow", host, id }            → {}
// { op: "mint", host, as? }             → { id }            as: the id's label, for later ids
// { op: "write", host, table?, id, patches, change?, name? }  → { commits, ephemeral? }   the
//                                                            patches to the entry at (table, id),
//                                                            default table value; none there: the
//                                                            first patch's value is the entry, the
//                                                            rest patches to it. commits: how many
//                                                            stored commits the host made;
//                                                            ephemeral: how many ephemeral ones,
//                                                            left out for none; name: the last
//                                                            one's label
// { op: "type", host, table?, id, path, at, text, change?, name? } → { commits }   each code
//                                                            point of text a write of its own to
//                                                            the entry there: an insert at path,
//                                                            from at on
// { op: "remove", host, table?, id, time?, name? } → { commits }   the entry taken out whole
// { op: "settle", host, id, change?, time?, name? } → { commits }
// { op: "quiet" }                       → {}                every host idle, nothing crossing
// { op: "read", host, table?, id }      → { value } | {}    the entry's value; {}: none
// { op: "change", host, table?, id }    → { change } | {}   the entry's change, but its op
// { op: "conflicts", host, id }         → { conflicts }     the conflicts table's entry, [] for
//                                                            none: [{ head, lamport, actor, tables }]
// { op: "heads", host, id, layer? }     → { heads }         the history's, in the agreed order;
//                                                            layer: stored (default) or ephemeral
// { op: "commits", host, id, layer? }   → { commits }       how many the history has taken in
// { op: "standing", host, id }          → { standing }      each device's standing ephemeral tip
//                                                            at the id: [[key, commit]], by key
// { op: "commit", host, id, commit, layer? } → { commit } | {}   a commit taken in, in JSON
// { op: "get", host, id, commit }       → { tables } | {}   sync.get: the node's tables at it
// { op: "stored", host, id }            → { stored }        how many loose commits are stored
// { op: "fragments", host, id }         → { fragments }     how many fragments the device holds
// a commit in an answer: its label (a write's name), else its name as hex. an id: a label minted
// (as), else the string as given
import * as sd from "npm:@automerge/subduction@0.23.0"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces, type Places } from "@ermine/places"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/table"
import { decode } from "@ermine/encoding/commit"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hex, jsonOf, unhex } from "../../../ermine/encoding/typescript/commit_harness.ts"
import { pipe, quiet, tablesJson } from "./harnesses.ts"
import { createSigner } from "./seal.ts"
import { type Conflict, createSync, type Sync } from "./sync.ts"
import { egwalker } from "./egwalker.ts"
import type { Merges } from "./replay.ts"

// every rule a host may be given
const RULES: Merges = { "eg-walker": egwalker }

export const TIME = 1_760_000_000
const ID = /^ermine:\/\/[0-9a-f]{64}$/

// ---- hosts

type Options = {
	seed: string
	zeros: boolean
	tables?: Key[]
	merges?: string[]
	merge?: string
	ephemeral: string[]
}
type Host = {
	name: string
	options: Options
	key: Uint8Array
	storage: sd.MemoryStorage
	table: Table
	places: Places
	sync: Sync
}
const hosts = new Map<string, Host>()
const links = new Map<string, { cut(): void }>()
// each host's count of random calls, kept across restarts
const calls = new Map<string, number>()
const pair = (a: string, b: string) => [a, b].sort().join(" ")
// the hosts' clock: sync's now, moved only by advance
let clock = TIME * 1000

function randomOf(name: string) {
	return (n: number) => {
		const k = calls.get(name) ?? 0
		calls.set(name, k + 1)
		return blake3(new TextEncoder().encode(`${name}/${k}`)).slice(0, n)
	}
}

async function make(name: string, options: Options, storage: sd.MemoryStorage): Promise<Host> {
	const signer = await createSigner(unhex(options.seed))
	const scheduler = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const sync = createSync({
		table,
		signer,
		zeros: options.zeros,
		tables: options.tables,
		merges: Object.fromEntries(
			(options.merges ?? []).map((n) => {
				if (!RULES[n]) throw new Error(`no rule ${n}`)
				return [n, RULES[n]]
			}),
		),
		merge: options.merge,
		ephemeral: (_doc, table) => options.ephemeral.includes(table as string),
		now: () => clock,
		storage: storage as unknown as sd.SedimentreeStorage,
		random: randomOf(name),
		commit: (changed) => places.commit(changed),
	})
	await sync.device.ready()
	return { name, options, key: signer.key, storage, table, places, sync }
}

function of(name: unknown): Host {
	const h = hosts.get(name as string)
	if (!h) throw new Error(`no host ${name}`)
	return h
}

async function shut(h: Host) {
	for (const [k, l] of links) if (k.split(" ").includes(h.name)) l.cut(), links.delete(k)
	await h.sync.close()
}

// ---- names

// ids by label
const ids = new Map<string, string>()
const idOf = (x: unknown) => typeof x === "string" ? ids.get(x) ?? x : String(x)
// commit labels by name, and names by label
const labels = new Map<string, string>()
const names = new Map<string, string>()
const label = (n: Uint8Array | string) => {
	const h = typeof n === "string" ? n : hex(n)
	return labels.get(h) ?? h
}
const nameOf = (x: unknown) => {
	const n = names.get(x as string) ?? x
	if (typeof n !== "string" || !/^[0-9a-f]{64}$/.test(n)) throw new Error(`no commit ${x}`)
	return unhex(n)
}

// what the host made in f: how many commits, the last labelled
function counting(h: Host, id: string, r: Request, f: () => void): Answer {
	// an id that is not a document's has no history: nothing is made for it
	const history = ID.test(id) ? h.sync.device.history(id) : undefined
	const eph = ID.test(id) ? h.sync.device.history(id, "ephemeral") : undefined
	const before = history?.all().length ?? 0, ephBefore = eph?.all().length ?? 0
	const was = Date.now
	const now = (r.time ?? TIME) * 1000
	Date.now = () => now
	try {
		f()
	} finally {
		Date.now = was
	}
	const all = history?.all() ?? [], ephAll = eph?.all() ?? []
	const made = all.length - before
	// the ephemeral history takes every stored commit too
	const fleeting = ephAll.length - ephBefore - made
	const last = ephAll.length > ephBefore ? ephAll[ephAll.length - 1] : all[all.length - 1]
	if (made + fleeting > 0 && typeof r.name === "string") {
		const n = hex(last.name)
		names.set(r.name, n)
		if (!labels.has(n)) labels.set(n, r.name)
	}
	return fleeting > 0 ? { commits: made, ephemeral: fleeting } : { commits: made }
}

const headerOf = (h: Host, r: Request): ChangeHeader =>
	r.change !== undefined
		? revive(r.change) as ChangeHeader
		: { time: TIME, actor: h.name, external: [{ file: "scenario", line: 1 }] }

function write(h: Host, part: Key, id: string, patches: Patch[], change: ChangeHeader) {
	if (h.table.get(part, id) === undefined) {
		const [first, ...rest] = patches
		h.table.add(part, id, createEntry(first.value as never, change))
		if (!rest.length) return
		patches = rest
	}
	const e = h.table.get(part, id)!
	update(e, patches as never, change)
	h.places.commit([e])
	h.sync.wrote([e])
}

async function answer(r: Request): Promise<Answer> {
	switch (r.op) {
		case "host": {
			if (hosts.has(r.name)) throw new Error(`a host ${r.name} already`)
			const options = {
				seed: r.seed,
				zeros: r.zeros === true,
				tables: r.tables,
				merges: r.merges ?? (r.merge ? [r.merge] : []),
				merge: r.merge,
				ephemeral: (r.ephemeral ?? []) as string[],
			}
			const h = await make(r.name, options, new sd.MemoryStorage())
			hosts.set(r.name, h)
			return { key: hex(h.key) }
		}
		case "restart": {
			const h = of(r.host)
			await shut(h)
			hosts.set(h.name, await make(h.name, h.options, h.storage))
			return {}
		}
		case "ephemeral":
			of(r.host).options.ephemeral = r.tables as string[]
			return {}
		case "advance":
			clock += r.ms as number
			for (const h of hosts.values()) h.sync.tick()
			return {}
		case "use":
			of(r.host).sync.use(r.merge)
			of(r.host).options.merge = r.merge
			return {}
		case "close": {
			await shut(of(r.host))
			hosts.delete(r.host)
			return {}
		}
		case "connect": {
			const a = of(r.a), b = of(r.b)
			const p = pipe()
			links.set(pair(a.name, b.name), p)
			await Promise.all([
				a.sync.device.connect(p.ends[0], true),
				b.sync.device.connect(p.ends[1], false),
			])
			return {}
		}
		case "disconnect": {
			const a = of(r.a), b = of(r.b)
			await Promise.all([a.sync.device.disconnect(b.key), b.sync.device.disconnect(a.key)])
			links.get(pair(a.name, b.name))?.cut()
			links.delete(pair(a.name, b.name))
			return {}
		}
		case "follow":
			await of(r.host).sync.follow(idOf(r.id))
			return {}
		case "mint": {
			const id = of(r.host).sync.mint()
			if (typeof r.as === "string") ids.set(r.as, id)
			return { id }
		}
		case "write": {
			const h = of(r.host), id = idOf(r.id)
			const patches = revive(r.patches) as Patch[]
			return counting(h, id, r, () => write(h, r.table ?? "value", id, patches, headerOf(h, r)))
		}
		case "type": {
			const h = of(r.host), id = idOf(r.id)
			const change = headerOf(h, r)
			return counting(h, id, r, () => {
				let at = r.at as number
				for (const c of r.text as string) {
					write(
						h,
						r.table ?? "value",
						id,
						[{ path: r.path, range: [at, at], value: c }],
						change,
					)
					at++
				}
			})
		}
		case "remove": {
			const h = of(r.host), id = idOf(r.id)
			return counting(h, id, r, () => h.table.del(r.table ?? "value", id))
		}
		case "settle": {
			const h = of(r.host), id = idOf(r.id)
			const change = r.change === undefined ? undefined : revive(r.change) as ChangeHeader
			return counting(h, id, r, () => h.sync.settle(id, change))
		}
		case "quiet":
			await quiet(() => Promise.all([...hosts.values()].map((h) => h.sync.idle())))
			return {}
		case "read": {
			const e = of(r.host).table.get(r.table ?? "value", idOf(r.id))
			return e === undefined || e.value === undefined ? {} : { value: toJson(e.value) }
		}
		case "change": {
			const e = of(r.host).table.get(r.table ?? "value", idOf(r.id))
			if (e === undefined) return {}
			const { op: _, ...change } = e.change
			return { change: toJson(change) }
		}
		case "conflicts": {
			const list = (of(r.host).table.get("conflicts", idOf(r.id))?.value ?? []) as Conflict[]
			return {
				conflicts: list.map((c) => ({
					head: label(c.head),
					lamport: c.lamport,
					actor: toJson(c.actor),
					tables: toJson(c.tables),
				})),
			}
		}
		case "heads":
			return {
				heads: of(r.host).sync.device.history(idOf(r.id), r.layer ?? "stored").heads().map((
					k,
				) => label(k.name)),
			}
		case "commits":
			return {
				commits: of(r.host).sync.device.history(idOf(r.id), r.layer ?? "stored").all().length,
			}
		case "standing":
			return {
				standing: of(r.host).sync.standing(idOf(r.id)).map(([key, n]) => [key, label(n)]),
			}
		case "commit": {
			const k = of(r.host).sync.device.history(idOf(r.id), r.layer ?? "stored").get(
				nameOf(r.commit),
			)
			if (k === undefined) return {}
			return { commit: jsonOf(decode(k.bytes), label) }
		}
		case "get": {
			const t = of(r.host).sync.get(idOf(r.id), nameOf(r.commit))
			return t === undefined ? {} : { tables: tablesJson(t) }
		}
		case "stored":
			return { stored: (await of(r.host).sync.device.stored(idOf(r.id))).length }
		case "fragments":
			return { fragments: of(r.host).sync.device.fragments(idOf(r.id)).length }
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	// Subduction's logging (a connection closed, …) is not an answer
	console.warn = () => {}
	await serve(answer)
	for (const h of hosts.values()) await shut(h).catch(() => {})
	Deno.exit(0)
}
