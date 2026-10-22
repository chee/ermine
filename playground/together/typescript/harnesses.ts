// what the sync harnesses share (playground/together/conformance/README.md): the commits a harness
// makes from a request, each under a label, its fields from the request or their defaults, its
// parents and base by label; tables as JSON; in-memory pipes
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import { type Commit, compare, encode, name as nameOf } from "@ermine/formats/commit"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import type { Request } from "../../../conformance/typescript/harness.ts"
import { hex, unhex } from "../../encoding/typescript/commit_harness.ts"
import type { Tables } from "./replay.ts"
import { createSigner, seal, type Signer } from "./seal.ts"

export type Made = {
	label: string
	commit: Commit
	bytes: Uint8Array
	name: Uint8Array
	signer: Signer
}

// a commit's fields a request may give; each one left out has its default
const FIELDS = [
	"table",
	"actor",
	"reader",
	"external",
	"metadata",
	"time",
	"seed",
	"nonce",
	"parents",
	"base",
	"merge",
	"lamport",
	"patches",
] as const
export const SEED = "01".repeat(32)
const NAME = /^[0-9a-f]{68}$/

export function createCommits() {
	const byLabel = new Map<string, Made>()
	const labels = new Map<string, string>()
	const signers = new Map<string, Promise<Signer>>()

	const signer = (seed: string) => {
		let s = signers.get(seed)
		if (!s) signers.set(seed, s = createSigner(unhex(seed)))
		return s
	}
	// a label made here, else a name as 68 hex digits
	function resolve(x: unknown): Uint8Array {
		if (typeof x !== "string") throw new Error(`not a label or a name: ${x}`)
		const m = byLabel.get(x)
		if (m) return m.name
		if (NAME.test(x)) return unhex(x)
		throw new Error(`no commit ${x}`)
	}
	const lamportOf = (name: Uint8Array) => byLabel.get(labels.get(hex(name)) ?? "")?.commit.lamport

	// whether the request gives any of a commit's fields
	const gives = (r: Request) => FIELDS.some((k) => k in r)

	// the commit the request says, made under its label (r.name). made already: that one
	async function make(r: Request): Promise<Made> {
		const label = r.name
		if (typeof label !== "string") throw new Error("a commit needs a label: name")
		const was = byLabel.get(label)
		if (was) {
			if (gives(r)) throw new Error(`${label} is made already`)
			return was
		}
		const s = await signer(r.seed ?? SEED)
		const parents = (r.parents ?? []).map(resolve).sort(compare)
		const c: Commit = {
			table: r.table ?? "value",
			actor: "actor" in r ? revive(r.actor) : null,
			time: r.time ?? 0,
			signer: s.key,
			nonce: r.nonce ?? 0,
			parents,
			lamport: r.lamport ??
				1 + Math.max(0, ...parents.map((p: Uint8Array) => lamportOf(p) ?? 0)),
			// replaces: labels or names (68 hex digits), sorted
			patches: (r.patches ?? []).map((p: Request) => {
				const out = revive(p) as Commit["patches"][number]
				if (Array.isArray(p.replaces)) {
					out.replaces = p.replaces.map((x: unknown) =>
						typeof x === "string" ? resolve(x) : revive(x) as Uint8Array
					).sort(compare)
				}
				return out
			}),
		}
		if (r.reader !== undefined) c.reader = r.reader
		if (r.external !== undefined) c.external = r.external
		if (r.metadata !== undefined) c.metadata = revive(r.metadata) as Commit["metadata"]
		if (r.base !== undefined) c.base = resolve(r.base)
		if (r.merge !== undefined) c.merge = r.merge
		const bytes = encode(c)
		const made = { label, commit: c, bytes, name: nameOf(bytes), signer: s }
		byLabel.set(label, made)
		if (!labels.has(hex(made.name))) labels.set(hex(made.name), label)
		return made
	}

	return {
		make,
		gives,
		get: (label: string) => byLabel.get(label),
		// a label or a name (68 hex digits), to its name
		name: resolve,
		// a name, to its label (or its hex)
		label: (name: Uint8Array | string) => {
			const h = typeof name === "string" ? name : hex(name)
			return labels.get(h) ?? h
		},
		// the made commit, sealed by its seed's signer for a document (its id)
		sealed: (m: Made, doc: string) =>
			seal(m.bytes, m.signer, doc, { commit: m.commit, name: m.name }),
	}
}
export type Commits = ReturnType<typeof createCommits>

// tables as JSON: each entry's value and change, nothing else
export function tablesJson(t: Tables): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [table, e] of Object.entries(t)) {
		out[table] = { value: toJson(e.value), change: toJson(e.change) }
	}
	return out
}

// a pipe: what one end sends the other receives, in order, while it is open; cut, nothing more
// crosses and a receive waiting is told so. moved: every message sent on any pipe, so a harness
// knows when nothing crosses
export const pipes = { moved: 0 }
type Waiting = { take(b: Uint8Array): void; fail(e: Error): void }
type End = Transport & { other?: End; queue: Uint8Array[]; waiting: Waiting[] }
export function pipe(): { ends: [Transport, Transport]; cut(): void } {
	let open = true
	const cut = () => {
		open = false
		for (const e of [a, b]) for (const w of e.waiting.splice(0)) w.fail(new Error("cut"))
	}
	const make = (): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				if (!open) return Promise.reject(new Error("cut"))
				pipes.moved++
				const o = end.other!, w = o.waiting.shift()
				if (w) w.take(bytes.slice())
				else o.queue.push(bytes.slice())
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				if (b) return Promise.resolve(b)
				if (!open) return Promise.reject(new Error("cut"))
				return new Promise((take, fail) => end.waiting.push({ take, fail }))
			},
			disconnect() {
				cut()
				return Promise.resolve()
			},
			onDisconnect() {},
		}
		return end
	}
	const a = make(), b = make()
	a.other = b, b.other = a
	return { ends: [a, b], cut }
}

// every one idle, and no message crossing for five rounds
export async function quiet(idle: () => Promise<unknown>) {
	let still = 0, last = -1
	for (let round = 0; round < 3000; round++) {
		await idle()
		await new Promise((r) => setTimeout(r, 2))
		if (pipes.moved === last) {
			if (++still >= 5) return
		} else still = 0, last = pipes.moved
	}
	throw new Error("never quiet")
}
