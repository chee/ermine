// One device as its own OS process, for a real Subduction server (sync/live/check.ts runs two or
// three). It speaks a line protocol on stdin/stdout: one JSON request a line, one JSON answer a line
// ({"ok": ...} or {"error": "..."}); first a line {"ready": ...}.
//
//   deno run -A peer.ts --seed HEX --doc ermine://… [--store DIR] [--server wss://galaxy.observer]
//     [--service NAME]
//
// The document is the scheduler's root: stored changes are writes at it.
//   {cmd:"commit", value, n?}      n (default 1) writes of value at the root, stored; answers when
//                                  sealed, stored and sent (value a string: "<value>-<i>" when n > 1)
//   {cmd:"read", doc?}             the versions of the node's value, as summaries, sorted
//   {cmd:"view", doc}              a node (an ephemeral document's) made empty and followed: what
//                                  an ephemeral change heard has to land in
//   {cmd:"ephemeral", doc, value}  a process makes the ephemeral node doc holding value, published
//   {cmd:"status"}                 {commits, fragments, taking}
//   {cmd:"quit"}
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { createScheduler } from "../../scheduler/ts/scheduler.ts"
import { is } from "../ts/id.ts"
import { createDevice } from "../ts/transport.ts"
import { createWiring, fresh } from "../ts/wiring.ts"
import { files } from "./files.ts"
import { Storage } from "./storage.ts"
import { hexOf, unhex } from "./blob.ts"
import createNode from "../../nodes/ts/node.ts"
// deno-lint-ignore no-explicit-any
type Any = any

const flag = (name: string, d?: string) => {
	const i = Deno.args.indexOf("--" + name)
	return i >= 0 ? Deno.args[i + 1] : d
}
const seed = unhex(flag("seed")!)
const DOC = flag("doc")!
const dir = flag("store")
const server = flag("server", "wss://galaxy.observer")!
const service = flag("service")
if (seed.length !== 32 || !is(DOC)) throw new Error("--seed (64 hex) and --doc (ermine://…) needed")

const key = ed25519.getPublicKey(seed)
const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, seed)) }
const storage = await Storage.open(files(dir ?? await Deno.makeTempDir({ prefix: "ermine-live-" })))
const device = createDevice({ signer, storage: storage as Any })
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const held: Any = {}
const wiring = createWiring(device, {
	versions: (...a: Any[]) => held.s.internal.versions(...a),
	signer,
	random,
})
const s = held.s = createScheduler({
	root: createNode(DOC, {}),
	actor: hexOf(key).slice(0, 8),
	site: () => undefined,
	id: () => fresh(random),
	changed: (r: Any) => wiring.changed(r),
} as Any)

// starting again: the device took in what the store held, as it was made (TRANSPORT.tex)
await device.ready()
await device.follow(DOC)
const online = flag("offline") === undefined
if (online) await device.connectDiscover(server, service)

const summary = (c: unknown): unknown =>
	typeof c === "string" && c.length > 100 ? `len:${c.length}:${hexOf(blake3(c)).slice(0, 8)}` : c
const read = (doc: string) => {
	const n = s.get(doc)
	return n ? n.value.map((v: Any) => summary(v.content)).sort() : null
}

async function handle(r: Any): Promise<unknown> {
	switch (r.cmd) {
		case "commit": {
			const n = r.n ?? 1
			for (let i = 0; i < n; i++) {
				s.write([], [{ path: [], value: n > 1 ? `${r.value}-${i}` : r.value }])
			}
			await wiring.idle()
			await device.idle()
			return { n }
		}
		case "view":
			s.create(undefined, { id: r.doc })
			await device.follow(r.doc)
			return {}
		case "ephemeral":
			s.start({
				address: [],
				id: "proc-" + hexOf(random(4)),
				program: ({ api }: Any) => {
					api.create(r.value, { id: r.doc, ephemeral: true })
					return 0
				},
			})
			await device.follow(r.doc)
			await wiring.idle()
			await device.idle()
			return {}
		case "read":
			return read(r.doc ?? DOC)
		case "status":
			return {
				commits: (await device.stored(DOC)).length,
				fragments: device.fragments(DOC).length,
				taking: device.taking(DOC),
			}
		case "quit":
			await wiring.idle().catch(() => {})
			await storage.flush()
			await device.close().catch(() => {})
			Deno.exit(0)
		// deno-lint-ignore no-fallthrough
		default:
			throw new Error("unknown cmd " + r.cmd)
	}
}

const out = (x: unknown) =>
	Deno.stdout.writeSync(new TextEncoder().encode(JSON.stringify(x) + "\n"))
out({ ready: { key: hexOf(key), online } })
let buffer = ""
const decoder = new TextDecoder()
for await (const chunk of Deno.stdin.readable) {
	buffer += decoder.decode(chunk, { stream: true })
	let at
	while ((at = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, at)
		buffer = buffer.slice(at + 1)
		if (!line.trim()) continue
		try {
			out({ ok: await handle(JSON.parse(line)) })
		} catch (e) {
			out({ error: String((e as Error).stack ?? e) })
		}
	}
}
await storage.flush()
Deno.exit(0)
