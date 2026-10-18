// the seal (seal.ts) on the line protocol (conformance/typescript/harness.ts). nothing lasts between
// lines. another implementation joins by speaking this (HARNESS). conventions:
// extensions/sync/conformance/README.md
//
// { op: "key", seed }               → { key }       the Ed25519 key of a 32-byte seed, as a
//                                                    multikey (0xed 0x01, then the 32 bytes)
// { op: "seal", seed, commit, doc?, header? } → { sealed }   commit: its bytes (hex), or a commit in JSON
//                                                    (encoded first); sealed by the seed's signer for
//                                                    the document doc (32 bytes, hex; default
//                                                    2a × 16 then 00 × 16, the default document's),
//                                                    under the varsig header (hex; default Ed25519's)
// { op: "unseal", sealed, doc?, also? } → { commit, bytes, name, stored }   commit in JSON, bytes its
//                                                    bytes, name its name, stored the seal's id; also:
//                                                    more varsig headers (hex), each checked as Ed25519
// { op: "unseal", value, doc?, also? } → the same, the value (its JSON form) encoded canonically first
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
import { createSigner, ED25519, good, seal, SealError, stored, unseal } from "./seal.ts"

// the document a seal is for: the request's, else the default's 32 bytes
export const docOf = (r: Request) => unhex(r.doc ?? "2a".repeat(16) + "00".repeat(16))

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
				if (r.header !== undefined) signer.header = unhex(r.header)
				return { sealed: hex(await seal(commitBytes(r.commit), signer, docOf(r))) }
			}
			case "unseal": {
				const sealed = r.value !== undefined
					? cbor.encode(revive(r.value) as cbor.Value)
					: unhex(r.sealed)
				const more = (r.also ?? []).map((h: string) => ({
					header: unhex(h),
					code: ED25519,
					size: 64,
					verify: good,
				}))
				const u = await unseal(sealed, docOf(r), more)
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
