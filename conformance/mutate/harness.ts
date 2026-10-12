// The reference mutate on the line protocol: one JSON request per line in, one answer per line
// out, in order. State lasts for the process: one node. Another implementation joins by speaking
// this (MUTATE_HARNESS).
//
// { op: "start", id?, value?, info? }  → {}      a fresh node (id default "a")
//    value: versions; info: [[name, versions]], in order
//    version: { content, change, because? }, all JSON
// { op: "node" }                       → { node: { id, value, info } }
// { op: "mutate", which, patches, header?, patched? }
//    which: "value" or ["info", name]; patches: JSON patches as notify.ts has them;
//    header: the change's (default { time: 1, actor: "me" })
//    → { change }, and, patched: true, { facts }: one Facts per patch, in order
//    → { fail: code, patch: i }    a MutateError; nothing changes
//
// Typed arrays in JSON: { "$Int8Array": [1, 2] } (Uint16, Int16, Uint32, Int32 too). An
// implementation without them skips those scenarios (MUTATE_SKIP). Bytes, a Uint8Array, as
// ENCODING.tex writes them: { "/": { "bytes": b64 } }.
// Anything not understood: { error }.
import { type Change } from "@ermine/graph/change"
import createNode, { type Node, type Version } from "@ermine/graph/node"
import mutate, { MutateError, type Which } from "@ermine/op/mutate"
import type { Facts, Patch } from "@ermine/scheduler/notify"
import { fromJson, toJson } from "../pack/form.ts"

// deno-lint-ignore no-explicit-any
type Request = Record<string, any>
type Json = unknown

const kinds = {
	Int8Array,
	Uint16Array,
	Int16Array,
	Uint32Array,
	Int32Array,
} as Record<string, new (a: number[]) => ArrayBufferView>

function revive(v: Json): Json {
	if (Array.isArray(v)) return v.map(revive)
	if (v !== null && typeof v === "object") {
		const keys = Object.keys(v)
		if (keys.length === 1 && keys[0].startsWith("$") && kinds[keys[0].slice(1)]) {
			return new kinds[keys[0].slice(1)]((v as Record<string, number[]>)[keys[0]])
		}
		const form = (v as Record<string, unknown>)["/"]
		if (keys.length === 1 && form !== null && typeof form === "object" && "bytes" in form) {
			return fromJson(v)
		}
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))
	}
	return v
}
function dehydrate(v: Json): Json {
	if (Array.isArray(v)) return v.map(dehydrate)
	if (v instanceof Uint8Array) return toJson(v)
	if (ArrayBuffer.isView(v)) return { ["$" + v.constructor.name]: [...(v as Int8Array)] }
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dehydrate(x)]))
	}
	return v
}

type V = { content: Json; change: Json; because?: Json }
// changes come as the scenario gives them
const versions = (vs: V[] = []) =>
	vs.map((v) => ({ ...v, content: revive(v.content) })) as Version<unknown, Change>[]
const dump = (vs: V[]) => vs.map((v) => ({ ...v, content: dehydrate(v.content) }))

let node: Node<unknown, Change> = createNode("a")

function answer(r: Request): Json {
	switch (r.op) {
		case "start":
			node = createNode<unknown, Change>(r.id ?? "a", {
				value: versions(r.value),
				info: (r.info ?? []).map(([k, vs]: [string, V[]]) => [k, versions(vs)]),
			})
			return {}
		case "node":
			return {
				node: {
					id: node.id,
					value: dump(node.value),
					info: [...node.info].map(([k, vs]) => [k, dump(vs)]),
				},
			}
		case "mutate": {
			const told: Facts[] = []
			const header = r.header ?? { time: 1, actor: "me" }
			const which = r.which as Which
			const patches = (r.patches as Patch[]).map((p) => revive(p) as Patch)
			const change = mutate(node, which, patches, {
				...header,
				...(r.patched ? { patched: (_p: Patch, f: Facts) => told.push(f) } : {}),
			})
			return r.patched ? { change, facts: told } : { change }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

function safe(r: Request): Json {
	try {
		return answer(r)
	} catch (e) {
		if (e instanceof MutateError) return { fail: e.code, patch: e.patch }
		return { error: String(e) }
	}
}

const out = Deno.stdout.writable.getWriter()
const encoder = new TextEncoder()
let buffer = ""
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	buffer += chunk
	let i
	let text = ""
	while ((i = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, i)
		buffer = buffer.slice(i + 1)
		if (line.trim() === "") continue
		text += JSON.stringify(safe(JSON.parse(line))) + "\n"
	}
	if (text) await out.write(encoder.encode(text))
}
