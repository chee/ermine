// Feasibility: two Subduction devices in one process over an in-memory pipe (TRANSPORT.tex).
//   deno run --allow-read --allow-env conformance/transport/probe.ts
// A commit added on a crosses to b, seen by b's storage's saveCommit; b unlinked, a commit on a
// does not cross; relinked, it does; an ephemeral message published on a is heard on b.
import * as sd from "npm:@automerge/subduction@0.23.0"

// a pipe end: what one side sends, the other receives, in order
function pipe() {
	type End = sd.Transport & { peer?: End; queue: Uint8Array[]; waiting: ((b: Uint8Array) => void)[] }
	const make = (): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				const other = end.peer!
				const w = other.waiting.shift()
				if (w) w(bytes.slice())
				else other.queue.push(bytes.slice())
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				return b ? Promise.resolve(b) : new Promise((r) => end.waiting.push(r))
			},
			disconnect: () => Promise.resolve(),
			onDisconnect() {},
		}
		return end
	}
	const a = make(), b = make()
	a.peer = b, b.peer = a
	return [a, b] as const
}

const saved: string[] = []
function device(name: string, seed: number) {
	const memory = new sd.MemoryStorage()
	const storage = new Proxy(memory, {
		get(t, k) {
			const f = (t as unknown as Record<string | symbol, unknown>)[k]
			if (typeof f !== "function") return f
			if (k === "saveCommit") {
				return (tree: sd.SedimentreeId, id: sd.CommitId, s: sd.SignedLooseCommit, blob: Uint8Array) => {
					saved.push(`${name} ${id.toHexString().slice(0, 8)} ${new TextDecoder().decode(blob)}`)
					return memory.saveCommit(tree, id, s, blob)
				}
			}
			if (k === "saveBatchAll") {
				return (tree: sd.SedimentreeId, cs: { commitId: sd.CommitId; blob: Uint8Array }[], fs: unknown[]) => {
					for (const c of cs) saved.push(`${name} ${c.commitId.toHexString().slice(0, 8)} ${new TextDecoder().decode(c.blob)} (batch)`)
					if (fs.length) saved.push(`${name} ${fs.length} fragments (batch)`)
					return memory.saveBatchAll(tree, cs, fs)
				}
			}
			return f.bind(t)
		},
	}) as unknown as sd.SedimentreeStorage
	const signer = sd.MemorySigner.fromBytes(new Uint8Array(32).fill(seed))
	const heard: string[] = []
	const s = new sd.Subduction({
		signer,
		storage,
		onEphemeral: (...args: unknown[]) => heard.push(JSON.stringify(args.map(String))),
	})
	return { s, signer, heard }
}

const a = device("a", 1), b = device("b", 2)
const tree = sd.SedimentreeId.fromBytes(new Uint8Array(32).fill(7))
const topic = sd.Topic.fromBytes(new Uint8Array(32).fill(7))
const id = (n: number) => new sd.CommitId(new Uint8Array(32).fill(n))

async function link() {
	const [x, y] = pipe()
	const [pa, pb] = await Promise.all([
		a.s.connectTransport(x, "ermine"),
		b.s.acceptTransport(y, "ermine"),
	])
	return { pa, pb }
}

// subscribed before any link: a later link carries the subscription
await a.s.subscribeEphemeral([topic])
await b.s.subscribeEphemeral([topic])
let { pa, pb } = await link()
console.log("linked:", pa.toString().slice(0, 12), pb.toString().slice(0, 12))
await a.s.syncWithAllPeers(tree, true)
await b.s.syncWithAllPeers(tree, true)

await a.s.addCommit(tree, id(1), [], new TextEncoder().encode("one"))
await new Promise((r) => setTimeout(r, 50))
console.log("after one:", saved)

console.log("disc", await a.s.disconnectFromPeer(pa), await b.s.disconnectFromPeer(pb))
console.log("peers", (await a.s.getConnectedPeerIds()).length, (await b.s.getConnectedPeerIds()).length)
await a.s.addCommit(tree, id(2), [id(1)], new TextEncoder().encode("two"))
await new Promise((r) => setTimeout(r, 50))
console.log("offline:", saved)

;({ pa, pb } = await link())
console.log("peers", (await a.s.getConnectedPeerIds()).length, (await b.s.getConnectedPeerIds()).length)
const r = await b.s.syncWithAllPeers(tree, true, 2000)
for (const e of r.entries()) console.log(e.success, e.stats.commitsReceived, e.stats.commitsSent, e.stats.remoteHeads.map((h) => h.toHexString().slice(0, 8)), e.transportErrors.map(String))
await new Promise((r) => setTimeout(r, 50))
console.log("relinked:", saved)

await a.s.publishEphemeral(topic, new TextEncoder().encode("hi"))
await new Promise((r) => setTimeout(r, 50))
console.log("heard on b:", b.heard, "on a:", a.heard)
Deno.exit(0)
