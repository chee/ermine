// Runs a files program scenario against a program harness (harness.ts has the protocol), for
// program_test.ts, and for fixtures.ts, which records the reference's answers. A scenario:
// {title, steps}, each step one of
//   {request, expect}   sent to the harness; open's folder (the store's), trash and home filled in
//                       here; answers normalised (below)
//   {edit}              made on the disk here, by the runner, never the harness, so every
//                       implementation meets the same edits
//   {observe, expect}   a snapshot made here: the folder, the Trash, and what the harness listed
// in one temp folder of its own: the store at <temp>/Store, its Trash <temp>/Trash, the test home
// <temp>/Home. A harness process per scenario.
//
// Edits, paths from the store's folder ("" is the folder itself), or "@path" from the temp
// folder ("@Trash/x"; the Trash is a folder an edit makes first: {edit: "mkdir", path: "@Trash"}):
//   {edit: "write", path, text | hex, keep?}  a file's bytes: written beside it and renamed over
//                       it, a new file id and no extended attributes, as an app saves; keep:
//                       written in place, its time then set to 2001-01-01
//   {edit: "mkdir", path}  {edit: "remove", path} (all of it)  {edit: "rename", from, to}
//   {edit: "link", path, target}
//   {edit: "copy", from, to}  as Duplicate: every entry, extended attributes too (cp -Rp)
//   {edit: "attr", path, name, text | hex}  {edit: "unattr", path, name}  the entry's own
//   {edit: "id", path, of}  the file's party.chee.ermine.id set to the id the harness gave the node
//                       a request answered as the label `of` ("id1", ...)
// A snapshot: {folder, trash, listed}: every entry under the store's folder (the folder itself
// as ""), and under the Trash (null if it is not there), by path in code point order: {path, kind:
// "file" | "folder" | "link", hex (a file's bytes) | target (a link's), attrs?}; attrs the entry's
// extended attributes named party.chee.ermine.id, .slot (decoded: [holder, slot]) and .side. Not
// shown: .ermine's manifest, tmp and values, and the store's uuid.
// Normalised, and nothing else: an id the harness minted ("i" and a number) is "id1" for the
// first met, "id2" for the next, in anything the harness answered and anything seen on disk, the
// answers and folder in the order the steps come; the temp folder in a path is "@".
import * as cbor from "../../encoding/ts/cbor.ts"
import { byCodePoint } from "../../files/ts/names.ts"
import { attr, type Sys, system } from "../../files/ts/sys.ts"
import { line } from "../pack/form.ts"

export type Step =
	| {
		request: Record<string, unknown> & { op: string }
		edit?: never
		observe?: never
		expect?: unknown
	}
	| { edit: string; request?: never; observe?: never; [k: string]: unknown }
	| { observe: Record<string, never>; request?: never; edit?: never; expect?: unknown }
export type Scenario = { title: string; steps: Step[] }

let made: Sys | undefined
const sys = new Proxy({} as Sys, { get: (_, k) => (made ??= system())[k as keyof Sys] })
const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true })
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const IDS = /(?<![A-Za-z0-9_-])i\d+(?![A-Za-z0-9_-])/g

/** What a run shows of what is not the same each run: ids, by the order met, and the temp folder. */
class Names {
	#label = new Map<string, string>()
	constructor(readonly dir: string) {}
	id(u: string): string {
		let l = this.#label.get(u)
		if (l === undefined) this.#label.set(u, l = `id${this.#label.size + 1}`)
		return l
	}
	/** A label's id, for an edit. */
	raw(l: string): string {
		for (const [u, x] of this.#label) if (x === l) return u
		return l
	}
	text(s: string): string {
		return s.replaceAll(this.dir + "/", "@").replaceAll(this.dir, "@")
			.replace(IDS, (u) => this.id(u))
	}
	deep(v: unknown): unknown {
		if (typeof v === "string") return this.text(v)
		if (Array.isArray(v)) return v.map((x) => this.deep(x))
		if (v !== null && typeof v === "object") {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)]))
		}
		return v
	}
	path(p: string, folder: string): string {
		return p.startsWith("@") ? this.dir + "/" + p.slice(1) : p === "" ? folder : `${folder}/${p}`
	}
}

/** A harness, asked one line at a time. */
function spawn(command: string[]) {
	const child = new Deno.Command(command[0], {
		args: command.slice(1),
		stdin: "piped",
		stdout: "piped",
		stderr: "inherit",
	}).spawn()
	const w = child.stdin.getWriter()
	const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
	let buffer = ""
	async function next(): Promise<string> {
		for (;;) {
			const i = buffer.indexOf("\n")
			if (i !== -1) {
				const l = buffer.slice(0, i)
				buffer = buffer.slice(i + 1)
				if (l.trim()) return l
				continue
			}
			const { value, done } = await lines.read()
			if (done) throw new Error("the harness ended without answering")
			buffer += value
		}
	}
	return {
		async ask(request: unknown): Promise<unknown> {
			await w.write(utf8.encode(line(request) + "\n"))
			let timer: ReturnType<typeof setTimeout> | undefined
			const late = new Promise<never>((_, no) => {
				timer = setTimeout(() => no(new Error("no answer in 60s")), 60_000)
			})
			try {
				return JSON.parse(await Promise.race([next(), late]))
			} finally {
				clearTimeout(timer)
			}
		},
		async close() {
			await w.close().catch(() => {})
			await lines.cancel().catch(() => {})
			try {
				child.kill()
			} catch {
				// already gone
			}
			await child.status
		},
	}
}

// ---- edits

const bytesOf = (e: { text?: unknown; hex?: unknown }) =>
	typeof e.hex === "string" ? unhex(e.hex) : utf8.encode(String(e.text ?? ""))

async function edit(e: Record<string, unknown>, folder: string, scratch: string, names: Names) {
	const at = (p: unknown) => names.path(p as string, folder)
	switch (e.edit) {
		case "write": {
			const bytes = bytesOf(e)
			if (e.keep) {
				await Deno.writeFile(at(e.path), bytes)
				const t = new Date("2001-01-01T00:00:00Z")
				await Deno.utime(at(e.path), t, t)
			} else {
				await Deno.writeFile(`${scratch}/edit`, bytes)
				await Deno.rename(`${scratch}/edit`, at(e.path))
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
			return await sys.set(at(e.path), attr.id, utf8.encode(names.raw(e.of as string)))
		default:
			throw new Error(`unknown edit ${e.edit}`)
	}
}

// ---- a snapshot

type Shown = Record<string, unknown> & { path: string; kind: string }
const KEPT = [attr.id, attr.slot, attr.side]

async function attrs(path: string) {
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

async function walk(dir: string, self: boolean, label = "") {
	const out: Shown[] = []
	const one = async (abs: string, path: string) => {
		const st = await Deno.lstat(abs)
		const shown: Shown = {
			path: path,
			kind: st.isSymlink ? "link" : st.isDirectory ? "folder" : st.isFile ? "file" : "other",
		}
		if (st.isSymlink) shown.target = await Deno.readLink(abs)
		else if (st.isFile) shown.hex = hex(await Deno.readFile(abs))
		const a = await attrs(abs)
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
	if (self) await one(dir, label)
	else for await (const e of Deno.readDir(dir)) await one(`${dir}/${e.name}`, e.name)
	// ids are met in path order, so the labels do not depend on the order the disk lists
	out.sort((a, b) => byCodePoint(a.path, b.path))
	return out
}

async function snapshot(folder: string, trash: string, listed: unknown, names: Names) {
	const inside = await walk(folder, true)
	const bin = await walk(trash, false)
	const relabel = (l: Shown[] | undefined) => l === undefined ? null : names.deep(l)
	return { folder: relabel(inside), trash: relabel(bin), listed }
}

/** Runs a scenario: each step's answer or snapshot, undefined for an edit. */
export async function run(scenario: Scenario, command: string[]): Promise<unknown[]> {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-program-conf-" }))
	const names = new Names(dir)
	const store = `${dir}/Store`, trash = `${dir}/Trash`
	const scratch = `${dir}/scratch`
	await Deno.mkdir(scratch)
	await Deno.mkdir(`${dir}/Home`)
	const h = spawn(command)
	const out: unknown[] = []
	try {
		for (const step of scenario.steps) {
			if (step.request) {
				let r: Record<string, unknown> = step.request
				if (r.op === "open") r = { ...r, folder: store, trash, home: `${dir}/Home` }
				out.push(names.deep(await h.ask(r)))
			} else if (step.edit !== undefined) {
				await edit(step as Record<string, unknown>, store, scratch, names)
				out.push(undefined)
			} else {
				const listed = names.deep(await h.ask({ op: "listed" }))
				out.push(await snapshot(store, trash, listed, names))
			}
		}
	} finally {
		await h.close()
		await Deno.remove(dir, { recursive: true })
	}
	return out
}
