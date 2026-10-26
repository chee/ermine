import { assert, assertEquals } from "@std/assert"
import createEntry from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Key } from "@ermine/core/table"
import { children, createPlaces } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createLog } from "./log.ts"
import { createHistory } from "./history.ts"
import { createSync, type Link } from "./sync.ts"
import { createGalaxy } from "./galaxy.ts"
import { socket } from "./carriers/websocket.ts"
import { frames, poll, unframe } from "./carriers/http.ts"
import { fileStore } from "./store_file.ts"

// one device, as tippet_test makes one
async function device() {
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
	return {
		log,
		sync,
		value: (id: string) => table.get("value", id)?.value,
		put: (id: string, v: unknown) =>
			run(() => table.sub("value", id, createEntry(v, createChangeHeader(s)))),
	}
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean, ms = 5000) {
	const end = Date.now() + ms
	while (!f()) {
		if (Date.now() > end) throw new Error("timed out")
		await tick(5)
	}
}

function serve(dir: string) {
	const galaxy = createGalaxy({ dir })
	const server = Deno.serve({ port: 0, onListen() {} }, galaxy.handler)
	return {
		url: `localhost:${server.addr.port}/tippet/pigs`,
		async close() {
			await galaxy.close()
			await server.shutdown()
		},
	}
}

// a websocket link, and a promise kept once it has closed
function ws(url: string): [Link, Promise<unknown>] {
	const w = new WebSocket(`ws://${url}`)
	const closed = new Promise((r) => w.addEventListener("close", r))
	return [socket(w), closed]
}

Deno.test("frames: messages back to back, and not frames refused", () => {
	const list = [new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3])]
	assertEquals(unframe(frames(list)), list)
	assertEquals(unframe(new Uint8Array([0, 0, 0, 5, 1])), undefined)
})

Deno.test("a file store: records and snapshot back after a restart, a torn tail cut", async () => {
	const dir = await Deno.makeTempDir()
	const store = fileStore(dir)
	await store.load(() => undefined)
	await store.append(new Uint8Array([1]))
	await store.append(new Uint8Array([2, 3]), ["d", 1, 1])
	await store.snapshot(new Uint8Array([9]))
	await Deno.writeFile(`${dir}/log`, new Uint8Array([0, 0, 0, 7, 4]), { append: true })
	const again = fileStore(dir), records: Uint8Array[] = []
	const snapshot = await again.load((
		r,
	) => (records.push(r), r.length === 2 ? ["d", 1, 1] : undefined))
	assertEquals({ records, snapshot }, {
		records: [new Uint8Array([1]), new Uint8Array([2, 3])],
		snapshot: new Uint8Array([9]),
	})
	// a step read back from the file, and one not yet written
	assertEquals(again.get("d", 1), new Uint8Array([2, 3]))
	const appended = again.append(new Uint8Array([5]), ["d", 2, 2])
	assertEquals(again.get("d", 2), new Uint8Array([5]))
	await appended
	assertEquals(again.get("d", 2), new Uint8Array([5]))
	again.close!()
	let n = 0
	await fileStore(dir).load(() => void n++)
	assertEquals(n, 3)
	await Deno.remove(dir, { recursive: true })
})

Deno.test("galaxy: a websocket and a long-poll in one room, then a restart", async () => {
	const dir = await Deno.makeTempDir()
	let g = serve(dir)
	const a = await device(), b = await device()
	const [wa, aClosed] = ws(g.url)
	const unlinkA = a.sync.link(wa)
	const unlinkB = b.sync.link(poll(`http://${g.url}`))

	a.put("pig", { from: "a" })
	await until(() => b.value("pig") !== undefined)
	assertEquals(b.value("pig"), { from: "a" })
	b.put("cow", { from: "b" })
	await until(() => a.value("cow") !== undefined)
	assertEquals(a.value("cow"), { from: "b" })

	const heard: Uint8Array[] = []
	b.sync.onLive((d) => heard.push(d))
	a.sync.live(new Uint8Array([1, 2, 3]))
	await until(() => heard.length === 1)
	assertEquals(heard[0], new Uint8Array([1, 2, 3]))

	unlinkA(), unlinkB()
	await aClosed
	await g.close()

	// the same dir, a new galaxy: a new device catches up on all of it
	g = serve(dir)
	const c = await device()
	const [wc, cClosed] = ws(g.url)
	const unlinkC = c.sync.link(wc)
	await until(() => c.value("pig") !== undefined && c.value("cow") !== undefined)
	assertEquals(c.value("pig"), { from: "a" })
	assertEquals(c.value("cow"), { from: "b" })
	assert(c.log.have()[a.log.device!] === 1 && c.log.have()[b.log.device!] === 1)
	unlinkC()
	await cClosed
	await g.close()
	await tick()
	await Deno.remove(dir, { recursive: true })
})

Deno.test("galaxy: a room that isn't a name is refused", async () => {
	const dir = await Deno.makeTempDir()
	const galaxy = createGalaxy({ dir })
	// "." and ".." are taken out by url parsing before they reach it
	for (const room of ["", "a%2Fb", "%2F", "%E0%A4%A"]) {
		const res = await galaxy.handler(new Request(`http://x/tippet/${room}/recv?link=1&ack=0`))
		assertEquals(res.status, 400, room)
		await res.body?.cancel()
	}
	assertEquals(await Array.fromAsync(Deno.readDir(dir)), [])
	await galaxy.close()
	await Deno.remove(dir, { recursive: true })
})
