// two ermines tied to one room in memory: a server's, and a page's that starts empty. LLM generated: a
// prototype's checks
import { assertEquals } from "@std/assert"
import {
	createAction,
	createEffect,
	createErmine,
	createNode,
	ensureNode,
	executeAction,
	explain,
	list,
	patch,
	peep,
	read,
	rename,
} from "@ermine/system"
import { createTie, type Link } from "./tie.ts"

const WAIT_MS = 3000
const TICK_MS = 5
const tick = () => new Promise((r) => setTimeout(r, TICK_MS))
// f true, looked at each tick
async function until(f: () => boolean, end = Date.now() + WAIT_MS): Promise<void> {
	if (f()) return
	if (Date.now() > end) throw new Error("timed out")
	await tick()
	return until(f, end)
}
// two links joined in memory, each message a macrotask later
function pair(): [Link, Link] {
	const fns: ((b: Uint8Array) => void)[] = []
	const mk = (i: number): Link => ({
		send: (b) => void setTimeout(() => fns[1 - i]?.(b), 0),
		onMessage: (fn) => void (fns[i] = fn),
	})
	return [mk(0), mk(1)]
}
const look = (e: ReturnType<typeof createErmine>, path: string) =>
	e.within(() => peep(() => read(path)))

async function room() {
	const server = createErmine({
		host: {
			setup: () => {
				ensureNode("/shared")
				ensureNode("/shared/count", 0)
				ensureNode("/shared/beat", 0)
				ensureNode("/shared/stickers")
				ensureNode("/shared/pens/a")
				ensureNode("/shared/pens/b")
				createNode("/shared/pens/a", "pip")
				ensureNode("/mine", "not shared")
			},
		},
	})
	const local = ["/shared/beat"]
	const s = await createTie(server, { at: "/shared", local })
	const page = createErmine({})
	const p = await createTie(page, { at: "/shared", id: s.root, local })
	const [a, b] = pair()
	s.sync.link(a)
	p.sync.link(b)
	await until(() => look(page, "/shared/count") === 0)
	const close = () => {
		s.stop(), p.stop(), server.close(), page.close()
	}
	return { server, page, close }
}

Deno.test("a page's empty ermine holds the server's folder, and writes go both ways", async () => {
	const { server, page, close } = await room()
	assertEquals(look(page, "/mine"), undefined)
	page.within(() => patch("/shared/count", [{ path: [], value: 1 }]))
	await until(() => look(server, "/shared/count") === 1)
	server.within(() => createNode("/shared/stickers", { s: "🐸" }))
	await until(() => page.within(() => peep(() => list("/shared/stickers"))).length === 1)
	const [name] = page.within(() => peep(() => list("/shared/stickers")))
	assertEquals(look(page, `/shared/stickers/${name}`), { s: "🐸" })
	close()
})

Deno.test("a rename is the same node at another name, there too", async () => {
	const { server, page, close } = await room()
	const [pig] = server.within(() => peep(() => list("/shared/pens/a")))
	await until(() => look(page, `/shared/pens/a/${pig}`) === "pip")
	page.within(() => rename(`/shared/pens/a/${pig}`, `/shared/pens/b/${pig}`))
	await until(() => look(server, `/shared/pens/b/${pig}`) === "pip")
	assertEquals(server.within(() => peep(() => list("/shared/pens/a"))), [])
	close()
})

Deno.test("a local path is each ermine's own", async () => {
	const { server, page, close } = await room()
	const beats = 3
	server.within(() => patch("/shared/beat", [{ path: [], value: beats }]))
	page.within(() => patch("/shared/beat", [{ path: [], value: beats + 1 }]))
	page.within(() => patch("/shared/count", [{ path: [], value: beats }]))
	await until(() => look(server, "/shared/count") === beats)
	assertEquals(look(server, "/shared/beat"), beats)
	assertEquals(look(page, "/shared/beat"), beats + 1)
	close()
})

Deno.test("a step landing runs a page's effect again", async () => {
	const { server, page, close } = await room()
	const seen: unknown[] = []
	page.start(() => {
		createEffect("watch", () => read("/shared/count"), (v) => void seen.push(v))
	}, "/visitors/v")
	const next = 2
	server.within(() => patch("/shared/count", [{ path: [], value: next }]))
	await until(() => seen.includes(next))
	assertEquals(seen, [0, next])
	close()
})

Deno.test("a process's write lands saying its process", async () => {
	const { server, page, close } = await room()
	const started = page.start(() => {
		createAction("on/count", () => patch("/shared/count", [{ path: [], value: 1 }]))
	}, "/visitors/v")
	if ("refused" in started) throw new Error("refused")
	page.getProcessContext(started.process)!.within(() => executeAction("on/count"))
	await until(() => look(server, "/shared/count") === 1)
	const seen = server.within(() => peep(() => explain("/shared/count"))) as {
		change?: { actor?: unknown }
	}
	assertEquals(seen.change?.actor, "/visitors/v")
	close()
})

Deno.test("writes made while unlinked go once linked again", async () => {
	const server = createErmine({
		host: { setup: () => (ensureNode("/shared"), ensureNode("/shared/count", 0)) },
	})
	const s = await createTie(server, { at: "/shared" })
	const page = createErmine({})
	const p = await createTie(page, { at: "/shared", id: s.root })
	const [a, b] = pair()
	s.sync.link(a)
	const unlink = p.sync.link(b)
	await until(() => look(page, "/shared/count") === 0)
	unlink()
	const offline = 7
	page.within(() => patch("/shared/count", [{ path: [], value: offline }]))
	await tick()
	assertEquals(look(server, "/shared/count"), 0)
	const [c, d] = pair()
	s.sync.link(c)
	p.sync.link(d)
	await until(() => look(server, "/shared/count") === offline)
	s.stop(), p.stop(), server.close(), page.close()
})
