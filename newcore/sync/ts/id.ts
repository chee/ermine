// a shared node's id, which binds its lock (ID.tex): the BLAKE3 hash of "ermine/v0/id", the
// lock's name as a CBOR text string, and the 32 bytes its make gave; written ermine:// and hex
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "../../encoding/ts/cbor.ts"

export type Code = "name" | "size" | "not-an-id"

export class IdError extends Error {
	constructor(readonly code: Code) {
		super(code)
	}
}

const PREFIX = "ermine://"
const DOMAIN = new TextEncoder().encode("ermine/v0/id")
const FORM = /^ermine:\/\/[0-9a-f]{64}$/

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// the id of a lock's name and what its make gave; a name with no UTF-8 form first, then the size
export function id(lock: string, made: Uint8Array): string {
	if (typeof lock !== "string" || !lock.isWellFormed()) throw new IdError("name")
	if (!(made instanceof Uint8Array) || made.length !== 32) throw new IdError("size")
	const name = cbor.encode(lock)
	const all = new Uint8Array(DOMAIN.length + name.length + 32)
	all.set(DOMAIN)
	all.set(name, DOMAIN.length)
	all.set(made, DOMAIN.length + name.length)
	return PREFIX + hex(blake3(all))
}

// whether a string has this form; upper-case hex does not
export function is(id: string): boolean {
	return typeof id === "string" && FORM.test(id)
}

// its 32 bytes
export function bytes(id: string): Uint8Array {
	if (!is(id)) throw new IdError("not-an-id")
	const out = new Uint8Array(32)
	for (let i = 0; i < 32; i++) {
		out[i] = parseInt(id.slice(PREFIX.length + 2 * i, PREFIX.length + 2 * i + 2), 16)
	}
	return out
}
