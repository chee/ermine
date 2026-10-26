// the graphs an explorer (finder.tsx) can look at, the host's side. two, each a name:
//   page   this page's own ermine, read as the host. changes made anywhere but /code and /host
//          (changeable, below): the page's own programs are never changed from a click
//   mac    astrobleme's, over the relay: asks sent as { t: "applet", name: "graph", …, ask }; changes
//          signed (relay.signed), exactly as before. its answers come back through heard
// the explorer asks in graph.ts' words (src/graph.ts says them in full) and gets the same shapes
// back from either. what the host offers it, as actions of its own:
//   /host/graphs/<graph>/ask      (name, ask) → the ask's id
//   /host/graphs/<graph>/change   (name, change) → its id
//   /host/graphs/<graph>/copy     (name, text): onto the clipboard (asked in the click's own moment)
//   /host/graphs/<graph>/took     (name, n): the answers up to n read, out of the inbox
// what the host writes, as the host:
//   /host/graphs/<graph>/inbox/<name>   the answers not yet taken, in order: [{ n, m }]
//   /host/graphs/tick                   Date.now(), each second while an explorer shows
//   /host/graphs/now                    Date.now(), every 15 s (the "ago"s), likewise
import type { Ermine } from "@ermine/system"
import { PENDING } from "@ermine/core/scheduler"
import { SHOWING, shows } from "./places.ts"

export type GraphName = "page" | "mac"
export const GRAPHS: readonly GraphName[] = ["page", "mac"]
export const graphAt = (graph: GraphName) => `/host/graphs/${graph}`
export const inboxOf = (graph: GraphName, name: string) => `${graphAt(graph)}/inbox/${name}`
export const TICK = "/host/graphs/tick"
export const NOW = "/host/graphs/now"
const CHANGES = new Set(["write", "edit", "make", "move", "remove"])

// what the explorer may change in the page's own graph: anything but the page's programs (/code:
// their code, actions and bindings) and the host's (/host: what it offers them), and not the root
// itself (tippi's pick, 10-26: it was /page and /finder only, which walled off the page's data too).
// the host holds to it; the explorer says it
export const changeable = (path: string) =>
	typeof path === "string" && /^\/[^/]/.test(path) && !/^\/(code|host)(\/|$)/.test(path) &&
	!/\/\.\.?(\/|$)/.test(path)
export const CHANGEABLE_WORDS =
	"the page's programs (/code) and the host's (/host) can't be changed from here"

type Relay = { send(m: object): void; signed(m: object): Promise<void> }
// deno-lint-ignore no-explicit-any
type Any = any

export function connectGraphs(ermine: Ermine, relay: Relay): { heard(m: Any): void } {
	const set = (path: string, value: unknown) => {
		ermine.ensureNode(path)
		ermine.patch(path, [{ path: [], value }])
	}
	const now = <T>(path: string): T | undefined => ermine.peep(() => ermine.read(path) as T)
	// an answer for one explorer, in its inbox
	let told = 0
	const tell = (graph: GraphName, name: string, m: Any) => {
		const at = inboxOf(graph, name)
		const was = now<{ n: number; m: Any }[]>(at) ?? []
		set(at, [...was, { n: ++told, m }])
	}
	const named = (name: unknown): name is string =>
		typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/i.test(name)

	// the asks in flight to the mac: whose each one is
	let asked = 0
	const whose = new Map<string, string>()
	const macNames = new Set<string>()
	// every explorer that has asked anything, of either graph: the clocks run while one shows
	const explorers = new Set<string>()
	const page = pageGraph(ermine)

	for (const graph of GRAPHS) {
		const G = graphAt(graph)
		ermine.ensureNode(`${G}/inbox`)
		ermine.createAction(`${G}/ask`, (name: string, m: Any) => {
			if (!named(name)) throw new Error(`no explorer is called ${String(name)}`)
			explorers.add(name)
			ermine.ensureNode(inboxOf(graph, name), [])
			const ask = `x${++asked}`
			if (graph === "mac") {
				macNames.add(name)
				whose.set(ask, name)
				relay.send({ ...m, t: "applet", name: "graph", ask })
			} else {
				// answered after the ask returns, as the mac's are
				queueMicrotask(() => tell("page", name, page.ask({ ...m, ask })))
			}
			return ask
		})
		ermine.createAction(`${G}/change`, (name: string, m: Any) => {
			if (!named(name)) throw new Error(`no explorer is called ${String(name)}`)
			ermine.ensureNode(inboxOf(graph, name), [])
			const ask = `x${++asked}`
			if (graph === "mac") {
				macNames.add(name)
				whose.set(ask, name)
				// signed with the key that knocked; one that couldn't be: said where it was asked
				relay.signed({ ...m, t: "applet", name: "graph", ask }).catch((err) => {
					whose.delete(ask)
					tell("mac", name, {
						do: m?.do,
						ask,
						path: m?.path,
						error: String(err?.message ?? err),
					})
				})
			} else queueMicrotask(() => tell("page", name, page.change({ ...m, ask })))
			return ask
		})
		ermine.createAction(`${G}/took`, (name: string, n: number) => {
			if (!named(name)) return
			const at = inboxOf(graph, name)
			const was = now<{ n: number }[]>(at) ?? []
			const left = was.filter((x) => x.n > n)
			if (left.length !== was.length) set(at, left)
		})
		// the clipboard is the page's: written in the click's (or the key's) own moment
		ermine.createAction(`${G}/copy`, (name: string, text: string) => {
			if (!named(name)) return
			const done = navigator.clipboard?.writeText(String(text))
			if (!done) {
				return tell(graph, name, { do: "copy", error: "this browser won't let a page copy" })
			}
			done.then(
				() => tell(graph, name, { do: "copy", text: String(text) }),
				() => tell(graph, name, { do: "copy", error: "the browser wouldn't let me copy that" }),
			)
		})
	}

	// the clocks, only while the page is seen and an explorer shows (places.ts' shows: nobody
	// looking, nothing written, so nothing reads them again): a tick each second (the explorer asks
	// what changed on it), and the time every 15 s for the "ago"s, and at once when one comes back
	// into view
	set(TICK, Date.now())
	set(NOW, Date.now())
	let nowAt = Date.now(), seen = false
	setInterval(() => {
		const page = SHOWING.map((p) => now(p))
		const any = document.visibilityState === "visible" &&
			[...explorers].some((name) => shows(name, page))
		const back = any && !seen
		seen = any
		if (!any) return
		const t = Date.now()
		set(TICK, t)
		if (back || t - nowAt >= 15_000) set(NOW, nowAt = t)
	}, 1000)

	return {
		// an answer from the relay's graph applet: to the explorer that asked. an answer to no ask (the
		// graph not answering at all): to every explorer of the mac's
		heard(m: Any) {
			if (m?.name !== undefined && m.name !== "graph") return
			const name = typeof m?.ask === "string" ? whose.get(m.ask) : undefined
			if (name !== undefined) {
				whose.delete(m.ask)
				return tell("mac", name, m)
			}
			if (m?.ask === undefined && m?.error) {
				for (const n of macNames) tell("mac", n, { do: "said", error: String(m.error) })
			}
		},
	}
}

// ---- the page's own graph, answered as the mac's tippette graph host answers its own ----
const FULL = 20_000
const typeOf = (v: unknown): string =>
	v === undefined
		? "nothing"
		: v === null
		? "null"
		: typeof v === "function"
		? "function"
		: typeof v === "symbol"
		? "pending"
		: typeof v === "string"
		? "text"
		: typeof v === "bigint"
		? "bigint"
		: v instanceof Error
		? "error"
		: v instanceof Uint8Array
		? "bytes"
		: ArrayBuffer.isView(v)
		? "typed array"
		: Array.isArray(v)
		? "list"
		: typeof v === "object"
		? "record"
		: typeof v
const hexOf = (b: Uint8Array, most = 64) =>
	[...b.subarray(0, most)].map((x) => x.toString(16).padStart(2, "0")).join(" ") +
	(b.length > most ? " …" : "")
function textOf(v: unknown, indent = 2): string {
	if (typeof v === "string") return v
	if (typeof v === "function") return String(v)
	if (typeof v === "symbol") return v.description ?? "a symbol"
	if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`
	if (v instanceof Uint8Array) return `${v.length} bytes: ${hexOf(v, 4096)}`
	try {
		return JSON.stringify(
			v,
			(_k, x) =>
				typeof x === "function"
					? `ƒ ${x.name || "function"}`
					: typeof x === "symbol"
					? `<${x.description ?? "symbol"}>`
					: typeof x === "bigint"
					? `${x}n`
					: x instanceof Error
					? { error: x.message }
					: x instanceof Uint8Array
					? `<${x.length} bytes: ${hexOf(x)}>`
					: x instanceof Map
					? Object.fromEntries(x)
					: x instanceof Set
					? [...x]
					: x?.constructor?.name === "Handle"
					? "[node]"
					: x,
			indent,
		) ?? String(v)
	} catch {
		return String(v)
	}
}
const shown = (v: unknown, most = FULL) => {
	const text = textOf(v)
	return {
		type: typeOf(v),
		text: text.length > most ? text.slice(0, most) : text,
		size: text.length,
		...text.length > most && { cut: true },
	}
}
const brief = (v: unknown, most = 80) => {
	if (v === undefined) return undefined
	const t = typeof v === "function"
		? `ƒ ${(v as { name?: string }).name || "function"}`
		: textOf(v, 0).replace(/\s+/g, " ")
	return t.length > most ? t.slice(0, most - 1) + "…" : t
}
const PICTURES: [string, number[]][] = [
	["image/png", [0x89, 0x50, 0x4e, 0x47]],
	["image/jpeg", [0xff, 0xd8, 0xff]],
	["image/gif", [0x47, 0x49, 0x46, 0x38]],
]
function pictureOf(v: unknown) {
	if (!(v instanceof Uint8Array) || v.length > 2_000_000) return undefined
	const webp = v.length > 12 && String.fromCharCode(...v.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...v.subarray(8, 12)) === "WEBP"
	const type = webp ? "image/webp" : PICTURES.find(([, m]) => m.every((b, i) => v[i] === b))?.[0]
	if (!type) return undefined
	let bin = ""
	for (let i = 0; i < v.length; i += 0x8000) {
		bin += String.fromCharCode(...v.subarray(i, i + 0x8000))
	}
	return `data:${type};base64,${btoa(bin)}`
}
const kid = (p: string, name: string) => (p === "/" ? "" : p) + "/" + name
const parentOf = (p: string) => p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/"))
const pathOf = (path: readonly string[] | undefined) =>
	path === undefined ? undefined : "/" + path.join("/")
type Site = { file: string; line: number; column?: number; function?: string }
const siteOf = (s: Any): Site | undefined =>
	s ? { file: s.file, line: s.line, column: s.column, function: s.function } : undefined
const COMPUTER_SCOPE = "ermine.computer.scope"
type Part = "value" | "attributes" | "children"

export function pageGraph(ermine: Ermine) {
	// a place: a path from the root, or "#<id>" (a node no path reaches first)
	const target = (p: string): Any =>
		p.startsWith("#") ? ermine.handleOf({ id: p.slice(1), part: "value" }) : p
	const quiet = <T>(f: () => T, or: T): T => {
		try {
			return ermine.peep(f) ?? or
		} catch {
			return or
		}
	}
	// a value as read, a pending memo's as pending
	const valueAt = (p: string): unknown => {
		try {
			return ermine.peep(() => {
				try {
					return ermine.read(target(p))
				} catch (e) {
					if (e === PENDING) return PENDING
					throw e
				}
			})
		} catch (e) {
			return e
		}
	}
	const names = (p: string) => quiet(() => [...ermine.list(target(p))].sort(), [] as string[])
	const idOf = (p: string): { id?: string; ids: string[]; from?: string } => {
		if (p.startsWith("#")) return { id: p.slice(1), ids: [p.slice(1)], from: "id" }
		const items = quiet(() => ermine.readEntries(p), [])
		const ids = items.filter((i) => !i.refused && i.node)
			.map((i) => String(ermine.dataOf(i.node)?.node.id ?? ""))
			.filter(Boolean)
		return { id: ids[0], ids, from: items[0]?.from }
	}
	const entry = (part: Part, id: string | undefined): Any =>
		id === undefined ? undefined : ermine.table.get(part, id)
	// the version of a place: its changes and its names' changes, each change by its own number
	const numbers = new WeakMap<object, number>()
	let counted = 0
	const numbered = (c: unknown) => {
		if (typeof c !== "object" || c === null) return 0
		let n = numbers.get(c)
		if (n === undefined) numbers.set(c, n = ++counted)
		return n
	}
	const own = (id: string | undefined) =>
		(["value", "attributes", "children"] as const).map((part) =>
			numbered(entry(part, id)?.change)
		)
			.join(".")
	function version(p: string) {
		const { id } = idOf(p)
		let s = `${id ?? "-"}:${own(id)}`
		for (const n of names(p)) s += `|${n}:${own(idOf(kid(p, n)).id)}`
		let h = 2166136261
		for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
		return (h >>> 0).toString(36)
	}
	const changeOf = (c: Any) =>
		c === undefined ? undefined : {
			who: brief(c.actor, 200),
			when: c.time,
			where: (c.external ?? []).map(siteOf),
			metadata: c.metadata === undefined ? undefined : Object.fromEntries(
				Object.entries(c.metadata as Record<string, unknown>).map((
					[k, v],
				) => [k, brief(v, 200)]),
			),
		}
	// every place from the root, each node once (its first path), at most `most`
	function walk(most: number) {
		const out = new Map<string, string>()
		const queue = ["/"]
		const root = idOf("/").id
		if (root) out.set(root, "/")
		while (queue.length && out.size < most) {
			const p = queue.shift()!
			for (const name of names(p)) {
				const q = kid(p, name)
				const { id } = idOf(q)
				if (id === undefined || out.has(id)) continue
				out.set(id, q)
				queue.push(q)
			}
		}
		return out
	}
	const isComputer = (id: string) =>
		ermine.records.run(id) !== undefined ||
		COMPUTER_SCOPE in ((entry("attributes", id)?.value ?? {}) as object)
	const statusOf = (p: string) => {
		const st = quiet(() => ermine.getStatus(target(p)), undefined)
		// a plain node's done says nothing: only a computer's (one that has run), or anything not done
		if (
			st === undefined ||
			(st.state === "done" && st.n === undefined && Object.keys(st).length === 1)
		) {
			return undefined
		}
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(st)) {
			out[k] = k === "waiting"
				? (v as Any[]).map((w) =>
					typeof w === "string"
						? w
						: "node" in w
						? pathOf(w.node) ?? "a node outside"
						: "code" in w
						? `its code at ${pathOf(w.code)}`
						: "send" in w
						? `an action at ${pathOf(w.send) ?? "a place outside"}`
						: JSON.stringify(w)
				)
				: k === "state" || k === "n" || k === "phase" || typeof v === "string"
				? v
				: k === "error"
				? brief(v, 2000)
				: JSON.parse(textOf(v, 0) || "null")
		}
		return out
	}
	function whyOf(p: string, part: "value" | "attributes", where: () => Map<string, string>) {
		const e = quiet(
			() => part === "value" ? ermine.explain(target(p)) : ermine.explainAttributes(target(p)),
			undefined,
		)
		if (e === undefined) return undefined
		const held = e.held && { feature: e.held.feature }
		const w = e.writer
		if (w === undefined) return { held }
		const { id } = idOf(p)
		const m = entry(part, id)?.change?.metadata ?? {}
		const by = typeof m.node === "string" ? m.node : undefined
		if (w.kind === "computer") {
			return {
				kind: "run",
				computer: by ?? "",
				at: pathOf(w.path) ?? (by && where().get(by)),
				// its record gone (only the latest run's is kept): no number
				n: w.run?.n,
				reads: w.run?.reads.length ?? 0,
				writes: w.run?.writes.length ?? 0,
				held,
			}
		}
		if (w.kind === "method") {
			const h = typeof m.handler === "string" ? m.handler : ""
			return {
				kind: "call",
				handler: h,
				at: pathOf(w.path) ?? where().get(h),
				n: w.call?.n ?? "",
				held,
			}
		}
		return { kind: "outside", where: siteOf(w.site ?? e.change?.site), held }
	}
	function readersOf(id: string | undefined, all: Map<string, string>) {
		if (id === undefined) return []
		const out: { at: string; label: string; kind: "run" | "call"; n: number; part: string }[] = []
		const hit = (rs: readonly Any[]) =>
			rs.find((r) => r.id === id && (r.part === "value" || r.part === "attributes"))
		for (const [c, at] of all) {
			const run = ermine.records.run(c)
			const r = run && hit(run.reads)
			if (r) out.push({ at, label: at, kind: "run", n: run!.n, part: String(r.part) })
			const call = ermine.records.call(c)
			const k = call && hit(call.reads)
			if (k) out.push({ at, label: at, kind: "call", n: call!.n, part: String(k.part) })
		}
		return out.slice(0, 40)
	}
	function nodeAt(p: string) {
		const { id, ids, from } = idOf(p)
		const v = valueAt(p)
		const attrs = quiet(() => ermine.readAttributes(target(p)), undefined) as
			| Record<string, unknown>
			| undefined
		let where: Map<string, string> | undefined
		const w = () => where ??= walk(4000)
		const kids = names(p)
		return {
			path: p,
			there: id !== undefined || p === "/" || kids.length > 0,
			id,
			ids,
			from,
			version: version(p),
			value: v === undefined ? undefined : shown(v),
			attributes: Object.fromEntries(
				Object.entries(attrs && typeof attrs === "object" ? attrs : {})
					.sort(([x], [y]) => x < y ? -1 : 1)
					.map(([k, x]) => [k, shown(x, 4000)]),
			),
			children: kids,
			// a node by id: each name's place, by the child's id
			inside: id !== undefined && p.startsWith("#")
				? Object.fromEntries(
					kids.map((k) => [k, "#" + String(entry("children", id)?.value?.[k] ?? "")]),
				)
				: undefined,
			change: {
				value: changeOf(entry("value", id)?.change),
				attributes: changeOf(entry("attributes", id)?.change),
				children: changeOf(entry("children", id)?.change),
			},
			why: {
				value: whyOf(p, "value", w),
				attributes: entry("attributes", id) === undefined
					? undefined
					: whyOf(p, "attributes", w),
			},
			status: statusOf(p),
			readBy: readersOf(id, w()),
			picture: pictureOf(v),
		}
	}
	function listAt(p: string) {
		const rows = names(p).map((name) => {
			const q = kid(p, name)
			const { id, from } = idOf(q)
			const v = valueAt(q)
			const t = Math.max(
				entry("value", id)?.change?.time ?? 0,
				entry("attributes", id)?.change?.time ?? 0,
			)
			return {
				name,
				id,
				from,
				folder: names(q).length > 0,
				type: typeOf(v),
				brief: brief(v, 60),
				when: t || undefined,
			}
		})
		return { path: p, version: version(p), rows }
	}
	function findAt(q: string) {
		const words = q.toLowerCase().trim()
		const found: { path: string; name: string; type: string; brief?: string; folder: boolean }[] =
			[]
		if (!words) return { q, found, looked: 0 }
		const seen = new Set<string>()
		let looked = 0
		const queue: [string, number][] = [["/", 0]]
		while (queue.length) {
			const [p, depth] = queue.shift()!
			for (const name of names(p)) {
				const q2 = kid(p, name)
				const { id } = idOf(q2)
				if (id !== undefined) {
					if (seen.has(id)) continue
					seen.add(id)
				}
				if (++looked > 5000) return { q, found, looked, more: true }
				const v = valueAt(q2)
				const b = brief(v, 80)
				const kids = names(q2)
				if (name.toLowerCase().includes(words) || (b ?? "").toLowerCase().includes(words)) {
					found.push({ path: q2, name, type: typeOf(v), brief: b, folder: kids.length > 0 })
					if (found.length >= 100) return { q, found, looked, more: true }
				}
				if (kids.length && depth < 14) queue.push([q2, depth + 1])
			}
		}
		return { q, found, looked, more: false }
	}
	function mapOf(by: string) {
		type Card = { id: string; at: string; name: string; kind: string; type: string }
		const HOST = String(ermine.node)
		const all = walk(500)
		const more = all.size >= 500
		const cards = new Map<string, Card>()
		const kindOf = (id: string, at: string) => {
			if (isComputer(id)) return "computer"
			const v = entry("value", id)?.value
			if (
				ermine.records.call(id) !== undefined ||
				(typeof v === "function" && /\/on\/[^/]+$/.test(at))
			) {
				return "handler"
			}
			if (names(at).length) return "folder"
			return v === undefined ? "empty" : "value"
		}
		cards.set(HOST, { id: HOST, at: "/", name: "the host", kind: "process", type: "nothing" })
		for (const [id, at] of all) {
			cards.set(id, {
				id,
				at,
				name: at === "/" ? "/" : at.slice(at.lastIndexOf("/") + 1),
				kind: kindOf(id, at),
				type: typeOf(entry("value", id)?.value),
			})
		}
		const edges: { from: string; to: string; kind: string }[] = []
		const writer = (id: string) => {
			const e = entry("value", id) ?? entry("children", id)
			const m = e?.change?.metadata ?? {}
			const w = m.call !== undefined ? m.handler : m.node
			return typeof w === "string" && w !== id && w !== HOST ? w : undefined
		}
		if (by === "owner") {
			for (const id of all.keys()) {
				const scope = (entry("attributes", id)?.value as Record<string, unknown> | undefined)
					?.[COMPUTER_SCOPE]
				const owner = typeof scope === "string" ? scope : writer(id) ?? HOST
				edges.push({
					from: cards.has(owner) ? owner : HOST,
					to: id,
					kind: typeof scope === "string" ? "made" : owner === HOST ? "host" : "wrote",
				})
			}
		} else if (by === "reads") {
			const seen = (
				rs: readonly Any[],
			) => [
				...new Set(
					rs.filter((r) =>
						typeof r.id === "string" && (r.part === "value" || r.part === "attributes")
					).map((r) => String(r.id)),
				),
			]
			for (const id of all.keys()) {
				const rec = ermine.records.run(id) ?? ermine.records.call(id)
				if (!rec) continue
				for (const r of seen(rec.reads)) {
					if (cards.has(r) && r !== id) edges.push({ from: r, to: id, kind: "read" })
				}
				for (const w of seen(rec.writes ?? [])) {
					if (cards.has(w) && w !== id) edges.push({ from: id, to: w, kind: "wrote" })
				}
			}
		} else {
			const ids = new Map([...all].map(([id, at]) => [at, id]))
			for (const [id, at] of all) {
				const parent = at === "/" ? undefined : ids.get(parentOf(at))
				if (parent !== undefined) edges.push({ from: parent, to: id, kind: "child" })
			}
		}
		const used = by === "reads" ? new Set(edges.flatMap((e) => [e.from, e.to])) : undefined
		return {
			by,
			cards: [...cards.values()].filter((
				c,
			) => (used ? used.has(c.id) : c.id !== HOST || by === "owner")),
			edges,
			more,
		}
	}
	// the trace: what led to a change, walked back through what explain says of each writer (a run
	// and what it read, a call and what it read, or code outside any), to depth
	type Step = {
		what: string
		label: string
		at?: string
		when?: number
		where?: Site[]
		note?: string
		more?: { id: string; part: Part; change: number }
		steps?: Step[]
	}
	function traceOf(p: string, part: Part, depth: number): Step[] {
		let left = 400
		const stop = (label: string, note?: string): Step => ({ what: "stop", label, note })
		const explained = (at: string, part: Part) =>
			quiet(
				() =>
					part === "value"
						? ermine.explain(target(at))
						: part === "attributes"
						? ermine.explainAttributes(target(at))
						: ermine.explainChildren(target(at)),
				undefined,
			)
		function reads(rs: readonly Any[], d: number, seen: Set<object>): Step[] {
			const own = rs.filter((r) => r.part === "value" || r.part === "attributes")
			const walked = rs.filter((r) => r.part !== "value" && r.part !== "attributes")
			const out: Step[] = own.slice(0, 12).map((r) => {
				const at = pathOf(r.path)
				const label = `read ${r.part} of ${at ?? "a node outside"}`
				if (at === undefined) return { what: "read", label, note: "not reachable from here" }
				const e = explained(at, r.part)
				return {
					what: "read",
					label,
					at,
					when: e?.change?.time,
					...because(at, r.part, d, seen),
				}
			})
			if (own.length > 12) out.push(stop(`and ${own.length - 12} more reads`, "not shown"))
			if (walked.length) {
				out.push({
					what: "walk",
					label: `found its way through ${walked.length} folder read${
						walked.length === 1 ? "" : "s"
					}`,
					note: "the names read on the way",
					steps: walked.slice(0, 24).map((r) => ({
						what: "read",
						label: `${r.part} of ${pathOf(r.path) ?? "a node outside"}`,
						at: pathOf(r.path),
					})),
				})
			}
			return out
		}
		function because(
			at: string,
			part: Part,
			d: number,
			seen: Set<object>,
		): { steps?: Step[]; more?: Step["more"] } {
			const e = explained(at, part)
			if (e?.change === undefined) return { steps: [stop("nothing written there")] }
			const c = e.change
			if (seen.has(c)) {
				return { steps: [stop("the same change as above", "a loop: not followed again")] }
			}
			if (d <= 0 || --left <= 0) return { more: { id: at, part, change: 0 } }
			const inner = new Set(seen).add(c)
			const where = c.site ? [siteOf(c.site)!] : []
			const w = e.writer
			if (w.kind === "computer") {
				const on = pathOf(w.path)
				const label = `${w.run ? `run ${w.run.n}` : "a run"} of ${
					on ?? "a memo or effect outside"
				}`
				if (w.run === undefined) {
					return {
						steps: [{
							what: "run",
							label,
							at: on,
							where,
							note: "its record is gone: only its latest run is kept",
						}],
					}
				}
				return {
					steps: [{
						what: "run",
						label,
						at: on,
						when: w.run.ended / 1000,
						where,
						note: `${w.run.end}; it read ${w.run.reads.length}, wrote ${w.run.writes.length}${
							where.length ? ". written in the code at" : ""
						}`,
						steps: reads(w.run.reads, d - 1, inner),
					}],
				}
			}
			if (w.kind === "method") {
				const on = pathOf(w.path)
				const label = `${w.call ? `call ${w.call.n}` : "a call"} to ${
					on ?? "an action outside"
				}`
				if (w.call === undefined) {
					return {
						steps: [{
							what: "call",
							label,
							at: on,
							where,
							note: "its record is gone: only the action's latest call is kept",
						}],
					}
				}
				return {
					steps: [{
						what: "call",
						label,
						at: on,
						when: w.call.started / 1000,
						where,
						note: `${w.call.end}, with ${brief(w.call.args, 120)}${
							where.length ? ". the write is at" : ""
						}`,
						steps: reads(w.call.reads, d - 1, inner),
					}],
				}
			}
			return {
				steps: [{
					what: "outside",
					label: "written from outside any run or call",
					where: w.site ? [siteOf(w.site)!] : where,
					note: `${c.actor !== undefined ? `by ${brief(c.actor, 60)}, ` : ""}${
						where.length || w.site ? "from the code at" : "no site was caught"
					}`,
				}],
			}
		}
		const e = explained(p, part)
		const root: Step = {
			what: `${part} write`,
			label: `the ${part} of ${p}`,
			at: p,
			when: e?.change?.time,
		}
		if (e?.change === undefined) return [{ ...root, note: "nothing written there" }]
		return [{ ...root, ...because(p, part, depth, new Set()) }]
	}

	// an ask: the answer, in the mac's shapes
	function ask(m: Any): Any {
		const at = String(m.path ?? "/").slice(0, 2000)
		const said = { do: m.do, ask: m.ask }
		try {
			if (m.do === "list") return { ...said, path: at, list: listAt(at) }
			if (m.do === "node") return { ...said, path: at, node: nodeAt(at) }
			if (m.do === "versions") {
				const paths = (Array.isArray(m.paths) ? m.paths : []).slice(0, 24).map(String)
				return {
					...said,
					versions: Object.fromEntries(paths.map((p: string) => [p, version(p)])),
				}
			}
			if (m.do === "trace") {
				const depth = Math.min(12, Math.max(1, Number(m.depth) || 6))
				const part = (["value", "attributes", "children"] as const).find((x) => x === m.part) ??
					"value"
				const from = typeof m.id === "string" ? m.id : at
				return {
					...said,
					path: at,
					trace: { path: from, part, depth, steps: traceOf(from, part, depth) },
				}
			}
			if (m.do === "map") return { ...said, ...mapOf(String(m.by ?? "place")) }
			if (m.do === "find") return { ...said, ...findAt(String(m.q ?? "").slice(0, 200)) }
			return { ...said, error: `there's no ${String(m.do)} here` }
		} catch (e) {
			return { ...said, path: at, error: (e as Error)?.message ?? String(e) }
		}
	}
	// a change: made by the host, only where changeable says
	function change(m: Any): Any {
		const at = String(m.path ?? "")
		const said = { do: m.do, ask: m.ask, path: at }
		if (!CHANGES.has(m.do)) return { ...said, error: `there's no ${String(m.do)} here` }
		if (!changeable(at) || (m.do === "move" && !changeable(String(m.to ?? "")))) {
			return { ...said, error: CHANGEABLE_WORDS }
		}
		try {
			if (m.do === "write") ermine.patch(at, [{ path: [], value: m.value }])
			else if (m.do === "edit") ermine.patch(at, m.patches ?? [])
			else if (m.do === "make") {
				if (ermine.peep(() => ermine.hasNode(at))) {
					return { ...said, error: `something's already at ${at}` }
				}
				ermine.ensureNode(at, m.value)
			} else if (m.do === "move") {
				const to = String(m.to)
				if (ermine.peep(() => ermine.hasNode(to))) {
					return { ...said, error: `something's already at ${to}` }
				}
				ermine.rename(at, to)
				return { ...said, done: "move", at: to }
			} else if (m.do === "remove") ermine.remove(at)
			return { ...said, done: m.do, at }
		} catch (e) {
			return { ...said, error: (e as Error)?.message ?? String(e) }
		}
	}
	return { ask, change }
}
