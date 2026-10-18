// a realm's side: real ermine in a worker. its own scheduler, a table that is a partial replica of
// the page's (replica.ts), places over it asked as the page's are, and ermine/api's
// createProcessAPIs: the program is given the real api, unchanged. what it reaches and does not
// have is pending: asked of the page, and it runs again as it lands. what it writes (its edits, its
// memos' and effects' results, their status and run records) is an ordinary write here, each change
// sent to the page as it lands (places' watchAll), where it is written again as the process
//
//   serve(port)       // a worker's own global: served as it loads
//
// what a realm has: the root, the folders on the way to its process and its cwd, and the process,
// handed at start; anything else as a read reaches it. the page sends every later change at an id
// it has (or wrote). a change landing from the page is written here with the page's header, told as
// any write is, and never sent back
//
// setup: run once, with the api, as start.ts runs a host runner (createProcessAPIs' run: its return
// the process's value). a setup that reads what is not loaded yet throws PENDING: what it made is
// torn down and it runs again once something lands (open: its writes so far stay)
//
// a method's call from the page: run in a scope of the call's info, its writes sent with the call
// (written on the page as the caller's), its return sent back (a promise: as it lands). a send to
// a method of the page's: its node's value here is a stand-in, called as any method is, giving
// back a promise of the page's answer
//
// what can't cross yet: realms.ts
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import { createProcessAPIs } from "@ermine/api"
import { children, type Contributor, createPlaces, type Fact, type Places } from "@ermine/places"
import { NODE } from "@ermine/places/header"
import { PROCESS, processes } from "@ermine/processes"
import { createScheduler, type Info, PENDING, type Scope } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import { createPaths } from "@ermine/scheduler/paths"
import type { Key } from "@ermine/table"
import { createReplica, type Replica } from "./replica.ts"
import {
	decode,
	decodePatches,
	encode,
	encodePatches,
	type Load,
	type Looked,
	type PageMessage,
	pointed,
	type Port,
	post,
	type RealmMessage,
} from "./wire.ts"

const key = (part: string, id: string) => `${part}\u0000${id}`

type Start = Extract<PageMessage, { t: "start" }>

// what a realm runs: made at start
type World = {
	s: ReturnType<typeof createScheduler>
	r: Replica
	places: Places
	root: Scope
	// the process's: [["process", at], [NODE, its id]] (the node's entries are the page's)
	scope?: Scope
	apis: ReturnType<typeof createProcessAPIs>
}

// the realm's side of the wire on port; gives back the stop (the port let go)
export function serve(port: Port): () => void {
	let w: World | undefined
	// the page's seq last landed; the page's call open; the patches and the key landing from the page
	let base = 0
	let current: number | undefined
	let inbound: readonly Patch[] | undefined
	let skip: string | undefined
	// sends of the realm's, by k; what is waiting for a landing (setup, pending)
	const sends = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
	let ks = 0
	let landing: (() => void)[] = []
	const next = () => new Promise<void>((resolve) => landing.push(resolve))

	const tell = (m: RealmMessage, marked: (m: RealmMessage) => RealmMessage = (x) => x) =>
		post(port, m, marked)

	function report(error: unknown) {
		try {
			tell(
				{ t: "error", error },
				(m) => ({ ...m, error: encode((m as { error: unknown }).error, false, true) }),
			)
		} catch {
			port.postMessage({ t: "error", error: new Error(String(error)) })
		}
	}

	// one pulse, soon, however many ask
	let queued = false
	function later() {
		if (queued || w === undefined) return
		queued = true
		queueMicrotask(() => {
			queued = false
			try {
				w!.s.pulse()
			} catch (e) {
				report(e)
			}
		})
	}

	function landed() {
		const fs = landing
		landing = []
		for (const f of fs) f()
	}

	// a stand-in for a method of the page's at id: a send, its promise
	const standIn = (id: string) => (...args: unknown[]) => {
		const k = ++ks
		tell({ t: "send", k, id, args }, (m) => ({
			...m,
			args: (m as { args: unknown[] }).args.map((a) => encode(a)),
		}))
		return new Promise((resolve, reject) => sends.set(k, { resolve, reject }))
	}

	// an entry put in whole, told as a table event, never sent back
	function put(r: Replica, part: Key, id: string, value: unknown, change?: ChangeHeader) {
		skip = key(part, id)
		try {
			r.raw.sub(part, id, createEntry(value, change ?? ({ time: 0, actor: undefined })))
		} finally {
			skip = undefined
		}
	}

	function land(load: Load, enc: boolean) {
		const r = w!.r
		r.loaded(load.id)
		for (const p of load.parts) {
			const part = p.part as Key
			if (p.bad !== undefined) {
				r.bad(part, load.id, p.bad)
				continue
			}
			r.bad(part, load.id)
			const value = enc
				? decode(p.value, part === "value" ? () => standIn(load.id) : undefined)
				: p.value
			const change = enc && p.change ? decode(p.change) as ChangeHeader : p.change
			r.point(pointed(part, value))
			put(r, part, load.id, value, change)
		}
	}

	function fact(m: Extract<PageMessage, { t: "fact" }>) {
		const { r, places } = w!
		base = m.seq
		const part = m.part as Key, id = m.id
		if (m.bad !== undefined) {
			r.bad(part, id, m.bad)
			skip = key(part, id)
			try {
				if (r.raw.get(part, id) !== undefined) r.raw.del(part, id)
				else places.onTableChange(part, id)
			} finally {
				skip = undefined
			}
			return
		}
		r.bad(part, id)
		const change = m.enc && m.change ? decode(m.change) as ChangeHeader : m.change
		try {
			if (m.gone) {
				if (r.raw.get(part, id) === undefined) return
				skip = key(part, id)
				try {
					r.raw.del(part, id)
				} finally {
					skip = undefined
				}
				return
			}
			const patches = m.enc ? decodePatches(part, m.patches!, () => standIn(id)) : m.patches!
			for (const p of patches) if (p.value !== undefined) r.point(pointed(part, p.value))
			const entry = r.raw.get(part, id)
			if (entry === undefined || m.reset) {
				put(r, part, id, apply(undefined, patches), change)
				return
			}
			inbound = patches
			try {
				update(entry, patches, change ?? { time: 0, actor: undefined })
				places.commit([entry])
			} finally {
				inbound = undefined
			}
		} catch (e) {
			// it doesn't land here: the page's entry again (PENDING: it landed, a watch on the way
			// reached what is not loaded yet)
			if (e !== PENDING) port.postMessage({ t: "reset", part, id })
		}
	}

	// a method of the realm's called from the page, in a scope of the call's pairs, its writes sent
	// with the call. it throws PENDING (it reached what is not loaded yet): called again once
	// something lands (open: what it wrote before is written again)
	function call(m: Extract<PageMessage, { t: "call" }>) {
		const reply = (out: { value?: unknown; error?: unknown }) => {
			try {
				tell({ t: "called", k: m.k, ...out }, (x) => {
					const c = x as { value?: unknown; error?: unknown }
					return {
						...x,
						value: encode(c.value),
						error: encode(c.error, false, true),
					} as RealmMessage
				})
			} catch (error) {
				port.postMessage({ t: "called", k: m.k, error })
			}
		}
		const { r, s } = w!
		const fn = r.raw.get("value", m.id)?.value
		if (typeof fn !== "function") return reply({ error: new Error(`not-a-method (${m.id})`) })
		const args = (m.enc ? decode(m.args) : m.args) as unknown[]
		const info = (m.enc ? decode(m.info) : m.info) as Info
		const once = () => {
			const scope = s.createScope(info, w!.scope ?? w!.root)
			// the scope torn down, the call still open (its teardowns' writes are the call's)
			const done = () => {
				current = m.k
				try {
					s.teardown(scope)
				} finally {
					current = undefined
				}
				later()
			}
			let out: unknown, threw = false, error: unknown
			current = m.k
			try {
				out = s.runWithScope(scope, () => (fn as (...a: unknown[]) => unknown)(...args))
			} catch (e) {
				threw = true
				error = e
			} finally {
				current = undefined
			}
			done()
			if (threw && error === PENDING) return void next().then(once)
			if (threw) return reply({ error })
			if (!isPromise(out)) return reply({ value: out })
			;(out as PromiseLike<unknown>).then(
				(value) => reply({ value }),
				(error) => reply({ error }),
			)
		}
		once()
	}

	function begin(m: Start) {
		const s = createScheduler()
		const paths = createPaths<unknown>()
		let places!: Places
		const r = createReplica({
			scheduler: s,
			want: (id) => port.postMessage({ t: "load", id: String(id) }),
			event: (part, id) => places.onTableChange(part, id),
		})
		const by = (name: string): Contributor => {
			if (name === "children") return children
			if (name === "process") return processes(m.root)
			throw new Error(`a contributor won't cross to a realm: ${name}`)
		}
		places = createPlaces({
			root: m.root,
			table: r.table,
			paths,
			scheduler: s,
			contributors: m.contributors.length ? m.contributors.map(by) : undefined,
		})
		s.onTrackingEnd((k) => places.release(k))
		const root = s.createRootScope({ realm: "worker" })
		const commit = (changed: Parameters<Places["commit"]>[0]) => places.commit(changed)
		const apis = createProcessAPIs({
			scheduler: s,
			table: r.table,
			commit,
			host: { places, table: r.table, scheduler: s, commit },
			programs: () => {
				throw new Error("start and stop can't cross to a realm yet: it has no programs")
			},
			notice: (made) => {
				if (made.kind === "method") return
				const path = made.node.path
				port.postMessage({
					t: "notice",
					kind: made.kind,
					id: String(made.id),
					...(path ? { path: [...path] } : {}),
				})
			},
		})
		w = { s, r, places, root, apis }
		base = m.seq
		r.point([m.root])
		for (const load of m.loads) land(load, m.enc === true)

		// every change landing here, but what came from the page, sent to it
		places.watchAll((f: Fact) => {
			if (f.patches === inbound || typeof f.id !== "string") return
			if (skip !== undefined && key(f.part, f.id) === skip) return
			if (!r.waiting(f.id)) r.loaded(f.id)
			const out: RealmMessage = {
				t: "fact",
				base,
				part: f.part,
				id: f.id,
				...(f.entry === undefined ? { gone: true as const } : { patches: [...f.patches] }),
				...(f.change?.external ? { site: f.change.external } : {}),
				...(f.change?.metadata ? { metadata: f.change.metadata } : {}),
				...(current === undefined ? {} : { call: current }),
			}
			try {
				tell(out, (x) => {
					const y = x as { part: string; patches?: Patch[]; metadata?: unknown }
					return {
						...x,
						...(y.patches ? { patches: encodePatches(y.part, y.patches) } : {}),
						...(y.metadata ? { metadata: encode(y.metadata, false, true) } : {}),
					} as RealmMessage
				})
			} catch (e) {
				port.postMessage({ t: "reset", part: f.part, id: f.id })
				throw e
			}
		})
		setup(m).catch(report)
	}

	async function setup(m: Start) {
		const { s, apis, places } = w!
		let mod: unknown
		try {
			const url = typeof m.code === "string"
				? URL.createObjectURL(new Blob([m.code], { type: "text/javascript" }))
				: m.code.url
			mod = await import(url)
			if (typeof m.code === "string") URL.revokeObjectURL(url)
		} catch (error) {
			tell({ t: "ready", error })
			return
		}
		const { id, at, args, cwd } = m.process
		for (;;) {
			const scope = s.createScope({ process: [...at], [NODE]: id }, w!.root)
			w!.scope = scope
			const api = apis.createProcessAPI({
				box: { root: m.root, places },
				places,
				process: { id, at, args, cwd },
				scheduler: s,
				table: w!.r.table,
				scope,
			})
			try {
				s.runWithScope(scope, () => apis.run(mod, api))
				break
			} catch (error) {
				if (error !== PENDING) {
					tell(
						{ t: "ready", error },
						(x) => ({ ...x, error: encode((x as { error: unknown }).error, false, true) }),
					)
					return
				}
				s.teardown(scope)
				await next()
			}
		}
		later()
		tell({ t: "ready" })
	}

	// what this realm has, walked from its root by the table under the replica's hook (raw), so the
	// look loads nothing: a process row or a child named, waiting or here or none, its value shown
	function look(): Looked | undefined {
		if (w === undefined) return undefined
		const { r, places } = w
		const isMap = (v: unknown): v is Record<string, unknown> =>
			typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)
		const rows = r.raw.get(PROCESS, places.root)?.value
		const show = (v: unknown) => {
			if (typeof v === "function") return "ƒ"
			try {
				const s = JSON.stringify(v)
				return s === undefined ? String(v) : s.length > 80 ? s.slice(0, 79) + "…" : s
			} catch {
				return String(v)
			}
		}
		const seen = new Set<string>()
		const node = (id: string, name: string, path: string[], from: Looked["from"]): Looked => {
			const here = r.raw.get("value", id) ?? r.raw.get("children", id) ??
				r.raw.get("attributes", id)
			const state = r.waiting(id) ? "waiting" : here === undefined ? "none" : "here"
			const out: Looked = { id, name, from, state, kids: [] }
			const v = r.raw.get("value", id)
			if (v !== undefined) out.shown = show(v.value)
			if (seen.has(id)) return out
			seen.add(id)
			let level: unknown = rows
			for (const p of path) level = isMap(level) ? level[p] : undefined
			const named = new Set<string>()
			if (isMap(level)) {
				for (const [n, x] of Object.entries(level)) {
					if (typeof x !== "string") continue
					named.add(n)
					out.kids.push(node(x, n, [...path, n], "process"))
				}
			}
			const kids = r.raw.get("children", id)?.value
			if (isMap(kids)) {
				for (const [n, x] of Object.entries(kids)) {
					if (typeof x === "string" && !named.has(n)) {
						out.kids.push(node(x, n, [...path, n], "children"))
					}
				}
			}
			return out
		}
		return node(String(places.root), "", [], "children")
	}

	function receive(e: MessageEvent) {
		const m = e.data as PageMessage
		try {
			switch (m.t) {
				case "start":
					return begin(m)
				case "loaded":
					base = m.seq
					land(m.load, m.enc === true)
					later()
					return landed()
				case "fact":
					fact(m)
					later()
					return landed()
				case "call":
					return call(m)
				case "look":
					return port.postMessage({ t: "looked", tree: look() })
				case "sent": {
					const it = sends.get(m.k)
					if (it === undefined) return
					sends.delete(m.k)
					const value = m.enc ? decode(m.value) : m.value
					const error = m.enc ? decode(m.error) : m.error
					if ("error" in m && m.error !== undefined) it.reject(error)
					else it.resolve(value)
					return
				}
			}
		} catch (error) {
			report(error)
		}
	}

	port.addEventListener("message", receive)
	return () => port.removeEventListener("message", receive)
}

// a worker's own global: served as it loads, its uncaught errors told to the page
// deno-lint-ignore no-explicit-any
const g = globalThis as any
if (typeof g.WorkerGlobalScope === "function" && globalThis instanceof g.WorkerGlobalScope) {
	const port = globalThis as unknown as Port
	serve(port)
	const told = (error: unknown) => {
		try {
			port.postMessage({ t: "error", error })
		} catch {
			port.postMessage({ t: "error", error: new Error(String(error)) })
		}
	}
	g.addEventListener("error", (e: ErrorEvent) => {
		e.preventDefault()
		told(e.error ?? new Error(e.message))
	})
	g.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
		e.preventDefault()
		told(e.reason)
	})
}
