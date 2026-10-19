// a presence Channel over a Subduction device's ephemeral messages: the connection the device
// already has. each message sealed by the signer (seal.ts's sealMessage), so its sender is the key
// that signed it whatever connection carried it (a littlesync gateway publishes for its devices).
// name: the signer's key as lowercase hex, which is how a receiver names the sender's rows. what
// arrives unsealed, badly sealed, or sealed by this signer is dropped. sends go in order, and what
// arrives is told in order (sealing and checking are async)
import type { Channel } from "@ermine/presence/channel"
import { hex } from "./hex.ts"
import { openMessage, sealMessage, type Signer } from "./seal.ts"
import type { Device } from "./transport.ts"

export function createChannel(device: Pick<Device, "send" | "listen">, signer: Signer): Channel {
	const name = hex(signer.key)
	let sending: Promise<unknown> = Promise.resolve()
	return {
		name,
		// ephemeral: a send that fails (no peer, a closed connection, a topic too long) is lost, as any
		// would be
		send: (topic, bytes) => {
			const sealed = sealMessage(topic, bytes, signer)
			sealed.catch(() => {})
			sending = sending.then(() => sealed).then((s) => device.send(topic, s)).catch(() => {})
		},
		on: (topic, fn) => {
			let told: Promise<unknown> = Promise.resolve()
			return device.listen(topic, (_, bytes) => {
				const opened = openMessage(bytes, topic)
				opened.catch(() => {})
				told = told.then(() => opened).then((m) => {
					const from = hex(m.signer)
					if (from !== name) fn(from, m.bytes)
				}).catch(() => {})
			})
		},
	}
}
