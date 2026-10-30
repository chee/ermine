// Galaxy is just another peer. Per room it has a log on disk and a relaying sync, with no graph and
// no signer: it checks every step's chain and signature and never reads a patch.
// PORT=8090 DIR=./tippet-data deno run --allow-net --allow-read --allow-write typescript/galaxy.ts
import { createLog, type Log } from "./log.ts"
import { createSync, type Sync } from "./sync.ts"
import { fileStore } from "./store_file.ts"
import { socket } from "./carriers/websocket.ts"
import { httpLinks } from "./carriers/http.ts"
import { hex } from "./step.ts"
import { blake3 } from "@ermine/encoding/blake3"

type Room = {
	log: Log
	sync: Sync
	http: ReturnType<typeof httpLinks>
	sockets: Set<WebSocket>
	written: number
	timer?: ReturnType<typeof setTimeout>
}

export function createGalaxy(o: { dir: string; at?: string; idle?: number; most?: number }): {
	handler: (req: Request) => Promise<Response>
	close(): Promise<void>
	readonly open: number
} {
	const at = (o.at ?? "/tippet") + "/"
	const idle = o.idle ?? 5 * 60_000, most = o.most ?? 1000
	const rooms = new Map<string, Promise<Room>>()
	const loaded = new Map<string, Room>()
	const closing = new Map<string, Promise<void>>()

	function free(n: string, r: Room) {
		clearTimeout(r.timer)
		rooms.delete(n), loaded.delete(n)
		r.http.close()
		for (const ws of r.sockets) ws.close()
		const done: Promise<void> = r.log.close().catch(() => {})
			.finally(() => closing.get(n) === done && closing.delete(n))
		closing.set(n, done)
	}

	// A room's dir is its name's hash, so names a filesystem folds together stay apart. At most
	// open, the one least recently written with no links is let go; every one linked: none opens
	// (undefined), and no room in use is ever let go for another.
	function room(n: string): Promise<Room> | undefined {
		let r = rooms.get(n)
		if (r) return r
		if (rooms.size >= most) {
			let oldest: [string, Room] | undefined
			for (const e of loaded) {
				if (!e[1].sync.links && (!oldest || e[1].written < oldest[1].written)) oldest = e
			}
			if (!oldest) return undefined
			free(...oldest)
		}
		r = (async () => {
			await closing.get(n)
			const dir = `${o.dir}/${hex(blake3(new TextEncoder().encode(n)))}`
			const log = createLog({ store: fileStore(dir) })
			await log.load()
			const sync = createSync({ log, relay: true })
			const room: Room = {
				log,
				sync,
				http: httpLinks((link) => sync.link(link)),
				sockets: new Set<WebSocket>(),
				written: 0,
			}
			log.on(() => room.written = Date.now())
			const linked = () => {
				clearTimeout(room.timer)
				if (loaded.get(n) !== room) return
				if (!sync.links) room.timer = setTimeout(() => free(n, room), idle)
			}
			loaded.set(n, room)
			sync.onLinks(linked)
			linked()
			return room
		})()
		rooms.set(n, r)
		r.catch(() => rooms.delete(n))
		return r
	}

	async function handler(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname
		const parts = path.startsWith(at) ? path.slice(at.length).split("/") : []
		if (parts.length < 1 || parts.length > 2) return new Response("not found", { status: 404 })
		let n = ""
		try {
			n = decodeURIComponent(parts[0])
		} catch {
		}
		if (["", ".", ".."].includes(n) || n.includes("/")) {
			return new Response("not a room", { status: 400 })
		}
		if (parts.length === 2 && parts[1] !== "send" && parts[1] !== "recv") {
			return new Response("not found", { status: 404 })
		}
		if (parts.length === 1 && req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("a websocket, or /send and /recv", { status: 426 })
		}
		const opening = room(n)
		if (!opening) return new Response("every room is in use", { status: 503 })
		const r = await opening
		if (parts.length === 2) return r.http(req)!
		const { socket: ws, response } = Deno.upgradeWebSocket(req)
		r.sockets.add(ws)
		ws.addEventListener("close", () => r.sockets.delete(ws))
		r.sync.link(socket(ws))
		return response
	}

	return {
		handler,
		async close() {
			await Promise.allSettled(rooms.values())
			for (const [n, r] of loaded) free(n, r)
			await Promise.all(closing.values())
		},
		get open() {
			return rooms.size
		},
	}
}

if (import.meta.main) {
	const galaxy = createGalaxy({ dir: Deno.env.get("DIR") ?? "./tippet-data" })
	Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8090) }, galaxy.handler)
}
