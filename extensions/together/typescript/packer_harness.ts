// packer_harness: packer.ts on the line protocol (harness.ts). one process: commits by label, each sealed
// by its seed's signer; packs packed by label. conventions: extensions/together/conformance/README.md
//
// { op: "make", name, ...fields }      → {}            made, labelled, sealed (default document:
//                                                      2a × 16 then 00 × 16)
// { op: "sealed", commit }             → { sealed }    hex
// { op: "pack", commits, name? }       → { run }       commits: labels, hex sealed bytes, or
//                                                      { vouched: label, stored? }; name: kept so
// { op: "unpack", run, set?, drop? }   → { sealed }    run: label or hex; set/drop: columns
//                                                      changed, then canonically encoded. sealed:
//                                                      labels (hex if unmade), vouched ones as
//                                                      { vouched: label | hex, stored? }
// { op: "unpack", value }              → { sealed }    value canonically encoded first
// { op: "columns", run }               → { columns }   JSON form
// refused: { error: code, column? } (PackError)
import * as cbor from "@ermine/encoding/cbor"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hex, unhex } from "../../../ermine/encoding/typescript/commit_harness.ts"
import { createCommits } from "./harnesses.ts"
import { type Member, pack, PackError, unpack } from "./packer.ts"
import { stored } from "./seal.ts"
import { docOf } from "./seal_harness.ts"

const commits = createCommits()
// sealed bytes by label, and labels by sealed bytes
const seals = new Map<string, Uint8Array>()
const sealedLabels = new Map<string, string>()
const runs = new Map<string, Uint8Array>()

function sealedOf(x: unknown): Uint8Array {
	if (typeof x !== "string") throw new Error(`not a commit: ${x}`)
	const s = seals.get(x)
	if (s) return s
	if (commits.get(x)) throw new Error(`${x} is not sealed`)
	return unhex(x)
}
const runOf = (x: unknown) => typeof x === "string" && runs.get(x) || unhex(x as string)

function edited(r: Request): Uint8Array {
	if (r.value !== undefined) return cbor.encode(revive(r.value) as cbor.Value)
	const bytes = runOf(r.run)
	if (r.set === undefined && r.drop === undefined) return bytes
	const o = { ...(cbor.decode(bytes) as Record<string, cbor.Value>) }
	for (const [k, v] of Object.entries(r.set ?? {})) o[k] = revive(v) as cbor.Value
	for (const k of r.drop ?? []) delete o[k]
	return cbor.encode(o)
}

async function answer(r: Request): Promise<Answer> {
	try {
		switch (r.op) {
			case "make": {
				const m = await commits.make(r)
				const s = await commits.sealed(m, docOf({}))
				seals.set(m.label, s)
				if (!sealedLabels.has(hex(s))) sealedLabels.set(hex(s), m.label)
				return {}
			}
			case "sealed":
				return { sealed: hex(sealedOf(r.commit)) }
			case "pack": {
				const members: Member[] = []
				for (const c of r.commits) {
					if (c === null || typeof c !== "object") members.push(sealedOf(c))
					else {
						const m = commits.get(c.vouched)
						if (!m) throw new Error(`no commit ${c.vouched}`)
						const id = c.stored !== undefined ? unhex(c.stored) : stored(sealedOf(c.vouched))
						members.push({ commit: m.bytes, stored: id })
					}
				}
				const run = pack(members)
				if (typeof r.name === "string") runs.set(r.name, run)
				return { run: hex(run) }
			}
			case "unpack":
				return {
					sealed: unpack(edited(r)).map((u) => {
						if (u.sealed !== undefined) {
							return sealedLabels.get(hex(u.sealed)) ?? hex(u.sealed)
						}
						const label = commits.label(u.name), s = seals.get(label)
						return s !== undefined && hex(stored(s)) === hex(u.stored)
							? { vouched: label }
							: { vouched: label, stored: hex(u.stored) }
					}),
				}
			case "columns":
				return { columns: toJson(cbor.decode(runOf(r.run))) }
		}
	} catch (e) {
		if (e instanceof PackError) {
			return e.column === undefined ? { error: e.code } : { error: e.code, column: e.column }
		}
		throw e
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) await serve(answer)
