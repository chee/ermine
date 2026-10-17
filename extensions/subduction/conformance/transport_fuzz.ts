// Writes fuzzed transport scenarios to subduction-transport/
// 50-fuzz-NN.json: a random history (forks, merges, two signers) put to one device out of order,
// as loose commits and fragments, some commits never put, some put with the wrong parents, some
// with a broken seal; pumps between. The expected answers are not worked out by hand: they are what
// the reference harness answered when the scenarios were written (a golden run). So they pin
// that every implementation, and every later version of one, ends where that run ended: same heads,
// same waiting, refused and stuck, same fragments.
// Each commit's value is drawn from its own stream (so the history's shape is the seed's either way):
// a number, or text and map keys with emoji, a skin-toned emoji (two code points) and NUL (lone
// surrogates have no encoding, so no blop holds one).
//   deno run -A extensions/subduction/conformance/transport_fuzz.ts [seeds = 24] [folder]
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { encode, name } from "@ermine/encoding/blop"
import * as cbor from "@ermine/encoding/cbor"
import { seal, stored } from "@ermine/subduction/seal"
import { id } from "@ermine/subduction/id"

const here = new URL(".", import.meta.url).pathname
const out = Deno.args[1] ? `${Deno.args[1].replace(/\/$/, "")}/` : `${here}subduction-transport/`
const harness = [
	"deno",
	"run",
	"--quiet",
	"--allow-env",
	"--allow-read",
	`${here}../typescript/transport_harness.ts`,
]
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const DOC = id("unlocked", Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i))

type Dev = { name: string; secret: Uint8Array; key: Uint8Array }
const dev = (name: string, n: number): Dev => {
	const secret = new Uint8Array(32).fill(n)
	return { name, secret, key: ed25519.getPublicKey(secret) }
}
const A = dev("a", 1), B = dev("b", 2)

// mulberry32
function random(seed: number) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Blop = { parents: Blop[]; lamport: number; name: string; sealed: Uint8Array; stored: string }
let nonces = 0

const STRINGS = ["", "a", "😀", "👍🏽", "a\u0000b", "\u0000", "é👍🏽x"]
const KEYS = ["x", "😀", "👍🏽", "\u0000", ""]
// a commit's value: its nonce (as the scenarios first were), a string, or a map of strings
function valueOf(r: () => number, n: number): unknown {
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
	const roll = r()
	if (roll < 0.4) return n
	if (roll < 0.7) return pick(STRINGS) + pick(STRINGS)
	return Object.fromEntries([pick(KEYS), pick(KEYS)].map((k) => [k, pick(STRINGS)]))
}

// deep: the stored id starts with a zero byte (a fragment's head), or must not
async function mk(
	by: Dev,
	parents: Blop[],
	deep: boolean,
	value: (n: number) => unknown,
): Promise<Blop> {
	const lamport = 1 + Math.max(0, ...parents.map((p) => p.lamport))
	for (;;) {
		const nonce = new Uint8Array(8)
		new DataView(nonce.buffer).setUint32(0, ++nonces)
		const bytes = encode({
			node: DOC,
			object: "value",
			actor: by.name,
			signer: by.key,
			nonce,
			parents: parents.map((p) => unhex(p.name)).sort((x, y) => hex(x) < hex(y) ? -1 : 1),
			...(parents.length >= 2 ? { base: unhex(parents[0].name) } : {}),
			lamport,
			patches: [{ path: [], value: value(nonces) }] as never,
		})
		const sealed = await seal(bytes, {
			key: by.key,
			sign: (m) => Promise.resolve(ed25519.sign(m, by.secret)),
		})
		const s = stored(sealed)
		if ((s[0] === 0) !== deep) continue
		return { parents, lamport, name: hex(name(bytes)), sealed, stored: hex(s) }
	}
}

async function scenario(seed: number) {
	const r = random(seed)
	const values = random(seed ^ 0x5157)
	const value = (n: number) => valueOf(values, n)
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]
	const shuffle = <T>(xs: T[]) => {
		for (let i = xs.length - 1; i > 0; i--) {
			const j = Math.floor(r() * (i + 1))
			;[xs[i], xs[j]] = [xs[j], xs[i]]
		}
		return xs
	}
	// the history: each blop on one or two earlier ones (a merge), now and then a head of its own
	const n = 12 + Math.floor(r() * 24)
	const blops: Blop[] = []
	const heads = new Set<Blop>()
	for (let i = 0; i < n; i++) {
		let parents: Blop[] = []
		if (blops.length) {
			const roll = r()
			if (roll < 0.15 && heads.size > 1) parents = shuffle([...heads]).slice(0, 2)
			else if (roll < 0.35) parents = [pick(blops)]
			else parents = [pick([...heads])]
		}
		const b = await mk(r() < 0.3 ? B : A, parents, r() < 0.12, value)
		for (const p of parents) heads.delete(p)
		heads.add(b)
		blops.push(b)
	}
	const steps: Record<string, unknown>[] = [
		{ op: "reset" },
		{ op: "device", name: "a", seed: hex(A.secret) },
		{ op: "follow", device: "a", doc: DOC },
	]
	const put = (b: Blop, parents = b.parents.map((p) => p.stored), blob = b.sealed) =>
		steps.push({ op: "put", device: "a", doc: DOC, head: b.stored, parents, blob: hex(blob) })
	const fragment = (h: Blop, members: Blop[]) =>
		steps.push({
			op: "putfragment",
			device: "a",
			doc: DOC,
			head: h.stored,
			boundary: [],
			checkpoints: [],
			blob: hex(cbor.encode(shuffle([...members]).map((m) => m.sealed))),
		})
	// what is put, in which order: each blop once, loose or in a fragment under a deep one (its
	// ancestors with it, back a few steps), never, with the wrong parents, or with a broken seal
	const order: (() => void)[] = []
	const inFragment = new Set<Blop>()
	for (const h of blops) {
		if (h.stored.slice(0, 2) !== "00" || r() < 0.3) continue
		const members = [h]
		for (let at = h; at.parents.length && r() < 0.8;) {
			at = pick(at.parents)
			if (!members.includes(at)) members.push(at)
		}
		for (const m of members) inFragment.add(m)
		order.push(() => fragment(h, members))
	}
	for (const b of blops) {
		if (inFragment.has(b) && r() < 0.7) continue
		const roll = r()
		if (roll < 0.08) continue
		if (roll < 0.14) {
			order.push(() => put(b, [...b.parents.map((p) => p.stored), "77".repeat(32)]))
		} else if (roll < 0.2) {
			const broken = b.sealed.slice()
			broken[broken.length - 1 - Math.floor(r() * 64)] ^= 1
			order.push(() => put(b, undefined, broken))
		} else order.push(() => put(b))
	}
	for (const f of shuffle(order)) {
		f()
		if (r() < 0.2) steps.push({ op: "pump" })
	}
	steps.push({ op: "pump" })
	steps.push({ op: "state", device: "a", doc: DOC })
	steps.push({ op: "fragments", device: "a", doc: DOC })
	return steps
}

async function answers(requests: Record<string, unknown>[]): Promise<unknown[]> {
	const child = new Deno.Command(harness[0], {
		args: harness.slice(1),
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((x) => JSON.stringify(x)).join("\n") + "\n"))
	await w.close()
	const lines = new TextDecoder().decode((await output).stdout).trim().split("\n")
	return lines.filter((l) => l).map((l) => JSON.parse(l))
}

const count = Number(Deno.args[0] ?? 24)
for (let seed = 1; seed <= count; seed++) {
	const requests = await scenario(seed)
	const got = await answers(requests)
	if (got.length !== requests.length) throw new Error(`seed ${seed}: an answer per request`)
	const file = `${out}50-fuzz-${String(seed).padStart(2, "0")}.json`
	const title = `fuzz seed ${seed}: ${
		requests.filter((x) => x.op === "put" || x.op === "putfragment").length
	} puts out of order; ends where the golden run ended`
	await Deno.writeTextFile(
		file,
		JSON.stringify({
			title,
			steps: requests.map((request, i) => ({ ...request, expect: got[i] })),
		}) + "\n",
	)
}
console.log(`wrote ${count} fuzz scenarios`)
