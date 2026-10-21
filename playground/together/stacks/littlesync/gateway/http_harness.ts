// a TS device (link.ts) over HTTP sessions (http.ts), for tests
import { assertEquals } from "@std/assert"
import { encode as encodeCommit, name as nameOf } from "@ermine/encoding/commit"
import { createSigner, seal, type Signer } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import { type Message, peek as decodeSealed } from "./wire.ts"
import { Link } from "./link.ts"

// a device as an ESP32 would be one: one HTTP client, a POST each turn with what it has to say
// (often nothing), waiting up to wait ms for an answer when there is nothing to say
export async function httpDevice(base: string, o: { wait?: number } = {}) {
	const signer = await createSigner()
	const got: Message[] = []
	const link = new Link(signer.key, (m) => got.push(m))
	const session = hex(crypto.getRandomValues(new Uint8Array(8)))
	let running = true, nonce = 0, posts = 0
	const loop = (async () => {
		while (running) {
			link.tick(Date.now())
			const up = link.next()
			const r = await fetch(`${base}${session}?wait=${up.length ? 0 : o.wait ?? 300}`, {
				method: "POST",
				body: up as Uint8Array<ArrayBuffer>,
			})
			posts++
			assertEquals(r.status, 200)
			link.feed(new Uint8Array(await r.arrayBuffer()), Date.now())
		}
	})()
	return {
		signer,
		session,
		got,
		link,
		posts: () => posts,
		// the node named: its heads (none), so the gateway follows it for this device
		follow(id: string) {
			link.send({ t: "heads", node: id, heads: [] })
		},
		async commit(id: string, c: { parents: Uint8Array[]; lamport: number; patches: unknown[] }) {
			const bytes = encodeCommit({
				table: "value",
				actor: null,
				time: Math.floor(Date.now() / 1000),
				signer: signer.key,
				nonce: nonce++,
				...c,
			} as never)
			const node = id
			link.send({ t: "commits", node, sealed: [await seal(bytes, signer as Signer, node)] })
			return nameOf(bytes)
		},
		// commit names it was sent
		heard: () => got.flatMap((m) => m.t === "commits" ? m.sealed : []),
		async stop() {
			running = false
			await loop
		},
	}
}
export type HttpDevice = Awaited<ReturnType<typeof httpDevice>>

// the commit names in what a device was sent
export const names = (d: HttpDevice) =>
	new Set(
		d.heard().map((s) => {
			const c = decodeSealed(s)
			return c ? hex(nameOf(c)) : ""
		}),
	)
