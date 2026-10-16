// program.ts: "ermine:program", a program node's processes and its compile,
// as an editor shows them (CLOADER.md, The editor). A process is found by the
// node it runs, never by a window: the host writes on each process's node its
// info ermine.program.load (loader.c), whose program is the id of the node its
// finder found; the processes looked for are those in the program's folder,
// where an editor's Run starts one.
//
//   needs(api, address)            what the program at address says it needs (its provisions)
//   processes(api, address)        the processes running it: [{id, name, address, status, value, said, failed,
//                                  handlers, load}]; failed, how its last part failed (js/wasm.ts), if it has said
//                                  nothing since
//   diagnostics(api, load)         its compile's, from the cache's leaf: [{level, message, line?, column?, file?}]
//   compiled(load, diagnostics, line?)   the compile in words: {text, tone}, the error on line first; null if none
//   state(process, stopped?)       the process in words: {text, tone}
//
// tone: ok, bad, warn, dim or ink.

import { first, isStatus, val } from "./kit.ts"
import type { Api } from "./kit.ts"

type Item = { id: string; node?: unknown; versions?: { content: unknown }[] }
type Info = Api & { info(address: readonly string[], name: string): Item[] }
// deno-lint-ignore no-explicit-any
type Any = any
export type Diagnostic = {
	level: string
	message: string
	line?: number
	column?: number
	file?: string
}
export type Load = {
	program?: string
	needs?: string[]
	compile?: "compiling" | "compiled" | "cached" | "failed"
	leaf?: string
	bytes?: number
	ms?: number
	errors?: number
	warnings?: number
	waits?: string
}
export type Process = {
	id: string
	name: string
	address: string[]
	status: Any
	value: unknown
	said: string[]
	failed: string | null
	handlers: string[]
	load: Load
}

export const PROVISIONS = "ermine.program.provisions"
export const LOAD = "ermine.program.load"

/** an info's value: the first item with versions, its first */
const infoOf = (api: Info, address: readonly string[], name: string): Any =>
	api.info(address, name).find((i) => i.versions?.length)?.versions?.[0].content

/** what the program at address needs: its provisions' needs */
export function needs(api: Api, address: readonly string[]): string[] {
	try {
		const p = infoOf(api as Info, address, PROVISIONS)
		return Array.isArray(p?.needs) ? p.needs.filter((n: unknown) => typeof n === "string") : []
	} catch {
		return []
	}
}

/** the processes in the program's folder whose load says they run its node; each with what an editor shows of it */
export function processes(api: Api, address: readonly string[]): Process[] {
	const folder = address.slice(0, -1)
	const node = api.look(address).find((i) => i.node)?.id
	if (!node) return []
	const out: Process[] = []
	for (const name of api.children(folder) as string[]) {
		try {
			for (const it of (api as Info).info([...folder, name], LOAD)) {
				const load = it.versions?.[0]?.content as Load | undefined
				if (load?.program !== node) continue
				const at = [...folder, name]
				const item = api.content(at).find((i) => i.id === it.id) as Item | undefined
				const versions = item?.versions as Any[] | undefined
				const said = val<unknown>(api, [...at, "log"])
				const failed = val<unknown>(api, [...at, "failed"])
				const on = (api.children([...at, "on"]) as string[]).filter((n) =>
					!n.startsWith("timer.")
				)
				out.push({
					id: it.id,
					name,
					address: at,
					status: versions?.find(isStatus)?.content ?? null,
					value: first(versions) ?? null,
					said: Array.isArray(said) ? said.filter((l) => typeof l === "string") : [],
					failed: typeof failed === "string" ? failed : null,
					handlers: on,
					load,
				})
			}
		} catch {
			// refused, or gone while read: not one of its
		}
	}
	return out
}

/** the compile's diagnostics, from its leaf in the cache; none known, [] */
export function diagnostics(api: Api, load?: Load | null): Diagnostic[] {
	if (!load?.leaf) return []
	const leaf = val<Any>(api, ["/", "cache", "c", load.leaf])
	return Array.isArray(leaf?.diagnostics)
		? leaf.diagnostics.filter((d: Any) => typeof d?.message === "string")
		: []
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
/** where a diagnostic is, and what it says: 4:17 use of undeclared identifier 'helo' */
const said = (d: Diagnostic) =>
	`${d.file ? `${d.file}:` : ""}${d.line ? `${d.line}:${d.column ?? 0} ` : ""}${d.message}`

/** the compile in words: ok · 412 bytes · cached; 3 errors · 4:18 … (the error on line, else the first) */
export function compiled(load: Load | null | undefined, diags: Diagnostic[], line?: number) {
	if (!load?.compile) return null
	const pick = (level: string) => {
		const all = diags.filter((d) => d.level === level)
		return { n: all.length, at: all.find((d) => !d.file && d.line === line) ?? all[0] }
	}
	if (load.compile === "compiling") return { text: "compiling…", tone: "dim" }
	const errors = pick("error"), warnings = pick("warning")
	if (load.compile === "failed") {
		const n = errors.n || load.errors || 1
		return {
			text: `${plural(n, "error")}${errors.at ? ` · ${said(errors.at)}` : ""}`,
			tone: "bad",
		}
	}
	const how = load.compile === "cached" ? "cached" : `compiled in ${load.ms ?? 0} ms`
	const warned = warnings.n ? ` · ${plural(warnings.n, "warning")} · ${said(warnings.at!)}` : ""
	return {
		text: `ok · ${load.bytes ?? 0} bytes · ${how}${warned}`,
		tone: warnings.n ? "warn" : "ok",
	}
}

/** a value as the strip shows it: text as it is, anything else as JSON, short */
const shown = (v: unknown) => {
	let t: string
	try {
		t = typeof v === "string"
			? v
			: JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? `<${x.byteLength} bytes>` : x)) ??
				String(v)
	} catch {
		t = String(v)
	}
	return t.length > 60 ? t.slice(0, 60) + "…" : t
}

/** the process in words: running · its value · the last line it said; stopped; not running: why */
export function state(p: Process | null | undefined, stopped = false) {
	if (!p) return { text: stopped ? "stopped" : "not running", tone: "dim" }
	const st = p.status ?? {}
	const e = st.error
	if (e) {
		// a compile's errors are the first row's: here only that it did not compile
		const why = e.code === "not-a-program"
			? `not running: ${String(e.message).replace(/^(it did not compile):.*$/s, "$1")}`
			: e.code === "crashed"
			? e.message
			: `${e.code ?? e.name ?? "error"}: ${e.message}`
		return { text: why, tone: "bad" }
	}
	if ("pending" in st) {
		return { text: p.load.waits ? `waiting: ${p.load.waits}` : "starting…", tone: "dim" }
	}
	// a handler crashed: it runs on, its next part as it was
	if (p.failed) return { text: p.failed, tone: "bad" }
	const parts = ["running"]
	if (p.value !== null && p.value !== undefined) parts.push(shown(p.value))
	if (p.said.length) parts.push(`said ${p.said[p.said.length - 1]}`)
	// edited since it started: the new code waits for Run Again
	const fresh = st.new
	if (fresh && typeof fresh === "object" && "node" in fresh) {
		parts.push("Run Again runs the new code")
	} else if (fresh && typeof fresh === "object") parts.push("the new code did not compile")
	return { text: parts.join(" · "), tone: "ink" }
}
