// one device as its own os process, for a real subduction server (live/check.ts runs two or
// three). it speaks a line protocol on stdin/stdout: one json request a line, one json answer a line
// ({"ok": ...} or {"error": "..."}); first a line {"ready": ...}.
//
//   deno run -A peer.ts --seed HEX [--doc ermine://…] [--store DIR] [--server wss://galaxy.observer]
//     [--service NAME] [--zeros]
//
// the host is composed as sync_test.ts composes one: table, places, scheduler and sync (@ermine/together).
// the document is a node of the table: stored changes are writes at it. no --doc: one is minted
// (with --zeros, its last 16 bytes zero, for a server with no grant for it) and told in "ready"
//   {cmd:"commit", value, n?}      n (default 1) writes of value at the document, kept; answers when
//                                  sealed, stored and sent (value a string: "<value>-<i>" when n > 1)
//   {cmd:"read", doc?}             the versions of the node's value (the one shown, then the others
//                                  in its conflicts table) as summaries, sorted; or, for a topic
//                                  viewed, what was heard on it
//   {cmd:"view", doc}              listen on a topic: what an ephemeral message heard has to land in
//   {cmd:"ephemeral", doc, value}  value sent on the topic: ephemeral, kept nowhere, in parts if big
//   {cmd:"status"}                 {commits, fragments, taking}
//   {cmd:"quit"}
import { blake3 } from "@ermine/blake3"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { type Conflict, createSync } from "@ermine/together/sync"
import { createSigner } from "@ermine/together/seal"
import { files } from "./files.ts"
import { Storage } from "./storage.ts"
import { hexOf, unhex } from "./blob.ts"
// deno-lint-ignore no-explicit-any
type Any = any

const flag = (name: string, d?: string) => {
	const i = Deno.args.indexOf("--" + name)
	return i >= 0 ? Deno.args[i + 1] : d
}
const seed = unhex(flag("seed")!)
const given = flag("doc")
const dir = flag("store")
const server = flag("server", "wss://galaxy.observer")!
const service = flag("service")
if (seed.length !== 32 || (given !== undefined && !/^ermine:\/\/[0-9a-f]{64}$/.test(given))) {
	throw new Error("--seed (64 hex) needed, and --doc if given an ermine:// id")
}

const signer = await createSigner(seed)
const key = signer.key
const storage = await Storage.open(files(dir ?? await Deno.makeTempDir({ prefix: "ermine-live-" })))
// saves resolve before they are kept (storage.ts): flushed every few seconds, so a write that
// failed is told, and before going on a signal
setInterval(() => storage.flush().catch((e) => console.error(`storage: ${e}`)), 2000)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	try {
		Deno.addSignalListener(signal, () => {
			storage.flush().catch(() => {}).finally(() => Deno.exit(0))
		})
	} catch {
		// a platform without the signal
	}
}
const scheduler = createScheduler()
const table = createTable((part, id) => {
	places.onTableChange(part, id)
	sync.tableChanged(part, id)
})
const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler })
const sync = createSync({
	table,
	signer,
	zeros: Deno.args.includes("--zeros"),
	storage: storage as Any,
	commit: (changed) => places.commit(changed),
})
const device = sync.device
const scope = scheduler.createRootScope({ actor: hexOf(key).slice(0, 8) })
const DOC = given ?? sync.mint()

// patches to the entry under (part, id), made whole first if none: told to places, then to sync
const write = (part: Key, id: Id, patches: Patch[]) =>
	scheduler.runWithScope(scope, () => {
		let entry = table.get(part, id)
		if (entry === undefined) {
			table.add(part, id, createEntry(patches[0].value as never, createChangeHeader(scheduler)))
			patches = patches.slice(1)
			entry = table.get(part, id)!
		}
		if (patches.length) {
			update(entry, patches as never, createChangeHeader(scheduler))
			places.commit([entry])
			sync.wrote([entry])
		}
	})

// starting again: the device took in what the store held, as it was made
await device.ready()
await sync.follow(DOC)
const online = flag("offline") === undefined
if (online) await device.connectDiscover(server, service)

// what was heard on each topic viewed
const heard = new Map<string, unknown[]>()
const summary = (c: unknown): unknown =>
	typeof c === "string" && c.length > 100
		? `len:${c.length}:${hexOf(blake3(new TextEncoder().encode(c))).slice(0, 8)}`
		: c
// every head of the node's value: the one shown, then the others from its conflicts table
const read = (doc: string) => {
	if (heard.has(doc)) return heard.get(doc)
	const shown = table.get("value", doc)
	if (!shown) return null
	const others = (table.get("conflicts", doc)?.value ?? []) as Conflict[]
	return [shown.value, ...others.filter((c) => "value" in c.tables).map((c) => c.tables.value)]
		.map(summary).sort()
}

async function handle(r: Any): Promise<unknown> {
	switch (r.cmd) {
		case "commit": {
			const n = r.n ?? 1
			for (let i = 0; i < n; i++) {
				write("value", DOC, [{ path: [], value: n > 1 ? `${r.value}-${i}` : r.value }])
			}
			await sync.idle()
			return { n }
		}
		case "view": {
			// listened to once the connection is up (a listen made before it is not subscribed on it)
			const list: unknown[] = []
			heard.set(r.doc, list)
			device.listen(r.doc, (_from, bytes) => list.push(summary(new TextDecoder().decode(bytes))))
			await device.idle()
			return {}
		}
		case "ephemeral":
			// the sender listens too (and so subscribes) before it publishes
			device.listen(r.doc, () => {})
			await device.idle()
			await device.send(r.doc, new TextEncoder().encode(r.value))
			await device.idle()
			return {}
		case "read":
			return read(r.doc ?? DOC)
		case "status":
			return {
				commits: (await device.stored(DOC)).length,
				fragments: device.fragments(DOC).length,
				taking: {
					refused: device.history(DOC).refused(),
					waiting: device.history(DOC).waiting(),
				},
			}
		case "quit":
			await sync.idle().catch(() => {})
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
out({ ready: { key: hexOf(key), doc: DOC, online } })
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
