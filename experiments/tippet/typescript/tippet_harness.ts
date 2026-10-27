// tippet_harness: tippet (WIRE.md) on the line protocol (conformance/typescript/harness.ts): its
// bytes, a log, the merge (history.ts) and catch-up over links joined by hand. one process a
// scenario: devices and links last between lines
//
// bytes are hex, lowercase. a value in a patch: conformance/typescript/form.ts's JSON form. a
// device is named by its key, 64 hex; in an answer, by the first device made with that key, if any
//
// deterministic: keys from seeds; a write's when the request's, else 1760000000; the harness's
// random: its k-th call (from 1) gives k, big-endian, in as many bytes as asked (a live id: 8)
//
// vectors
// { op: "encode", step }               → { bytes }    step: { device, n, before, node,
//                                                      relative?, part, patches, lamport, when,
//                                                      on?, who? }, before hex or null; relative:
//                                                      true, node written relative to the device;
//                                                      on: [[device, n], …], none an old step's
// { op: "decode", bytes }              → { step } | { refused: true }
// { op: "hash", bytes }                → { hash }     blake3
// { op: "sign", seed, bytes }          → { sig }      ed25519 over the bytes
// { op: "pack", steps, before? }       → { pack }     steps: hex; pack: its cbor; before: hex,
//                                                      the step before, packed against
// { op: "unpack", pack, before? }      → { steps } | { refused: true }   before: as pack's
// { op: "message", message }           → { bytes }    message as on the wire, bytes hex, a run's
//                                                      pack as its steps: ["run", device, sig, steps]
// { op: "read", bytes }                → { message } | { refused: true }   as message gives one; a
//                                                      run whose pack doesn't unpack: ["run",
//                                                      device, "not a pack"] (a message still)
//
// a log
// { op: "device", name, seed }         → { key }      a log that writes, its graph (history.ts)
//                                                      and sync
// { op: "relay", name }                → {}           a log with no key and no graph; its sync
//                                                      a relay
// { op: "write", device, node, part?, patches, when?, who? } → { n, lamport }
//    into the graph, as a host writes: the step is what history makes of it. part: value. no
//    entry there: patches must be one whole value, [{ path: [], value }]. a disk's: a step of
//    these fields, straight into its log
//
// a log on disk (the file store, in a directory of its own)
// { op: "disk", name, seed, log? }     → { key }      a log that writes, no graph; its sync. log:
//                                                      hex, what dir/log holds to start
// { op: "sync", device }               → {}           store.sync
// { op: "reset", device }              → { count }    its process gone, nothing more written, and
//                                                      started again from its files (unlinked first):
//                                                      its own steps held
// { op: "tear", device, file, bytes }  → {}           dir/<file> (log, open) its last bytes cut off
// { op: "files", device }              → { log, open, bytes }   each whole frame: ["run", device,
//                                                      first, last], ["step", device, n] or
//                                                      ["other"]; bytes: { log, open }, the sizes
// { op: "value", device, node, part? } → { value } | {}   history.ts's merge: every step's patches
//                                                      in order of lamport, then device
// { op: "versions", device, node, part? } → { versions }   history.ts's: each { value } or
//                                                      { gone: true }, and from: [[device, n], …],
//                                                      the heads it is
// { op: "have", device }               → { have }     { device: n }, log.have()
// { op: "count", device, of }          → { count }    steps held, signed or not
// { op: "steps", device, of }          → { steps }    every step held, hex
// { op: "run", device, of, from }      → { from, to, sig } | {}
// { op: "take", device, run }          → { added } | { refused }   run: { device, steps, sign?,
//                                                      sig? }; a step hex, or fields as encode's
//                                                      (device: the run's; before: none, the hash
//                                                      of the step before it in the list, null at
//                                                      the first); sign: the device whose key signs
//                                                      the last step's hash (the run's when none);
//                                                      sig: hex, as given
// { op: "pass", from, to, of, at }     → { added } | { refused }   to takes from's run(of, at)
//
// links, joined by hand: a message sent waits until delivered
// { op: "link", a, b }                 → {}           a links, then b; each says have
// { op: "unlink", a, b }               → {}           what waits is dropped
// { op: "queued", from, to }           → { queued }   what waits from → to, as views
// { op: "deliver", from, to, count? }  → { got }      what waits from → to (the first count),
//                                                      delivered in order, as views
// { op: "drop", from, to, count? }     → { dropped }  what waits, lost on the way, as deliver
// { op: "inject", from, to, message? , bytes? } → {}  to gets it on its link from from: message
//                                                      as message's, or bytes as they are
// { op: "live", device, data }         → {}           sync.live
// { op: "heard", device }              → { heard }    every live data heard, hex, in order
//
// views: ["have", { device: n }], ["run", device, from, to], ["live", id, data],
// ["refused", device, n]
//
// after each request every device is idle: no take or run going on
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import createEntry from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import type { Patch } from "@ermine/core/changeable/apply"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/core/table"
import { children, createPlaces } from "@ermine/core/places"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createLog, isRun, type Log, type Store } from "./log.ts"
import { fileStore } from "./store_file.ts"
import { createHistory } from "./history.ts"
import { createSync, type Link, type Message, read, type Sync, wire } from "./sync.ts"
import { createSigner, type Signer } from "./sign.ts"
import { decodeStep, encodeStep, hashStep, hex, type Step, unhex } from "./step.ts"
import { firstOf, pack, type Packed, priorOf, stepsIn, unpack } from "./pack.ts"

const WHEN = 1_760_000_000

// the harness's random: the k-th call gives k
let calls = 0
crypto.getRandomValues = (<T extends ArrayBufferView>(a: T): T => {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
	let k = ++calls
	for (let i = b.length - 1; i >= 0; i--) b[i] = k % 256, k = Math.floor(k / 256)
	return a
}) as typeof crypto.getRandomValues

// takes and runs going on, every device's: idle at none
let pending = 0
const track = <T>(p: Promise<T>) => {
	pending++
	return p.finally(() => pending--)
}
async function idle() {
	for (let quiet = 0; quiet < 2;) {
		await new Promise((r) => setTimeout(r, 0))
		quiet = pending ? 0 : quiet + 1
	}
}

// ---- devices

type Device = {
	log: Log
	sync: Sync
	signer?: Signer
	// a disk's: its directory, and the store there
	dir?: string
	store?: Store
	graph?: {
		table: Table
		history: ReturnType<typeof createHistory>
		write: (node: string, part: string, patches: Patch[], when: number, who?: string) => void
	}
	heard: Uint8Array[]
}
const devices = new Map<string, Device>()
const device = (name: string) => {
	const d = devices.get(name)
	if (!d) throw new Error(`no device ${name}`)
	return d
}
// a device's key, by its name or as given
const keyOf = (s: string) => devices.get(s)?.log.device ?? s
// a key's name, the first device made with it, or the key
const nameOf = (key: string) => {
	for (const [n, d] of devices) if (d.log.device === key) return n
	return key
}

function made(log: Log, relay: boolean, signer?: Signer): Device {
	// a log whose takes and runs are counted
	const tracked = new Proxy(log, {
		get(t, k) {
			const v = Reflect.get(t, k)
			return k === "take" || k === "run"
				? (...a: unknown[]) => track((v as (...a: unknown[]) => Promise<unknown>)(...a))
				: v
		},
	})
	const d: Device = { log, sync: createSync({ log: tracked, relay }), signer, heard: [] }
	d.sync.onLive((b) => d.heard.push(b))
	return d
}

async function createDevice(seed: Uint8Array): Promise<Device> {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: "root",
		table,
		paths: createPaths(),
		scheduler: s,
		contributors: [children],
	})
	s.onTrackingEnd((k) => places.release(k))
	const scope = s.createRootScope({ actor: "harness" })
	const run = <T>(f: () => T) => s.runWithScope(scope, f)
	const log = createLog({ writes: true, seed })
	const history = createHistory({ log, table, places, run })
	await history.load()
	const d = made(log, false, await createSigner(seed))
	d.graph = {
		table,
		history,
		write(node, part, patches, when, who) {
			const change = { time: when, actor: who ?? null }, unkept = history.unkept.length
			run(() => {
				const e = table.get(part as Key, node)
				if (e) return void (update(e, patches, change), places.commit([e]))
				const [p] = patches
				if (patches.length !== 1 || p.path.length || p.range || p.move || !("value" in p)) {
					throw new Error("a first write is one whole value")
				}
				table.sub(part as Key, node, createEntry(p.value, change))
			})
			if (history.unkept.length > unkept) {
				throw new Error(`not kept: ${history.unkept[unkept].why}`)
			}
		},
	}
	return d
}

// a log on a file store in dir, its sync
async function onDisk(dir: string, seed: Uint8Array): Promise<Device> {
	const store = fileStore(dir), log = createLog({ store, seed })
	await log.load()
	const d = made(log, false, await createSigner(seed))
	d.dir = dir, d.store = store
	return d
}
const disk = (name: string) => {
	const d = device(name)
	if (!d.dir) throw new Error(`${name} is not on disk`)
	return d as Device & { dir: string; store: Store }
}
const readOr = (path: string) =>
	Deno.readFile(path).catch((e) => {
		if (e instanceof Deno.errors.NotFound) return new Uint8Array()
		throw e
	})
// a file's whole frames, as files gives them
function framesOf(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = []
	for (let at = 0; at + 4 <= bytes.length;) {
		const size = view.getUint32(at)
		if (!size || at + 4 + size > bytes.length) break
		const r = bytes.slice(at + 4, at + 4 + size)
		at += 4 + size
		try {
			if (isRun(r)) {
				const [, device, , p] = decode(r) as [string, Uint8Array, Uint8Array, Packed]
				const from = firstOf(p).n
				out.push(["run", nameOf(hex(device)), from, from + stepsIn(p) - 1])
			} else {
				const s = decodeStep(r)
				out.push(["step", nameOf(s.device), s.n])
			}
		} catch {
			out.push(["other"])
		}
	}
	return out
}
// ---- forms

const patchesIn = (ps: Patch[]): Patch[] =>
	ps.map((p) => "value" in p ? { ...p, value: revive(p.value) } : p)
const patchesOut = (ps: readonly Patch[]) =>
	ps.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p)

function stepIn(s: Request, device?: string, before?: Uint8Array | null): Step {
	const out: Step = {
		device: keyOf(s.device ?? device),
		n: s.n,
		before: s.before === undefined ? before ?? null : s.before === null ? null : unhex(s.before),
		node: s.node,
		...(s.relative === true && { relative: true }),
		part: s.part,
		patches: patchesIn(s.patches),
		lamport: s.lamport,
		when: s.when,
	}
	if (s.on !== undefined) {
		out.on = (s.on as [string, number][]).map(([d, n]) => ({ device: keyOf(d), n }))
	}
	if (s.who !== undefined) out.who = s.who
	return out
}
function stepOut(s: Step) {
	return {
		device: s.device,
		n: s.n,
		before: s.before && hex(s.before),
		node: s.node,
		...(s.relative && { relative: true }),
		part: s.part,
		patches: patchesOut(s.patches),
		lamport: s.lamport,
		when: s.when,
		...(s.on !== undefined && { on: s.on.map((o) => [o.device, o.n]) }),
		...(s.who !== undefined && { who: s.who }),
	}
}

// a message from its form: ["have", [[device, n]]], ["run", device, sig, steps], ["live", id,
// data], ["refused", device, n]
function messageIn(m: unknown[]): Message {
	const [t, x, y, z] = m as [string, unknown, unknown, unknown]
	if (t === "have") {
		return {
			t,
			have: Object.fromEntries((x as [string, number][]).map(([d, n]) => [keyOf(d), n])),
		}
	}
	if (t === "run") {
		return {
			t,
			device: keyOf(x as string),
			sig: unhex(y as string),
			pack: pack((z as string[]).map(unhex)),
		}
	}
	if (t === "live") return { t, id: x as string, data: unhex(y as string) }
	if (t === "refused") return { t, device: keyOf(x as string), n: y as number }
	throw new Error(`not a message: ${t}`)
}
function messageOut(m: Message): unknown[] {
	if (m.t === "have") return [m.t, Object.entries(m.have)]
	if (m.t === "run") return [m.t, m.device, hex(m.sig), unpack(m.pack).map(hex)]
	if (m.t === "live") return [m.t, m.id, hex(m.data)]
	return [m.t, m.device, m.n]
}
// a message sent, as a scenario reads it
function view(b: Uint8Array): unknown[] {
	const m = read(b)
	if (!m) return ["not a message", hex(b)]
	if (m.t === "have") {
		return [m.t, Object.fromEntries(Object.entries(m.have).map(([d, n]) => [nameOf(d), n]))]
	}
	if (m.t === "run") {
		const from = firstOf(m.pack).n
		return [m.t, nameOf(m.device), from, from + stepsIn(m.pack) - 1]
	}
	if (m.t === "live") return [m.t, m.id, hex(m.data)]
	return [m.t, nameOf(m.device), m.n]
}
const haveOut = (h: Record<string, number>) =>
	Object.fromEntries(Object.entries(h).map(([d, n]) => [nameOf(d), n]))

// ---- links

// a side of a link: what it sent, waiting, and what it is told with
type Side = { queue: Uint8Array[]; told?: (b: Uint8Array) => void; unlink?: () => void }
const links = new Map<string, Side>()
const side = (from: string, to: string) => {
	const s = links.get(`${from} ${to}`)
	if (!s) throw new Error(`no link ${from} ${to}`)
	return s
}
function join(a: string, b: string) {
	for (const [x, y] of [[a, b], [b, a]]) {
		if (links.has(`${x} ${y}`)) throw new Error(`${x} and ${y} are linked`)
		links.set(`${x} ${y}`, { queue: [] })
	}
	for (const [x, y] of [[a, b], [b, a]]) {
		const mine = side(x, y)
		const link: Link = {
			send: (bytes) => void mine.queue.push(bytes),
			onMessage: (fn) => void (side(y, x).told = fn),
		}
		mine.unlink = device(x).sync.link(link)
	}
}
// to's side of the link from → to: what to hears from
const hear = (from: string, to: string, bytes: Uint8Array) => {
	const told = side(from, to).told
	if (!told) throw new Error(`${to} does not listen to ${from}`)
	told(bytes)
}

// ---- runs

async function runIn(r: Request) {
	const device = keyOf(r.device)
	let before: Uint8Array | null = null
	const steps = (r.steps as (string | Request)[]).map((s) => {
		const bytes = typeof s === "string" ? unhex(s) : encodeStep(stepIn(s, device, before))
		before = hashStep(bytes)
		return bytes
	})
	const signer = r.sig === undefined ? signerOf(r.sign ?? r.device) : undefined
	const sig = signer ? await signer.sign(hashStep(steps[steps.length - 1])) : unhex(r.sig)
	return { device, steps, sig }
}
const signerOf = (name: string) => {
	const s = device(name).signer
	if (!s) throw new Error(`${name} signs nothing`)
	return s
}

async function answer(r: Request): Promise<Answer> {
	try {
		return await one(r)
	} finally {
		await idle()
	}
}

async function one(r: Request): Promise<Answer> {
	switch (r.op) {
		// vectors
		case "encode":
			return { bytes: hex(encodeStep(stepIn(r.step))) }
		case "decode":
			try {
				return { step: stepOut(decodeStep(unhex(r.bytes))) }
			} catch {
				return { refused: true }
			}
		case "hash":
			return { hash: hex(hashStep(unhex(r.bytes))) }
		case "sign":
			return { sig: hex(await (await createSigner(unhex(r.seed))).sign(unhex(r.bytes))) }
		case "pack": {
			const before = r.before === undefined ? undefined : priorOf(unhex(r.before))
			return {
				pack: hex(encode(pack((r.steps as string[]).map(unhex), before) as unknown as Value)),
			}
		}
		case "unpack":
			try {
				const before = r.before === undefined ? undefined : priorOf(unhex(r.before))
				return { steps: unpack(decode(unhex(r.pack)), before).map(hex) }
			} catch {
				return { refused: true }
			}
		case "message":
			return { bytes: hex(wire(messageIn(r.message))) }
		case "read": {
			const m = read(unhex(r.bytes))
			if (!m) return { refused: true }
			try {
				return { message: messageOut(m) }
			} catch {
				// a run whose pack doesn't unpack: a message still, refused when taken
				return { message: [m.t, (m as { device: string }).device, "not a pack"] }
			}
		}

		// a log
		case "device": {
			if (devices.has(r.name)) throw new Error(`${r.name} is made`)
			const d = await createDevice(unhex(r.seed))
			devices.set(r.name, d)
			return { key: d.log.device! }
		}
		case "disk": {
			if (devices.has(r.name)) throw new Error(`${r.name} is made`)
			const dir = await Deno.makeTempDir()
			if (r.log !== undefined) await Deno.writeFile(`${dir}/log`, unhex(r.log))
			const d = await onDisk(dir, unhex(r.seed))
			devices.set(r.name, d)
			return { key: d.log.device! }
		}
		case "sync":
			await disk(r.device).store.sync?.()
			return {}
		case "reset": {
			const d = disk(r.device)
			for (const k of links.keys()) {
				if (k.split(" ").includes(r.device)) throw new Error(`${r.device} is linked`)
			}
			// what it appended is written; what it held only in memory is gone
			await d.log.saved()
			d.store.close?.()
			const seed = await Deno.readFile(`${d.dir}/key`), again = await onDisk(d.dir, seed)
			devices.set(r.device, again)
			return { count: again.log.count(again.log.device!) }
		}
		case "tear": {
			const path = `${disk(r.device).dir}/${r.file}`, size = (await Deno.stat(path)).size
			await Deno.truncate(path, Math.max(0, size - r.bytes))
			return {}
		}
		case "files": {
			const d = disk(r.device)
			const log = await readOr(`${d.dir}/log`), open = await readOr(`${d.dir}/open`)
			return {
				log: framesOf(log),
				open: framesOf(open),
				bytes: { log: log.length, open: open.length },
			}
		}
		case "relay":
			if (devices.has(r.name)) throw new Error(`${r.name} is made`)
			devices.set(r.name, made(createLog(), true))
			return {}
		case "write": {
			const d = device(r.device)
			if (d.dir) {
				const s = d.log.write({
					node: r.node,
					part: r.part ?? "value",
					patches: patchesIn(r.patches),
					when: r.when ?? WHEN,
					...(r.who !== undefined && { who: r.who }),
				})
				return { n: s.n, lamport: s.lamport }
			}
			if (!d.graph) throw new Error(`${r.device} writes nothing`)
			d.graph.write(r.node, r.part ?? "value", patchesIn(r.patches), r.when ?? WHEN, r.who)
			const s = decodeStep(d.log.step(d.log.device!, d.log.count(d.log.device!)))
			return { n: s.n, lamport: s.lamport }
		}
		case "value": {
			const e = device(r.device).graph?.table.get((r.part ?? "value") as Key, r.node)
			return e?.value === undefined ? {} : { value: toJson(e.value) }
		}
		case "versions": {
			const h = device(r.device).graph?.history
			if (!h) throw new Error(`${r.device} has no graph`)
			return {
				versions: h.versions(r.node, r.part ?? "value").map((v) => ({
					...(v.gone ? { gone: true } : { value: toJson(v.value) }),
					from: v.from.heads.map(([d, n]) => [nameOf(d), n]),
				})),
			}
		}
		case "have":
			return { have: haveOut(device(r.device).log.have()) }
		case "count":
			return { count: device(r.device).log.count(keyOf(r.of)) }
		case "steps":
			return { steps: device(r.device).log.steps(keyOf(r.of)).map(hex) }
		case "run": {
			const b = await device(r.device).log.run(keyOf(r.of), r.from)
			if (!b) return {}
			const from = decodeStep(b.steps[0]).n
			return { from, to: from + b.steps.length - 1, sig: hex(b.sig) }
		}
		case "take":
			return await device(r.device).log.take(await runIn(r.run))
		case "pass": {
			const b = await device(r.from).log.run(keyOf(r.of), r.at)
			if (!b) throw new Error(`${r.from} has no run of ${r.of} at ${r.at}`)
			return await device(r.to).log.take(b)
		}

		// links
		case "link":
			device(r.a), device(r.b), join(r.a, r.b)
			return {}
		case "unlink":
			for (const [x, y] of [[r.a, r.b], [r.b, r.a]]) side(x, y).unlink?.()
			links.delete(`${r.a} ${r.b}`), links.delete(`${r.b} ${r.a}`)
			return {}
		case "queued":
			return { queued: side(r.from, r.to).queue.map(view) }
		case "deliver": {
			const q = side(r.from, r.to).queue
			const got = q.splice(0, r.count ?? q.length)
			for (const b of got) hear(r.from, r.to, b)
			return { got: got.map(view) }
		}
		case "drop": {
			const q = side(r.from, r.to).queue
			return { dropped: q.splice(0, r.count ?? q.length).map(view) }
		}
		case "inject":
			hear(r.from, r.to, r.bytes !== undefined ? unhex(r.bytes) : wire(messageIn(r.message)))
			return {}
		case "live":
			device(r.device).sync.live(unhex(r.data))
			return {}
		case "heard":
			return { heard: device(r.device).heard.map(hex) }
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

// the disks' directories, let go at the end
globalThis.addEventListener("unload", () => {
	for (const d of devices.values()) if (d.dir) Deno.removeSync(d.dir, { recursive: true })
})

if (import.meta.main) await serve(answer)
