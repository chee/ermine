// Tippet (WIRE.md) on the line protocol (conformance/typescript/harness.ts), one process per
// scenario.
// Bytes are lowercase hex; a device is named by its 64-hex key. Deterministic: keys come from
// seeds,
// a write's when is the request's or 1760000000, and the k-th random call gives k big-endian.
//   encode  { step: { device, n, before, node, relative?, part, patches, lamport, when, on?, ids?, who? } } -> { bytes }
//           ids: per patch null or { after: id | null, gone: [[id, count], …] }, an id [device, n, k]
//   decode  { bytes } -> { step } | { refused: true }
//   hash    { bytes } -> { hash }        blake3
//   sign    { seed, bytes } -> { sig }   ed25519
//   pack    { steps, before? } -> { pack }       before: the step it is packed against
//   unpack  { pack, before? } -> { steps } | { refused: true }
//   message { message } -> { bytes }     a run is ["run", device, sig, steps]
//   read    { bytes } -> { message } | { refused: true }
//   device  { name, seed, rebase?, forgets? } -> { key }    a log that writes, with its graph and sync;
//                                        rebase: history's (how many steps an entry can undo)
//   relay   { name } -> {}               no key, no graph
//   write   { device, node, part?, patches, when?, who? } -> { n, lamport }
//   disk    { name, seed, log? } -> { key }    a log on the file store, no graph; log: initial hex
//   sync    { device } -> {}
//   reset   { device } -> { count }      restart from its files
//   tear    { device, file, bytes } -> {}      cut the last bytes off dir/<file> (log, open)
//   files   { device } -> { log, open, bytes }   frames: ["run", device, first, last], ["step", device, n], ["other"]
//   value   { device, node, part? } -> { value } | {}
//   versions { device, node, part? } -> { versions }   each { value } or { gone: true }, and from
//   have    { device } -> { have }       { device: n }
//   count   { device, of } -> { count }
//   steps   { device, of } -> { steps }  hex
//   run     { device, of, from } -> { from, to, sig } | {}
//   take    { device, run } -> { added } | { refused }   run: { device, steps, sign?, sig? }
//   pass    { from, to, of, at } -> { added } | { refused }    to takes from's run(of, at)
//   link    { a, b } -> {}               each side says have; messages wait until delivered
//   unlink  { a, b } -> {}
//   queued  { from, to } -> { queued }
//   deliver { from, to, count? } -> { got }
//   drop    { from, to, count? } -> { dropped }
//   inject  { from, to, message?, bytes? } -> {}
//   live    { device, data } -> {}
//   heard   { device } -> { heard }
// Views: ["have", { device: n }], ["run", device, from, to], ["live", id, data], ["refused",
// device, n].
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import createEntry from "@ermine/graph/entry"
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key, type Table } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createLog, isRun, type Log, type Store } from "./log.ts"
import { fileStore } from "./store_file.ts"
import { createHistory } from "./history.ts"
import { createSync, type Link, type Message, read, type Sync, wire } from "./sync.ts"
import { createSigner, type Signer } from "./sign.ts"
import { decodeStep, encodeStep, hashStep, hex, type Id, type Step, unhex } from "./step.ts"
import { firstOf, pack, type Packed, priorOf, stepsIn, unpack } from "./pack.ts"

const WHEN = 1_760_000_000

let calls = 0
crypto.getRandomValues = (<T extends ArrayBufferView>(a: T): T => {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
	let k = ++calls
	for (let i = b.length - 1; i >= 0; i--) b[i] = k % 256, k = Math.floor(k / 256)
	return a
}) as typeof crypto.getRandomValues

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

type Device = {
	log: Log
	sync: Sync
	signer?: Signer
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
const keyOf = (s: string) => devices.get(s)?.log.device ?? s
const nameOf = (key: string) => {
	for (const [n, d] of devices) if (d.log.device === key) return n
	return key
}

function made(log: Log, relay: boolean, signer?: Signer): Device {
	const tracked = new Proxy(log, {
		get(t, k) {
			const v = Reflect.get(t, k)
			return k === "take" || k === "takePack" || k === "run"
				? (...a: unknown[]) => track((v as (...a: unknown[]) => Promise<unknown>)(...a))
				: v
		},
	})
	const d: Device = { log, sync: createSync({ log: tracked, relay }), signer, heard: [] }
	d.sync.onLive((b) => d.heard.push(b))
	return d
}

async function createDevice(
	seed: Uint8Array,
	rebase?: number,
	forgets?: boolean,
): Promise<Device> {
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
	const history = createHistory({ log, table, places, run, rebase, forgets })
	await history.load()
	const d = made(log, false, await createSigner(seed))
	d.graph = {
		table,
		history,
		write(node, part, patches, when, who) {
			const change = { time: when, actor: who ?? null, frame: { info: {}, parent: undefined } },
				unkept = history.unkept.length
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
	if (s.ids !== undefined) {
		const id = ([d, n, k]: [string, number, number]) => ({ device: keyOf(d), n, k })
		out.ids = (s.ids as ({
			after: [string, number, number] | null
			gone: [[string, number, number], number][]
		} | null)[])
			.map((x) =>
				x &&
				{
					after: x.after && id(x.after),
					gone: x.gone.map(([i, c]) => [id(i), c] as [Id, number]),
				}
			)
	}
	if (s.who !== undefined) out.who = s.who
	return out
}
const idOut = (i: Id) => [i.device, i.n, i.k]
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
		...(s.ids !== undefined && {
			ids: s.ids.map((x) =>
				x && { after: x.after && idOut(x.after), gone: x.gone.map(([i, c]) => [idOut(i), c]) }
			),
		}),
		...(s.who !== undefined && { who: s.who }),
	}
}

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
const hear = (from: string, to: string, bytes: Uint8Array) => {
	const told = side(from, to).told
	if (!told) throw new Error(`${to} does not listen to ${from}`)
	told(bytes)
}

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
				return { message: [m.t, (m as { device: string }).device, "not a pack"] }
			}
		}

		case "device": {
			if (devices.has(r.name)) throw new Error(`${r.name} is made`)
			const d = await createDevice(unhex(r.seed), r.rebase, r.forgets)
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

globalThis.addEventListener("unload", () => {
	for (const d of devices.values()) if (d.dir) Deno.removeSync(d.dir, { recursive: true })
})

if (import.meta.main) await serve(answer)
