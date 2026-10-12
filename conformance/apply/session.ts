// The line protocol the apply and commit harnesses speak: one JSON request per line in, one
// answer per line out, in order. Values in their JSON form (../pack/form.ts): a blop's byte fields
// and a change's signer {"/": {"bytes": b64}}; names lowercase hex (64 digits); an object as
// BLOP.tex writes it. A session starts at create; a later create starts a new one (a scenario
// with two devices has a session for each, in turn).
//   {op: "create", node}            -> {}; createHistories(node, check), check APPLY.tex's
//   {op: "add", blop, name}         -> what add answers (HISTORY.tex): "taken", "passed",
//                                      {waiting: [names]}, {stuck: [names]}, {refused: code}
//   {op: "side", name}              -> {side} | {none: true}: side(histories, name), name its bytes
//   {op: "versions", object, times} -> [{content, change, because}]: versions(histories, object,
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
import { createHistories } from "@ermine/subduction/history"
import * as apply from "@ermine/subduction/apply"
import { fromJson, line, toJson } from "../pack/form.ts"

export type Request = Record<string, unknown> & { op: string }

export const hex = (b: Uint8Array | string) =>
	typeof b === "string" ? b : Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the byte fields Uint8Arrays, in the API (BLOP.tex) and in the JSON form (form.ts)
export const blopIn = (j: unknown) => fromJson(j) as never
export const blopOut = (b: unknown) => toJson(b)

// deno-lint-ignore no-explicit-any
export type Histories = any
export const state: { histories: Histories } = { histories: undefined }

export function answer(r: Request): unknown {
	switch (r.op) {
		case "create":
			state.histories = createHistories(r.node as string, apply.check)
			return {}
		case "add":
			return state.histories.add(blopIn(r.blop), unhex(r.name as string))
		case "side": {
			const s = apply.side(state.histories, unhex(r.name as string))
			return s === undefined ? { none: true } : { side: toJson(s) }
		}
		case "versions": {
			const times = r.times as Record<string, number>
			return toJson(
				apply.versions(state.histories, fromJson(r.object) as never, (n: string) => times[n]),
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
