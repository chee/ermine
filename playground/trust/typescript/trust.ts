// trust: whether to believe what a session signed. the installs trusted are a value: a map from an
// install's id to what is said of it ({ name } and the like). where it comes from is the caller's: a
// node's value (an authorized_keys node, as one idea to try), the host's own list, a file. this only
// reads the value given. which question: do I believe this
//
//   trusted(keys, { session, install, vouch }, message, signature, ed25519)
//   // true: install is in keys, it vouched for session (sessions' vouched), and session signed message
//
// what a session signs, and how it is carried, is whoever signs it's: a history's write, a message.
// this checks the three things and nothing else: no domain is added to message, and an install in
// keys may vouch for any number of sessions
import { bytes, kind } from "@ermine/ids"
import { type Verifying, vouched } from "@ermine/sessions"

export type Claim = {
	// the session's id (its key's), its install's id, the install's vouch for it
	readonly session: string
	readonly install: string
	readonly vouch: Uint8Array
}

// keys: the trusted value; anything not a map trusts no one
export async function trusted(
	keys: unknown,
	claim: Claim,
	message: Uint8Array,
	signature: Uint8Array,
	ed: Verifying,
): Promise<boolean> {
	if (!isMap(keys) || !Object.hasOwn(keys, claim.install)) return false
	if (kind(claim.session) !== "key") return false
	if (!(await vouched({ id: claim.session, install: claim.install, vouch: claim.vouch }, ed))) {
		return false
	}
	// a key id: ed 01, then the key's 32 bytes
	return await ed.verify(bytes(claim.session)!.subarray(2), message, signature)
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)
