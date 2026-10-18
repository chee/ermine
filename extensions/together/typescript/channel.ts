// a presence Channel over a Subduction device's ephemeral messages: the connection the device
// already has. name: the key as lowercase hex, which is how a receiver names the sender's rows
import type { Channel } from "@ermine/presence/channel"
import type { Device } from "./transport.ts"

export function createChannel(device: Pick<Device, "send" | "listen">, key: Uint8Array): Channel {
	const name = Array.from(key, (x) => x.toString(16).padStart(2, "0")).join("")
	return {
		name,
		// ephemeral: a send that fails (no peer, a closed connection) is lost, as any would be
		send: (topic, bytes) => void device.send(topic, bytes).catch(() => {}),
		on: (topic, fn) => device.listen(topic, fn),
	}
}
