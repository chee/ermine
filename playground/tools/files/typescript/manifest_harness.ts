// manifest (manifest.ts) on the line protocol (conformance/typescript/harness.ts). Values in their
// JSON form (conformance/typescript/form.ts); bytes and hashes lowercase hex; a node as the pack
// harness shows it ({id, value, info, children, header},
// in a list {"symbol": name} a symbol). Records and frames are lists of [key, bytes], bytes null
// for a key that goes; answers list them sorted by the key's UTF-8.
// Errors: {code: "store"} for a StoreError, {code: "form"} for a FormError, {code: "wrong-form"}
// for render given a value not in that form.
//   values
//   {op: "form", value}                 -> {form}
//   {op: "render", value, form}         -> {bytes}
//   {op: "parse", bytes, form}          -> {value}
//   {op: "hash", value}                 -> {hash}
//   {op: "digest", bytes}               -> {hash}
//   {op: "null"}                        -> {hash}: NULL
//   node records
//   {op: "kept", value}                 -> {kept: [hash, form]}: keptOf
//   {op: "save", node, without?, live?} -> {record, values: [[hash, value]], shape}, values
//     sorted by hash; without: the ids save's skip says yes to; live: paths into node (["value", 2,
//     "content"], ["info", 0, 1, 0, "change"], ["header", "actor"]) whose value is made live,
//     one with no encoding
//   {op: "kepts", record}               -> {kepts: [[hash, form]]}
//   {op: "restore", record, values}     -> {node}; values [[hash, value]]
//   {op: "shape", record, heads}        -> {shape}; heads [[hash, bytes]]
//     a shape: {kept, head?, sides: [[hash, form, head?]], info: [[name, hash, form]],
//     directory: [[name, [ids]]]}
//   records
//   {op: "encode", codec, record}       -> {bytes}; codec meta | shown | plan | state, the
//     record as the TS type, hashes hex, a layout's entries a map {name: stem | [stems]}
//   {op: "decode", codec, bytes}        -> {record}, the same
//   {op: "named", records}              -> {hashes}, sorted
//   the folder: one manifest at a time, made by open; paths in answers are from dir, "." itself
//   {op: "open", dir?, slack?}          -> {}: manifest(dir), touching nothing. No dir: <temp>/.ermine,
//     which does not exist yet, <temp> a folder of the harness's own, the same for every open of
//     the run and removed when the requests end
//   {op: "make"} | {op: "exists"}       -> {} | {exists}
//   {op: "read"}                        -> {records}
//   {op: "append", frame}               -> {synced: [paths]}, each path sync was given, in order
//   {op: "grown"}                       -> {grown}
//   {op: "fold", records}               -> {synced}
//   {op: "put", value, hash?}           -> {kept, synced}
//   {op: "get", hash, form}             -> {value}
//   {op: "write", path, bytes, append?} -> {}: raw bytes at a path from dir, its folders made
//   {op: "files"}                       -> {folders: [paths], files: [[path, bytes]]}, all
//     under dir, sorted
// Anything else thrown answers {error: message}, which no scenario expects.
// Another implementation joins by speaking this (HARNESS).
import createNode, {
	type ChangeHeader as Header,
	type List,
	type Node,
	type Side as Version,
} from "./saved.ts"
import * as m from "./manifest.ts"
import type { Sys } from "./sys.ts"
import { FormError, StoreError } from "./types.ts"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

type V = Version<unknown, unknown>
type N = Node<unknown, unknown>
type Shown = {
	id: string
	value: V[]
	info: [string, V[]][]
	children: [string, V[]][]
	header: Header
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const utf8 = new TextEncoder()
function bytewise(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
	return x.length - y.length
}
const byKey = (a: [string, unknown], b: [string, unknown]) => bytewise(a[0], b[0])

// nodes, as the pack harness shows them
const symbol = (e: unknown): string | symbol =>
	typeof e === "object" && e !== null && "symbol" in e ? Symbol.for(String(e.symbol)) : String(e)
const unsymbol = (e: unknown) => typeof e === "symbol" ? { symbol: Symbol.keyFor(e) } : e
const versions = (vs: V[], content: (c: unknown) => unknown): V[] =>
	vs.map((v) => {
		const out: V = { content: content(v.content), change: fromJson(v.change) }
		if ("because" in v) out.because = fromJson(v.because)
		return out
	})
const header = (h: Header, f: (x: unknown) => unknown): Header => {
	const out: Header = { ...h }
	if ("actor" in h) out.actor = f(h.actor)
	if ("cause" in h) out.cause = f(h.cause)
	return out
}
// the node's fields as values, still shaped as shown, so live paths reach into it
const inflate = (s: Shown): Shown => ({
	id: s.id,
	value: versions(s.value, fromJson),
	info: s.info.map(([name, vs]) => [name, versions(vs, fromJson)]),
	children: s.children.map((
		[name, vs],
	) => [name, versions(vs, (c) => (c as unknown[]).map(symbol))]),
	header: header(s.header, fromJson),
})
const node = (s: Shown): N =>
	createNode(s.id, {
		value: s.value,
		attributes: s.info,
		children: s.children as [string, Version<List, unknown>[]][],
	}, { header: s.header })
const json = (vs: V[], content: (c: unknown) => unknown): V[] =>
	vs.map((v) => {
		const out: V = { content: content(v.content), change: toJson(v.change) }
		if ("because" in v) out.because = toJson(v.because)
		return out
	})
const show = (n: N): Shown => ({
	id: n.id,
	value: json(n.value, toJson),
	info: [...n.attributes].map(([name, vs]) => [name, json(vs, toJson)]),
	children: [...n.children].map((
		[name, vs],
	) => [name, json(vs as V[], (c) => (c as unknown[]).map(unsymbol))]),
	header: header(n.change, toJson),
})
function live(s: Shown, path: (string | number)[]) {
	// deno-lint-ignore no-explicit-any
	let at: any = s
	for (const k of path.slice(0, -1)) at = at[k]
	at[path[path.length - 1]] = () => {}
}

const shape = (x: ReturnType<typeof m.shape>) => {
	const out: Record<string, unknown> = {
		kept: x.kept,
		sides: x.sides.map(([h, f, head]) => head ? [h, f, hex(head)] : [h, f]),
		info: x.info,
		directory: [...x.directory],
	}
	if (x.head) out.head = hex(x.head)
	return out
}

// records in and out of their JSON form
const records = (list: [string, string][]) =>
	new Map(list.map(([k, v]) => [k, unhex(v)] as [string, Uint8Array]))
const listed = (r: ReadonlyMap<string, Uint8Array>) =>
	[...r].map(([k, v]) => [k, hex(v)] as [string, string]).sort(byKey)

// deno-lint-ignore no-explicit-any
const CODECS: Record<string, m.Codec<any>> = {
	meta: m.meta,
	shown: m.shown,
	plan: m.plan,
	state: m.state,
}
// a layout's entries are a Map in the API, a map here
const recordIn = (codec: string, x: Record<string, unknown>) =>
	codec === "shown" && x.entries ? { ...x, entries: new Map(Object.entries(x.entries)) } : x
const recordOut = (codec: string, x: Record<string, unknown>) =>
	codec === "shown" && x.entries
		? { ...x, entries: Object.fromEntries(x.entries as Map<string, unknown>) }
		: x

// the folder
let dir = ""
// the run's own temp folder, made at the first open given no dir
let temp: string | undefined
let man: m.Manifest | undefined
let synced: string[] = []
const from = (path: string) => path === dir ? "." : path.slice(dir.length + 1)
const sys = {
	sync: (path: string) => {
		synced.push(from(path))
		return Promise.resolve()
	},
} as Sys
const took = () => {
	const s = synced
	synced = []
	return s
}

async function walk(
	at: string,
	rel: string,
	out: { folders: string[]; files: [string, string][] },
) {
	for await (const e of Deno.readDir(at)) {
		const p = rel ? `${rel}/${e.name}` : e.name
		if (e.isDirectory) {
			out.folders.push(p)
			await walk(`${at}/${e.name}`, p, out)
		} else out.files.push([p, hex(await Deno.readFile(`${at}/${e.name}`))])
	}
}

async function answer(r: Request): Promise<Answer> {
	try {
		switch (r.op) {
			case "form":
				return { form: m.form(fromJson(r.value) as never) }
			case "render":
				try {
					return { bytes: hex(m.render(fromJson(r.value) as never, r.form)) }
				} catch (e) {
					if (e instanceof StoreError || e instanceof FormError) throw e
					return { code: "wrong-form" }
				}
			case "parse":
				return { value: toJson(m.parse(unhex(r.bytes), r.form)) }
			case "hash":
				return { hash: m.hash(fromJson(r.value) as never) }
			case "digest":
				return { hash: m.digest(unhex(r.bytes)) }
			case "null":
				return { hash: m.NULL }
			case "kept":
				return { kept: m.keptOf(fromJson(r.value)) }
			case "save": {
				const s = inflate(r.node)
				for (const p of r.live ?? []) live(s, p)
				const skip = new Set<string>(r.without ?? [])
				const out = m.save(node(s), (id) => skip.has(id))
				return {
					record: hex(out.record),
					values: [...out.values].map(([h, v]) => [h, toJson(v)]).sort((a, b) =>
						bytewise(a[0] as string, b[0] as string)
					),
					shape: shape(out.shape),
				}
			}
			case "kepts":
				return { kepts: m.kepts(unhex(r.record)) }
			case "restore": {
				const values = new Map<string, unknown>(
					(r.values as [string, unknown][]).map(([h, v]) => [h, fromJson(v)]),
				)
				const n = m.restore(unhex(r.record), (h) => {
					if (!values.has(h)) throw new StoreError(`no value ${h}`)
					return values.get(h) as never
				})
				return { node: show(n) }
			}
			case "shape": {
				const heads = new Map((r.heads as [string, string][]).map(([h, b]) => [h, unhex(b)]))
				return { shape: shape(m.shape(unhex(r.record), (h) => heads.get(h))) }
			}
			case "encode":
				return { bytes: hex(CODECS[r.codec].encode(recordIn(r.codec, r.record))) }
			case "decode":
				return { record: recordOut(r.codec, CODECS[r.codec].decode(unhex(r.bytes))) }
			case "named":
				return { hashes: [...m.named(records(r.records))].sort() }
			case "open":
				if (typeof r.dir === "string") dir = r.dir
				else dir = `${temp ??= await Deno.realPath(await Deno.makeTempDir())}/.ermine`
				synced = []
				man = m.manifest(dir, sys, r.slack === undefined ? {} : { slack: r.slack })
				return {}
			case "make":
				await man!.make()
				return {}
			case "exists":
				return { exists: await man!.exists() }
			case "read":
				return { records: listed(await man!.read()) }
			case "append":
				took()
				await man!.append(
					new Map(
						(r.frame as [string, string | null][]).map((
							[k, v],
						) => [k, v === null ? null : unhex(v)]),
					),
				)
				return { synced: took() }
			case "grown":
				return { grown: man!.grown() }
			case "fold":
				took()
				await man!.fold(records(r.records))
				return { synced: took() }
			case "put": {
				took()
				const kept = await man!.put(fromJson(r.value) as never, r.hash)
				return { kept, synced: took() }
			}
			case "get":
				return { value: toJson(await man!.get(r.hash, r.form)) }
			case "write": {
				const path = `${dir}/${r.path}`
				await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
				await Deno.writeFile(path, unhex(r.bytes), { append: r.append ?? false })
				return {}
			}
			case "files": {
				const out = { folders: [] as string[], files: [] as [string, string][] }
				await walk(dir, "", out)
				out.folders.sort(bytewise)
				out.files.sort(byKey)
				return out
			}
			default:
				return { error: `unknown op ${r.op}` }
		}
	} catch (e) {
		took()
		if (e instanceof StoreError) return { code: "store" }
		if (e instanceof FormError) return { code: "form" }
		// anything else is the harness's or the implementation's fault: shown, not fatal
		return { error: String(e) }
	}
}

if (import.meta.main) {
	try {
		await serve(answer)
	} finally {
		if (temp) await Deno.remove(temp, { recursive: true })
	}
}
