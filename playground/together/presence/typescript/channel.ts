// an ephemeral channel: bytes on a topic, to whoever listens, saved nowhere. generic: Subduction,
// iroh, a BroadcastChannel or pigeons can be one. a channel never says a peer left: "gone" comes
// from the rows' until, not from the transport. each channel has a name (its device); on is told
// the sender's name

export type Channel = {
	readonly name: string
	send: (topic: string, bytes: Uint8Array) => void
	// fn told each message on the topic from another channel; gives back the stop
	on: (topic: string, fn: (from: string, bytes: Uint8Array) => void) => () => void
}

type Listener = (from: string, bytes: Uint8Array) => void

function listeners() {
	const by = new Map<string, Set<Listener>>()
	return {
		add(topic: string, fn: Listener) {
			let s = by.get(topic)
			if (s === undefined) by.set(topic, s = new Set())
			s.add(fn)
			return () => void s.delete(fn)
		},
		tell(topic: string, from: string, bytes: Uint8Array) {
			for (const fn of [...(by.get(topic) ?? [])]) fn(from, bytes)
		},
	}
}

// two channels in one process, each sending to the other, at once. sent: every message, by sender
export function createPair(a = "a", b = "b"): {
	a: Channel
	b: Channel
	sent: { from: string; topic: string; bytes: Uint8Array }[]
} {
	const la = listeners(), lb = listeners()
	const sent: { from: string; topic: string; bytes: Uint8Array }[] = []
	return {
		sent,
		a: {
			name: a,
			send: (topic, bytes) => (sent.push({ from: a, topic, bytes }), lb.tell(topic, a, bytes)),
			on: la.add,
		},
		b: {
			name: b,
			send: (topic, bytes) => (sent.push({ from: b, topic, bytes }), la.tell(topic, b, bytes)),
			on: lb.add,
		},
	}
}

// a BroadcastChannel (browsers, deno): every channel of the same bus name, in any tab or worker,
// but not this one. name: this device's
export function createBroadcast(
	name: string,
	bus = "ermine-presence",
): Channel & { close: () => void } {
	const bc = new BroadcastChannel(bus)
	const l = listeners()
	bc.onmessage = (e: MessageEvent) => {
		const m = e.data as { from: string; topic: string; bytes: Uint8Array }
		if (m.from !== name) l.tell(m.topic, m.from, m.bytes)
	}
	return {
		name,
		send: (topic, bytes) => bc.postMessage({ from: name, topic, bytes }),
		on: l.add,
		close: () => bc.close(),
	}
}
