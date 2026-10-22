// links over unix domain sockets, for processes on one machine (deno). each message is a frame: its
// length as 4 bytes, big-endian, then its bytes
//
//   const server = listen("/tmp/pigs.sock", (link) => a.link(link))
//   b.link(await connect("/tmp/pigs.sock"))
//   server.close()   // its links closed, the socket file removed
import type { Link } from "../sync.ts"

// the biggest frame read: a longer one ends the link
const most = 64 * 1024 * 1024

// a connection as a link. it reads once something listens; a later listener takes its place
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
			// closed already
		}
		for (const f of closes) f()
	}
	// fill buf from the connection; false: it ended first
	async function fill(buf: Uint8Array) {
		for (let at = 0; at < buf.length;) {
			const n = await conn.read(buf.subarray(at))
			if (n === null) return false
			at += n
		}
		return true
	}
	// each frame: its length, then one buffer of that size
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
			// the socket broke, or was closed here
		}
		end()
	}
	return {
		send(b) {
			if (!open) throw new Error("closed")
			const frame = new Uint8Array(4 + b.length)
			new DataView(frame.buffer).setUint32(0, b.length)
			frame.set(b, 4)
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

// a socket at path; each connection made to it, a link
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
			// closed
		}
	})()
	return {
		close() {
			try {
				listener.close()
			} catch {
				// closed already
			}
			for (const l of links) l.close!()
			try {
				Deno.removeSync(path)
			} catch {
				// gone already
			}
		},
	}
}

// a link to the socket at path
export const connect = async (path: string): Promise<Link> =>
	framed(await Deno.connect({ transport: "unix", path }))
