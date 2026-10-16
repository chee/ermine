// The disk of the store's and the program's harnesses (store_harness.ts, program_harness.ts): a temp
// folder of the run's own, the edits made on it between requests, and what it shows when looked
// at. A harness makes the edits and the snapshots itself, the same for every implementation, as a
// person's Finder would: never through the store. Nothing here is the store's or the program's rule.
//
// The temp folder holds Store (the store's folder), Trash (the fake Trash, made by the store or an
// edit), Home (a test home, there from the start: ~/.ermine/external is @Home/.ermine/external),
// Outside (the one place the store's host names, made by an edit when needed) and scratch (where a
// write is made before it is renamed in).
//
// A path in an edit or a request is from the store's folder ("" is the folder itself), or, written
// "@path", from the temp folder ("@" is the temp folder itself):
//   {edit: "write", path, text | hex, keep?}  a file's bytes: written beside it and renamed over it,
//                       a new file id and no extended attributes, as an app saves; keep: written in
//                       place, its time then set to 2001-01-01, so it is never the file as laid
//   {edit: "mkdir", path}  {edit: "remove", path} (all of it)  {edit: "rename", from, to}
//   {edit: "link", path, target}
//   {edit: "copy", from, to}  as Duplicate: every entry, hidden ones and extended attributes too
//                       (cp -Rp)
//   {edit: "attr", path, name, text | hex}  {edit: "unattr", path, name}  the entry's own
//   {edit: "id", path, of}  the file's party.chee.ermine.id set to the id an answer showed as `of`
//   {edit: "cut", path, by}  the file less its last by bytes
//   {edit: "unframe", count, leave}  .ermine/manifest less its last count whole frames, but the
//                       first leave bytes of the first of them: a frame cut short
//   {edit: "append", path, hex}
//   {edit: "frame", records}  a frame appended to .ermine/manifest: 4 bytes big-endian of its
//                       length, then the CBOR of {key: bytes | null}; records {key: hex | null},
//                       but plan given decoded, in JSON form (conformance/typescript/form.ts), each
//                       folder's file id in a step's before or after written {"ino": path}, the
//                       file id of what is at path now
//
// What a run shows of what is not the same each run, in every answer and snapshot: the temp folder
// in a path is "@", and each label's kind (Labels) by the order met.
import * as cbor from "@ermine/encoding/cbor"
import { byCodePoint } from "./names.ts"
import { attr, type Sys, system } from "./sys.ts"
import { fromJson, toJson } from "../../../conformance/typescript/form.ts"

// the platform's calls, made when first needed
let made: Sys | undefined
const sys = new Proxy({} as Sys, { get: (_, k) => (made ??= system())[k as keyof Sys] })
const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true })
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

/** What is labelled: the pattern, and the label of the nth met (from 0). */
export type Labels = { pattern: RegExp; label: (n: number) => string }
/** A store's uuids: "uuid", then "uuid2", "uuid3", ... */
export const UUIDS: Labels = {
	pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
	label: (n) => n === 0 ? "uuid" : `uuid${n + 1}`,
}
/** The ids a harness mints ("i" and a number): "id1", "id2", ... */
export const IDS: Labels = {
	pattern: /(?<![A-Za-z0-9_-])i\d+(?![A-Za-z0-9_-])/g,
	label: (n) => `id${n + 1}`,
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The run's temp folder, its labels, and the paths of a scenario. */
export class Disk {
	#label = new Map<string, string>()
	readonly store: string
	readonly trash: string
	readonly home: string
	readonly outside: string
	readonly scratch: string
	private constructor(readonly dir: string, readonly labels: Labels) {
		this.store = `${dir}/Store`
		this.trash = `${dir}/Trash`
		this.home = `${dir}/Home`
		this.outside = `${dir}/Outside`
		this.scratch = `${dir}/scratch`
	}
	/** A new temp folder, with Home and scratch in it. */
	static async make(prefix: string, labels: Labels): Promise<Disk> {
		const dir = await Deno.realPath(await Deno.makeTempDir({ prefix }))
		await Deno.mkdir(`${dir}/scratch`)
		await Deno.mkdir(`${dir}/Home`)
		return new Disk(dir, labels)
	}
	async remove() {
		await Deno.remove(this.dir, { recursive: true })
	}
	/** The label of what was met. */
	label(raw: string): string {
		let l = this.#label.get(raw)
		if (l === undefined) this.#label.set(raw, l = this.labels.label(this.#label.size))
		return l
	}
	/** A label's raw text, for a request; what is not a label as it is. */
	raw(l: string): string {
		for (const [u, x] of this.#label) if (x === l) return u
		return l
	}
	/** A string, the temp folder as "@" and each label's kind as its label. */
	text(s: string): string {
		return s.replaceAll(this.dir + "/", "@").replaceAll(this.dir, "@")
			.replace(this.labels.pattern, (u) => this.label(u))
	}
	/** Every string in a JSON value, as text. */
	deep(v: unknown): unknown {
		if (typeof v === "string") return this.text(v)
		if (Array.isArray(v)) return v.map((x) => this.deep(x))
		if (v !== null && typeof v === "object") {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)]))
		}
		return v
	}
	/** A path of a scenario: "@x" is x in the temp folder, the rest from folder. */
	path(p: string, folder: string): string {
		return p.startsWith("@") ? this.dir + "/" + p.slice(1) : p === "" ? folder : `${folder}/${p}`
	}

	/** An edit, its plain paths from folder. */
	async edit(e: Record<string, unknown>, folder: string) {
		const at = (p: unknown) => this.path(p as string, folder)
		switch (e.edit) {
			case "write": {
				const bytes = bytesOf(e)
				if (e.keep) {
					await Deno.writeFile(at(e.path), bytes)
					const t = new Date("2001-01-01T00:00:00Z")
					await Deno.utime(at(e.path), t, t)
				} else {
					await Deno.writeFile(`${this.scratch}/edit`, bytes)
					await Deno.rename(`${this.scratch}/edit`, at(e.path))
				}
				return
			}
			case "mkdir":
				return await Deno.mkdir(at(e.path), { recursive: true })
			case "remove":
				return await Deno.remove(at(e.path), { recursive: true })
			case "rename":
				return await Deno.rename(at(e.from), at(e.to))
			case "link":
				return await Deno.symlink(e.target as string, at(e.path))
			case "copy": {
				const r = await new Deno.Command("cp", { args: ["-Rp", at(e.from), at(e.to)] }).output()
				if (!r.success) throw new Error("cp failed")
				return
			}
			case "attr":
				return await sys.set(at(e.path), e.name as string, bytesOf(e))
			case "unattr":
				return await sys.unset(at(e.path), e.name as string)
			case "id":
				return await sys.set(at(e.path), attr.id, utf8.encode(this.raw(e.of as string)))
			case "cut": {
				const { size } = await Deno.lstat(at(e.path))
				return await Deno.truncate(at(e.path), size - (e.by as number))
			}
			case "unframe": {
				const log = `${folder}/.ermine/manifest`
				const bytes = await Deno.readFile(log)
				const view = new DataView(bytes.buffer)
				const starts: number[] = []
				for (let i = 0; i + 4 <= bytes.length; i += 4 + view.getUint32(i)) starts.push(i)
				const from = starts[starts.length - (e.count as number)]
				return await Deno.truncate(log, from + (e.leave as number))
			}
			case "append":
				return await Deno.writeFile(at(e.path), unhex(e.hex as string), { append: true })
			case "frame":
				return await Deno.writeFile(
					`${folder}/.ermine/manifest`,
					frame(e.records as Record<string, unknown>, at),
					{ append: true },
				)
			default:
				throw new Error(`unknown edit ${e.edit}`)
		}
	}
}

const bytesOf = (e: { text?: unknown; hex?: unknown }) =>
	typeof e.hex === "string" ? unhex(e.hex) : utf8.encode(String(e.text ?? ""))

/** A plan in JSON form, each {"ino": path} the file id of what is at path, as the store encodes one. */
function plan(json: unknown, at: (path: string) => string): Uint8Array {
	const steps = (json as Record<string, unknown>[]).map((s) => {
		const out = { ...s }
		for (const k of ["before", "after"]) {
			const f = out[k] as { folder?: unknown } | null
			if (f && typeof f.folder === "object" && f.folder !== null && "ino" in f.folder) {
				out[k] = { folder: Deno.lstatSync(at((f.folder as { ino: string }).ino)).ino }
			}
		}
		return out
	})
	return cbor.encode(fromJson(steps) as cbor.Value)
}

/** A frame: 4 bytes big-endian of its length, then the CBOR of its records. */
function frame(records: Record<string, unknown>, at: (path: string) => string): Uint8Array {
	const map: Record<string, cbor.Value> = {}
	for (const [k, v] of Object.entries(records)) {
		if (v === null) map[k] = null
		else if (k === "plan" && Array.isArray(v)) map[k] = plan(v, at)
		else map[k] = unhex(v as string)
	}
	const body = cbor.encode(map)
	const out = new Uint8Array(4 + body.length)
	new DataView(out.buffer).setUint32(0, body.length)
	out.set(body, 4)
	return out
}

// ---- what the store's harness shows
//
// A snapshot: {folder, trash, listed, at?}. observe: {attrs?, folder?, at?}: folder, "@..", is the
// folder shown in place of the store's; at, a list of "@.." paths, each shown, folders and all,
// under the key at, a folder or file there null if it is not: at[path] is what folder is. folder
// and trash: every entry under them, the store's folder itself as "" (null if it is not there; []
// for a Trash never made), by path in code point order: {path, kind: "file" | "folder" | "link",
// hex (a file's bytes) | target (a link's), attrs?}; attrs the entry's own extended attributes
// named party.chee.ermine.*, and any names observe.attrs gives, each as UTF-8 text, or {hex} if it
// is not. .ermine/manifest is shown as {frames, rest?}: each whole frame's records {key: hex |
// null}, the plan decoded as the frame edit takes it, and raw (hex) if the frame is not the
// canonical CBOR of its records; rest the bytes after the last whole frame, hex.
// A uuid in party.chee.ermine.store is labelled, the folders shown met before anything else, in
// order; the list of stores (.ermine/external/stores) is shown as {stores: [{uuid, path}]} by path,
// no bookmark; a folder's file id in a plan is {"ino": path} of what has it now in the folder, or
// in the Trash as "trash/<path>", or {"ino": "#n"}, n counting the others from 1 in order met; a
// file's time and id are never shown.

type Shown = Record<string, unknown> & { path: string; kind: string }

async function storeAttrs(path: string, extra: readonly string[], d: Disk) {
	const out: Record<string, unknown> = {}
	const all = (await sys.names(path)).filter((n) => n.startsWith(attr.own) || extra.includes(n))
	for (const n of all.sort(byCodePoint)) {
		const b = (await sys.get(path, n))!
		let v: unknown
		try {
			const t = strict.decode(b)
			v = t.includes("\0") ? { hex: hex(b) } : t
		} catch {
			v = { hex: hex(b) }
		}
		if (n === attr.store && typeof v === "string" && UUID.test(v)) v = d.label(v)
		out[n] = v
	}
	return out
}

/** Every entry under dir, dir itself as "" (as label if there is one) if self, by path; with each one's file id. */
async function storeWalk(
	dir: string,
	self: boolean,
	extra: readonly string[],
	d: Disk,
	label = "",
) {
	const out: { shown: Shown; abs: string; ino: number | null; isDir: boolean }[] = []
	const one = async (abs: string, path: string) => {
		const st = await Deno.lstat(abs)
		const shown: Shown = {
			path: d.text(path),
			kind: st.isSymlink ? "link" : st.isDirectory ? "folder" : st.isFile ? "file" : "other",
		}
		if (st.isSymlink) shown.target = await Deno.readLink(abs)
		else if (st.isFile) shown.hex = hex(await Deno.readFile(abs))
		const a = await storeAttrs(abs, extra, d)
		if (Object.keys(a).length) shown.attrs = a
		out.push({ shown, abs, ino: st.ino, isDir: st.isDirectory })
		if (st.isDirectory) {
			for await (const e of Deno.readDir(abs)) {
				await one(`${abs}/${e.name}`, path === "" ? e.name : `${path}/${e.name}`)
			}
		}
	}
	try {
		await Deno.lstat(dir)
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return undefined
		throw e
	}
	const sub = (name: string) => (label === "" ? name : `${label}/${name}`)
	if (self) await one(dir, label)
	else for await (const e of Deno.readDir(dir)) await one(`${dir}/${e.name}`, sub(e.name))
	out.sort((a, b) => byCodePoint(a.shown.path, b.shown.path))
	return out
}

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

/** The manifest's frames, the plan decoded, each folder's file id as what has it. */
function frames(bytes: Uint8Array, ino: (n: number) => string) {
	const out: unknown[] = []
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let at = 0
	while (at + 4 <= bytes.length) {
		const end = at + 4 + view.getUint32(at)
		if (end > bytes.length) break
		const body = bytes.subarray(at + 4, end)
		let f: cbor.Value
		try {
			f = cbor.decode(body)
		} catch {
			break
		}
		if (f === null || typeof f !== "object" || Array.isArray(f) || ArrayBuffer.isView(f)) break
		const records: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(f as Record<string, cbor.Value>)) {
			if (!(v instanceof Uint8Array)) {
				records[k] = v === null ? null : toJson(v)
				continue
			}
			records[k] = k === "plan" ? planOf(v, ino) : hex(v)
		}
		const shown: Record<string, unknown> = { records }
		if (!same(cbor.encode(f), body)) shown.raw = hex(body)
		out.push(shown)
		at = end
	}
	const result: Record<string, unknown> = { frames: out }
	if (at < bytes.length) result.rest = hex(bytes.subarray(at))
	return result
}

function planOf(b: Uint8Array, ino: (n: number) => string): unknown {
	let steps: cbor.Value
	try {
		steps = cbor.decode(b)
	} catch {
		return hex(b)
	}
	if (!Array.isArray(steps) || !same(cbor.encode(steps), b)) return hex(b)
	return toJson(steps.map((s) => {
		if (s === null || typeof s !== "object" || Array.isArray(s)) return s
		const out: Record<string, unknown> = { ...(s as Record<string, unknown>) }
		for (const k of ["before", "after"]) {
			const f = out[k] as { folder?: unknown } | null
			if (f && typeof f.folder === "number") out[k] = { folder: { ino: ino(f.folder) } }
		}
		return out
	}))
}

/** The list of stores, as shown: each uuid's last path, by path. */
function listOf(bytes: Uint8Array, d: Disk) {
	const v = cbor.decode(bytes) as Record<string, { path: string }>
	return Object.entries(v).map(([u, e]) => ({
		uuid: UUID.test(u) ? d.label(u) : u,
		path: d.text(e.path),
	}))
		.sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.uuid, b.uuid))
}

/** The store's harness's snapshot of folder (the one shown), the Trash, and what was listed (shown already). */
export async function storeSnapshot(
	d: Disk,
	folder: string,
	listed: unknown,
	look: { attrs?: string[]; at?: string[] },
) {
	const extra = look.attrs ?? []
	const more = (look.at ?? []).map((p) => ({ label: p, abs: d.path(p, d.store) }))
	// the uuids of the folders shown come first in the labels, in order
	for (const abs of [folder, ...more.map((m) => m.abs)]) {
		try {
			const b = await sys.get(abs, attr.store)
			if (b) {
				const t = strict.decode(b)
				if (UUID.test(t)) d.label(t)
			}
		} catch {
			// not there, or not a folder
		}
	}
	const inside = await storeWalk(folder, true, extra, d)
	const bin = await storeWalk(d.trash, false, extra, d)
	const elsewhere = await Promise.all(more.map((m) => storeWalk(m.abs, true, extra, d, m.label)))
	const inos = new Map<number, string>()
	for (const e of bin ?? []) {
		if (e.isDir && e.ino !== null) inos.set(e.ino, `trash/${e.shown.path}`)
	}
	for (const w of elsewhere) {
		for (const e of w ?? []) if (e.isDir && e.ino !== null) inos.set(e.ino, e.shown.path)
	}
	for (const e of inside ?? []) if (e.isDir && e.ino !== null) inos.set(e.ino, e.shown.path)
	const others = new Map<number, string>()
	const ino = (n: number) =>
		inos.get(n) ?? others.get(n) ?? (others.set(n, `#${others.size + 1}`), others.get(n)!)
	const shown = (list: typeof inside) =>
		(list ?? []).map((e) => {
			const p = e.shown.path
			if (e.shown.kind !== "file") return e.shown
			if (
				p === ".ermine/manifest" || p.endsWith("/.ermine/manifest") ||
				/\/\.ermine\/external\/[^/]+\/manifest$/.test(p)
			) {
				const { hex: h, ...rest } = e.shown
				return { ...rest, ...frames(unhex(h as string), ino) }
			}
			if (p.endsWith("/.ermine/external/stores")) {
				const { hex: h, ...rest } = e.shown
				return { ...rest, stores: listOf(unhex(h as string), d) }
			}
			return e.shown
		})
	const out: Record<string, unknown> = {
		folder: inside ? shown(inside) : null,
		trash: (bin ?? []).map((e) => e.shown),
		listed,
	}
	if (more.length) {
		out.at = Object.fromEntries(
			more.map((m, i) => [m.label, elsewhere[i] ? shown(elsewhere[i]) : null]),
		)
	}
	return out
}

// ---- what the program's harness shows
//
// A snapshot: {folder, trash, listed}: every entry under the store's folder (the folder itself as
// ""), and under the Trash (null if it is not there), by path in code point order: {path, kind:
// "file" | "folder" | "link", hex (a file's bytes) | target (a link's), attrs?}; attrs the entry's
// extended attributes named party.chee.ermine.id, .slot (decoded: [holder, slot]) and .side. Not
// shown: .ermine's manifest, tmp, values and external, and the store's uuid. Ids are labelled in
// the order met: listed first, then the folder's entries in path order.

const KEPT = [attr.id, attr.slot, attr.side]

async function programAttrs(path: string) {
	const out: Record<string, unknown> = {}
	const all = (await sys.names(path)).filter((n) => KEPT.includes(n))
	for (const n of all.sort(byCodePoint)) {
		const b = (await sys.get(path, n))!
		let v: unknown
		if (n === attr.slot) {
			try {
				v = cbor.decode(b)
			} catch {
				v = { hex: hex(b) }
			}
		} else {
			try {
				const t = strict.decode(b)
				v = t.includes("\0") ? { hex: hex(b) } : t
			} catch {
				v = { hex: hex(b) }
			}
		}
		out[n] = v
	}
	return out
}

const hidden = (p: string) =>
	p === ".ermine/manifest" || p === ".ermine/tmp" || p.startsWith(".ermine/tmp/") ||
	p === ".ermine/values" || p.startsWith(".ermine/values/") || p === ".ermine/external" ||
	p.startsWith(".ermine/external/")

async function programWalk(dir: string, self: boolean) {
	const out: Shown[] = []
	const one = async (abs: string, path: string) => {
		const st = await Deno.lstat(abs)
		const shown: Shown = {
			path,
			kind: st.isSymlink ? "link" : st.isDirectory ? "folder" : st.isFile ? "file" : "other",
		}
		if (st.isSymlink) shown.target = await Deno.readLink(abs)
		else if (st.isFile) shown.hex = hex(await Deno.readFile(abs))
		const a = await programAttrs(abs)
		if (Object.keys(a).length) shown.attrs = a
		if (!hidden(path)) out.push(shown)
		if (st.isDirectory) {
			for await (const e of Deno.readDir(abs)) {
				await one(`${abs}/${e.name}`, path === "" ? e.name : `${path}/${e.name}`)
			}
		}
	}
	try {
		await Deno.lstat(dir)
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return undefined
		throw e
	}
	if (self) await one(dir, "")
	else for await (const e of Deno.readDir(dir)) await one(`${dir}/${e.name}`, e.name)
	// ids are met in path order, so the labels do not depend on the order the disk lists
	out.sort((a, b) => byCodePoint(a.path, b.path))
	return out
}

/** The program's harness's snapshot of the store's folder, the Trash, and what was listed (shown already). */
export async function programSnapshot(d: Disk, listed: unknown) {
	const inside = await programWalk(d.store, true)
	const bin = await programWalk(d.trash, false)
	const relabel = (l: Shown[] | undefined) => l === undefined ? null : d.deep(l)
	return { folder: relabel(inside), trash: relabel(bin), listed }
}
