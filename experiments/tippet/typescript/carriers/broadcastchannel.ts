// A link over a BroadcastChannel: one link reaches every tab on the origin with the same name, so
// it is many.
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
