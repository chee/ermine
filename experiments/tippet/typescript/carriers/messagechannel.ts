// a link over a MessagePort: a worker, an iframe, or two syncs in one page
//
//   const { port1, port2 } = new MessageChannel()
//   a.link(port(port1)); b.link(port(port2))
import type { Link } from "../sync.ts"

export function port(p: MessagePort): Link {
	return {
		send: (b) => p.postMessage(b),
		onMessage(fn) {
			p.onmessage = (e) => e.data instanceof Uint8Array && fn(e.data)
		},
		close: () => p.close(),
	}
}
