// views.ts (newos, from deno/views.ts): "ermine:views", values drawn as what they are, as readline is a
// library a program imports: what the inspector drew, for any program that shows a value. A string with its lines, length and what is
// hard to see; a number in hex and binary, as a time, a colour's swatch; a
// boolean a box; a list, a map, counted and previewed; bytes as UTF-8 and a
// dump; a typed array's stats and sparkline, uint32 pixels beside w and h a
// picture; {kind: "picture"} the picture; an address followable; an id, a
// function, a live value badges.
//
//   const V = views.make(blit, {u, colours, hex})   blit from "ermine:draw"; colours the program's theme (paper, ink, line, lemon,
//                                              cherry...), hex whole numbers in hex: read at each call, so the
//                                              program changes them in place
//   V.fonts({text, title, fixed})              the fonts it draws in, as they come; the font ROM until then
//   V.kinds(map)                               the views registered by kind (/etc/views, below)
//
// A row: V.kind(v, key?, ctx?), V.badge(v, kind), V.pieces(v, kind, key?,
// ctx?, o?) (a line, in pieces [text, colour, swatch?]), V.summary(f, x, y,
// v, o) (the badge and the pieces; f null measures). A pane: V.blocks(f, w)
// (a column of blocks, each {h, draw}), V.about(v, kind, o) (one line of
// what it is), V.body(B, v, kind, o) (the value itself), V.lay(B, R,
// scroll) (drawn from scroll down, the scroll it could be), or all three in
// V.pane(f, R, v, o). What can be clicked is in B.zones, {x, y, w, h, act}:
// follow (an address, its address), toggle (a boolean), hex, into (with
// o.into, a key of a list or a map); V.hit(zones, x, y). Editing:
// V.edit(v, kind, o) a readline field for a simple value, or null;
// V.parse(text, kind) {value} or {error}; V.field(f, box, field) draws one,
// and says where its caret is.
//
// o: {key, ctx, parent, name, write, address, api, into, play}. key
// the value's own key, ctx what holds it ("colors" for a picture's), parent
// the map a typed array's w and h are in; write whether Enter may edit it;
// api a part's interface, to say what an address reaches. play: a draw
// list beside its w and h played into a picture, pixels drawn at a map's
// head, a list of strings as text, and registered views.
//
// /etc/views, a map from a value's kind ({kind: "js", ...}) to how it
// looks: {label, line, show}. label the badge's word (the kind); line the
// keys whose values a row's summary shows (every key, as a map's); show the
// key the pane shows first, drawn as what its value is, the other keys
// below it as a map's. A kind built in (picture) is never another's.

// deno-lint-ignore-file no-explicit-any
import { first, idAt, make as makeAt, snap, val } from "./kit.ts"
import type { Blitter, Font, Form, List, Rect } from "./blitter.ts"
import * as readline from "./readline.ts"

type Target = Form | List
export type Piece = [string, number, number?]
export type Zone = {
	x: number
	y: number
	w: number
	h: number
	act: string
	role?: string
	label?: string
	key?: string | number
	address?: string[]
}
export type Options = {
	key?: string | number
	ctx?: unknown
	parent?: any
	name?: string
	write?: boolean
	address?: string[]
	api?: { content(address: string[]): any[] }
	into?: boolean
	play?: boolean
	pending?: boolean
	why?: (e: any) => string
}
export type View = { label?: string; line?: string[]; show?: string }
type Block = { h: number; draw: (x: number, y: number, clip: Rect) => void }
export type Blocks = {
	f: Target
	w: number
	cols: number
	pad: number
	items: Block[]
	zones: Zone[]
	push(h: number, draw: Block["draw"]): void
	line(ps: Piece[], font?: Font): void
	gap(h?: number): void
	rule(): void
	text(t: string, c?: number, font?: Font): void
}

// keys as the graph sorts them (CBOR's): a shorter one first, those of one length by their bytes
// made at the first use: JavaScriptCore's runner gives TextEncoder after this module is evaluated (jsc.ts)
let encoder: TextEncoder | null = null
const bytes = (t: string) => (encoder ??= new TextEncoder()).encode(t)
export function order(a: string, b: string): number {
	const x = bytes(a), y = bytes(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}
const ADDRESSY = [
	"owner",
	"node",
	"address",
	"at",
	"path",
	"line",
	"call",
	"ctl",
	"launch",
	"to",
	"program",
	"start",
	"cursor",
]
const BUILT = ["picture"]
const proto = (v: unknown) => Object.getPrototypeOf(v)
const names = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "string")
const isAddress = (v: unknown, key?: string | number) =>
	names(v) && (v[0] === "/" || (ADDRESSY.includes(String(key)) && !v.some((n) => n.includes(" "))))
const typedKind = (v: any) =>
	v.constructor.name.replace(/Array$/, "").replace(/^Big/, "").toLowerCase()
/** an address as names from the root: "/" first; a path from the root (programs/term) made one */
export const addressOf = (
	v: string | string[],
) => (typeof v === "string"
	? ["/", ...v.split("/").filter((n) => n)]
	: v[0] === "/"
	? v
	: ["/", ...v])
export const shown = (a: string[]) => "/" + a.filter((n) => n !== "/").join("/")
export const short = (pid: unknown) => {
	const p = pid
	return typeof p === "string" && p.length > 9 && p.startsWith("@")
		? "@…" + p.slice(-6)
		: String(p)
}
const isColour = (v: unknown, key: unknown, ctx: unknown) =>
	Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffff &&
	(/colou?r|paper|ink|line|chrome|desk|grain|^bg$|^fg$|fill|^hi$|^lo$|select|lemon|cherry|rose|mint|lilac|sky|teal|peach|butter|riso|acme|^tag$|check|mark|swatch/i
		.test(String(key ?? "")) || ctx === "colors")
const hex = (v: number, n = 6) => v.toString(16).padStart(n, "0")
/** a colour t of the way from a to b */
const mix = (a: number, b: number, t: number) =>
	[16, 8, 0].reduce(
		(c, k) => c | (Math.round(((a >> k) & 255) * (1 - t) + ((b >> k) & 255) * t) << k),
		0,
	)
const bytesOf = (
	v: any,
) => (v instanceof ArrayBuffer
	? new Uint8Array(v)
	: new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
// the text, if the bytes are UTF-8 (checked here: a runner's TextDecoder may not refuse), else null
const utf8 = (b: Uint8Array) => {
	for (let i = 0; i < b.length;) {
		const c = b[i],
			n = c < 0x80
				? 0
				: c >= 0xc2 && c < 0xe0
				? 1
				: c >= 0xe0 && c < 0xf0
				? 2
				: c >= 0xf0 && c < 0xf5
				? 3
				: -1
		if (n < 0 || i + n >= b.length + (n ? 0 : 1)) return null
		for (let k = 1; k <= n; k++) if ((b[i + k] & 0xc0) !== 0x80) return null
		if (c === 0) return null
		i += n + 1
	}
	return new TextDecoder().decode(b)
}
export const size = (
	n: number,
) => (n < 1024
	? `${n} B`
	: n < 1048576
	? `${(n / 1024).toFixed(1)} KB`
	: `${(n / 1048576).toFixed(1)} MB`)
// a string with what is hard to see made seen: a tab →, a control character as \xNN, a return ⏎
const escaped = (t: string, max = 400) => {
	let out = ""
	for (const ch of t.slice(0, max)) {
		const c = ch.codePointAt(0)!
		out += ch === "\n"
			? "⏎"
			: ch === "\t"
			? "→"
			: c < 0x20 || c === 0x7f
			? `\\x${hex(c, 2)}`
			: c === 0xa0
			? "⍽"
			: ch
	}
	return out + (t.length > max ? "…" : "")
}
/** a time the graph gives (microseconds) as the clock shows it */
export const clock = (t: unknown) => {
	if (typeof t !== "number" || t < 1e15) return String(t)
	const d = new Date(t / 1000)
	const p = (n: number, k = 2) => String(n).padStart(k, "0")
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${
		p(d.getMilliseconds(), 3)
	}`
}
/**
 * who made a change, as one line: a process by its name (pids maps ids to names), else its id; "host" for
 * what the host itself did. A change in JS says its time, node and reader (the process that made it); an
 * actor, if one is ever given, is said first
 */
export const who = (c: any, pids: { [id: string]: string } = {}) => {
	if (!c) return null
	// an actor alone is its string; an agent with more (a person, code) is the agent's map
	const actor = typeof c.actor === "string"
		? c.actor
		: typeof c.actor?.actor === "string"
		? c.actor.actor
		: null
	if (typeof c.reader === "string") {
		return [actor, pids[c.reader] ?? short(c.reader)].filter((x) => x && x !== "machine").join(
			" via ",
		) || "machine"
	}
	if (actor) return actor
	return "host"
}
/** where in code, file:line */
export const site = (
	s: any,
) => (s && typeof s.file === "string" ? `${s.file}${s.line != null ? ":" + s.line : ""}` : null)
/**
 * when a change was, as the clock shows it; a history's change with no time (one the card stored
 * before it kept times), its Lamport number: "#3"
 */
export const when = (
	c: any,
) => (typeof c?.time !== "number" && c?.lamport !== undefined ? `#${c.lamport}` : clock(c?.time))
/**
 * a version's change as one line: when (the clock), who, where in code if the change says:
 * "12:04:33.120 · wmiirc". v is a version (an item's versions[0]); pids names for ids (ids, below)
 */
export const head = (v: any, o: { pids?: { [id: string]: string } } = {}) => {
	const c = v?.change
	if (!c) return "no change: the root's first value"
	return [when(c), who(c, o.pids), site(c.site)].filter(Boolean).join(" · ")
}
/**
 * names for ids: each program in /programs, each driver in /drivers, a process in /apps/<app> its app's,
 * a driver's process /dev/<x>/driver as x, one in /dev/wm/client/* its start's name
 */
export const ids = (api: any) => {
	const pids: { [id: string]: string } = {}
	// a directory: [name, items] for each name
	const dir = (a: string[]): [string, any[]][] => {
		try {
			return (api.children(a) as string[]).map((n) => [n, api.children(a, n) as any[]])
		} catch {
			return []
		}
	}
	for (const [n, items] of dir(["/", "programs"])) for (const i of items) if (i.id) pids[i.id] = n
	for (const [n, items] of dir(["/", "drivers"])) for (const i of items) if (i.id) pids[i.id] = n
	// a process beside its app's documents: /apps/<app>/<name>
	for (const [app] of dir(["/", "apps"])) {
		for (const [, items] of dir(["/", "apps", app])) {
			for (const i of items) if (i.id?.startsWith("@")) pids[i.id] = app
		}
	}
	try {
		for (const n of api.children(["/", "dev"]) as string[]) {
			for (const i of api.children(["/", "dev", n], "driver") as any[]) {
				if (i.id) pids[i.id] = n
			}
		}
	} catch { /* refused */ }
	for (const [n] of dir(["/", "dev", "wm", "client"])) {
		try {
			const v = val(api, ["/", "dev", "wm", "client", n]) as any
			const start = v?.start ?? {},
				program = Array.isArray(start.program)
					? start.program.at(-1)
					: typeof start.program === "string"
					? start.program.split("/").at(-1)
					: null
			if (v?.pid) {
				pids[v.pid] = typeof start.name === "string" && !start.name.startsWith("@")
					? start.name
					: program ?? n
			}
		} catch { /* refused */ }
	}
	return { pids }
}
/**
 * what a change in a history (/dev/sync/history) did, a line: a write's patches by path, a slot's
 * change its name
 */
export const did = (c: any) => {
	if (c?.kind === "write") {
		const one = (p: any) => {
			const path = (p.path ?? []).join(".")
			if (!(p.path ?? []).length && !p.range) return p.value === undefined ? "removed" : "whole"
			return `${p.range ? "splice" : p.value === undefined ? "remove" : "set"} ${path}`
		}
		return (c.patches ?? []).map(one).join(", ") || "write"
	}
	return `${c?.kind ?? "?"}${c?.name !== undefined ? " " + c.name : ""}`
}
/** a history's change as a version, for head: its time (or Lamport number), reader and site */
export const itemOf = (c: any) => ({
	change: {
		time: c?.time,
		lamport: c?.lamport,
		reader: c?.reader,
		actor: c?.actor,
		site: c?.site,
	},
})
/**
 * a history's changes newest first; with a key, those that changed what is at
 * it (by the value after each, else a patch on its path)
 */
export const changes = (h: any, key: (string | number)[] = []) => {
	const cs: any[] = Array.isArray(h?.changes) ? h.changes : []
	const at = (v: any, k: (string | number)[]) =>
		k.reduce((x, n) => (x === null || x === undefined ? undefined : x[n]), v)
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
	const on = (p: any) => {
		const path = p.path ?? []
		return path.every((n: unknown, i: number) =>
			i >= key.length || String(n) === String(key[i])
		) || key.every((n, i) => String(n) === String(path[i]))
	}
	const out = []
	for (let i = 0; i < cs.length; i++) {
		const c = cs[i], prev = i ? cs[i - 1] : null
		if (key.length && c.kind !== "write") continue
		if (key.length && "value" in c && (!prev || "value" in prev)) {
			if (same(at(c.value, key), prev ? at(prev.value, key) : undefined)) continue
		} else if (key.length && !(c.patches ?? []).some(on)) continue
		out.push(c)
	}
	return out.reverse()
}
/**
 * what changed while a window was away from a folder: a document beside it,
 * {seen: {id: stamp}, dirs: {path: true}}. A stamp is a number that rises with each change of
 * the document: the time of its change. at(api, path, docs), each
 * time it shows a folder, its documents [{id, stamp}]: the ids marked, set
 * on entering, those whose stamp rose since it last left it, or new
 * in a folder it left before; entering another leaves the last, its
 * documents written as seen (one write, when they differ). leave(api) on
 * closing.
 */
export const away = (address: string[]) => {
	let doc: any = null,
		dir: string | null = null,
		docs: { id: string; stamp: number }[] = [],
		marked = new Set<string>()
	const leave = (api: any) => {
		if (dir === null || !doc) return
		const seen = { ...(doc.seen ?? {}) }
		for (const d of docs) seen[d.id] = d.stamp
		const next = { seen, dirs: { ...(doc.dirs ?? {}), [dir]: true } }
		if (JSON.stringify(next) === JSON.stringify(doc)) return
		try {
			if (!idAt(api, address.slice(0, -1))) {
				makeAt(api, address.slice(0, -2), address.at(-2)!, null)
			}
			snap(api, address, next)
			doc = next
		} catch { /* refused: marked again next time */ }
	}
	return {
		at(api: any, path: string[], now: { id: string; stamp: number }[]) {
			if (!doc) doc = val(api, address) ?? { seen: {}, dirs: {} }
			const k = "/" + path.join("/")
			if (k !== dir) {
				leave(api)
				const was = doc.seen ?? {}
				marked = new Set(
					doc.dirs?.[k]
						? now.filter((d) => was[d.id] === undefined || d.stamp > was[d.id]).map((d) =>
							d.id
						)
						: [],
				)
				dir = k
			}
			docs = now
			return marked
		},
		leave,
	}
}
/** a draw list's ops, counted by op */
export const ops = (list: any[]) => {
	const n: { [op: string]: number } = {}
	for (const o of list) n[o?.op] = (n[o?.op] ?? 0) + 1
	return `${list.length} ops · ` +
		Object.entries(n).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" · ")
}
// a live value a host holds, as a program reads it: a stand-in (runner.ts's Stand) of some kind
const liveName = (
	v: any,
): string => (v?.constructor?.name === "Stand" ? String(v.kind ?? "") : String(v))
const isOps = (v: unknown) =>
	Array.isArray(v) && v.length > 0 &&
	v.every((o) => o && typeof o === "object" && typeof o.op === "string")
const isPixels = (v: any, w: unknown, h: unknown) =>
	v instanceof Uint32Array && Number.isInteger(w) && Number.isInteger(h) && (w as number) > 0 &&
	(h as number) > 0 && (w as number) * (h as number) <= v.length

export function make(
	blit: Blitter,
	style: { u?: number; colours: { [name: string]: number }; hex?: boolean },
) {
	const u = style.u ?? 1
	const C = style.colours
	let F: Font | undefined, FT: Font | undefined, FX: Font | undefined
	let registered: { [kind: string]: View } = {}
	const fonts = (f: { text?: Font; title?: Font; fixed?: Font }) => {
		F = f.text ?? undefined
		FT = f.title ?? undefined
		FX = f.fixed ?? undefined
	}
	const kinds = (m: unknown) => {
		registered = m && typeof m === "object" && !Array.isArray(m)
			? m as { [kind: string]: View }
			: {}
	}
	const role = (
		r: string,
	) => (r === "text" ? F : r === "title" ? FT : r === "fixed" ? FX : undefined)
	const viewOf = (
		v: any,
	):
		| View
		| null => (v && typeof v.kind === "string" && !BUILT.includes(v.kind) && registered[v.kind] &&
				typeof registered[v.kind] === "object"
			? registered[v.kind]
			: null)

	// --- what a value is
	const kind = (
		v: any,
		key?: string | number,
		_ctx?: unknown,
		o: { play?: boolean } = {},
	): string => {
		if (v === undefined) return "none"
		if (v === null) return "null"
		if (typeof v === "boolean") return "bool"
		if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? "int" : "float"
		if (typeof v === "string") {
			return /^@\d{10,}(-\d+)?$/.test(v)
				? "id"
				: key === "program" && /^[^/ ]+(\/[^/ ]+)+$/.test(v)
				? "address"
				: "string"
		}
		if (typeof v === "function") return "fn"
		if (v instanceof Uint8Array) return "bytes"
		if (ArrayBuffer.isView(v)) return v instanceof DataView ? "bytes" : "typed"
		if (Array.isArray(v)) return isAddress(v, key) ? "address" : "list"
		if (typeof v === "object") {
			if (proto(v) !== Object.prototype && proto(v) !== null) return "live"
			if (v.kind === "picture" && Array.isArray(v.rows)) return "picture"
			if (o.play && viewOf(v)) return "view"
			return "map"
		}
		return "live"
	}
	const number = (v: number, key?: unknown, ctx?: unknown) => {
		if (Number.isNaN(v)) return "NaN"
		if (Object.is(v, -0)) return "-0"
		if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity"
		if (Number.isInteger(v) && (style.hex || isColour(v, key, ctx)) && v >= 0) {
			return "0x" + hex(v, isColour(v, key, ctx) ? 6 : 1)
		}
		return String(v)
	}
	// a badge: the kind and how much, as a row shows it
	const badge = (v: any, k: string): string => {
		switch (k) {
			case "string":
				return `str ${v.length}`
			case "int":
				return "int"
			case "float":
				return "num"
			case "bool":
				return "bool"
			case "null":
				return "null"
			case "none":
				return "—"
			case "list":
				return `list ${v.length}`
			case "map":
				return `map ${Object.keys(v).length}`
			case "bytes":
				return `bytes ${v.byteLength}`
			case "typed":
				return `${
					typedKind(v).replace("uint", "u").replace("int", "i").replace("float", "f")
				}×${v.length}`
			case "picture":
				return "picture"
			case "address":
				return "addr"
			case "id":
				return "id"
			case "fn":
				return "fn"
			case "view":
				return String(viewOf(v)?.label ?? v.kind)
			default:
				return "live"
		}
	}
	const brief = (x: any): string => {
		const k = kind(x)
		return k === "string"
			? JSON.stringify(x.length > 16 ? x.slice(0, 16) + "…" : x)
			: k === "int" || k === "float"
			? number(x)
			: k === "bool" || k === "null"
			? String(x)
			: k === "address"
			? shown(addressOf(x))
			: `‹${badge(x, k)}›`
	}
	// a value in one line, in pieces, each [text, colour, swatch?]
	const pieces = (
		v: any,
		k: string,
		key?: string | number,
		ctx?: unknown,
		o: Options = {},
	): Piece[] => {
		switch (k) {
			case "string":
				return [['"', C.dim], [escaped(v, 120), C.ink], ['"', C.dim]]
			case "int":
			case "float":
				return isColour(v, key, ctx)
					? [["", C.ink, v], ["#" + hex(v).toUpperCase(), C.blue]]
					: [[number(v, key, ctx), C.blue]]
			case "bool":
				return [[String(v), v ? C.mint : C.cherry]]
			case "null":
				return [["null", C.dim]]
			case "none":
				return [["nothing", C.dim]]
			case "list":
				if (o.play && isOps(v)) return [[ops(v), C.ink2]]
				return [["[", C.dim], [
					v.slice(0, 6).map((x: any) => brief(x)).join(", ") + (v.length > 6 ? ", …" : ""),
					C.ink2,
				], ["]", C.dim]]
			case "map": {
				const ks = Object.keys(v).sort(order)
				return [
					["{", C.dim],
					[ks.slice(0, 8).join(" ") + (ks.length > 8 ? " …" : ""), C.ink2],
					["}", C.dim],
				]
			}
			case "bytes": {
				const b = bytesOf(v), t = utf8(b)
				return t !== null && b.length
					? [["utf-8 ", C.dim], ['"' + escaped(t, 80) + '"', C.lilac]]
					: [[
						[...b.slice(0, 16)].map((x) => hex(x, 2)).join(" ") + (b.length > 16 ? " …" : ""),
						C.lilac,
					]]
			}
			case "typed": {
				const xs = [...v.slice(0, 8)].map((
					x: any,
				) => (typeof x === "bigint" ? String(x) : number(Number(x))))
				return [[xs.join(" ") + (v.length > 8 ? " …" : ""), C.teal]]
			}
			case "picture":
				return [
					[`${v.rows[0]?.length ?? 0}×${v.rows.length}`, C.ink2],
					...Object.values(v.colors ?? {}).slice(0, 8).map((c) =>
						["", C.ink, c as number] as Piece
					),
					[v.tile ? " tile" : "", C.dim],
				]
			case "address":
				return [[shown(addressOf(v)), C.rose]]
			case "id":
				return [[v.slice(0, 22) + "…", C.lilac]]
			case "fn":
				return [["a function, the process's", C.dim]]
			case "view": {
				const view = viewOf(v)!
				const ks = Array.isArray(view.line)
					? view.line.filter((x) => x in v)
					: Object.keys(v).filter((x) => x !== "kind").sort(order)
				const out: Piece[] = []
				for (const x of ks.slice(0, 6)) {
					if (out.length) out.push(["  ", C.dim])
					const xk = kind(v[x], x)
					out.push(
						...(xk === "string"
							? [[escaped(v[x], 80), C.ink] as Piece]
							: pieces(v[x], xk, x, v, o)),
					)
				}
				return out.length ? out : [["{}", C.dim]]
			}
			default:
				return [[`live ${liveName(v)}`.trim(), C.lilac]]
		}
	}

	// --- drawing in a line
	const fitted = (text: string, w: number, font?: Font) => {
		const n = blit.fit(text, w, font)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	const swatch = (f: Target, x: number, y: number, c: number, sz: number) => {
		blit.fill(f, x, y, sz, sz, C.line)
		blit.fill(f, x + u, y + u, sz - 2 * u, sz - 2 * u, c)
		return x + sz + 3 * u
	}
	// pieces in a line: text, or a swatch where a piece has a colour; f null measures
	const text = (f: Target | null, x: number, y: number, ps: Piece[], clip: Rect, font = FX) => {
		for (const [t, c, sw] of ps) {
			if (x >= clip.x + clip.w) break
			if (sw !== undefined) {
				const sz = blit.height(font) - 2 * u
				if (x + sz < clip.x + clip.w) x = f ? swatch(f, x, y + u, sw, sz) : x + sz + 3 * u
			}
			if (t) x = f ? blit.text(f, x, y, t, c, undefined, clip, font) : x + blit.measure(t, font)
		}
		return x
	}
	// a badge's tag: with the theme's tag colour, a pill of it, ringed a little darker, as catclock's tags; else a box
	const tag = (
		f: Target | null,
		x: number,
		y: number,
		t: string,
		fg: number,
		bg?: number,
		line?: number,
	) => {
		const pill = C.tag !== undefined && bg === undefined && line === undefined
		const pad = pill ? 6 * u : 3 * u, w = blit.measure(t, FX) + 2 * pad, h = blit.height(FX)
		if (!f) return x + w + 4 * u
		if (pill) {
			const r = Math.floor((h - 1) / 2), ring = mix(C.tag, C.ink, 0.12)
			for (const [c, d] of [[ring, 0], [C.tag, u]]) {
				blit.fill(f, x + r, y + d, w - 2 * r, h - 2 * d, c)
				blit.fillellipse(f, x + r, y + r, r - d, r - d, c)
				blit.fillellipse(f, x + w - r - 1, y + r, r - d, r - d, c)
			}
		} else {
			if (bg !== undefined) blit.fill(f, x, y, w, h, bg)
			for (let i = 0; i < u; i++) blit.frame(f, x + i, y + i, w - 2 * i, h - 2 * i, line ?? C.lo)
		}
		blit.text(f, x + pad, y, t, fg, undefined, undefined, FX)
		return x + w + 4 * u
	}
	/** a value in a row: its badge, then it in a line; f null measures. o.kind, o.clip besides the options */
	const summary = (
		f: Target | null,
		x: number,
		y: number,
		v: any,
		o: Options & { kind?: string; clip?: Rect } = {},
	) => {
		const k = o.kind ?? kind(v, o.key, o.ctx, o)
		const clip = o.clip ?? { x, y, w: 1 << 20, h: 1 << 20 }
		const b = badge(v, k)
		x = k === "fn"
			? tag(f, x, y, "fn", C.paper, C.line, C.line)
			: k === "live"
			? tag(f, x, y, b, C.lilac, undefined, C.lilac)
			: tag(f, x, y, b, C.ink2)
		// played: a null is its badge; a picture small, as tall as the line, before its size
		if (o.play && k === "null") return x
		if (o.play && k === "picture" && v.rows.length) {
			const h = blit.height(FX), sc = Math.max(1, Math.floor(h / v.rows.length))
			const form = drawn(v, sc)
			if (f && x + form.w < clip.x + clip.w) {
				blit.blit(
					f,
					x,
					y + Math.max(0, Math.floor((h - form.h) / 2)),
					form,
					0,
					0,
					form.w,
					Math.min(form.h, h),
				)
			}
			x += form.w + 4 * u
		}
		return text(f, x, y, pieces(v, k, o.key, o.ctx, o), clip)
	}
	const about = (v: any, k: string, o: Options = {}) => {
		switch (k) {
			case "string": {
				const lines = v.split("\n").length
				return `string · ${v.length} characters · ${lines} ${
					lines === 1 ? "line" : "lines"
				} · ${bytes(v).length} bytes of UTF-8`
			}
			case "int":
				return `whole number${
					isColour(v, o.key ?? o.name, o.ctx) ? " · a colour, 0xRRGGBB" : ""
				}`
			case "float":
				return Number.isNaN(v)
					? "NaN: not a number"
					: Number.isFinite(v)
					? "number, binary64"
					: "an infinity"
			case "bool":
				return "boolean"
			case "null":
				return "null: nothing, or a folder"
			case "none":
				return o.pending ? "pending: its node is not here yet" : "no value"
			case "list":
				return `list · ${v.length} items`
			case "map":
				return `map · ${Object.keys(v).length} ${
					Object.keys(v).length === 1 ? "key" : "keys"
				}, sorted as the graph sorts them`
			case "bytes":
				return `bytes · ${v.byteLength}`
			case "typed":
				return `typed array · ${typedKind(v)} × ${v.length} · ${size(v.byteLength)}`
			case "picture":
				return `picture · ${v.rows[0]?.length ?? 0} × ${v.rows.length} · ${
					Object.keys(v.colors ?? {}).length
				} colours${v.tile ? " · a tile" : ""}${v.hot ? ` · hot ${v.hot.join(",")}` : ""}`
			case "address":
				return "an address: f or Enter follows it"
			case "id":
				return "an id: a node's own, wherever it is placed"
			case "fn":
				return "a function: its process holds it, the scheduler calls it (the shell's call)"
			case "proc":
				return "a process: its node holds a run"
			case "view":
				return `${v.kind} · ${Object.keys(v).length} keys · its view in /etc/views`
			default:
				return `a live value: its host holds it, the graph never looks inside${
					liveName(v) ? " · " + liveName(v) : ""
				}`
		}
	}

	// --- a pane: blocks, each {h, draw(x, y, clip)}, laid out from a scroll down
	const blocks = (f: Target, w: number): Blocks => {
		const cw = Math.max(1, blit.measure("m", FX))
		const B: Blocks = {
			f,
			w,
			cols: Math.max(8, Math.floor(w / cw)),
			pad: 10 * u,
			items: [],
			zones: [],
			push: (h, draw) => B.items.push({ h, draw }),
			line: (ps, font = FX) =>
				B.items.push({
					h: blit.height(font) + u,
					draw: (x, y, clip) => text(f, x, y, ps, clip, font),
				}),
			gap: (h = 6 * u) => B.items.push({ h, draw: () => {} }),
			rule: () =>
				B.items.push({ h: 7 * u, draw: (x, y) => blit.fill(f, x, y + 3 * u, w, u, C.lo) }),
			// cut to the width, as a fixed font's columns
			text: (t, c = C.ink, font = FX) => {
				for (let i = 0; i < Math.max(1, t.length); i += B.cols) {
					B.line([[t.slice(i, i + B.cols), c]], font)
				}
			},
		}
		return B
	}
	/** the blocks drawn in R from scroll down; the scroll, kept to what there is */
	const lay = (B: Blocks, R: Rect, scroll: number) => {
		const total = B.items.reduce((n, b) => n + b.h, 0)
		if (scroll > Math.max(0, total - R.h + 12 * u)) scroll = Math.max(0, total - R.h + 12 * u)
		let y = R.y + 6 * u - scroll
		for (const b of B.items) {
			if (y + b.h > R.y && y < R.y + R.h) b.draw(R.x + B.pad, y, R)
			y += b.h
		}
		return scroll
	}
	// a picture's rows in a form, sc pixels a letter; a letter not in colors the check
	const drawn = (v: any, sc: number) => {
		const pw = Math.max(0, ...v.rows.map((x: string) => x.length)), ph = v.rows.length
		const fw = Math.max(1, pw * sc), fh = Math.max(1, ph * sc)
		const form = blit.form(fw, fh)
		const n = Math.max(1, Math.floor(sc / 2))
		for (let j = 0; j < fh; j++) {
			const rowText = v.rows[Math.floor(j / sc)] ?? ""
			for (let i = 0; i < fw; i++) {
				const c = v.colors?.[rowText[Math.floor(i / sc)]]
				form.bits[j * fw + i] = typeof c === "number"
					? c
					: (Math.floor(i / n) + Math.floor(j / n)) & 1
					? C.check
					: C.hi
			}
		}
		return form
	}
	const picture = (B: Blocks, v: any) => {
		const { f, w } = B
		const pw = Math.max(0, ...v.rows.map((x: string) => x.length)), ph = v.rows.length
		const sc = Math.max(
			1,
			Math.min(
				12 * u,
				Math.floor(Math.min(w, 280 * u) / Math.max(1, pw)),
				Math.floor(220 * u / Math.max(1, ph)),
			),
		)
		const fw = Math.max(1, pw * sc), fh = Math.max(1, ph * sc)
		B.push(fh + 10 * u, (x, y) => {
			const form = drawn(v, sc)
			blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line)
			blit.blit(f, x, y, form)
			if (Array.isArray(v.hot)) {
				const hx = x + v.hot[0] * sc, hy = y + v.hot[1] * sc
				for (let i = 0; i < u; i++) {
					blit.frame(
						f,
						hx - u + i,
						hy - u + i,
						sc + 2 * u - 2 * i,
						sc + 2 * u - 2 * i,
						C.cherry,
					)
				}
			}
		})
	}
	// uint32 pixels, pw × ph of them (a row stride apart): a picture
	const pixels = (B: Blocks, v: Uint32Array, pw: number, ph: number, stride: number) => {
		const { f, w } = B
		const sc = Math.max(
			1,
			Math.min(8 * u, Math.floor(Math.min(w, 260 * u) / pw), Math.floor(200 * u / ph)),
		)
		const fw = Math.min(pw * sc, w), fh = Math.min(ph * sc, 240 * u)
		// a layer's pixels are 0x00RRGGBB, 0xff000000 clear; a cursor's plane has alpha in its top byte, 0 clear
		const alpha = v.some((x) => x >>> 24 === 0xff && x & 0xffffff) &&
			v.every((x) => x === 0 || x >>> 24 !== 0)
		B.push(fh + 8 * u, (x, y) => {
			const form = blit.form(fw, fh)
			for (let j = 0; j < fh; j++) {
				for (let i = 0; i < fw; i++) {
					const px = v[Math.floor(j / sc) * stride + Math.floor(i / sc)]
					form.bits[j * fw + i] = px === undefined
						? C.check
						: (alpha ? px >>> 24 < 0x80 : px & 0x80000000)
						? (((i >> 2) + (j >> 2)) & 1 ? C.check : C.hi)
						: px & 0xffffff
				}
			}
			blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line)
			blit.blit(f, x, y, form)
		})
		B.text(`${pw} × ${ph} pixels${sc > 1 ? `, ${sc}× ` : ""}`, C.dim)
	}
	// a draw list, played as the compositor plays a layer's, then made small to fit
	let last: { list: unknown; fw: number; fh: number; form: Form } | null = null
	const played = (B: Blocks, list: any[], lw: number, lh: number) => {
		const { f, w } = B
		if (!(lw > 0 && lh > 0) || lw * lh > 1 << 23) return
		const sc = Math.min(1, Math.min(w, 520 * u) / lw, 320 * u / lh)
		const fw = Math.max(1, Math.round(lw * sc)), fh = Math.max(1, Math.round(lh * sc))
		B.push(fh + 8 * u, (x, y) => {
			// the last one played kept: a list read again, unchanged, is the same list
			if (last?.list !== list || last.fw !== fw || last.fh !== fh) {
				const whole = blit.form(lw, lh, C.check)
				try {
					blit.play(whole, list, role)
				} catch {
					// an op it cannot play: what it drew so far
				}
				const form = blit.form(fw, fh)
				for (let j = 0; j < fh; j++) {
					for (let i = 0; i < fw; i++) {
						form.bits[j * fw + i] = whole.bits[Math.floor(j / sc) * lw + Math.floor(i / sc)] &
							0xffffff
					}
				}
				last = { list, fw, fh, form }
			}
			blit.fill(f, x - u, y - u, fw + 2 * u, fh + 2 * u, C.line)
			blit.blit(f, x, y, last.form)
		})
		B.text(
			`${lw} × ${lh}, played${sc < 1 ? ` at ${Math.round(sc * 100)}%` : ""} · ${ops(list)}`,
			C.dim,
		)
	}
	// the value itself, by its kind
	const body = (B: Blocks, v: any, k: string, o: Options = {}) => {
		const { line, gap, text: say, f, w, cols } = B
		const push = B.push
		const LH = blit.height(FX) + u
		const key = o.key ?? o.name
		switch (k) {
			case "string": {
				// each line as it is: a tab →, a control character \xNN in cherry, trailing spaces ·, a line's end ¶
				const ls = v.split("\n")
				ls.slice(0, 400).forEach((l: string, i: number) => {
					const ps: Piece[] = []
					const trail = l.length - l.trimEnd().length
					let run = ""
					const flush = () => {
						if (run) ps.push([run, C.ink])
						run = ""
					}
					;[...l.slice(0, l.length - trail)].forEach((ch) => {
						const c = ch.codePointAt(0)!
						const odd = c < 0x20 || c === 0x7f || c === 0xa0 ||
							(c >= 0x200b && c <= 0x200f) || c === 0xfeff
						if (ch !== "\t" && !odd) return void (run += ch)
						flush()
						ps.push(
							ch === "\t" ? ["→", C.dim] : [c === 0xa0 ? "⍽" : `\\u${hex(c, 4)}`, C.cherry],
						)
					})
					flush()
					if (trail) ps.push(["·".repeat(trail), C.dim])
					if (i < ls.length - 1) ps.push(["¶", C.lo])
					// cut to the width by characters
					let row: Piece[] = [], n = 0
					for (const [t, c] of ps) {
						let rest = t
						while (rest.length) {
							const take = Math.max(0, cols - n)
							if (!take) {
								line(row)
								row = []
								n = 0
								continue
							}
							row.push([rest.slice(0, take), c])
							n += Math.min(take, rest.length)
							rest = rest.slice(take)
						}
					}
					line(row.length ? row : [["", C.ink]])
				})
				if (ls.length > 400) say(`… ${ls.length - 400} more lines`, C.dim)
				if (o.write) {
					gap()
					say(
						v.includes("\n")
							? "Enter or e opens it in the editor"
							: "Enter edits it in place",
						C.dim,
						F,
					)
				}
				break
			}
			case "int":
			case "float": {
				const colour = isColour(v, key, o.ctx)
				push(blit.height(FT) * 2, (x, y, clip) => {
					let nx = x
					if (colour) nx = swatch(f, x, y, v, blit.height(FT) * 2 - 4 * u) + 6 * u
					blit.text(
						f,
						nx,
						y + Math.floor(blit.height(FT) / 2),
						colour ? "#" + hex(v).toUpperCase() : number(v, key),
						C.blue,
						undefined,
						clip,
						FT,
					)
				})
				if (Number.isInteger(v) && v >= 0) {
					say(`decimal ${v}`, C.ink2)
					push(LH, (x, y) => {
						const end = blit.text(
							f,
							x,
							y,
							`hex 0x${hex(v, 1)}`,
							C.ink2,
							undefined,
							undefined,
							FX,
						)
						const t = style.hex ? "[x] hex everywhere" : "[ ] hex everywhere"
						const e2 = blit.text(f, end + 16 * u, y, t, C.rose, undefined, undefined, FX)
						B.zones.push({
							x: end + 16 * u,
							y,
							w: e2 - end - 16 * u,
							h: LH,
							act: "hex",
							role: "checkbox",
							label: "hex everywhere",
						})
					})
					if (v < 2 ** 32) say(`binary ${v.toString(2)}`, C.dim)
					if (colour) {
						say(`red ${(v >> 16) & 255} · green ${(v >> 8) & 255} · blue ${v & 255}`, C.ink2)
					}
					if (v > 1e15 && v < 1e17) {
						say(`as a time: ${new Date(v / 1000).toISOString()}`, C.dim)
					}
				} else if (Number.isFinite(v)) {
					say(`exactly ${v.toPrecision(17).replace(/\.?0+$/, "")}`, C.ink2)
				}
				if (o.write) {
					gap()
					say("Enter edits it in place: a number, 0x… or #RRGGBB", C.dim, F)
				}
				break
			}
			case "bool": {
				push(blit.height(FT) + 8 * u, (x, y) => {
					const b = blit.height(FT)
					blit.fill(f, x, y, b, b, C.line)
					blit.fill(f, x + u, y + u, b - 2 * u, b - 2 * u, C.hi)
					if (v) {
						blit.line(f, x + 2 * u, y + 2 * u, x + b - 3 * u, y + b - 3 * u, u, C.line)
						blit.line(f, x + b - 3 * u, y + 2 * u, x + 2 * u, y + b - 3 * u, u, C.line)
					}
					blit.text(
						f,
						x + b + 8 * u,
						y,
						String(v),
						v ? C.mint : C.cherry,
						undefined,
						undefined,
						FT,
					)
					if (o.write) {
						B.zones.push({
							x,
							y,
							w: b + 60 * u,
							h: b,
							act: "toggle",
							role: "checkbox",
							label: String(v),
						})
					}
				})
				if (o.write) say("a click, space or Enter turns it over", C.dim, F)
				break
			}
			case "null":
			case "none":
				say(k === "null" ? "null" : "—", C.dim, FT)
				break
			case "address": {
				const a = addressOf(v)
				push(blit.height(F) + 8 * u, (x, y) => {
					const end = blit.text(
						f,
						x,
						y,
						shown(a),
						C.rose,
						undefined,
						{ x, y, w, h: 40 * u },
						F,
					)
					blit.fill(f, x, y + blit.height(F), Math.min(end, x + w) - x, u, C.rose)
					B.zones.push({
						x,
						y,
						w: Math.min(end, x + w) - x,
						h: blit.height(F) + 2 * u,
						act: "follow",
						role: "link",
						label: shown(a),
						address: a,
					})
				})
				// what is there now
				if (!o.api) break
				let there
				try {
					// as the old core's read gave it: [{value, change}], one a member placed there
					there = (o.api.content(a) as any[]).filter((i) => i.versions).map((i) => ({
						value: first(i.versions),
						change: i.versions[0]?.change,
						id: i.id,
					}))
				} catch (e) {
					say(o.why ? o.why(e) : String((e as any)?.message ?? e), C.cherry)
					break
				}
				if (!there.length) say("nothing is there", C.cherry)
				else {
					const t = there[0], tk = kind(t.value)
					line([["there: ", C.dim], ...pieces(t.value, tk)])
					if (there.length > 1) say(`${there.length} members`, C.dim)
				}
				break
			}
			case "list":
			case "map": {
				// played: a draw list beside its w and h, pixels beside theirs, at the head
				if (o.play && k === "map" && isOps(v.draw)) played(B, v.draw, v.w, v.h)
				if (o.play && k === "list" && isOps(v) && o.parent) played(B, v, o.parent.w, o.parent.h)
				if (o.play && k === "map") {
					const px = Object.keys(v).find((x) => isPixels(v[x], v.w ?? v.cols, v.h ?? v.rows))
					if (px) pixels(B, v[px], v.w ?? v.cols, v.h ?? v.rows, v.stride ?? v.w ?? v.cols)
				}
				if (
					o.play && k === "list" && v.length && v.every((x: unknown) => typeof x === "string")
				) {
					// lines of text, as a column: each its index, then it as it is
					const iw = String(v.length - 1).length
					v.slice(0, 400).forEach((t: string, i: number) => {
						const row: Piece[] = [[String(i).padStart(iw) + " ", C.dim], [
							escaped(t, cols - iw - 1),
							C.ink,
						]]
						push(LH, (x, y, clip) => {
							text(f, x, y, row, clip)
							if (o.into) {
								B.zones.push({
									x,
									y,
									w,
									h: LH,
									act: "into",
									key: i,
									role: "button",
									label: `[${i}]`,
								})
							}
						})
					})
					if (v.length > 400) say(`… ${v.length - 400} more`, C.dim)
					break
				}
				const ks = k === "list"
					? v.map((_x: unknown, i: number) => i)
					: Object.keys(v).sort(order)
				const kw = Math.min(
					16,
					Math.max(
						3,
						...ks.slice(0, 200).map((x: unknown) =>
							String(x).length + (k === "list" ? 2 : 0)
						),
					),
				)
				for (const kk of ks.slice(0, 200)) {
					const x = v[kk], xk = kind(x, String(kk), undefined, o)
					const label = (k === "list" ? `[${kk}]` : String(kk)).padEnd(kw).slice(0, kw)
					const row: Piece[] = [
						[label + " ", k === "list" ? C.dim : C.ink],
						...pieces(
							x,
							xk,
							String(kk),
							o.key === "colors" || o.name === "colors" ? "colors" : undefined,
							o,
						),
					]
					if (!o.into) line(row)
					else {
						push(LH, (px, py, clip) => {
							text(f, px, py, row, clip)
							B.zones.push({
								x: px,
								y: py,
								w,
								h: LH,
								act: "into",
								key: kk,
								role: "button",
								label: String(kk),
							})
						})
					}
				}
				if (ks.length > 200) say(`… ${ks.length - 200} more`, C.dim)
				if (o.name === "draw" && k === "list") {
					gap()
					say(ops(v), C.ink2)
				}
				break
			}
			case "bytes": {
				const b = bytesOf(v), t = utf8(b)
				say(
					t === null ? "not UTF-8" : `looks like UTF-8: ${[...t].length} characters`,
					t === null ? C.dim : C.mint,
					F,
				)
				if (t !== null && b.length) {
					for (const l of t.slice(0, 2000).split("\n").slice(0, 12)) {
						say(escaped(l, 400), C.lilac)
					}
					gap()
				}
				// the dump: offset, 16 bytes in two eights, what they are as characters
				const per = cols >= 70 ? 16 : 8
				for (let at = 0; at < Math.min(b.length, 4096); at += per) {
					const row = [...b.slice(at, at + per)]
					const hx = row.map((x) => hex(x, 2)).join(" ").padEnd(per * 3 - 1)
					const as = row.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : "·"))
						.join("")
					line([[hex(at, 4) + "  ", C.dim], [hx + "  ", C.ink], [as, C.lilac]])
				}
				if (b.length > 4096) say(`… ${b.length - 4096} more bytes`, C.dim)
				break
			}
			case "typed": {
				const xs = Array.from(v as ArrayLike<number | bigint>, (x) => Number(x))
				let lo = Infinity, hi = -Infinity, sum = 0
				for (const x of xs) {
					if (x < lo) lo = x
					if (x > hi) hi = x
					sum += x
				}
				if (xs.length) {
					say(
						`min ${number(lo)} · max ${number(hi)} · mean ${
							number(+(sum / xs.length).toPrecision(6))
						}`,
						C.ink2,
					)
				}
				// pixels, w × h from the map it is in: a picture of them
				const p = o.parent ?? (o.ctx as any)
				const pw = p?.w ?? p?.cols, ph = p?.h ?? p?.rows
				if (isPixels(v, pw, ph)) pixels(B, v, pw, ph, p.stride ?? pw)
				else if (xs.length > 1) {
					// a sparkline: each column the mean of what falls in it
					const n = Math.min(xs.length, Math.floor(w / (2 * u)))
					const hh = 40 * u
					push(hh + 8 * u, (x, y) => {
						blit.fill(f, x, y + hh, n * 2 * u, u, C.lo)
						for (let i = 0; i < n; i++) {
							const a = Math.floor((i * xs.length) / n),
								z = Math.max(a + 1, Math.floor(((i + 1) * xs.length) / n))
							let m = 0
							for (let j = a; j < z; j++) m += xs[j]
							m /= z - a
							const bh = hi > lo ? Math.max(u, Math.round(((m - lo) / (hi - lo)) * hh)) : u
							blit.fill(f, x + i * 2 * u, y + hh - bh, u + (u > 1 ? u - 1 : 0), bh, C.teal)
						}
					})
				}
				// pixels in hex, as 0xAARRGGBB
				const px = v instanceof Uint32Array && /pixels|bits|colou?rs/.test(String(key))
				const per = Math.max(1, Math.floor(cols / 12))
				for (let i = 0; i < Math.min(xs.length, 512); i += per) {
					line([[`[${i}]`.padEnd(7), C.dim], [
						Array.from(
							v.slice(i, i + per) as ArrayLike<number | bigint>,
							(x) => (typeof x === "bigint" ? String(x) : px ? hex(x, 8) : number(x)),
						).map((t) => t.padStart(10)).join(" "),
						C.teal,
					]])
				}
				if (xs.length > 512) say(`… ${xs.length - 512} more`, C.dim)
				break
			}
			case "picture": {
				picture(B, v)
				for (
					const [letter, c] of Object.entries(v.colors ?? {}).sort((a, b) => order(a[0], b[0]))
				) {
					line([[`${letter}  `, C.ink], ["", C.ink, c as number], [
						`#${hex(c as number).toUpperCase()}`,
						C.blue,
					]])
				}
				gap()
				say("e opens it in Paint", C.dim, F)
				break
			}
			case "view": {
				// its view: the key it shows first, as what that is; then every key, as a map's
				const view = viewOf(v)!
				if (typeof view.show === "string" && view.show in v) {
					const x = v[view.show]
					const xk = kind(x, view.show, undefined, o)
					say(view.show, C.ink2, F)
					body(B, x, xk === "view" ? "map" : xk, {
						...o,
						key: view.show,
						name: view.show,
						parent: v,
						ctx: v,
						write: false,
					})
					B.rule()
				}
				body(B, v, "map", { ...o, play: false })
				break
			}
			case "id":
				say(v, C.lilac)
				break
			case "fn":
				push(blit.height(FT) + 6 * u, (x, y) => tag(f, x, y, "fn", C.paper, C.line, C.line))
				if (o.address) say(`call ${shown(o.address)} [json…]   in a shell`, C.dim)
				break
			case "proc":
				say("→ goes into it", C.dim, F)
				break
			default:
				push(
					blit.height(FT) + 6 * u,
					(x, y) => tag(f, x, y, `live ${liveName(v)}`.trim(), C.lilac, undefined, C.lilac),
				)
		}
	}
	/** a value's whole view in R: what it is, then it, from scroll down; the scroll it could be and what can be clicked */
	const pane = (
		f: Target,
		R: Rect,
		v: any,
		o: Options & { kind?: string; scroll?: number } = {},
	) => {
		const k = o.kind ?? kind(v, o.key, o.ctx, o)
		const B = blocks(f, R.w - 20 * u)
		B.text(about(v, k, o), C.ink2, F)
		B.rule()
		body(B, v, k, o)
		const scroll = lay(B, R, o.scroll ?? 0)
		return { scroll, zones: B.zones, kind: k }
	}
	const hit = (zones: Zone[], x: number, y: number) =>
		[...zones].reverse().find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) ??
			null

	// --- editing a simple value in place: a readline field
	const simple = ["string", "int", "float", "null"]
	/** a field to edit v in, or null: a string of one line, a number, a null (which may become anything JSON says) */
	const edit = (v: any, k: string, o: Options = {}): readline.Field | null => {
		if (!simple.includes(k) || (k === "string" && v.includes("\n"))) return null
		const t = k === "string" ? v : k === "null" ? "" : number(v, o.key ?? o.name, o.ctx)
		return { text: t, pos: t.length, mark: t ? 0 : null }
	}
	/** what a field's text means as a value of that kind: a number as written, decimal, 0x… or #RRGGBB; a null's, JSON or a string */
	const parse = (t: string, k: string): { value?: unknown; error?: string; none?: boolean } => {
		if (k === "string") return { value: t }
		if (k === "null") {
			if (t.trim() === "") return { none: true }
			try {
				return { value: JSON.parse(t) }
			} catch {
				return { value: t }
			}
		}
		const m = /^#([0-9a-f]{6})$/i.exec(t.trim())
		const n = m
			? parseInt(m[1], 16)
			: /^-?0x[0-9a-f]+$/i.test(t.trim())
			? parseInt(t.trim(), 16)
			: t.trim() === ""
			? NaN
			: Number(t.trim())
		if (Number.isNaN(n) && t.trim() !== "NaN") return { error: `not a number: ${t}` }
		return { value: n }
	}
	/** a field in box b: its text from where the caret shows, the selection on lemon, the caret at pos; where the caret is */
	const field = (f: Target, b: Rect, x: readline.Field) => {
		const t = x.text, room = b.w - 8 * u
		let from = 0
		while (from < x.pos && blit.measure(t.slice(from, x.pos), FX) > room) from++
		const at = (i: number) => b.x + 4 * u + blit.measure(t.slice(from, Math.max(from, i)), FX)
		blit.fill(f, b.x, b.y, b.w, b.h, C.line)
		blit.fill(f, b.x + u, b.y + u, b.w - 2 * u, b.h - 2 * u, C.hi)
		const clip = { x: b.x + u, y: b.y, w: b.w - 2 * u, h: b.h }
		const sel = readline.selection(x)
		if (sel) {
			blit.fill(
				f,
				at(sel[0]),
				b.y + 2 * u,
				Math.max(u, at(sel[1]) - at(sel[0])),
				b.h - 4 * u,
				C.lemon,
				clip,
			)
		}
		blit.text(
			f,
			b.x + 4 * u,
			b.y + Math.floor((b.h - blit.height(FX)) / 2),
			t.slice(from),
			C.ink,
			undefined,
			clip,
			FX,
		)
		const cx = Math.min(b.x + b.w - 3 * u, at(x.pos))
		blit.fill(f, cx, b.y + 2 * u, 2 * u, b.h - 4 * u, C.rose)
		return { text: t, pos: x.pos, x: cx, y: b.y + 2 * u, h: b.h - 4 * u, from, b }
	}
	/** where a click at x in a field drawn as caret says lands: an offset in its text */
	const click = (caret: { text: string; from: number; b: Rect }, x: number) =>
		caret.from + blit.at(caret.text.slice(caret.from), x - caret.b.x - 4 * u, FX)

	return {
		fonts,
		kinds,
		kind,
		badge,
		pieces,
		number,
		summary,
		about,
		text,
		tag,
		swatch,
		fitted,
		blocks,
		body,
		lay,
		pane,
		hit,
		edit,
		parse,
		field,
		click,
		order,
		addressOf,
		shown,
		short,
		clock,
		when,
		who,
		head,
		ids,
		site,
		did,
		itemOf,
		changes,
		away,
		ops,
		size,
	}
}
