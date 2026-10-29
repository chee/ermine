// cbor.ts on the line protocol (conformance/typescript/harness.ts): nothing lasts
// between lines. another implementation joins by speaking this (HARNESS; c/cbor_harness.c).
// a value: its JSON form (conformance/typescript/form.ts), lone surrogates taken; bytes lowercase hex
//
// { op: "encode", value } → { bytes }          or { error: "no-encoding" | "not-a-form" }
// { op: "decode", bytes } → { value, again }   or { error: "not-an-encoding" }
//                                                again: the value encoded again, hex
import { CborError, decode, encode, type Value } from "./cbor.ts"
import { FormError, revive, toJson } from "../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../conformance/typescript/harness.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: unknown) =>
	typeof s === "string" && /^([0-9a-f]{2})*$/.test(s)
		? Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
		: undefined

export function answer(r: Request): Answer {
	switch (r.op) {
		case "encode": {
			let v: Value
			try {
				v = revive(r.value) as Value
			} catch (e) {
				if (e instanceof FormError) return { error: "not-a-form" }
				throw e
			}
			try {
				return { bytes: hex(encode(v)) }
			} catch (e) {
				if (e instanceof CborError) return { error: "no-encoding" }
				throw e
			}
		}
		case "decode": {
			const b = unhex(r.bytes)
			if (!b) return { error: "not-hex" }
			try {
				const v = decode(b)
				return { value: toJson(v), again: hex(encode(v)) }
			} catch (e) {
				if (e instanceof CborError) return { error: "not-an-encoding" }
				throw e
			}
		}
	}
	return { error: `unknown op ${r.op}` }
}

if (import.meta.main) await serve(answer)
