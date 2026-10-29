import { assert, assertEquals } from "@std/assert"
import { decode, encode } from "@ermine/encoding/cbor"
import createEntry from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable, type Key } from "@ermine/graph/table"
import { children, createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createLog } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync } from "./sync.ts"
import { createGalaxy } from "./galaxy.ts"
import { fileStore } from "./store_file.ts"
import { frames, httpLinks, unframe } from "./carriers/http.ts"
import { show } from "./nodes.ts"
import { pack } from "./pack.ts"
import { hex, unhex } from "./step.ts"

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// a recv answer's number and messages
async function opened(res: Response) {
	const bytes = new Uint8Array(await res.arrayBuffer())
	return { k: new DataView(bytes.buffer).getUint32(0), got: unframe(bytes.subarray(4))! }
}
// a recv, given up on after ms (as a client that hangs up)
function recv(handle: (r: Request) => Promise<Response> | undefined, q: string, ms = 100) {
	const stop = new AbortController()
	const t = setTimeout(() => stop.abort(), ms)
	return handle(new Request(`http://x/r/recv?${q}`, { signal: stop.signal }))!.finally(() =>
		clearTimeout(t)
	)
}

Deno.test("check: http, a link made again here: its first message reaches a client that acked 1", async () => {
	// a galaxy restarted, or the link 60 s unheard: the new link says what it has at once
	// the client that acked 1 is told to link again, and links again with a fresh id
	const http = httpLinks((link) => link.send(new Uint8Array([7])))
	const again = await recv(http, "link=a&ack=1")
	await again.body?.cancel()
	const { k, got } = await opened(await recv(http, "link=b&ack=0"))
	http.close()
	assertEquals(again.status, 410)
	assertEquals({ k, got }, { k: 1, got: [new Uint8Array([7])] })
})

Deno.test("check: http, a second poller on one link id answers the first at once", async () => {
	const http = httpLinks(() => {})
	let first = false
	const a = recv(http, "link=a&ack=0", 300).then((r) => (first = true, r))
	await tick(10)
	const b = recv(http, "link=a&ack=0", 300)
	await tick(50)
	const waited = !first
	await (await a).body?.cancel(), await (await b).body?.cancel()
	http.close()
	assert(waited, "the first recv was answered empty as soon as the second came")
})

Deno.test("check: galaxy, rooms Pigs and pigs are one dir on this mac", async () => {
	const dir = await Deno.makeTempDir()
	const me = createLog({ writes: true })
	await me.load()
	me.write({ node: "pig", part: "value", patches: [{ path: [], value: 1 }], when: 0 })
	const b = (await me.run(me.device!, 1))!
	let g = createGalaxy({ dir })
	const res = await g.handler(
		new Request("http://x/tippet/Pigs/send?link=a", {
			method: "POST",
			body: frames([encode(["run", unhex(b.device), b.sig, pack(b.steps)] as never)]),
		}),
	)
	await res.body?.cancel()
	await tick()
	await g.close()
	g = createGalaxy({ dir })
	const { got } = await opened(
		await g.handler(new Request("http://x/tippet/pigs/recv?link=b&ack=0")),
	)
	await g.close()
	const [, have] = decode(got[0]) as [string, [Uint8Array, number][]]
	await Deno.remove(dir, { recursive: true })
	assertEquals(
		have.map(([d]) => hex(d)).includes(me.device!),
		false,
		"a step sent to Pigs is in pigs",
	)
})

Deno.test("check: galaxy, a malformed batch leaves its device in every have", async () => {
	const dir = await Deno.makeTempDir()
	const g = createGalaxy({ dir })
	const bad = ["run", new Uint8Array(3), new Uint8Array(64), [encode("hi")]]
	const res = await g.handler(
		new Request("http://x/tippet/pigs/send?link=a", {
			method: "POST",
			body: frames([encode(bad)]),
		}),
	)
	await res.body?.cancel()
	await tick()
	const { got } = await opened(
		await g.handler(new Request("http://x/tippet/pigs/recv?link=b&ack=0"))!,
	)
	await g.close()
	await Deno.remove(dir, { recursive: true })
	assertEquals(decode(got[0]), ["have", []])
})

// a log with steps from another, and their signatures, on disk
async function written(dir: string) {
	const a = createLog({ writes: true })
	await a.load()
	const g = createLog({ store: fileStore(dir) })
	await g.load()
	const put = (v: number) =>
		a.write({ node: "pig", part: "value", patches: [{ path: [], value: v }], when: 0 })
	put(1), put(2)
	await g.take((await a.run(a.device!, 1))!)
	put(3)
	await g.take((await a.run(a.device!, 3))!)
	await g.close()
	return { a, g }
}

Deno.test("check: a store file with a zeroed tail loads what came before it", async () => {
	const dir = await Deno.makeTempDir()
	const { a } = await written(dir)
	// the file grown but its bytes never written, as after a power cut
	await Deno.writeFile(`${dir}/log`, new Uint8Array(8), { append: true })
	const g = createLog({ store: fileStore(dir) })
	const loaded = await g.load().then(() => true, () => false)
	await g.close()
	await Deno.remove(dir, { recursive: true })
	assert(loaded, "load threw")
	assertEquals(g.have()[a.device!], 3)
})

Deno.test("check: show() with history's default kept feeds itself", async () => {
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
	const scope = s.createRootScope({ actor: "test" })
	const run = <T>(f: () => T) => s.runWithScope(scope, f)
	const log = createLog({ writes: true })
	const history = createHistory({ log, table, places, run })
	await history.load()
	const sync = createSync({ log })
	let writes = 0
	const stop = show({
		sync,
		log,
		history,
		write: (v) => {
			if (++writes > 50) return stop()
			run(() => table.sub("value", "sync", createEntry(v, createChangeHeader(s))))
		},
	})
	await tick()
	stop()
	assert(
		writes <= 1,
		`${writes} writes, ${log.count(log.device!)} steps, with nothing else written`,
	)
})
