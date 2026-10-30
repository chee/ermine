// Links over unix domain sockets, for processes on one machine (deno). Each message is a frame as
// in http: its length as 4 bytes big-endian, then its bytes.
import type { Link } from "../sync.ts"
import { frames } from "./http.ts"

const most = 64 * 1024 * 1024

function framed(conn: Deno.Conn): Link {
	const closes: (() => void)[] = []
	let open = true, writing = Promise.resolve()
	let on: ((bytes: Uint8Array) => void) | undefined
	const end = () => {
		if (!open) return
		open = false
		try {
			conn.close()
		} catch {
		}
		for (const f of closes) f()
	}
	async function fill(buf: Uint8Array) {
		for (let at = 0; at < buf.length;) {
			const n = await conn.read(buf.subarray(at))
			if (n === null) return false
			at += n
		}
		return true
	}
	async function read() {
		const head = new Uint8Array(4)
		try {
			while (open && await fill(head)) {
				const size = new DataView(head.buffer).getUint32(0)
				if (size > most) break
				const bytes = new Uint8Array(size)
				if (!await fill(bytes)) break
				on!(bytes)
			}
		} catch {
		}
		end()
	}
	return {
		send(b) {
			if (!open) throw new Error("closed")
			const frame = frames([b])
			writing = writing.then(async () => {
				for (let at = 0; at < frame.length;) at += await conn.write(frame.subarray(at))
			}).catch(end)
		},
		onMessage(fn) {
			if (!on) void read()
			on = fn
		},
		onClose: (fn) => void closes.push(fn),
		close: end,
	}
}

export function listen(path: string, onLink: (link: Link) => void): { close(): void } {
	const listener = Deno.listen({ transport: "unix", path })
	const links = new Set<Link>()
	void (async () => {
		try {
			for await (const conn of listener) {
				const link = framed(conn)
				links.add(link)
				link.onClose!(() => links.delete(link))
				onLink(link)
			}
		} catch {
		}
	})()
	return {
		close() {
			try {
				listener.close()
			} catch {
			}
			for (const l of links) l.close!()
			try {
				Deno.removeSync(path)
			} catch {
			}
		},
	}
}

export const connect = async (path: string): Promise<Link> =>
	framed(await Deno.connect({ transport: "unix", path }))
