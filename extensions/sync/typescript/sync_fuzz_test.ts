// a fuzz of sync on one invariant (Alex Good's, from Automerge): a host's readers, told every
// patch as it lands, end where the host is, and where a host computed fresh from the same history
// would be; hosts with the same history are in the same place.
//
// hosts (2-4) on one node, each a table, places and sync over its own device, with no pipes: a
// commit crosses only when the fuzz hands its seal to a device (transport_conformance_hook_put, as a peer's commit is
// stored), so delivery is the fuzz's: any order, late, twice, one host cut off a while. ephemeral
// commits stay home (only Subduction carries them): a drag shows on its own host until the drop.
// told: places.watchAll, every fact (a table event's whole value, a write's patches) on the node.
//
// checked after every step, on every host:
// (a) the patches told, applied in order from nothing, are each table's value (exactly: key order,
//     -0)
// (b) the history computed fresh (replay of the first head; with a rule and several heads, its
//     merge) is each kept table's value, or under a drag, what the "ephemeral" table says is under
// (c) hosts with the same stored history and no drag show the same tables and conflicts
// and now and then (and at the end, everything delivered) a fresh host fed the history is where
// the host is. a failure is shrunk (steps dropped while the same check still fails) and printed
import * as sd from "npm:@automerge/subduction@0.23.0"
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import { decode, name as nameOf } from "@ermine/encoding/commit"
import { createPlaces } from "@ermine/places"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/table"
import { createSigner, seal, type Signer, stored } from "./seal.ts"
import { createSync, type Ephemeral, type Sync } from "./sync.ts"
import type { Device } from "./transport.ts"
import {
	transport_conformance_hook_put,
	transport_conformance_hook_taking,
} from "./transport_conformance_hook.ts"
import { egwalker } from "./egwalker.ts"
import { type Merges, plain, replay, type Tables } from "./replay.ts"
import { hex } from "./hex.ts"

const DOC = "ermine://" + "ab".repeat(32)
const DOC_BYTES = new Uint8Array(32).fill(0xab)
const TIME = 1_760_000_000
const KEPT = ["value", "attributes", "children"] as const
const MERGES: Merges = { "eg-walker": egwalker }
type Rule = "eg-walker" | undefined

// ---- random

function rng(seed: number) {
	let s = Math.imul((seed >>> 0) ^ 0x5bd1e995, 0x9e3779b1) >>> 0 || 0x9e3779b9
	s ^= s >>> 15, s = Math.imul(s, 0x85ebca6b) >>> 0 || 1
	const next = () => {
		s ^= s << 13, s ^= s >>> 17, s ^= s << 5
		return s >>> 0
	}
	const r = (n: number) => n <= 0 ? 0 : next() % n
	return Object.assign(r, { next })
}
type R = ReturnType<typeof rng>
const pick = <T>(r: R, xs: readonly T[]): T => xs[r(xs.length)]

// ---- values exactly: key order, -0, typed arrays

// ordered false: a map's keys compared as a set (what crosses a commit, canonical CBOR, has its
// keys in canonical order)
function exact(a: unknown, b: unknown, ordered = true, at = "$"): string | undefined {
	if (Object.is(a, b)) return
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return `${at}: ${show(a)} ≠ ${show(b)}`
	}
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (a.constructor !== b.constructor) return `${at}: ${show(a)} ≠ ${show(b)}`
		const x = [...(a as unknown as ArrayLike<unknown>) as never], y = [...(b as never)]
		return x.length === y.length && x.every((v, i) => Object.is(v, y[i]))
			? undefined
			: `${at}: ${show(a)} ≠ ${show(b)}`
	}
	if (Array.isArray(a) !== Array.isArray(b)) return `${at}: ${show(a)} ≠ ${show(b)}`
	if (Array.isArray(a)) {
		const y = b as unknown[]
		if (a.length !== y.length) return `${at}: ${show(a)} ≠ ${show(b)}`
		for (let i = 0; i < a.length; i++) {
			const d = exact(a[i], y[i], ordered, `${at}[${i}]`)
			if (d) return d
		}
		return
	}
	const ka = Object.keys(a), kb = Object.keys(b)
	const same = ordered
		? ka.join("\0") === kb.join("\0")
		: ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k))
	if (!same) return `${at}: keys ${show(ka)} ≠ ${show(kb)}`
	for (const k of ka) {
		const d = exact((a as never)[k], (b as never)[k], ordered, `${at}.${k}`)
		if (d) return d
	}
}

function show(v: unknown): string {
	if (v === undefined) return "undefined"
	if (Object.is(v, -0)) return "-0"
	if (typeof v === "string") return JSON.stringify(v)
	if (typeof v !== "object" || v === null) return String(v)
	if (ArrayBuffer.isView(v)) {
		return `${v.constructor.name}[${[...(v as unknown as ArrayLike<number>) as never].join(",")}]`
	}
	if (Array.isArray(v)) return `[${v.map(show).join(",")}]`
	return `{${
		Object.entries(v).map(([k, x]) =>
			`${/^[a-z]\w*$/.test(k) ? k : JSON.stringify(k)}:${show(x)}`
		)
			.join(",")
	}}`
}

const showPatch = (p: Patch) => {
	const parts = [`path:${show(p.path)}`]
	if (p.range) parts.push(`range:${show(p.range)}`)
	if ("value" in p) parts.push(`value:${show(p.value)}`)
	if (p.move) {
		parts.push(
			`move:{path:${show(p.move.path)}${p.move.range ? `,range:${show(p.move.range)}` : ""}}`,
		)
	}
	return `{${parts.join(",")}}`
}

// ---- edits: patches made on what a host's table shows now, from a step's own random

const CHARS = ["a", "b", "c", "d", "é", "😀"]
const LEAVES = [0, 1, -0, 2.5, "x", "", true, false, null, "😀"]
const KEYS = ["a", "b", "c", "d"]

const text = (r: R) => Array.from({ length: r(5) }, () => pick(r, CHARS)).join("")
function gen(r: R, depth = 0): unknown {
	switch (r(depth >= 2 ? 3 : 7)) {
		case 0:
		case 1:
			return pick(r, LEAVES)
		case 2:
			return text(r)
		case 3:
		case 4:
			return Array.from({ length: r(4) }, () => gen(r, depth + 1))
		case 5:
			return Int32Array.from({ length: r(4) }, () => r(9) - 4)
		default: {
			const out: Record<string, unknown> = {}
			const keys = [...KEYS].sort(() => r(2) - 0.5).slice(0, r(4))
			for (const k of keys) out[k] = gen(r, depth + 1)
			return out
		}
	}
}

type Spot = { path: (string | number)[]; v: unknown }
function spots(v: unknown, path: (string | number)[] = [], out: Spot[] = []): Spot[] {
	out.push({ path, v })
	if (Array.isArray(v)) v.forEach((x, i) => spots(x, [...path, i], out))
	else if (v !== null && typeof v === "object" && !ArrayBuffer.isView(v)) {
		for (const [k, x] of Object.entries(v)) spots(x, [...path, k], out)
	}
	return out
}
const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)
const lengthOf = (v: unknown) =>
	typeof v === "string" ? [...v].length : (v as ArrayLike<unknown>).length
const span = (r: R, n: number): [number, number] => {
	const a = r(n + 1)
	return [a, a + r(Math.min(3, n - a) + 1)]
}

// one patch on v, for a table: value anything; attributes a map of small values; children a map
// of names to ermine ids
function patchOn(r: R, v: unknown, part: Key): Patch {
	const child = () => "ermine://" + pick(r, ["01", "02", "03"]).repeat(32)
	const small = () => pick(r, LEAVES)
	if (part !== "value") {
		const make = part === "children" ? child : small
		if (!isMap(v) || r(12) === 0) {
			const out: Record<string, unknown> = {}
			for (const k of [...KEYS].sort(() => r(2) - 0.5).slice(0, r(4))) out[k] = make()
			return { path: [], value: out }
		}
		const have = Object.keys(v)
		switch (r(3)) {
			case 0:
				if (have.length) return { path: [pick(r, have)] }
				break
			case 1:
				if (have.length) return { path: [pick(r, KEYS)], move: { path: [pick(r, have)] } }
		}
		return { path: [pick(r, KEYS)], value: make() }
	}
	if (v === undefined || r(20) === 0) return { path: [], value: gen(r) }
	const all = spots(v)
	const { path, v: at } = pick(r, all)
	if (typeof at === "string" || ArrayBuffer.isView(at) || Array.isArray(at)) {
		const n = lengthOf(at), range = span(r, n)
		const fill = () =>
			typeof at === "string"
				? text(r)
				: ArrayBuffer.isView(at)
				? Int32Array.from({ length: r(3) }, () => r(9) - 4)
				: Array.from({ length: r(3) }, () => gen(r, 2))
		switch (r(6)) {
			case 0:
				return { path, range }
			case 1:
				if (Array.isArray(at) && n > 0) return { path: [...path, r(n)] }
				break
			case 2:
				if (Array.isArray(at) && n > 0) return { path: [...path, r(n)], value: gen(r, 2) }
				break
			case 3: {
				// a range moved within the same sequence
				const to = r(n + 1)
				return { path, range: [to, to], move: { path, range } }
			}
		}
		return { path, range, value: fill() }
	}
	if (isMap(at)) {
		const have = Object.keys(at)
		switch (r(4)) {
			case 0:
				if (have.length) return { path: [...path, pick(r, have)] }
				break
			case 1: {
				// a key moved: to a key of this map or of another map
				if (!have.length) break
				const maps = all.filter((s) => isMap(s.v))
				const to = pick(r, maps).path
				return { path: [...to, pick(r, KEYS)], move: { path: [...path, pick(r, have)] } }
			}
		}
		return { path: [...path, pick(r, KEYS)], value: gen(r, path.length + 1) }
	}
	return { path, value: gen(r, path.length) }
}

// one or two patches that apply to v; none found: undefined
function patchesOn(r: R, v: unknown, part: Key, two = true): Patch[] | undefined {
	for (let tries = 0; tries < 12; tries++) {
		const out: Patch[] = []
		let now = v
		const n = r(4) === 0 && two ? 2 : 1
		try {
			for (let i = 0; i < n; i++) {
				const p = patchOn(r, now, part)
				now = apply(now, [structuredClone(p)])
				out.push(p)
			}
			if (out[0].path.length === 0 && !("value" in out[0])) continue
			return out
		} catch {
			continue
		}
	}
}

// ---- hosts

type Host = {
	n: number
	name: string
	table: Table
	sync: Sync
	device: Device
	// what the readers were told, applied in order, by table
	model: Map<string, unknown>
	told: number
	// a told patch that did not apply to what was told before
	broken?: string
	held: boolean
	write(part: Key, patches: Patch[]): void
	close(): Promise<void>
}

async function makeHost(n: number, rule: Rule, seed: number, signer: Signer): Promise<Host> {
	const r = rng(seed * 7919 + n + 1)
	const scheduler = createScheduler()
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
	})
	const places = createPlaces({ root: "R", table, paths: createPaths(), scheduler })
	const h = { n, name: `h${n}`, table, model: new Map(), held: false, told: 0 } as unknown as Host
	const sync = createSync({
		table,
		signer,
		storage: new sd.MemoryStorage() as unknown as sd.SedimentreeStorage,
		random: (k) => Uint8Array.from({ length: k }, () => r(256)),
		commit: (changed) => places.commit(changed),
		ephemeral: (_doc, part) => h.held && part === "value",
		// no beats, no ttl: time stands still
		now: () => TIME * 1000,
		...(rule ? { merges: MERGES, merge: rule } : {}),
	})
	places.watchAll((f) => {
		if (f.id !== DOC || h.broken) return
		h.told++
		const was = h.model.get(f.part as string)
		const patches = structuredClone(f.patches) as Patch[]
		try {
			const now = apply(was, patches)
			if (now === undefined) h.model.delete(f.part as string)
			else h.model.set(f.part as string, now)
		} catch (e) {
			h.broken = `${f.part}: told ${patches.map(showPatch).join(" ")} on ${show(was)}: ${e}`
		}
	})
	const change = (): ChangeHeader => ({ time: TIME, actor: h.name })
	h.write = (part, patches) => {
		const entry = table.get(part, DOC)
		if (entry === undefined) {
			table.add(part, DOC, createEntry(structuredClone(patches[0].value) as never, change()))
			patches = patches.slice(1)
			if (!patches.length) return
		}
		const e = table.get(part, DOC)!
		update(e, structuredClone(patches) as never, change())
		places.commit([e])
		sync.wrote([e])
	}
	h.sync = sync
	h.device = sync.device
	h.close = () => sync.close()
	await sync.follow(DOC)
	return h
}

const settled = async (hs: Host[]) => {
	for (let i = 0; i < 2; i++) {
		await Promise.all(hs.map((h) => h.sync.idle()))
		await new Promise((r) => setTimeout(r, 0))
	}
}

// what the fuzz checks exactly; a check left out is a bug found already, which has a test of its
// own (below). order: a map's key order across hosts and fresh; conflicts: the conflicts table's
// "tables" (in which tables each head differs) across hosts
// alias: writes of two patches to attributes and children (entries places keeps cow: false)
type Strict = { order: boolean; conflicts: boolean; alias: boolean }
const STRICT: Strict = { order: true, conflicts: true, alias: true }
const LOOSE: Strict = { order: false, conflicts: false, alias: false }

// what a host's table shows at p; the conflicts but their tables, unless strict
function shown(h: Host, p: Key, strict: Strict): unknown {
	const v = h.table.get(p, DOC)?.value
	if (p !== "conflicts" || strict.conflicts || !Array.isArray(v)) return v
	return v.map(({ tables: _, ...c }) => c)
}

// the tables a drag shows over (the "ephemeral" table's), and what is stored under them
function overlaid(h: Host): Set<string> {
	const eph = h.table.get("ephemeral", DOC)?.value as Ephemeral | undefined
	return new Set(eph?.on.flatMap((o) => o.tables) ?? [])
}
function storedAt(h: Host, p: Key): unknown {
	if (!overlaid(h).has(p as string)) return h.table.get(p, DOC)?.value
	return (h.table.get("ephemeral", DOC)!.value as Ephemeral).under[p as string]
}

// ---- the history fresh

function fresh(h: Host, rule: Rule): Tables {
	const history = h.device.history(DOC)
	const heads = history.heads()
	if (heads.length === 0) return {}
	if (rule !== undefined && heads.length > 1) {
		return MERGES[rule](
			history,
			heads,
			(ns) => ns.length === 1 ? plain(history, ns[0]) : undefined,
		)
	}
	return replay(history, heads[0].name, undefined, MERGES) ?? {}
}

// ---- a run

type Step =
	| { k: "edit"; h: number; part: Key; r: number }
	| { k: "deliver"; h: number; r: number }
	| { k: "again"; h: number; r: number }
	| { k: "cut"; h: number }
	| { k: "heal" }
	| { k: "settle"; h: number }
	| { k: "remove"; h: number; part: Key }
	| { k: "drag"; h: number; r: number }
	| { k: "drop"; h: number; r: number }
	| { k: "fresh"; h: number }

type Failure = { check: string; at: number; message: string }
// what a run did: steps that did something, by kind; the most heads a host had; steps after which
// some host listed conflicts; facts told
type Stats = Record<string, number>
type Outcome = { failure?: Failure; log: string[]; stats: Stats }

function script(seed: number, length: number): { hosts: number; rule: Rule; steps: Step[] } {
	const r = rng(seed)
	const hosts = 2 + r(3)
	const rule: Rule = seed % 2 === 0 ? "eg-walker" : undefined
	const steps: Step[] = []
	for (let i = 0; i < length; i++) {
		const h = r(hosts), x = r(100)
		const part: Key = pick(r, ["value", "value", "value", "value", "attributes", "children"])
		steps.push(
			x < 36
				? { k: "edit", h, part, r: r.next() }
				: x < 70
				? { k: "deliver", h, r: r.next() }
				: x < 74
				? { k: "again", h, r: r.next() }
				: x < 77
				? { k: "cut", h }
				: x < 81
				? { k: "heal" }
				: x < 85
				? { k: "settle", h }
				: x < 88
				? { k: "remove", h, part }
				: x < 93
				? { k: "drag", h, r: r.next() }
				: x < 97
				? { k: "drop", h, r: r.next() }
				: { k: "fresh", h },
		)
	}
	return { hosts, rule, steps }
}

async function run(
	seed: number,
	hostCount: number,
	rule: Rule,
	steps: readonly Step[],
	strict: Strict,
): Promise<Outcome> {
	const log: string[] = []
	const stats: Stats = { heads: 0, conflicted: 0, told: 0 }
	const was = Date.now
	Date.now = () => TIME * 1000
	const signers = await Promise.all(
		Array.from({ length: hostCount }, (_, n) => createSigner(new Uint8Array(32).fill(n + 1))),
	)
	const bySigner = new Map(signers.map((s) => [hex(s.key), s]))
	const hosts: Host[] = []
	const extra: Host[] = []
	for (let n = 0; n < hostCount; n++) hosts.push(await makeHost(n, rule, seed, signers[n]))

	// the network: every commit any host made, by name; each host's inbox (names not yet handed to
	// it) and what it was handed
	type Sent = {
		bytes: Uint8Array
		from: number
		label: string
		sealed?: Uint8Array
		id?: Uint8Array
	}
	const sent = new Map<string, Sent>()
	const inbox = hosts.map(() => [] as string[])
	const handed = hosts.map(() => new Set<string>())
	let cut: number | undefined
	const labelOf = (name: string) => sent.get(name)?.label ?? name.slice(0, 8)
	function discover() {
		for (const h of hosts) {
			for (const k of h.device.history(DOC).all()) {
				const name = hex(k.name)
				if (sent.has(name)) continue
				const c = { bytes: k.bytes, from: h.n, label: `c${sent.size}` }
				sent.set(name, c)
				for (const o of hosts) if (o !== h) inbox[o.n].push(name)
				handed[h.n].add(name)
			}
		}
	}
	async function sealOf(name: string): Promise<Sent> {
		const c = sent.get(name)!
		if (c.sealed === undefined) {
			const commit = decode(c.bytes)
			const signer = bySigner.get(hex(commit.signer))!
			c.sealed = await seal(c.bytes, signer, DOC_BYTES, { commit, name: nameOf(c.bytes) })
			c.id = stored(c.sealed)
		}
		return c
	}
	async function hand(to: Host, name: string) {
		const c = await sealOf(name)
		const commit = decode(c.bytes)
		const parents: Uint8Array[] = []
		for (const p of commit.parents) parents.push((await sealOf(hex(p))).id!)
		await transport_conformance_hook_put(to.device, DOC, c.id!, parents, c.sealed!)
	}
	const open = (to: number, name: string) =>
		cut === undefined || (to !== cut && sent.get(name)!.from !== cut)

	const kind = (check: string, message: string, at: number): Failure => ({ check, at, message })

	function describe(h: Host): string {
		const t = KEPT.map((p) => `${p}=${show(h.table.get(p, DOC)?.value)}`).join(" ")
		return `${h.name}: ${t}`
	}

	// the checks, after a step
	function check(at: number): Failure | undefined {
		for (const h of hosts) {
			if (h.broken) return kind("a", `${h.name} ${h.broken}`, at)
			const parts = new Set<string>([...h.model.keys(), ...h.table.get(DOC).map(([p]) => p)])
			for (const p of parts) {
				const d = exact(h.model.get(p), h.table.get(p as Key, DOC)?.value)
				if (d) {
					return kind("a", `${h.name} ${p}: told ${d} shown (told ≠ shown)`, at)
				}
			}
			const f = fresh(h, rule)
			const over = overlaid(h)
			for (const p of KEPT) {
				const d = exact(f[p]?.value, storedAt(h, p), strict.order)
				if (d) {
					return kind(
						"b",
						`${h.name} ${p}${over.has(p) ? " (under a drag)" : ""}: fresh ${d} shown`,
						at,
					)
				}
			}
		}
		const groups = new Map<string, Host[]>()
		for (const h of hosts) {
			if (h.sync.standing(DOC).length) continue
			const key = h.device.history(DOC).all().map((k) => hex(k.name)).sort().join(" ")
			groups.set(key, [...groups.get(key) ?? [], h])
		}
		for (const g of groups.values()) {
			for (const h of g.slice(1)) {
				for (const p of [...KEPT, "conflicts"] as Key[]) {
					const d = exact(
						shown(g[0], p, strict),
						shown(h, p, strict),
						strict.order,
					)
					if (d) {
						return kind(
							"c",
							`${g[0].name} and ${h.name} have the same commits, ${p} differs: ${d}`,
							at,
						)
					}
				}
			}
		}
	}

	// a fresh host fed what h has, in the order given: where h is
	async function freshHost(h: Host, names: string[], at: number): Promise<Failure | undefined> {
		const f = await makeHost(
			90 + extra.length,
			rule,
			seed,
			await createSigner(new Uint8Array(32).fill(99)),
		)
		extra.push(f)
		for (const n of names) await hand(f, n)
		await settled([f])
		for (const p of KEPT) {
			const d = exact(f.table.get(p, DOC)?.value, storedAt(h, p), strict.order)
			if (d) {
				return kind(
					"b-host",
					`a fresh host fed ${h.name}'s ${names.length} commits: ${p} ${d} (fresh ≠ ${h.name}); ` +
						`it took ${f.device.history(DOC).all().length}, waiting ${
							show(f.device.history(DOC).waiting().map((w) => labelOf(w.name)))
						}, refused ${
							show(
								f.device.history(DOC).refused().map((w) =>
									`${labelOf(w.name)} ${w.refused}`
								),
							)
						}, transport ${show(transport_conformance_hook_taking(f.device, DOC))}`,
					at,
				)
			}
		}
	}

	async function step(s: Step, at: number): Promise<string | undefined> {
		const h = "h" in s ? hosts[s.h] : undefined
		switch (s.k) {
			case "edit": {
				const v = h!.table.get(s.part, DOC)?.value
				const ps = patchesOn(rng(s.r), v, s.part, strict.alias || s.part === "value")
				if (!ps) return
				h!.write(s.part, ps)
				return `${h!.name} writes ${s.part}${h!.held ? " (dragging)" : ""} ${
					ps.map(showPatch).join(" ")
				}`
			}
			case "deliver": {
				const can = inbox[h!.n].filter((n) => open(h!.n, n))
				if (!can.length) return
				const name = can[s.r % can.length]
				inbox[h!.n].splice(inbox[h!.n].indexOf(name), 1)
				handed[h!.n].add(name)
				await hand(h!, name)
				return `${h!.name} gets ${labelOf(name)} (from h${sent.get(name)!.from})`
			}
			case "again": {
				const can = [...handed[h!.n]].filter((n) => sent.get(n)!.from !== h!.n && open(h!.n, n))
				if (!can.length) return
				const name = can[s.r % can.length]
				await hand(h!, name)
				return `${h!.name} gets ${labelOf(name)} again`
			}
			case "cut":
				if (cut !== undefined) return
				cut = s.h
				return `${h!.name} cut off`
			case "heal":
				if (cut === undefined) return
				cut = undefined
				return `reconnected`
			case "settle":
				if (h!.device.history(DOC).heads().length < 2) return
				h!.sync.settle(DOC, { time: TIME, actor: h!.name })
				return `${h!.name} settles`
			case "remove":
				if (h!.table.get(s.part, DOC) === undefined) return
				h!.table.del(s.part, DOC)
				return `${h!.name} removes ${s.part}`
			case "drag": {
				const v = h!.table.get("value", DOC)?.value
				const ps = patchesOn(rng(s.r), v, "value")
				if (!ps) return
				h!.held = true
				h!.write("value", ps)
				return `${h!.name} drags value ${ps.map(showPatch).join(" ")}`
			}
			case "drop": {
				if (!h!.held) return
				return drop(h!, s.r)
			}
			case "fresh": {
				const failed = await freshHost(
					h!,
					h!.device.history(DOC).all().map((k) => hex(k.name)),
					at,
				)
				if (failed) throw failed
				return `a fresh host fed ${h!.name}'s history agrees`
			}
		}
	}
	function drop(h: Host, r: number) {
		h.held = false
		const v = h.table.get("value", DOC)?.value
		const ps = patchesOn(rng(r), v, "value") ?? [{ path: [], value: "dropped" }]
		h.write("value", ps)
		return `${h.name} drops: value ${ps.map(showPatch).join(" ")}`
	}

	try {
		// the root, on every host
		hosts[0].write("value", [{
			path: [],
			value: { t: "hello", l: ["a", "b", "c"], m: { a: 1, b: "x" } },
		}])
		hosts[0].write("attributes", [{ path: [], value: { color: "red" } }])
		hosts[0].write("children", [{ path: [], value: { notes: "ermine://" + "01".repeat(32) } }])
		await settled(hosts)
		discover()
		for (const h of hosts.slice(1)) {
			for (const n of inbox[h.n].splice(0)) await hand(h, n), handed[h.n].add(n)
		}
		await settled(hosts)
		log.push(`root on h0, handed to all: ${describe(hosts[0])}`)
		{
			const f = check(-1)
			if (f) return { failure: f, log, stats }
		}
		for (let i = 0; i < steps.length; i++) {
			let said: string | undefined
			try {
				said = await step(steps[i], i)
				await settled(hosts)
			} catch (e) {
				if (e && typeof e === "object" && "check" in e) {
					return { failure: e as Failure, log, stats }
				}
				return { failure: kind("throw", String((e as Error)?.stack ?? e), i), log, stats }
			}
			discover()
			if (said !== undefined) {
				log.push(`${i}: ${said}`)
				stats[steps[i].k] = (stats[steps[i].k] ?? 0) + 1
			}
			for (const h of hosts) {
				stats.heads = Math.max(stats.heads, h.device.history(DOC).heads().length)
			}
			if (hosts.some((h) => h.table.get("conflicts", DOC))) stats.conflicted++
			const f = check(i)
			if (f) {
				for (const h of hosts) log.push(`   ${describe(h)}`)
				return { failure: f, log, stats }
			}
		}
		// the end: everyone reconnected, every drag dropped, every commit handed to everyone (in
		// a random order, some twice)
		const end = steps.length
		try {
			cut = undefined
			const r = rng(seed ^ 0x5bd1e995)
			for (const h of hosts) if (h.held) log.push(`end: ${drop(h, r.next())}`)
			await settled(hosts)
			discover()
			for (let round = 0; round < 4 && hosts.some((h) => inbox[h.n].length); round++) {
				const todo = hosts.flatMap((h) => inbox[h.n].splice(0).map((n) => [h, n] as const))
				todo.sort(() => r(2) - 0.5)
				for (const [h, n] of todo) {
					await hand(h, n), handed[h.n].add(n)
					if (r(8) === 0) await hand(h, n)
				}
				await settled(hosts)
				discover()
			}
		} catch (e) {
			return { failure: kind("throw", String((e as Error)?.stack ?? e), end), log, stats }
		}
		log.push(`end: every commit handed to every host`)
		const f = check(end)
		if (f) {
			for (const h of hosts) log.push(`   ${describe(h)}`)
			return { failure: f, log, stats }
		}
		const all = hosts.map((h) => h.device.history(DOC).all().length)
		if (all.some((n) => n !== sent.size)) {
			const why = hosts.map((h) => {
				const hist = h.device.history(DOC)
				return `${h.name} took ${hist.all().length}/${sent.size}, waiting ${
					JSON.stringify(hist.waiting().map((w) => labelOf(w.name)))
				}, refused ${
					JSON.stringify(hist.refused().map((w) => `${labelOf(w.name)}:${w.refused}`))
				}, transport ${
					JSON.stringify(transport_conformance_hook_taking(h.device, DOC).refused.length)
				}`
			})
			return {
				failure: kind("c", `not every host took every commit: ${why.join("; ")}`, end),
				log,
				stats,
			}
		}
		for (const h of hosts.slice(1)) {
			for (const p of [...KEPT, "conflicts"] as Key[]) {
				const d = exact(shown(hosts[0], p, strict), shown(h, p, strict), strict.order)
				if (d) {
					return {
						failure: kind("c", `h0 and ${h.name} differ at ${p}: ${d}`, end),
						log,
						stats,
					}
				}
			}
		}
		const names = [...sent.keys()].sort(() => rng(seed).next() % 2 - 0.5)
		const failed = await freshHost(hosts[0], names, end)
		if (failed) return { failure: failed, log, stats }
		stats.told = hosts.reduce((a, h) => a + h.told, 0)
		return { log, stats }
	} finally {
		Date.now = was
		for (const h of [...hosts, ...extra]) await h.close().catch(() => {})
	}
}

// ---- shrinking: steps dropped, chunk by chunk, while the same check still fails

async function shrink(
	seed: number,
	hosts: number,
	rule: Rule,
	steps: Step[],
	check: string,
	strict: Strict,
): Promise<{ steps: Step[]; outcome: Outcome }> {
	let best = steps
	let outcome = await run(seed, hosts, rule, best, strict)
	// steps after the failing one never ran
	if (outcome.failure && outcome.failure.at < best.length) {
		best = best.slice(0, outcome.failure.at + 1)
	}
	for (let size = Math.max(1, best.length >> 1); size >= 1; size = size >> 1) {
		for (let i = 0; i < best.length;) {
			const trial = [...best.slice(0, i), ...best.slice(i + size)]
			const o = await run(seed, hosts, rule, trial, strict)
			if (o.failure?.check === check) {
				best = o.failure.at < trial.length ? trial.slice(0, o.failure.at + 1) : trial
				outcome = o
			} else i += size
		}
	}
	return { steps: best, outcome: await run(seed, hosts, rule, best, strict) }
}

const LENGTH = 60

async function fuzz(seed: number, strict: Strict = LOOSE, length = LENGTH) {
	const { hosts, rule, steps } = script(seed, length)
	const o = await run(seed, hosts, rule, steps, strict)
	if (!o.failure) return
	const { steps: small, outcome } = await shrink(seed, hosts, rule, steps, o.failure.check, strict)
	const f = outcome.failure ?? o.failure
	const text = [
		`seed ${seed}, ${hosts} hosts, merge ${rule ?? "none"}: check (${f.check}) broke`,
		`  ${f.message}`,
		`shrunk to ${small.length} of ${steps.length} steps: ${JSON.stringify(small)}`,
		...outcome.log.map((l) => "  " + l),
	].join("\n")
	throw new Error(text)
}

const opts = { sanitizeOps: false, sanitizeResources: false }
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1)

Deno.test({
	name: "sync fuzz: told patches, the history fresh and every host agree (first head shows)",
	...opts,
	async fn() {
		for (const s of SEEDS) await fuzz(s * 2 - 1)
	},
})

Deno.test({
	name: "sync fuzz: told patches, the history fresh and every host agree (eg-walker)",
	...opts,
	async fn() {
		for (const s of SEEDS) await fuzz(s * 2)
	},
})

// ---- findings: each the shrunk run of a seed that broke a check, kept as it broke. ignored until
// the bug is fixed; then they pass, and the check they name goes back into the batches above

// a shrunk run again: hosts, rule and steps as the shrink left them
async function again(
	seed: number,
	hosts: number,
	rule: Rule,
	steps: Step[],
	strict: Strict,
): Promise<void> {
	const o = await run(seed, hosts, rule, steps, strict)
	if (!o.failure) return
	throw new Error(
		[`check (${o.failure.check}) at step ${o.failure.at}: ${o.failure.message}`, ...o.log]
			.join("\n"),
	)
}

// BUG: a map's key order does not cross a commit. commits are canonical CBOR, so every other host,
// and a replay, has the keys in canonical order, while the writer keeps them as written: (b) and
// (c) break on the root itself ({t,l,m} written, {l,m,t} everywhere else)
Deno.test({
	name: "sync fuzz FINDING: key order is lost across a commit (seed 1)",
	ignore: true,
	...opts,
	fn: () => again(1, 3, undefined, [], { ...LOOSE, order: true }),
})

// BUG: the conflicts table goes stale on a write. a host's own write while it has several heads
// (no rule) extends the head shown but does not work its conflicts out again (send calls later()
// only when the commit has several parents), so the "tables" in which the other head differs miss
// the table just written; a host given the same commits lists it. (c): h0 lists ["value"], h1
// ["value","children"]
Deno.test({
	name:
		"sync fuzz FINDING: conflicts' tables go stale after a write on a conflicted node (seed 5)",
	ignore: true,
	...opts,
	fn: () =>
		again(5, 2, undefined, [
			{ k: "edit", h: 1, part: "value", r: 1762824969 },
			{ k: "edit", h: 0, part: "value", r: 1921671129 },
			{ k: "deliver", h: 0, r: 3677534454 },
			{ k: "edit", h: 0, part: "children", r: 3391370211 },
		], { ...LOOSE, conflicts: true }),
})

// BUG (core/node update with core/op apply, cow: false; places makes children and attributes
// entries so): a patch's value is put in the entry as is, and a later patch of the same write
// changes it in place, so entry.change.op.patches no longer say what happened. readers are told
// [{path:[],value:{b:X}}, {path:["b"],move:{path:["d"]}}] for a write of {d:X} then the move, which
// does not apply (a); sync encodes those same patches into the commit, so other hosts would refuse it
Deno.test({
	name: "sync fuzz FINDING: told patches change after the write, on cow: false entries (seed 4)",
	ignore: true,
	...opts,
	fn: () =>
		again(4, 2, "eg-walker", [{ k: "edit", h: 1, part: "children", r: 3588249658 }], {
			...LOOSE,
			alias: true,
		}),
})

// BUG: with a rule, a drag that goes on after a stored commit came in under it. fleet's new
// ephemeral commit goes on the new stored head but carries the standing one's patches (made on the
// old head) then the new ones; the own take is not checked, and show()'s replay of it throws
// (wrong-kind) out of sync.wrote, into the host's write
Deno.test({
	name:
		"sync fuzz FINDING: a drag after a stored commit lands under it throws (eg-walker, seed 40)",
	ignore: true,
	...opts,
	fn: () =>
		again(40, 2, "eg-walker", [
			{ k: "edit", h: 1, part: "value", r: 3434236702 },
			{ k: "drag", h: 0, r: 2357922532 },
			{ k: "deliver", h: 0, r: 2579717390 },
			{ k: "edit", h: 0, part: "value", r: 2548861663 },
		], LOOSE),
})

// BUG: with a rule, a drop (a stored write over a standing drag) on several heads makes a merge
// commit, and send() keeps that commit's tables (remember) before landed() puts the write into the
// stored under the overlay: the state kept for the merge commit is the stored value before the
// write. the next drag starts its under from it (storedNow → replay → that state), so (b): the
// history replayed says c.b is "", the host's stored says "x"
Deno.test({
	name:
		"sync fuzz FINDING: a drop that merges keeps the stored state before it (eg-walker, seed 18)",
	ignore: true,
	...opts,
	fn: () =>
		again(18, 3, "eg-walker", [
			{ k: "edit", h: 2, part: "value", r: 837242773 },
			{ k: "edit", h: 0, part: "value", r: 3280471431 },
			{ k: "drag", h: 2, r: 1601496281 },
			{ k: "deliver", h: 2, r: 1186163521 },
			{ k: "drop", h: 2, r: 500226752 },
			{ k: "drag", h: 2, r: 426248192 },
		], LOOSE),
})
