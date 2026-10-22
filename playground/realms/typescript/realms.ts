// realms: a host runner that runs a program in a worker, with ermine on both sides (worker.ts)
//
//   page (main thread)                           worker (worker.ts)
//     graph · scheduler · places · protect         scheduler · places · ermine/api, the program
//     the page's table                ◄── port ──► a partial replica of it, filled as it is read
//
//   const realms = createRealms({ commit })
//   createPrograms({ ..., createProcessAPI: realms.wrap(apis.createProcessAPI) })
//   put("value", "realm", realms.run)          // a host runner: takes javascript source text
//
// the page is the authority: a realm's writes are asked of the host's policy and written again
// here; a write made on a stale value is rebased past the page's (rebase.ts). errors, and refused
// writes, become the process's status. methods cross as promises.
//
// not across yet: start and stop, presence, patch nodes' overlay, live values, iframes
// costs (measure.ts): startup 33–50 ms, a first read 3–7 ms, a rerun round trip ~0.7 ms
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import type { API } from "@ermine/api"
import { type Path, unplace } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeHeader, NODE } from "@ermine/places/header"
import { createGuard, slot, target, type Thing } from "@ermine/places/guard"
import { STATUS } from "@ermine/places/status"
import type { Context } from "@ermine/processes/start"
import type { Handle, Runner } from "@ermine/programs/start"
import type { Policy } from "@ermine/protect"
import { PENDING, type Scope } from "@ermine/scheduler"
import type { Key } from "@ermine/table"
import { rebase } from "./rebase.ts"
import {
	decode,
	decodePatches,
	encode,
	encodePatches,
	type Load,
	named,
	type PageMessage,
	type Part,
	type Port,
	post,
	type RealmMessage,
} from "./wire.ts"

// a worker, or anything that stands in for one: a port, and its end
export type Realm = Port & {
	terminate(): void
	addEventListener(type: "error", f: (e: ErrorEvent) => void): void
}

export type Setup = {
	// where the page's writes are said written (none: the process's places' commit)
	commit?: (changed: readonly Entry<unknown>[]) => void
	// the policy a realm's writes and loads are asked of, from where its process is (none: all
	// allowed)
	may?: Policy
	// a new realm (none: a module worker of worker.ts)
	worker?: () => Realm
	// how a pulse is asked for (none: queueMicrotask)
	schedule?: (f: () => void) => void
}

export type Realms = {
	run: Runner
	// createProcessAPI, its apis remembered with their Context, for run (a runner is handed only the
	// api: ermine/api's runners keep theirs the same way)
	wrap: <A>(create: (ctx: Context) => A) => (ctx: Context) => A
}

const key = (part: string, id: string) => `${part}\u0000${id}`
const empty = (part: string) => part === "attributes" ? {} : undefined
const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

// a header without its op (its patches are the fact's)
const strip = (c: ChangeHeader | undefined) => {
	if (c === undefined) return undefined
	const { op: _, ...rest } = c
	return rest
}

const plain = (e: unknown) => e instanceof Error ? e.message : String(e)

export function createRealms(setup: Setup = {}): Realms {
	const contexts = new WeakMap<object, Context>()
	const wrap = <A>(create: (ctx: Context) => A) => (ctx: Context): A => {
		const api = create(ctx)
		if (typeof api === "object" && api !== null) contexts.set(api, ctx)
		return api
	}
	const make = setup.worker ??
		(() =>
			new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			}) as unknown as Realm)

	const run: Runner = (code, api) => {
		const ctx = contexts.get(api as object)
		if (ctx === undefined) {
			throw new Error("a realm needs the process's context: make its api with realms.wrap")
		}
		if (typeof code === "function") {
			throw new Error(
				"a function won't cross to a realm: give its module's source text, or { url }",
			)
		}
		const source = typeof code === "string"
			? code
			: isMap(code) && typeof code.url === "string"
			? { url: code.url }
			: undefined
		if (source === undefined) throw new Error("not a program: no source text, no { url }")
		return open(source, api as API, ctx)
	}

	function open(code: string | { url: string }, api: API, ctx: Context): Promise<Handle> {
		const { scheduler: s, table, places, process, scope } = ctx
		const commit = setup.commit ?? places.commit
		const schedule = setup.schedule ?? queueMicrotask
		const worker = make()
		const root = String(ctx.box.root)

		let seq = 0
		let dead = false
		// ids the realm has (loaded, or wrote): changes there are sent; the ids it made itself
		const has = new Set<string>()
		const own = new Set<string>()
		// an id's path from the box's root, as the page last sent its name
		const paths = new Map<string, Path>()
		// the seq last sent at a key
		const sent = new Map<string, number>()
		// what was sent at a key, by seq, till the realm has it (its base past it): the patches, to
		// rebase the realm's past; null: the entry whole (loaded, reset, gone), nothing to rebase past
		const told = new Map<string, { seq: number; patches: Patch[] | null }[]>()
		const tell_ = (k: string, seq: number, patches: Patch[] | null) => {
			const l = told.get(k) ?? []
			l.push({ seq, patches })
			told.set(k, l.length > 256 ? [{ seq, patches: null }] : l)
		}
		// the patches and the key landing from the realm (never sent back)
		const mine = new Set<readonly Patch[]>()
		let skip: string | undefined
		// the realm's methods called, by k: their scopes; the memo and effect nodes it made
		const calls = new Map<
			number,
			{ resolve: (v: unknown) => void; reject: (e: unknown) => void; scope: Scope }
		>()
		let ks = 0
		const computers = new Map<string, Path | undefined>()
		let ready: { resolve: (h: Handle) => void; reject: (e: unknown) => void } | undefined

		// the process's scope holds its NODE key (processes' start): a header's metadata stops
		// there, a call's plain scope under it riding along
		const header = () => createChangeHeader(s)

		const guard = setup.may === undefined
			? undefined
			: createGuard({ places, scheduler: s, table, may: setup.may, from: process.at })

		let queued = false
		function later() {
			if (queued) return
			queued = true
			schedule(() => {
				queued = false
				if (!dead) s.pulse()
			})
		}

		// an id's path, when the page's places still find it there
		function pathOf(id: string): Path | undefined {
			const p = paths.get(id)
			return p !== undefined && get(places, p) === id ? p : undefined
		}
		const thing = (id: string): Thing => {
			const path = pathOf(id)
			return path === undefined ? { id } : { id, path }
		}
		function learn(part: string, id: string, patches: readonly Patch[]) {
			if (part !== "children" && part !== "process") return
			const at = part === "process" ? (id === root ? [] : undefined) : paths.get(id)
			if (at === undefined) return
			for (const [p, child] of named(part, at, patches)) paths.set(child, p)
		}

		const tell = (m: PageMessage, marked: (m: PageMessage) => PageMessage) =>
			post(worker, m, marked)

		// an entry as it crosses; refused a read, or won't cross: bad
		function partOf(part: string, id: string, entry: Entry<unknown>): Part {
			if (guard !== undefined && !own.has(id)) {
				try {
					s.runWithScope(scope, () => guard.read(target(thing(id), part as Key)))
				} catch (e) {
					return { part, bad: e === PENDING ? "pending" : plain(e) }
				}
			}
			const p: Part = { part, change: strip(entry.change) }
			if (entry.value !== undefined) p.value = entry.value
			return p
		}
		const markPart = (p: Part): Part =>
			p.bad !== undefined ? p : {
				...p,
				value: encode(p.value, p.part === "value"),
				change: encode(p.change, false, true) as ChangeHeader,
			}
		function loadOf(id: string): Load {
			has.add(id)
			const parts = table.get(id).map(([part, entry]) => partOf(part, id, entry))
			for (const p of parts) {
				if (p.bad === undefined) learn(p.part, id, [{ path: [], value: p.value }])
			}
			return { id, parts }
		}
		// each part that won't cross, as it won't, bad
		function sift(load: Load): Load {
			return {
				id: load.id,
				parts: load.parts.map((p) => {
					try {
						structuredClone(markPart(p))
						return markPart(p)
					} catch (e) {
						return { part: p.part, bad: plain(e) }
					}
				}),
			}
		}
		function sendLoad(load: Load) {
			const m: PageMessage = { t: "loaded", seq: ++seq, load }
			for (const p of load.parts) {
				sent.set(key(p.part, load.id), seq)
				tell_(key(p.part, load.id), seq, null)
			}
			try {
				tell(
					m,
					(x) =>
						({ ...x, load: { id: load.id, parts: load.parts.map(markPart) } }) as PageMessage,
				)
			} catch {
				worker.postMessage({ ...m, load: sift(load), enc: true })
			}
		}

		// a change at a key the realm has; reset: the page's entry whole, in place of the realm's
		function sendFact(
			part: string,
			id: string,
			body: { patches: Patch[] } | { gone: true },
			change: ChangeHeader | undefined,
			reset?: true,
		) {
			const m: PageMessage = {
				t: "fact",
				seq: ++seq,
				part,
				id,
				...body,
				...(change ? { change: strip(change) } : {}),
				...(reset ? { reset } : {}),
			}
			sent.set(key(part, id), seq)
			tell_(key(part, id), seq, "patches" in body && !reset ? body.patches : null)
			if ("patches" in body) learn(part, id, body.patches)
			try {
				tell(m, (x) => {
					const y = x as Extract<PageMessage, { t: "fact" }>
					return {
						...y,
						...(y.patches ? { patches: encodePatches(part, y.patches, false) } : {}),
						...(y.change ? { change: encode(y.change, false, true) as ChangeHeader } : {}),
					}
				})
			} catch (e) {
				worker.postMessage({ t: "fact", seq: m.seq, part, id, bad: plain(e) })
			}
		}
		function resend(part: string, id: string) {
			const entry = table.get(part as Key, id)
			sendFact(
				part,
				id,
				entry === undefined ? { gone: true } : { patches: [{ path: [], value: entry.value }] },
				entry?.change,
				true,
			)
		}

		// the process's status: an Error. before setup has run: the promise run gave, rejected
		function fail(error: unknown) {
			if (dead) return
			if (ready !== undefined) {
				const r = ready
				ready = undefined
				return r.reject(error)
			}
			if (scope.state === "gone") return
			const e = error instanceof Error ? error : new Error(String(error))
			s.runWithScope(scope, () => {
				const h = header()
				const entry = table.get("attributes", process.id) as Entry<unknown> | undefined
				if (entry === undefined) {
					table.add("attributes", process.id, createEntry({ [STATUS]: e }, h))
					return
				}
				update(
					entry,
					isMap(entry.value)
						? [{ path: [STATUS], value: e }]
						: [{ path: [], value: { [STATUS]: e } }],
					h,
				)
				commit([entry])
			})
			later()
		}

		// what a realm's write changes, asked of the policy as ermine/api asks
		function ask(part: string, id: string, gone: boolean, patches: readonly Patch[]) {
			if (guard === undefined || own.has(id)) return
			if (id === process.id && part === "value") return
			const t = thing(id)
			if (gone) return guard.write("remove", target(t))
			if (part !== "children") return guard.write("edit", target(t, part as Key))
			const names = new Set<string>()
			for (const p of patches) {
				if (p.path.length === 0) {
					const was = table.get("children", id)?.value
					for (const v of [was, p.value]) {
						if (isMap(v)) { for (const n of Object.keys(v)) names.add(n) }
					}
				} else if (typeof p.path[0] === "string") names.add(p.path[0])
				if (p.move && typeof p.move.path[0] === "string") names.add(p.move.path[0])
			}
			for (const name of names) guard.write("place", slot(t, name))
		}

		// a realm's write's header: the page's (actor, reader, its metadata to the process's node), the
		// realm's site; the realm's metadata in place of the page's when its NODE key (the scope
		// it stops at) is the process's node or one the realm made (a memo's or effect's own)
		function headerOf(m: Extract<RealmMessage, { t: "fact" }>): ChangeHeader {
			const h = header()
			if (m.site?.length) h.external = m.site
			const meta = m.enc && m.metadata ? decode(m.metadata) as typeof m.metadata : m.metadata
			const node = meta?.[NODE]
			if (
				node !== undefined && (node === String(process.id) || own.has(node as string))
			) h.metadata = { ...meta }
			return h
		}

		// a realm's write, written here as the process (or the call open when it was made)
		function land(m: Extract<RealmMessage, { t: "fact" }>) {
			const part = m.part as Key, id = m.id, k = key(part, id)
			const opened = m.call === undefined ? undefined : calls.get(m.call)?.scope
			const at = opened?.state === "alive" ? opened : scope
			if (at.state === "gone") return
			if (!has.has(id) && table.get(id).length === 0) own.add(id)
			has.add(id)
			const gone = m.gone === true
			// what the page sent since the realm's base: the realm's patches moved past it (rebase.ts)
			const since = (told.get(k) ?? []).filter((x) => x.seq > m.base)
			if (since.length) told.set(k, since)
			else told.delete(k)
			const made = gone
				? []
				: m.enc
				? decodePatches(part, m.patches!, () => standIn(id))
				: m.patches!
			const patches = since.length && since.every((x) => x.patches)
				? rebase(since.flatMap((x) => x.patches!), made)
				: made
			let refused: unknown, failed = false
			s.runWithScope(at, () => {
				try {
					ask(part, id, gone, patches)
				} catch (e) {
					refused = e
					return
				}
				const header = headerOf(m)
				try {
					const entry = table.get(part, id) as Entry<unknown> | undefined
					if (gone) {
						if (entry === undefined) return
						skip = k
						try {
							table.del(part, id)
						} finally {
							skip = undefined
						}
					} else if (entry === undefined) {
						const made = createEntry(apply(empty(part), patches), header)
						skip = k
						try {
							table.add(part, id, made as never)
						} finally {
							skip = undefined
						}
					} else {
						mine.add(patches)
						try {
							update(entry, patches, header)
							commit([entry])
						} finally {
							mine.delete(patches)
						}
					}
				} catch {
					failed = true
				}
			})
			if (!gone) learn(part, id, patches)
			if (refused !== undefined || failed) {
				resend(part, id)
				if (refused !== undefined) fail(refused)
			} else if ((sent.get(k) ?? 0) > m.base) resend(part, id)
			later()
		}

		// a stand-in for the realm's method at id: the call crosses, its promise comes back
		const standIn = (id: string) => (...args: unknown[]) => {
			if (dead) throw new Error("the realm has stopped")
			const info = { ...s.getInfo() }
			const k = ++ks
			tell({ t: "call", k, id, args, info }, (x) => {
				const y = x as Extract<PageMessage, { t: "call" }>
				return {
					...y,
					args: y.args.map((a) => encode(a)),
					info: encode(y.info, false, true) as never,
				}
			})
			const opened = s.createScope(info, scope)
			return new Promise((resolve, reject) => calls.set(k, { resolve, reject, scope: opened }))
		}

		// the realm's send to a method here, as the process
		function serveSend(m: Extract<RealmMessage, { t: "send" }>) {
			const reply = (out: { value?: unknown; error?: unknown }) => {
				if (dead) return
				try {
					tell({ t: "sent", k: m.k, ...out }, (x) => {
						const y = x as { value?: unknown; error?: unknown }
						return {
							...x,
							value: encode(y.value),
							error: encode(y.error, false, true),
						} as PageMessage
					})
				} catch (error) {
					worker.postMessage({ t: "sent", k: m.k, error })
				}
			}
			const args = (m.enc ? decode(m.args) : m.args) as unknown[]
			const path = pathOf(m.id)
			let out: unknown
			try {
				out = api.send(
					path === undefined ? { id: m.id, part: "value" } : { path, part: "value" },
					...args,
				)
			} catch (error) {
				return reply({ error })
			}
			Promise.resolve(out).then((value) => reply({ value }), (error) => reply({ error }))
		}

		function receive(e: MessageEvent) {
			if (dead) return
			const m = e.data as RealmMessage
			try {
				switch (m.t) {
					case "ready": {
						const r = ready
						ready = undefined
						if (m.error !== undefined) r?.reject(m.enc ? decode(m.error) : m.error)
						else r?.resolve(handle)
						return
					}
					case "load":
						return sendLoad(loadOf(m.id))
					case "fact":
						return land(m)
					case "reset":
						return resend(m.part, m.id)
					case "send":
						return serveSend(m)
					case "called": {
						const c = calls.get(m.k)
						if (c === undefined) return
						calls.delete(m.k)
						if (c.scope.state === "alive") s.teardown(c.scope)
						if ("error" in m && m.error !== undefined) {
							c.reject(m.enc ? decode(m.error) : m.error)
						} else c.resolve(m.enc ? decode(m.value) : m.value)
						return later()
					}
					case "notice":
						if (m.kind === "memo" || m.kind === "effect") computers.set(m.id, m.path)
						return
					case "error":
						return fail(m.enc ? decode(m.error) : m.error)
				}
			} catch (error) {
				fail(error)
			}
		}

		// the memo and effect nodes the realm made, taken out as ermine/api takes them out
		function clean() {
			if (scope.state === "gone" || computers.size === 0) return
			s.runWithScope(scope, () => {
				for (const [id, path] of computers) {
					if (path !== undefined && path.length) {
						const parent = get(places, path.slice(0, -1))
						const kids = parent === undefined ? undefined : table.get("children", parent)
						const name = path[path.length - 1]
						if (kids !== undefined && isMap(kids.value) && kids.value[name] === id) {
							commit(unplace(kids as Entry<unknown>, name, header()))
						}
					}
					for (const [part] of table.get(id)) table.del(part, id)
				}
			})
			computers.clear()
		}

		function stop() {
			if (dead) return
			dead = true
			worker.terminate()
			worker.removeEventListener("message", receive)
			off()
			for (const c of calls.values()) {
				c.reject(new Error("the realm has stopped"))
				if (c.scope.state === "alive") s.teardown(c.scope)
			}
			calls.clear()
			ready?.resolve(handle)
			ready = undefined
			clean()
		}
		const handle: Handle = { stop }

		// every change at an id the realm has, but its own, sent as it lands
		const off = places.watchAll((f) => {
			if (dead || typeof f.id !== "string" || !has.has(f.id)) return
			if (mine.has(f.patches) || (skip !== undefined && key(f.part, f.id) === skip)) return
			sendFact(
				f.part,
				f.id,
				f.entry === undefined ? { gone: true } : { patches: [...f.patches] },
				f.change,
			)
		})
		worker.addEventListener("message", receive)
		worker.addEventListener("error", (e) => {
			e.preventDefault()
			fail(
				e.error ??
					new Error(e.message || "the worker failed: its script did not load, or it died"),
			)
		})
		s.registerTeardown(scope, stop)

		// what it is handed: the root, the folders on the way to at and cwd, the process
		const ids: string[] = [root]
		paths.set(root, [])
		for (const route of [process.at, process.cwd]) {
			const names: string[] = []
			for (const step of places.walk(route)) {
				names.push(step.name)
				if (typeof step.id !== "string") continue
				if (!ids.includes(step.id)) ids.push(step.id)
				paths.set(step.id, [...names])
			}
		}
		if (!ids.includes(String(process.id))) ids.push(String(process.id))
		const loads = ids.map(loadOf)
		const start: PageMessage = {
			t: "start",
			seq,
			code,
			process: {
				id: String(process.id),
				at: [...process.at],
				args: [...process.args],
				cwd: [...process.cwd],
			},
			root,
			contributors: (places.contributors ?? []).map((c) => c.from),
			loads,
		}
		const promise = new Promise<Handle>((resolve, reject) => (ready = { resolve, reject }))
		try {
			tell(
				start,
				(x) =>
					({
						...x,
						loads: loads.map((l) => ({ id: l.id, parts: l.parts.map(markPart) })),
					}) as PageMessage,
			)
		} catch {
			worker.postMessage({ ...start, loads: loads.map(sift), enc: true })
		}
		return promise
	}

	return { run, wrap }
}
