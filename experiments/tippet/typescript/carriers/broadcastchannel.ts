// a link over a BroadcastChannel: every tab (or worker) on one origin that opens the same name. one
// link reaches all of them, so it is many
//
//   a.link(bus("pigs")); b.link(bus("pigs"))
import type { Link } from "../sync.ts"

export function bus(name: string): Link {
	const ch = new BroadcastChannel(name)
	return {
		send: (b) => ch.postMessage(b),
		onMessage(fn) {
			ch.onmessage = (e) => e.data instanceof Uint8Array && fn(e.data)
		},
		close: () => ch.close(),
		many: true,
	}
}
