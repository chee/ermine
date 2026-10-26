// trust (trust.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. installs and sessions are named: the install named N has secret BLAKE3(N's UTF-8), its id
// its key's (as sessions' harness); a session is started of an install by name
//
// { op: "session", name, install }       -> {}   a session of the install named, named name
// { op: "keys", value }                  -> {}   the trusted node's value: a map's keys that name an
//    install are that install's id; anything else as it is
// { op: "check", session, message, signed?, signer?, as?, from? } -> { trusted }
//    message: a string, its UTF-8 checked; signed: what was signed instead (none: message), by the
//    session named signer (none: session); the claim
//    is session's, with as: the install named as instead of its own, from: the vouch of the session
//    named from instead of its own
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { blake3 } from "@ermine/core/blake3"
import * as ed25519 from "@ermine/core/ed25519"
import { text } from "@ermine/ids"
import { type Session, startSession } from "@ermine/sessions"
import { trusted } from "./trust.ts"

const installs = new Map<string, { id: string; secret: Uint8Array }>()
async function install(name: string) {
	let i = installs.get(name)
	if (i === undefined) {
		const secret = blake3(new TextEncoder().encode(name))
		const key = await ed25519.publicKeyOf(secret)
		installs.set(name, i = { id: text(Uint8Array.of(0xed, 0x01, ...key))!, secret })
	}
	return i
}
const sessions = new Map<string, Session>()
const session = (name: unknown) => {
	const s = sessions.get(String(name))
	if (s === undefined) throw new Error(`no session ${name}`)
	return s
}
let keys: unknown = undefined

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

export async function answer(r: Request): Promise<Record<string, unknown>> {
	switch (r.op) {
		case "session":
			sessions.set(String(r.name), await startSession(await install(String(r.install)), ed25519))
			return {}
		case "keys": {
			if (!isMap(r.value)) {
				keys = r.value
				return {}
			}
			const named: Record<string, unknown> = {}
			for (const [k, v] of Object.entries(r.value)) {
				named[installs.has(k) ? installs.get(k)!.id : k] = v
			}
			keys = named
			return {}
		}
		case "check": {
			const s = session(r.session)
			const signer = r.signer === undefined ? s : session(r.signer)
			const message = new TextEncoder().encode(String(r.message))
			const signed = r.signed === undefined
				? message
				: new TextEncoder().encode(String(r.signed))
			const signature = await ed25519.sign(signer.secret, signed)
			const claim = {
				session: s.id,
				install: r.as === undefined ? s.install : (await install(String(r.as))).id,
				vouch: r.from === undefined ? s.vouch : session(r.from).vouch,
			}
			return { trusted: await trusted(keys, claim, message, signature, ed25519) }
		}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
