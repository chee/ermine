// realms: a host runner that runs a program in a worker, with ermine on both sides (worker.ts)
//
//   page (main thread)                           worker (worker.ts)
//     graph · scheduler · places · protect         scheduler · places · @ermine/system, the program
//     the page's table                ◄── port ──► a partial replica of it, filled as it is read
//
//   const realms = createRealms({ ermine })
//   realms.start(source, "/work/clock")        // a process of ermine's, its program in a worker
//   software.offer(session, "runners", "realm", attributes, realms.run)   // software's, the same
//
// realms.start(code, at, { args? }) is ermine.start with the program in a realm: the process
// is the page's (its setup is the wait for the realm's), and its status is pending till the realm
// has run its setup, failed if that threw. realms.run is a runner in @ermine/software's shape:
// start(code, ctx), ctx the start's facts (its Start, the process context's). the program is given
// nothing: it imports @ermine/system's functions (the realm's own ermine, on the worker's side).
// the scheduler, table and places are ermine's
//
// the page is the authority: a realm's writes are asked of the host's policy and written again
// here; a write made on a stale value is rebased past the page's (rebase.ts). errors, and refused
// writes, become the process's status. methods cross as promises.
//
// not across yet: start and stop, presence, patch nodes' overlay, live values, iframes
// costs (measure.ts): startup 33–50 ms, a first read 3–7 ms, a rerun round trip ~0.7 ms
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import apply, { type Patch } from "@ermine/core/changeable/apply"
import { type Path, unplace } from "@ermine/core/places"
import { get } from "@ermine/core/places/lib"
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import { createGuard, slot, target, type Thing } from "@ermine/core/places/guard"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import type { Handle, Runner, Start } from "@ermine/software"
import type { Policy } from "@ermine/core/protect"
import { PENDING, type Scope } from "@ermine/core/scheduler"
import type { Key } from "@ermine/core/table"
import { type Ermine, executeAction, type Started } from "@ermine/system"
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
	// the page's: its scheduler, table and places are what the realm's program runs on, and where its
	// writes land
	ermine: Ermine
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
	// a process of ermine's at at, its program (source text, or { url }) in a realm
	start: (
		code: string | { url: string },
		at: string | Path,
		options?: { args?: readonly string[] },
	) => Started | { refused: string }
}

const key = (part: string, id: string) => `${part}\u0000${id}`
const empty = (part: string) => part === "attributes" || part === STATUS_TABLE ? {} : undefined
const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

// a header without its op (its patches are the fact's)
const strip = (c: ChangeHeader | undefined) => {
	if (c === undefined) return undefined
	const { op: _, ...rest } = c
	return rest
}

const plain = (e: unknown) => e instanceof Error ? e.message : String(e)

export function createRealms(setup: Setup): Realms {
	const make = setup.worker ??
		(() =>
			new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			}) as unknown as Realm)

	// a program's source run in a realm of its own, for the process the start's facts say
	function start(code: unknown, ctx: Start): Promise<Handle> {
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
		return open(source, ctx)
	}
	const run: Runner = { start }

	// ermine.start with the program in a realm: its setup the wait for the realm's, run in the
	// process's scope, whose facts (node, path, folder, args) the realm is started from
	function launch(
		code: string | { url: string },
		at: string | Path,
		options: { args?: readonly string[] } = {},
	) {
		const { ermine } = setup
		const args = options.args ?? []
		return ermine.start(
			() => {
				let scope: Scope | undefined, id: string | undefined, path: Path = []
				for (let o = ermine.scheduler.getCurrentScope(); o !== undefined; o = o.parent) {
					if (NODE in o.info) {
						scope = o
						id = String(o.info[NODE])
						path = o.info.process as Path
						break
					}
				}
				if (scope === undefined || id === undefined) throw new Error("no process is open here")
				const folder = path.slice(0, -1)
				const ctx = {
					scope,
					folder,
					at: path,
					args,
					process: { id, at: path, folder, scope },
				}
				return open(code, ctx as unknown as Start).then(() => undefined)
			},
			at,
			{ args: [...args] },
		)
	}

	function open(code: string | { url: string }, ctx: Start): Promise<Handle> {
		const { ermine } = setup
		const { scheduler: s, table } = ermine
		const { places } = ermine
		const { process, at, folder, args, scope } = ctx
		const commit = setup.commit ?? places.commit
		const schedule = setup.schedule ?? queueMicrotask
		const worker = make()
		const root = String(places.root)

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
			: createGuard({ places, scheduler: s, table, may: setup.may, from: at })

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
				// its status is in the status table, not its attributes (places' status.ts)
				const entry = table.get(STATUS_TABLE, process.id) as Entry<unknown> | undefined
				if (entry === undefined) {
					table.add(STATUS_TABLE, process.id, createEntry({ [STATUS]: e }, h))
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

		// what a realm's write changes, asked of the policy as @ermine/system asks
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
				// as the process: its context's scope open, the node by the path it has, else by id
				const context = ermine.getProcessContext(process)
				if (context === undefined) throw new Error("the process has stopped")
				const node = ermine.handleOf(
					path === undefined ? { id: m.id, part: "value" } : { path, part: "value" },
				)
				out = context.within(() => executeAction(node, ...args))
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

		// the memo and effect nodes the realm made, taken out as @ermine/system takes them out
		function clean() {
			if (computers.size === 0) return
			// the process's scope is going as the realm stops with it: the host's, as the page takes
			// nodes out
			const at = scope.state === "alive" ? scope : ermine.getProcessContext()!.scope
			s.runWithScope(at, () => {
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

		// what it is handed: the root, the folders on the way to at and folder, the process
		const ids: string[] = [root]
		paths.set(root, [])
		for (const route of [at, folder]) {
			const names: string[] = []
			for (const step of places.walk(route)) {
				names.push(step.name)
				// the process's own node is the realm's to make: the start writes it there
				if (typeof step.id !== "string" || step.id === String(process.id)) continue
				if (!ids.includes(step.id)) ids.push(step.id)
				paths.set(step.id, [...names])
			}
		}
		const loads = ids.map(loadOf)
		const start: PageMessage = {
			t: "start",
			seq,
			code,
			process: {
				id: String(process.id),
				at: [...at],
				args: [...args],
				folder: [...folder],
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

	return { run, start: launch }
}
