// the seal (seal.ts) on the line protocol (conformance/typescript/harness.ts). nothing lasts between
// lines. another implementation joins by speaking this (HARNESS). conventions:
// extensions/sync/conformance/README.md
//
// { op: "key", seed }               → { key }       the Ed25519 key of a 32-byte seed, as a
//                                                    multikey (0xed 0x01, then the 32 bytes)
// { op: "seal", seed, commit }      → { sealed }    commit: its bytes (hex), or a commit in JSON
//                                                    (encoded first); sealed by the seed's signer
// { op: "unseal", sealed }          → { commit, bytes, name, stored }   commit in JSON, bytes its
//                                                    bytes, name its name, stored the seal's id
// { op: "unseal", value }           → the same, the value (its JSON form) encoded canonically first
// { op: "stored", sealed }          → { stored }
// { op: "verify", key, message, signature } → { good }   the raw signature (64 bytes) the raw key's
//                                                    (32 bytes) over the message, checked strictly
// refused: { error: code }, SealError's code; a commit's own refusal as the commit harness gives it
import * as cbor from "@ermine/encoding/cbor"
import { encode } from "@ermine/encoding/commit"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import {
	commitOf,
	hex,
	jsonOf,
	refusal,
	unhex,
} from "../../../ermine/encoding/typescript/commit_harness.ts"
import { createSigner, good, seal, SealError, stored, unseal } from "./seal.ts"

// a commit's bytes: hex, or a commit in JSON encoded
export const commitBytes = (x: unknown) => typeof x === "string" ? unhex(x) : encode(commitOf(x))

// what a SealError (or CommitError) answers
export function sealRefusal(e: unknown): Answer {
	if (e instanceof SealError) return { error: e.code }
	return refusal(e)
}

async function answer(r: Request): Promise<Answer> {
	try {
		switch (r.op) {
			case "key":
				return { key: hex((await createSigner(unhex(r.seed))).key) }
			case "seal": {
				const signer = await createSigner(unhex(r.seed))
				return { sealed: hex(await seal(commitBytes(r.commit), signer)) }
			}
			case "unseal": {
				const sealed = r.value !== undefined
					? cbor.encode(revive(r.value) as cbor.Value)
					: unhex(r.sealed)
				const u = await unseal(sealed)
				return {
					commit: jsonOf(u.commit),
					bytes: hex(u.bytes),
					name: hex(u.name),
					stored: hex(u.stored),
				}
			}
			case "stored":
				return { stored: hex(stored(unhex(r.sealed))) }
			case "verify": {
				const key = unhex(r.key), signature = unhex(r.signature)
				const ok = key.length === 32 && signature.length === 64 &&
					await good(signature, key, unhex(r.message))
				return { good: ok }
			}
		}
	} catch (e) {
		return sealRefusal(e)
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) await serve(answer)
