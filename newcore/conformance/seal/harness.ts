// The reference seal.ts on the line protocol: one JSON request per line in, one answer per line
// out, in order. Bytes are lowercase hex. Another implementation joins by speaking this.
//   {op: "seal", blop, seed}: the host's signer made from the 32-byte Ed25519 seed, its sign a
//     Promise (SEAL.tex); {bytes} or {code}
//   {op: "unseal", bytes}: {blop, name, stored, signer} or {code}; blop the blop's bytes, the
//     decoded blop encoded again by blop.ts (canonical, so the bytes sealed)
//   {op: "stored", bytes}: {stored}
// {code} for a SealError
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { encode } from "../../encoding/ts/blop.ts"
import { seal, SealError, stored, unseal } from "../../sync/ts/seal.ts"

type Request = { op: string; blop?: string; seed?: string; bytes?: string }

const hex = (b: Uint8Array | ArrayBuffer) =>
	Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function signer(seed: Uint8Array) {
	return {
		key: ed25519.getPublicKey(seed),
		sign: (message: Uint8Array) => Promise.resolve(ed25519.sign(message, seed)),
	}
}

async function answer(r: Request): Promise<unknown> {
	try {
		switch (r.op) {
			case "seal":
				return { bytes: hex(await seal(unhex(r.blop!), signer(unhex(r.seed!)))) }
			case "unseal": {
				const u = unseal(unhex(r.bytes!))
				return {
					blop: hex(encode(u.blop)),
					name: hex(u.name),
					stored: hex(u.stored),
					signer: hex(u.signer),
				}
			}
			case "stored":
				return { stored: hex(stored(unhex(r.bytes!))) }
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		if (e instanceof SealError) return { code: e.code }
		throw e
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const l = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (l.trim() === "") continue
		text += JSON.stringify(await answer(JSON.parse(l))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
