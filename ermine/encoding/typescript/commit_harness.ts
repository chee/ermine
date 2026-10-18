// the commit (commit.ts) on the line protocol (conformance/typescript/harness.ts). nothing lasts
// between lines. another implementation joins by speaking this (HARNESS). conventions:
// extensions/together/conformance/README.md
//
// bytes: lowercase hex. a value (actor, metadata, a patch's value): its JSON form
// (conformance/typescript/form.ts), lone surrogates taken. a commit in JSON: its fields as commit.ts
// names them, signer, each parent and base as hex; a byte field given as anything but a string is
// passed on as its value (so encode can refuse it)
//
// { op: "encode", commit }        → { bytes, name }          commit: a commit in JSON, or any
//                                                              other value, to be refused
// { op: "decode", bytes }         → { commit, name }         bytes: hex
// { op: "decode", value }         → { commit, name }         value: a value, encoded canonically
//                                                              (cbor.ts) first
// { op: "compare", a, b }         → { order }                a, b: hex; order -1, 0 or 1
// refused: { error: code, field? }, CommitError's code and the field named
import { type Commit, CommitError, compare, decode, encode, name } from "./commit.ts"
import * as cbor from "./cbor.ts"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

export function hex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}
// lowercase hex only; anything else is not bytes
export function unhex(s: string): Uint8Array {
	if (typeof s !== "string" || !/^([0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`)
	return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
}

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
// a byte field: a string its hex, anything else the value it stands for
const bytesOr = (x: unknown) => typeof x === "string" ? unhex(x) : revive(x)

// a commit from its JSON form; not a map: the value it stands for
export function commitOf(x: unknown): Commit {
	if (!isMap(x)) return revive(x) as Commit
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(x)) {
		if (k === "signer" || k === "base") out[k] = bytesOr(v)
		else if (k === "parents") out[k] = Array.isArray(v) ? v.map(bytesOr) : revive(v)
		else out[k] = revive(v)
	}
	return out as Commit
}

// a commit's JSON form; names: how a parent or base is written (default hex)
export function jsonOf(
	c: Commit,
	names: (b: Uint8Array) => string = hex,
): Record<string, unknown> {
	const out: Record<string, unknown> = { table: c.table, actor: toJson(c.actor) }
	if (c.reader !== undefined) out.reader = c.reader
	if (c.external !== undefined) out.external = c.external
	if (c.metadata !== undefined) out.metadata = toJson(c.metadata)
	out.time = c.time
	out.signer = hex(c.signer)
	out.nonce = c.nonce
	out.parents = c.parents.map(names)
	if (c.base !== undefined) out.base = names(c.base)
	if (c.merge !== undefined) out.merge = c.merge
	out.lamport = c.lamport
	out.patches = toJson(c.patches)
	return out
}

export function refusal(e: unknown): Answer {
	if (e instanceof CommitError) {
		return e.field === undefined ? { error: e.code } : { error: e.code, field: e.field }
	}
	throw e
}

function answer(r: Request): Answer {
	try {
		switch (r.op) {
			case "encode": {
				const bytes = encode(commitOf(r.commit))
				return { bytes: hex(bytes), name: hex(name(bytes)) }
			}
			case "decode": {
				const bytes = r.value !== undefined
					? cbor.encode(revive(r.value) as cbor.Value)
					: unhex(r.bytes)
				return { commit: jsonOf(decode(bytes)), name: hex(name(bytes)) }
			}
			case "compare":
				return { order: Math.sign(compare(unhex(r.a), unhex(r.b))) }
		}
	} catch (e) {
		return refusal(e)
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) await serve(answer)
