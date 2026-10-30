// A link over a websocket, either end. Sends wait until it is open. A run goes once less than MORE
// is unsent (wait); past QUEUE unsent (one message whole, however big), a send throws, and sync
// drops the link and closes it.
import type { Link } from "../sync.ts"

const MORE = 1024 * 1024, QUEUE = 8 * 1024 * 1024, EVERY = 50

export function socket(ws: WebSocket): Link {
	ws.binaryType = "arraybuffer"
	const waiting: Uint8Array[] = []
	let held = 0
	ws.addEventListener("open", () => {
		for (const b of waiting.splice(0)) ws.send(b)
		held = 0
	})
	// bytes sent but not yet gone: those before it opens, then the socket's own
	const unsent = () => ws.readyState === ws.CONNECTING ? held : ws.bufferedAmount
	return {
		send(b) {
			// one message at least, however big
			const now = unsent()
			if (now && now + b.length > QUEUE) throw new Error("too much unsent")
			if (ws.readyState === ws.CONNECTING) waiting.push(b), held += b.length
			else ws.send(b)
		},
		onMessage(fn) {
			ws.addEventListener("message", (e) => {
				if (e.data instanceof ArrayBuffer) fn(new Uint8Array(e.data))
			})
		},
		onClose(fn) {
			ws.addEventListener("close", () => fn())
		},
		close: () => ws.close(),
		// no drain event: looked at every EVERY ms; closed, at once
		wait: () =>
			new Promise<void>((r) => {
				const look = () =>
					unsent() < MORE || ws.readyState >= ws.CLOSING ? r() : void setTimeout(look, EVERY)
				look()
			}),
	}
}
