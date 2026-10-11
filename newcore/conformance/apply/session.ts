// The line protocol the apply and commit harnesses speak: one JSON request per line in, one
// answer per line out, in order. Values in their JSON form (../pack/form.ts): a blop's byte fields
// and a change's signer {"/": {"bytes": b64}}; names lowercase hex (64 digits); an object as
// BLOP.tex writes it. A session starts at create; a later create starts a new one (a scenario
// with two devices has a session for each, in turn).
//   {op: "create", node}            -> {}; createChains(node, check), check APPLY.tex's
//   {op: "add", blop, name}         -> what add answers (CHAIN.tex): "taken", "passed",
//                                      {waiting: [names]}, {stuck: [names]}, {refused: code}
//   {op: "side", name}              -> {side} | {none: true}: side(chains, name), name its bytes
//   {op: "versions", object, times} -> [{content, change, because}]: versions(chains, object,
//                                      time), time(name) times[name], name as hex
//   {op: "commit", change, at, roots, random} -> {blop} | {code}  (commit harness only)
//        change: {node, object, patches, header, signer}; header with time; signer bytes(32)
//        at: {version: i} | {span: [from, to]} | {pop: i | [from, to]}; given to commit as
//            i, [from, to], or {pop: i | [from, to]} (PLACES.tex's slotindex)
//        roots: the source roots, strings
//        random: hex; random(n) hands out its next n bytes, in order
//        a live value, which JSON cannot hold: {"$live": kind} in the change (harness.ts of commit/);
//        the blop has {"/": {"live": kind}}, a stand-in, there. An implementation with no live
//        values skips those scenarios (COMMIT_SKIP)
//        a refusal: an error with code, answered {code}
// Another implementation joins by speaking this.
import { createChains } from "../../sync/ts/chain.ts"
import * as apply from "../../sync/ts/apply.ts"
import { fromJson, line, toJson } from "../pack/form.ts"

export type Request = Record<string, unknown> & { op: string }

export const hex = (b: Uint8Array | string) =>
	typeof b === "string" ? b : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the byte fields are Uint8Array in the API (BLOP.tex); the JSON form's bytes are ArrayBuffers
const FIELDS = ["signer", "nonce", "base"]
const map = (b: unknown, f: (x: ArrayBuffer | Uint8Array) => unknown) =>
	b instanceof ArrayBuffer || b instanceof Uint8Array ? f(b) : b
function convert(blop: unknown, f: (x: ArrayBuffer | Uint8Array) => unknown): unknown {
	if (typeof blop !== "object" || blop === null || Array.isArray(blop)) return blop
	const o: Record<string, unknown> = { ...blop }
	for (const k of FIELDS) if (k in o) o[k] = map(o[k], f)
	if (Array.isArray(o.parents)) o.parents = o.parents.map((p) => map(p, f))
	return o
}
export const toArray = (b: ArrayBuffer | Uint8Array) =>
	b instanceof ArrayBuffer ? new Uint8Array(b) : b
const toBuffer = (b: ArrayBuffer | Uint8Array) => b instanceof Uint8Array ? b.slice().buffer : b
export const blopIn = (j: unknown) => convert(fromJson(j), toArray) as never
export const blopOut = (b: unknown) => toJson(convert(b, toBuffer))

// deno-lint-ignore no-explicit-any
export type Chains = any
export const state: { chains: Chains } = { chains: undefined }

export function answer(r: Request): unknown {
	switch (r.op) {
		case "create":
			state.chains = createChains(r.node as string, apply.check)
			return {}
		case "add":
			return state.chains.add(blopIn(r.blop), unhex(r.name as string))
		case "side": {
			const s = apply.side(state.chains, unhex(r.name as string))
			return s === undefined ? { none: true } : { side: toJson(s) }
		}
		case "versions": {
			const times = r.times as Record<string, number>
			return toJson(
				apply.versions(state.chains, fromJson(r.object) as never, (n: string) => times[n]),
			)
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

export async function serve(answer: (r: Request) => unknown) {
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
			text += line(answer(JSON.parse(l))) + "\n"
		}
		if (text) await out.write(encoder.encode(text))
	}
}
