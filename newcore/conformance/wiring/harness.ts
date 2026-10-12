// The reference wiring (sync/ts/wiring.ts, WIRING.tex) on the line protocol: one JSON request per
// line in, one answer per line out, in order. Several named devices in one process, each a
// scheduler (scheduler.ts) wired to a transport device (TRANSPORT.tex), linked by in-memory pipes.
// Values (patches, contents, actors) in their JSON form (../pack/form.ts); keys, seeds and made
// bytes as lowercase hex; ids as strings; an object as BLOP.tex writes it ("value", ["info", name],
// ["children", name]); spans and slotindexes as PLACES.tex gives them (a number or [from, to]).
// Lock: "unlocked" only. A scenario starts with reset.
//
// A device, fixed by this harness so that every blop is known in advance:
//   its signer the Ed25519 key of seed; the scheduler's root and host actor as given; site: none
//   (the scheduler's site option answers nothing, so no change has a site); roots none;
//   random(n): the device's k-th call (k from 1, counted per device) gives n bytes, the first four
//   k big-endian, the rest zero; sync calls it once per blop it makes (COMMIT.tex's nonce), in the
//   order of the records, so a rename's old name's blop takes the lower k;
//   ids (the scheduler's id option): id("unlocked", made) (ID.tex), made the bytes the next create
//   was given (create's made), else 32 random bytes. The lock's make is the harness's.
//
//   {op: "reset"}                       -> {}  every device closed, every link gone
//   {op: "device", name, seed, root, actor}
//                                       -> {key}  a device: a transport device signing with seed's
//                                          key, a scheduler with that root and host actor, and the
//                                          wiring between them; the root followed where it is an
//                                          ermine:// id
//   {op: "follow", device, doc}         -> {}  the transport device's follow (TRANSPORT.tex)
//   {op: "link", a, b}                  -> {}  an in-memory pipe, the handshake done
//   {op: "unlink", a, b}                -> {}  the pipe gone: nothing more crosses
//   host operations, each the scheduler's own, as the host (PLACES.tex), answering {} or
//   {error: code} (the error's code, else its message):
//   {op: "write", device, address, patches, index?, slotindex?}
//   {op: "set", device, address, name, patches, index?, slotindex?}
//   {op: "insert", device, id, name, child, index?, slotindex?}
//   {op: "remove", device, id, name, index, slotindex?}
//   {op: "pop", device, id, name, slotindex}
//   {op: "rename", device, id, name, to}
//   {op: "move", device, id, name, index, toid, toname, toindex?}
//   {op: "create", device, value?, id?, made?, ephemeral?}
//                                       -> {id}  the scheduler's create; made: the 32 bytes the
//                                          lock's make gives for this node's id (none given and no
//                                          id: random). ephemeral: made by a process (only a
//                                          process makes an ephemeral node): one started at the
//                                          root with the id "proc-k" (k from 1, per device), whose
//                                          setup creates it, owned, and gives 0
//   {op: "start", device, value, made?: hex | [hex]}
//                                       -> {id}  a process started at the root, named "proc-k" (k
//                                          as create's), with the id the
//                                          lock's make gives (made, as create's), its setup giving
//                                          value: its node is ephemeral, and the scheduler's own
//                                          writes to it (its value, its status) make records too
//   {op: "ops", device, ops: [host operations without device]}
//                                       -> [answers]  run one after another with nothing between
//                                          (no await, no turn of the event loop): two operations
//                                          before sync could take a turn
//   {op: "pump"}                        -> {}  everything runs until quiet: no message crossing,
//                                          no sealing, taking in or committing left
//   {op: "read", device, id, object, only?}
//                                       -> [{content, change, because?}] | null  the node's
//                                          object (default "value"), every version, in order;
//                                          null: the node not loaded. change: its fields node,
//                                          actor, reader, site, cause, those present, never time
//                                          (WIRING.tex does not fix how many times sync takes the
//                                          clock); because as the version holds it, none: left out.
//                                          only: the fields of each version given, the others
//                                          left out
//   {op: "records", device, node?, only?}
//                                       -> [{node, object, patches, header, at, ephemeral}]
//                                          every record changed was given on the device since
//                                          records was last asked there, in order (WIRING.tex,
//                                          Out); node: only that node's answered (all are taken
//                                          all the same); header: its actor, reader, site, cause,
//                                          those present, never time; only: as read's
//   {op: "versions", device, id, object, list}
//                                       -> {}  the scheduler's internal versions(node, object,
//                                          list) called directly (WIRING.tex, In), list as given:
//                                          [{content, change, because?}], change with its time
//   {op: "watch", device, address}     -> {}  a compute started at the root (id "watch-k", k from 1,
//                                          per device) reading content(address), tracked
//   {op: "marked", device}              -> [header]  every change given to the device's watch
//                                          computes as what marked them (their by), since marked
//                                          was last asked, in order: actor, reader, site, cause,
//                                          those present, never time
//   {op: "stored", device, doc}         -> [ids]  the loose commits the transport device holds of
//                                          the tree (TRANSPORT.tex), hex, sorted
//   anything that throws                -> {error: code or message}
// Another implementation joins by speaking this (WIRING_HARNESS).
//
// wiring.ts and the graph and scheduler additions are not written yet; this shim assumes:
//   createScheduler({root, actor, site, id, changed}): changed(record) given each record
//     {node, object, patches, header, at, ephemeral}; the answer has internal.versions(node,
//     object, list) beside the host's interface
//   createWiring(device, {versions, signer, random}) -> {changed(record), idle()} (WIRING.tex);
//     idle() resolves when no sealing, storing or sending is left
//   the transport device (TRANSPORT.tex) gains a synchronous take-in of a blop this device made,
//     not yet sealed: take(doc, blop: Uint8Array, layer): the blop's bytes into that layer's
//     histories at once, so the next operation commits against them (WIRING.tex, Out); add(sealed)
//     and publish then pass over the name already taken in. wiring.ts calls it; this shim does not
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import { createDevice } from "../../sync/ts/transport.ts"
import { createWiring } from "../../sync/ts/wiring.ts"
import { id as idOf, is } from "../../sync/ts/id.ts"
import { createScheduler } from "../../scheduler/ts/scheduler.ts"
import { fromJson, line, toJson } from "../pack/form.ts"
import createNode from "../../nodes/ts/node.ts"

type Request = Record<string, unknown> & { op: string }
// deno-lint-ignore no-explicit-any
type Any = any

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// a pipe, as conformance/transport/harness.ts has it: moved counts messages
let moved = 0
type End = Transport & { other?: End; queue: Uint8Array[]; waiting: ((b: Uint8Array) => void)[] }
function pipe(): { ends: [End, End]; cut(): void } {
	let open = true
	const make = (): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				if (!open) return Promise.reject(new Error("unlinked"))
				moved++
				const o = end.other!, w = o.waiting.shift()
				if (w) w(bytes.slice())
				else o.queue.push(bytes.slice())
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				if (b) return Promise.resolve(b)
				if (!open) return Promise.reject(new Error("unlinked"))
				return new Promise((r) => end.waiting.push(r))
			},
			disconnect() {
				open = false
				return Promise.resolve()
			},
			onDisconnect() {},
		}
		return end
	}
	const a = make(), b = make()
	a.other = b, b.other = a
	return { ends: [a, b], cut: () => (open = false) }
}

type Held = {
	device: Any
	scheduler: Any
	wiring: Any
	key: Uint8Array
	made: Uint8Array[]
	marks: Record<string, unknown>[]
	records: Record<string, unknown>[]
	procs: number
	watches: number
}
let devices = new Map<string, Held>()
let links = new Map<string, { cut(): void }>()
const of = (n: unknown) => {
	const d = devices.get(n as string)
	if (!d) throw new Error(`no device ${n}`)
	return d
}
const pair = (a: unknown, b: unknown) => [a, b].sort().join(" ")

// a header's fields as answered: never time, never what the graph adds
const HEADER = ["actor", "reader", "site", "cause"]
const CHANGE = ["node", ...HEADER]
function pick(x: Record<string, unknown>, keys: string[]) {
	const out: Record<string, unknown> = {}
	for (const k of keys) if (x[k] !== undefined) out[k] = toJson(x[k])
	return out
}
const only = (x: Record<string, unknown>, fields: unknown) =>
	Array.isArray(fields)
		? Object.fromEntries(fields.filter((f) => f in x).map((f) => [f, x[f]]))
		: x

// what a record is answered as, taken when it is given: later changes do not reach it
function recorded(r: Any): Record<string, unknown> {
	return {
		node: r.node,
		object: toJson(r.object),
		patches: toJson(r.patches),
		header: pick(r.header, HEADER),
		at: toJson(r.at),
		ephemeral: r.ephemeral,
	}
}

async function pump() {
	let quiet = 0, last = -1
	for (let round = 0; round < 2000; round++) {
		await Promise.all(
			[...devices.values()].flatMap((d) => [d.wiring.idle(), d.device.idle()]),
		)
		await new Promise((r) => setTimeout(r, 2))
		if (moved === last) {
			if (++quiet >= 5) return
		} else quiet = 0, last = moved
	}
	throw new Error("never quiet")
}

const code = (e: unknown) => {
	const c = (e as { code?: unknown })?.code
	return typeof c === "string" ? c : String((e as Error)?.message ?? e)
}

// a host operation on a device, run now
function host(d: Held, r: Request): unknown {
	const s = d.scheduler
	const span = (x: unknown) => x as number | [number, number] | undefined
	try {
		switch (r.op) {
			case "write":
				s.write(r.address, fromJson(r.patches), r.index, span(r.slotindex))
				return {}
			case "set":
				s.set(r.address, r.name, fromJson(r.patches), r.index, span(r.slotindex))
				return {}
			case "insert":
				s.insert(r.id, r.name, r.child, span(r.index), span(r.slotindex))
				return {}
			case "remove":
				s.remove(r.id, r.name, span(r.index), span(r.slotindex))
				return {}
			case "pop":
				s.pop(r.id, r.name, span(r.slotindex))
				return {}
			case "rename":
				s.rename(r.id, r.name, r.to)
				return {}
			case "move":
				s.move(r.id, r.name, r.index, r.toid, r.toname, r.toindex)
				return {}
			case "create": {
				if (r.made !== undefined) d.made.push(unhex(r.made as string))
				const value = "value" in r ? fromJson(r.value) : undefined
				const o = r.id === undefined ? {} : { id: r.id as string }
				if (!r.ephemeral) return { id: s.create(value, o) }
				let made = ""
				s.start({
					address: [],
					id: `proc-${++d.procs}`,
					program: ({ api }: Any) => {
						made = api.create(value, { ...o, ephemeral: true })
						return 0
					},
				})
				return { id: made }
			}
			case "start": {
				// made: one id's bytes, or several (the process's, then its run node's)
				for (const m of [r.made ?? []].flat()) d.made.push(unhex(m as string))
				const value = fromJson(r.value)
				return {
					id: s.start({ address: [], name: `proc-${++d.procs}`, program: () => value }).id,
				}
			}
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		return { error: code(e) }
	}
}

const HOST = new Set([
	"write",
	"set",
	"insert",
	"remove",
	"pop",
	"rename",
	"move",
	"create",
	"start",
])

async function answer(r: Request): Promise<unknown> {
	if (HOST.has(r.op)) return host(of(r.device), r)
	switch (r.op) {
		case "reset":
			for (const l of links.values()) l.cut()
			await Promise.all([...devices.values()].map((d) => d.device.close()))
			devices = new Map(), links = new Map()
			return {}
		case "device": {
			const secret = unhex(r.seed as string)
			const key = ed25519.getPublicKey(secret)
			const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
			const device = createDevice({ signer })
			let calls = 0
			const random = (n: number) => {
				const b = new Uint8Array(n)
				new DataView(b.buffer).setUint32(0, ++calls)
				return b
			}
			const held: Held = {
				device,
				scheduler: undefined,
				wiring: undefined,
				key,
				made: [],
				marks: [],
				records: [],
				procs: 0,
				watches: 0,
			}
			held.wiring = createWiring(device, {
				versions: (...a: unknown[]) => held.scheduler.internal.versions(...a),
				signer,
				random,
			})
			held.scheduler = createScheduler({
				root: createNode(r.root as string, {}),
				actor: r.actor,
				site: () => undefined,
				wallclock: () => undefined,
				id: () =>
					idOf("unlocked", held.made.shift() ?? crypto.getRandomValues(new Uint8Array(32))),
				changed: (record: unknown) => {
					held.records.push(recorded(record))
					held.wiring.changed(record)
				},
			} as Any)
			devices.set(r.name as string, held)
			if (is(r.root as string)) await device.follow(r.root as string)
			return { key: hex(key) }
		}
		case "follow":
			await of(r.device).device.follow(r.doc)
			return {}
		case "link": {
			const a = of(r.a), b = of(r.b)
			const p = pipe()
			links.set(pair(r.a, r.b), p)
			await Promise.all([a.device.connect(p.ends[0], true), b.device.connect(p.ends[1], false)])
			return {}
		}
		case "unlink": {
			const a = of(r.a), b = of(r.b)
			await Promise.all([a.device.disconnect(b.key), b.device.disconnect(a.key)])
			links.get(pair(r.a, r.b))?.cut()
			links.delete(pair(r.a, r.b))
			return {}
		}
		case "ops": {
			const d = of(r.device)
			return (r.ops as Request[]).map((o) => host(d, o))
		}
		case "pump":
			await pump()
			return {}
		case "read": {
			const n = of(r.device).scheduler.get(r.id)
			if (!n) return null
			const o = (r.object ?? "value") as string | [string, string]
			const vs = o === "value"
				? n.value
				: (o[0] === "info" ? n.info : n.children).get(o[1]) ?? []
			return vs.map((v: Any) => {
				const out: Record<string, unknown> = {}
				// no content: a removal among other heads
				if (v.content !== undefined) out.content = toJson(v.content)
				out.change = pick(v.change ?? {}, CHANGE)
				if (v.because !== undefined) out.because = toJson(v.because)
				return only(out, r.only)
			})
		}
		case "records": {
			const d = of(r.device)
			const all = d.records.splice(0)
			return all.filter((x) => r.node === undefined || x.node === r.node).map((x) =>
				only(x, r.only)
			)
		}
		case "versions":
			of(r.device).scheduler.internal.versions(r.id, fromJson(r.object), fromJson(r.list))
			return {}
		case "watch": {
			const d = of(r.device)
			d.scheduler.start({
				address: [],
				id: `watch-${++d.watches}`,
				program: {
					compute: ({ api, by }: Any) => {
						for (const b of by ?? []) d.marks.push(pick(b, HEADER))
						api.content(r.address)
						return 0
					},
				},
			})
			return {}
		}
		case "marked":
			return of(r.device).marks.splice(0)
		case "stored":
			return (await of(r.device).device.stored(r.doc)).map(hex).sort()
		default:
			return { error: `unknown op ${r.op}` }
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		let a: unknown
		try {
			a = await answer(JSON.parse(l))
		} catch (e) {
			a = { error: code(e) }
		}
		await out.write(encoder.encode(line(a) + "\n"))
	}
}
Deno.exit(0)
