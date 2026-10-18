// prog-build's host: programs at paths, found by @ermine/programs' satisfy, each compile cached by
// @ermine/programs/build, each process started in a box (@ermine/boxes) through the process api.
// the world (@ermine/slaygrounds/world) runs the shell (program.ts); this file holds what is this
// demo's: a supervisor that keeps the programs running, the page's own loaders, and the keys.
//
// what the api now gives, that the first version of this host did by hand:
//   a chain      satisfy: every way to run a program, nearest first, each candidate not taken with
//                its why (onwhynot). the walk and chain cards are drawn from it
//   a build      builds.compile: keyed by the compiler's identity and the input's hash. a comment
//                edit is a miss whose bytes equal the last: the supervisor sees the same build and
//                restarts nothing (a cutoff). a revert is a hit
//   a box        a plain folder, the process's "/". a key is a node placed in it (keys/print): a
//                grant is a placement, and a program sees only what its folder holds. escape.c in
//                /boxes/escape holds print; started from /c/vault, a folder that also holds
//                keys/secret, it gets secret
//   a process    start(way, "main", { box }), at <box>/main; its own state is bare nodes inside it
//                (out, shown); /value is its exports, the node placed from /value/<name>, so a
//                program that uses another has /uses/<name> placed in its box from there
//
// the supervisor (below) is the host's: it watches each program's build and restarts the process
// when it changes (hot), or keeps the run it has and says what differs (pinned). it is an effect
// on the host's own api, so it lives across program.ts reloads; a reload only mounts the files
// and restarts the shell
import { hash } from "@ermine/encoding/hash"
import type { API } from "@ermine/api"
import * as lib from "@ermine/places/lib"
import { status as statusOf } from "@ermine/places/status"
import { ATTRIBUTES as A, satisfy } from "@ermine/programs"
import { COMPILER, createBuilds } from "@ermine/build"
import type { Places } from "@ermine/places"
import type { Process } from "@ermine/programs/start"
import { PENDING } from "@ermine/scheduler"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const JS = "com.netscape.javascript-source"
const WASM = "public.wasm-executable"
const C = "public.c-source"

// ---- small things ----
function digest(v: unknown): string | null {
	if (v === undefined || typeof v === "function") return null
	try {
		return Array.from(hash(v as never).subarray(0, 8), (b) => b.toString(16).padStart(2, "0"))
			.join("")
	} catch {
		return null
	}
}
const short = (h: unknown) => (typeof h === "string" ? h.slice(0, 6) : "none")
const message = (e: unknown) => String((e as Error)?.message ?? e)
const nick = (uti: string) => (typeof uti === "string" ? uti.split(".").pop() : "?")
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const names = (path: string) => path.split("/").filter(Boolean)

// ---- what the shell is given beyond the api (written in the head of each) ----
export type Extra = {
	// the plan for a program: satisfy's answer as data, for the walk and chain cards. read in a
	// memo, so tracked: a loader on the way up, a type installed, an edit, a move, and it is planned
	// again
	plan: (path: string) => any
	// every program in the tree: a node with a type that is no loader, and what is running
	programs: () => { path: string; type: string; name: string }[]
}
export type Tools = API & Extra

const world = createWorld({
	render,
	processes: [{ name: "shell", export: "shell" }],
	types: true,
	extend: (): Extra => ({
		plan: (path) => planOf(path).view,
		programs,
	}),
})
const w = world.world
const h = world.hostAPI
const places = w.places

// ---- the plan: satisfy taken whole. its ways and every whynot; nothing yielded: the search's own
// whynot. the way is for the supervisor, the view for the cards ----
function planOf(path: string) {
	const whys: any[] = []
	let refused: any = null
	const ways = [
		...satisfy(places, path, [], {
			onwhynot: (x) => void ("for" in x ? whys.push(x) : (refused = x)),
		}),
	]
	if (refused?.why === "nothing-there") {
		const missing = `nothing at ${refused.path}`
		return {
			way: undefined,
			view: { program: path, missing, steps: null, chains: [], why: [], walk: [] } as any,
		}
	}
	const program = ways[0]?.program ?? { id: refused.id, at: refused.at }
	const type = places.readValue("attributes", program.id, [A.type])
	const named = new Map<unknown, string>([[program.id, program.at.at(-1)]])
	for (const x of whys) named.set(x.id, x.at.at(-1))
	const said = (st: any): any => {
		named.set(st.id, st.at.at(-1))
		const a = (places.readValue("attributes", st.id) ?? {}) as any
		const v = places.readValue("value", st.id)
		const gives = a[A.gives]
		return {
			name: st.at.at(-1),
			path: "/" + st.at.join("/"),
			id: st.id,
			takes: a[A.takes] ?? [],
			gives: typeof gives === "string" ? gives : null,
			host: typeof v === "function",
			// what it is: the page's function by its identity (none: its node), code by its code
			hash: typeof v === "function" ? digest(a[COMPILER] ?? st.id) : digest(v),
			by: st.by.map(said),
		}
	}
	const chains = ways.map((x) => x.chain.map(said))
	const steps = chains[0] ?? null
	const why = whys.map((x) => ({
		name: x.at.at(-1),
		path: "/" + x.at.join("/"),
		takes: places.readValue("attributes", x.id, [A.takes]) ?? [],
		for: named.get(x.for) ?? short(String(x.for)),
		own: x.for === program.id && x.type === type,
		type: x.type,
		why: x.why,
		missing: x.missing ?? null,
	}))
	const view: any = {
		program: "/" + program.at.join("/"),
		id: program.id,
		file: program.at.at(-1),
		type: typeof type === "string" ? type : null,
		code: digest(places.readValue("value", program.id)),
		steps,
		chains: chains.map((c: any[]) => c.map((x) => x.path)),
		why,
		refused: refused?.why ?? null,
		walk: walkOf(program.at, steps, why),
		whyNot: null,
	}
	if (!steps) view.whyNot = explain(view)
	return { way: ways[0], view }
}

// the way up, for the walk card: each folder from the program's up to "/", and each loader seen
// there (in it, or in a loaders folder in it): the step it is, the steps it runs, or why not
function walkOf(at: readonly string[], steps: any[] | null, why: any[]) {
	const levels: string[][] = []
	for (let k = at.length - 1; k >= 0; k--) levels.push(at.slice(0, k) as string[])
	const levelOf = (path: string) => {
		const ns = names(path)
		const l = levels.find((l) => l.length < ns.length && l.every((n, i) => n === ns[i]))
		return "/" + (l ?? []).join("/")
	}
	const met = new Map<string, any>()
	const chip = (x: any) => {
		let c = met.get(x.path)
		if (!c) {
			met.set(
				x.path,
				c = {
					name: x.name,
					path: x.path,
					takes: x.takes.map(nick),
					gives: x.gives ? nick(x.gives) : null,
					step: 0,
					runs: [] as string[],
					why: null,
				},
			)
		}
		return c
	}
	const runs = (st: any) => {
		for (const y of st.by) {
			const c = chip(y)
			if (!c.runs.includes(st.name)) c.runs.push(st.name)
			runs(y)
		}
	}
	steps?.forEach((x, i) => {
		chip(x).step = i + 1
		runs(x)
	})
	for (const x of why) {
		const c = chip({ ...x, gives: null })
		const text = x.why + (x.missing ? ` ${x.missing.join(", ")}` : "") +
			(x.own ? "" : ` (for ${x.for}, ${nick(x.type)})`)
		if (c.why === null || (x.own && !c.own)) (c.why = text, c.own = x.own)
	}
	return levels.map((l) => {
		const here = "/" + l.join("/")
		return { at: here, seen: [...met.values()].filter((c) => levelOf(c.path) === here) }
	})
}

// no chain, in words, from the why list
function explain(p: any) {
	if (p.refused === "no-type") {
		return `${p.file} has no ${A.type} and is no live function: nothing runs it`
	}
	const own = p.why.filter((x: any) => x.own)
	if (own.length && own.every((x: any) => x.why === "wrong-type" || x.why === "unknown-type")) {
		return `nothing on the way up takes ${nick(p.type)}: ` +
			own.map((x: any) => `${x.name} takes ${x.takes.map(nick).join(", ")}`).join(", ")
	}
	return own.map((x: any) => `${x.name}: ${x.why}${x.missing ? " " + x.missing.join(", ") : ""}`)
		.join("; ") || "no chain"
}

// every program in the tree: a node with a type that is no loader. not into the folders the host
// keeps its own things in, nor into a process
const mine = ["boxes", "state", "value", "ctl", "keys", "cache", "code", "ermine", "main", "uses"]
function programs() {
	const out: { path: string; type: string; name: string }[] = []
	const walk = (at: string[]) => {
		for (const m of lib.members(places, at)) {
			if (mine.includes(m.name) && (at.length === 0 || m.name === "main" || m.name === "keys")) {
				continue
			}
			const a = (places.readValue("attributes", m.id) ?? {}) as any
			if (a[A.takes] || a[A.loaders]) continue
			const type = a[A.type]
			if (typeof type === "string") {
				out.push({ path: "/" + [...at, m.name].join("/"), type, name: m.name })
			} else walk([...at, m.name])
		}
	}
	walk([])
	return out
}

// ---- the page's own: live functions the host puts in the graph, never saved. satisfy's search
// ends at them (a node with no type whose value is a function: the host runs it) ----

// javascript source, imported as a module (once per code), its default export called with the api
// the process is given. what it returns is the process's /value
const modules = new Map<string, Promise<(api: API) => unknown>>()
function importCode(code: string) {
	const d = digest(code)!
	if (!modules.has(d)) {
		const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
		modules.set(d, import(url).then((m) => m.default))
	}
	return modules.get(d)!
}
const js = async (code: unknown, api: API) => {
	const f = await importCode(String(code))
	const value = f(api)
	if (value !== undefined) api.edit("/value", [{ path: [], value }])
	return { stop() {} }
}

// wasm: compiled, then instantiated with the keys in the process's box (its /keys) and nothing
// else. an import not handed is not linked: the engine itself refuses (a LinkError, the process's
// status). main runs once; the exports are the process's /value
const wasm = async (bytes: unknown, api: API) => {
	const module = await WebAssembly.compile(bytes as BufferSource)
	const handed = api.list("/keys")
	const env: Record<string, unknown> = {}
	for (const i of WebAssembly.Module.imports(module)) {
		if (i.module === "env" && handed.includes(i.name)) {
			env[i.name] = (api.read(`/keys/${i.name}`) as (api: API) => unknown)(api)
		}
	}
	api.open("out", [])
	const { exports } = new WebAssembly.Instance(module, { env })
	;(exports.main as (() => void) | undefined)?.()
	api.edit("/value", [{ path: [], value: exports }])
	return { stop() {} }
}

// C to wasm on this machine, through the dev server (compile.ts). a 501 says there is no wasm-ld
async function compileC(source: unknown) {
	const base = (globalThis as any).parent.__base ??
		(globalThis as any).parent.location.origin + "/"
	const r = await fetch(new URL("compile", base).href, { method: "POST", body: String(source) })
		.catch(() => undefined)
	// a static host has no /compile: 404, 405 (or the page itself back)
	const here = r?.headers.get("content-type") ?? ""
	if (!r || r.status === 404 || r.status === 405 || here.startsWith("text/html")) {
		throw new Error("compiling C needs the local server (deno task serve)")
	}
	if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
	return new Uint8Array(await r.arrayBuffer())
}

// a key's value makes the import for whoever it is handed to: (api) => fn
const keys: Record<string, (api: API) => unknown> = {
	// a line on the process's own out
	print: (api) => (n: unknown) => api.edit("out", (d: string[]) => void d.push(String(n))),
	// what only the vault's folder holds
	secret: () => () => 42,
}

// ---- the build log, a node at /state/log: hits, misses, cutoffs, the latest first ----
const tally = { hits: 0, misses: 0, cutoffs: 0, failed: 0, recent: [] as object[] }
function log(e: Record<string, unknown> & { kind: string }) {
	if (e.kind === "hit") tally.hits++
	else if (e.kind === "miss") tally.misses++
	else if (e.kind === "cutoff") tally.cutoffs++
	else tally.failed++
	tally.recent = [{ ...e, time: new Date().toLocaleTimeString() }, ...tally.recent].slice(0, 40)
	const copy = { ...tally }
	// seen inside a run: the write waits until it is over
	queueMicrotask(() => h.edit("/state/log", [{ path: [], value: copy }]))
}

// ---- the supervisor: one entry per process. its build is an effect: the chain found, each
// compiler through the cache. a ready build starts the process, or restarts it when it differs
// from what runs (hot), or is only noted (pinned) ----
type Entry = {
	name: string
	path: string
	box: string
	keys: string[]
	uses: string[]
	pinned: boolean
	proc?: Process
	// its folder, seen from inside: the host's own places does not show a process started in a box
	view?: Places
	// the source of the last ready build seen
	src?: string | null
	// the build running, and the newest ready one
	running?: Ready
	ready?: Ready
	runs: number
	// what the used programs' values were when it started
	saw: Map<string, unknown>
	// the compiles of the last look, to tell a hit from a miss from a cutoff
	seen: Map<number, string>
	since: Map<string, number>
	failed: Set<string>
	scope?: unknown
}
type Ready = {
	kind: "ready"
	sig: string
	way: any
	steps: { name: string; path: string; hash: string | null }[]
	src: string | null
	built: string | null
	deps: unknown[]
	compiled: boolean
}
type Build =
	| Ready
	| { kind: "none"; sig: string; why: string }
	| { kind: "building"; sig: string }
	| { kind: "failed"; sig: string; error: string }
	| { kind: "waiting"; sig: string; blocked: string[] }

const entries = new Map<string, Entry>()
const state = new Map<string, Record<string, any>>()
// a write to /state/<name>, merged
function set(name: string, patch: Record<string, unknown>) {
	const v = { ...state.get(name), ...patch }
	state.set(name, v)
	h.edit(`/state/${name}`, [{ path: [], value: v }])
}

// the effect's read: tracked. the chain, the compilers through the cache, the used programs
function build(e: Entry): Build {
	const { way, view } = planOf(e.path)
	if (!way) return { kind: "none", sig: "none", why: view.whyNot ?? view.missing ?? "no chain" }
	const sig = JSON.stringify(view.chains[0])
	let input = places.readValue("value", way.program.id)
	if (input === undefined) return { kind: "building", sig }
	const src = digest(input)
	let compiled = false
	for (const [i, step] of way.chain.slice(0, -1).entries()) {
		compiled = true
		const from = digest(input)
		const k = `${step.id} ${from}`
		const out = builds.compile(step.id, input)
		const said = { step: step.at.at(-1), program: view.file, from }
		if (out === PENDING) {
			if (!e.since.has(k)) e.since.set(k, performance.now())
			return { kind: "building", sig }
		}
		if (out instanceof Error) {
			e.since.delete(k)
			e.seen.set(i, k)
			if (!e.failed.has(k)) {
				;(e.failed.add(k), log({ kind: "failed", ...said, error: message(out) }))
			}
			return { kind: "failed", sig, error: message(out) }
		}
		e.failed.delete(k)
		if (e.since.has(k)) {
			const ms = Math.round(performance.now() - e.since.get(k)!)
			e.since.delete(k)
			log({ kind: "miss", ...said, to: digest(out), ms })
		} else if (e.seen.get(i) !== k) log({ kind: "hit", ...said, to: digest(out) })
		e.seen.set(i, k)
		input = out
	}
	const blocked: string[] = []
	const deps = e.uses.map((u) => {
		const v = h.read(`/value/${u}`)
		if (v === null || v === undefined) blocked.push(u)
		return v
	})
	if (blocked.length) return { kind: "waiting", sig, blocked }
	return {
		kind: "ready",
		sig,
		way,
		steps: (view.steps ?? []).map((x: any) => ({ name: x.name, path: x.path, hash: x.hash })),
		src,
		built: digest(input),
		deps,
		compiled,
	}
}

// the same build: nothing after it runs again
const sameReady = (a: Ready, b: Ready) =>
	a.sig === b.sig && a.built === b.built && a.deps.length === b.deps.length &&
	a.deps.every((d, i) => d === b.deps[i])
// the same bytes as what runs, from another source: the compile was out and came back the same,
// so nothing after it runs again. told once per source
function cutoff(e: Entry, b: Ready) {
	if (b.compiled && b.src !== e.src) {
		log({
			kind: "cutoff",
			step: b.steps.at(-1)?.name,
			program: e.path.split("/").pop()!,
			from: b.built,
		})
	}
	e.src = b.src
}
function sameBuild(e: Entry) {
	return (a: Build, b: Build) => {
		const same = a.kind === b.kind &&
			(a.kind === "ready" ? sameReady(a, b as Ready) : JSON.stringify(a) === JSON.stringify(b))
		if (same && a.kind === "ready") cutoff(e, a)
		return same
	}
}

// the effect's act: what a build says is written for the shell; a ready one runs
function act(e: Entry, b: Build) {
	if (b.kind === "ready") {
		e.ready = b
		set(e.name, {
			building: false,
			failed: null,
			waiting: null,
			why: null,
			next: { file: e.path.split("/").pop(), code: b.src, built: b.built, steps: b.steps },
		})
		// the same as runs now (a fix after a failed build): nothing to do
		if (e.proc && e.running && sameReady(e.running, b)) return cutoff(e, b)
		e.src = b.src
		if (!e.proc || !e.pinned) begin(e, b)
		return
	}
	if (b.kind === "building") set(e.name, { building: true, failed: null, waiting: null })
	else if (b.kind === "failed") {
		set(e.name, { building: false, failed: b.error.split("\n").slice(0, 5).join("\n") })
	} else if (b.kind === "waiting") set(e.name, { building: false, waiting: b.blocked })
	else set(e.name, { building: false, why: b.why })
}

// a grant is a placement: the keys and the used programs' values placed in the process's folder
function grant(box: ReturnType<API["box"]>, at: string, from: string) {
	try {
		box.unplace(at)
	} catch { /* not there */ }
	box.place(at, from)
}

// the process started (or started again) in its folder on this build
function begin(e: Entry, b: Ready) {
	if (e.proc) {
		h.stop(e.proc)
		e.proc = undefined
	}
	const box = h.box(e.box)
	e.view = box.box.places
	for (const k of h.list(`${e.box}/keys`)) if (!e.keys.includes(k)) box.unplace(`keys/${k}`)
	for (const k of e.keys) grant(box, `keys/${k}`, `/keys/${k}`)
	for (const u of e.uses) grant(box, `uses/${u}`, `/value/${u}`)
	grant(box, "value", `/value/${e.name}`)
	const p = h.start(b.way, "main", { box })
	if ("refused" in p) {
		set(e.name, { failed: `refused: ${p.refused}` })
		return
	}
	e.proc = p
	e.running = b
	e.saw = new Map(e.uses.map((u) => [u, h.read(`/value/${u}`)]))
	set(e.name, {
		failed: null,
		record: {
			run: ++e.runs,
			time: new Date().toLocaleTimeString(),
			file: e.path.split("/").pop(),
			code: b.src,
			built: b.built,
			steps: b.steps,
			keys: e.keys,
			uses: e.uses,
		},
	})
}

function track(name: string, path: string, o: Partial<Entry> = {}) {
	while (entries.has(name)) name += "+"
	const e: Entry = {
		name,
		path,
		box: `/boxes/${name}`,
		keys: ["print"],
		uses: [],
		pinned: false,
		runs: 0,
		saw: new Map(),
		seen: new Map(),
		since: new Map(),
		failed: new Set(),
		...o,
	}
	entries.set(name, e)
	h.open(`/state/${name}`, { pinned: e.pinned, path })
	state.set(name, { pinned: e.pinned, path })
	h.open(`/value/${name}`, null)
	h.edit("/state/names", (d: string[]) => void d.push(name))
	// the build, in a scope of its own so stopping the program takes it away
	const scope = w.s.createScope({ supervisor: name }, w.host)
	e.scope = scope
	w.s.runWithScope(scope, () => {
		h.effect(`build-${name}`, () => build(e), (b) => act(e, b as Build), {
			equal: sameBuild(e) as never,
		})
	})
	return e
}

function untrack(name: string) {
	const e = entries.get(name)
	if (!e) return
	entries.delete(name)
	state.delete(name)
	w.s.teardown(e.scope as never)
	if (e.proc) h.stop(e.proc)
	h.edit(`/value/${name}`, [{ path: [], value: null }])
	h.edit("/state/names", (d: string[]) => void d.splice(d.indexOf(name), 1))
	h.remove(`/state/${name}`)
}

// the programs the demo starts, and what each is given
const roster: [name: string, path: string, o: Partial<Entry>][] = [
	["fib", "/c/fib.c", {}],
	["table", "/apps/table.js", { uses: ["fib"], keys: [] }],
	["chart", "/apps/chart.js", { uses: ["fib"], keys: [], pinned: true }],
	["escape", "/c/sandbox/escape.c", {}],
	["sneaky", "/apps/sneaky.js", {}],
]
const rosterOf = (path: string) => roster.find((r) => r[1] === path)

// ---- what the shell reads: one row per process, a memo at /state/procs ----
function rows() {
	const live = (h.read("/state/names") ?? []) as string[]
	return live.flatMap((name) => {
		const e = entries.get(name)
		const st = (h.read(`/state/${name}`) ?? {}) as Record<string, any>
		if (!e) return []
		// what is inside the process: read through the folder's own view
		const view = e.view
		const inner = (name: string) => {
			const id = view && lib.get(view, ["main", name])
			return id === undefined || !view ? undefined : view.readValue("value", id)
		}
		const pid = view && lib.get(view, ["main"])
		const status = pid === undefined || !view ? undefined : statusOf(view, pid)
		const rec = st.record
		const runtime = status instanceof Error ? message(status) : undefined
		const shown = inner("shown")
		const out = (inner("out") ?? []) as string[]
		const stale: string[] = []
		if (rec) {
			for (const u of rec.uses as string[]) {
				if (h.read(`/value/${u}`) !== e.saw.get(u)) {
					stale.push(`uses ${entries.get(u)?.path ?? u}: it ran again since`)
				}
			}
			if (st.next) {
				const differs: string[] = []
				// the source changed but the bytes are the same: nothing differs
				if (st.next.built !== rec.built) {
					differs.push(`code: ${rec.file} ${short(rec.code)} → ${short(st.next.code)}`)
				}
				const was = rec.steps.map((x: any) => x.path).join(" → ")
				const now = st.next.steps.map((x: any) => x.path).join(" → ")
				if (was !== now) differs.push(`chain: ${was || "none"} → ${now || "none"}`)
				if (differs.length && st.failed) {
					stale.push(...differs, `the next build fails: ${String(st.failed).split("\n")[0]}`)
				} else if (differs.length && st.building) {
					stale.push(...differs, "the next build is building")
				} else stale.push(...differs)
			}
		}
		const value = h.read(`/value/${name}`)
		return [{
			name,
			path: e.path,
			box: e.box,
			pinned: !!st.pinned,
			run: rec?.run,
			chain: rec ? rec.steps.map((x: any) => `${x.name} ${short(x.hash)}`) : [],
			keys: rec?.keys ?? [],
			granted: h.list(`${e.box}/keys`),
			uses: (rec?.uses ?? []).map((u: string) => entries.get(u)?.path ?? u),
			error: runtime,
			missing: runtime ? missingKey(runtime, rec?.keys ?? []) : undefined,
			stale,
			building: !!st.building || status === PENDING,
			failed: st.failed ?? undefined,
			waiting: st.waiting ?? undefined,
			why: st.why ?? undefined,
			out,
			shown: shown === undefined
				? undefined
				: Array.isArray(shown)
				? shown.map(String)
				: String(shown),
			value: describe(value),
		}]
	})
}
function describe(v: unknown) {
	if (v === undefined || v === null) return ""
	if (typeof v === "string") return v
	if (typeof v === "object" && Object.getPrototypeOf(v) === null) {
		return "exports " +
			Object.keys(v).filter((k) => typeof (v as any)[k] === "function").join(", ")
	}
	return JSON.stringify(v)
}
// a link error names the import; if the host has a key of that name, say it is not in the box
function missingKey(error: string, handed: string[]) {
	for (const k of Object.keys(keys)) {
		if (error.includes(`"${k}"`) && !handed.includes(k)) {
			return `${k} is a key, but not in this box`
		}
	}
}

// ---- the disk: program.ts's files, each a node at its path: code its value, the rest its
// attributes, each short name (type, takes, gives, loaders) written as the attribute
// @ermine/programs reads. a reload writes only what changed since program.ts was last loaded ----
const disk = new Map<string, string>()
const attr = (a: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(a).map(([k, v]) => [(A as Record<string, string>)[k] ?? k, v]))
function mountFiles(files: Record<string, Record<string, unknown>>) {
	const wrote: string[] = []
	world.seed((host) => {
		for (const [path, entry] of Object.entries(files)) {
			const text = JSON.stringify(entry)
			if (disk.get(path) === text) continue
			const { code: was, ...wasAttrs } = disk.has(path) ? JSON.parse(disk.get(path)!) : {} as any
			const { code, ...attributes } = entry
			const node = host.open(path)
			if (host.read(node) === undefined) host.open(path, code ?? null)
			else if (code !== was) host.edit(node, [{ path: [], value: code ?? null }])
			if (!sameJSON(attributes, wasAttrs) || host.read(host.info(node)) === undefined) {
				host.edit(host.info(node), [{ path: [], value: attr(attributes) }])
			}
			disk.set(path, text)
			wrote.push(path)
		}
		for (const path of [...disk.keys()]) {
			if (path in files) continue
			host.remove(path)
			disk.delete(path)
			wrote.push(path + " (gone)")
		}
	})
	console.info(
		`program.ts: wrote ${wrote.length ? wrote.join(", ") : "nothing (no file changed)"}`,
	)
}

// ---- the world's own folders: the page's loaders, the keys, the cache (the types are the world's)
let builds!: ReturnType<typeof createBuilds>
world.seed((host) => {
	builds = createBuilds({
		scheduler: w.s,
		table: w.table,
		places: { readValue: places.readValue, commit: places.commit },
		// the world's own builds share it: a compile made here is a hit when a process starts
		cache: "cache",
	})
	host.place("/cache", { id: "cache", part: "value" })
	const folder = (at: string) => {
		host.open(at, null)
		host.edit(host.info(at), [{ path: [], value: { [A.loaders]: true } }])
	}
	const loader = (at: string, fn: unknown, attributes: Record<string, unknown>) => {
		host.open(at, fn)
		host.edit(host.info(at), [{ path: [], value: attributes }])
	}
	// js and wasm run what they take; cc, clang on this machine, compiles c to wasm. what it is (its
	// identity) is what the cache is keyed by, not the node
	folder("/loaders")
	loader("/loaders/js", js, { [A.takes]: [JS] })
	loader("/loaders/wasm", wasm, { [A.takes]: [WASM] })
	host.open("/c", null)
	folder("/c/loaders")
	loader("/c/loaders/cc", compileC, {
		[A.takes]: [C],
		[A.gives]: WASM,
		[COMPILER]: {
			name: "clang",
			target: "wasm32",
			flags: ["-O2", "-nostdlib", "-nostdinc", "-fvisibility=default"],
		},
	})
	for (const [k, make] of Object.entries(keys)) host.open(`/keys/${k}`, make)
	host.open("/boxes", null)
	host.open("/state/names", [])
	host.open("/state/log", { ...tally })
	h.memo("/state/procs", rows, { equal: sameJSON as never })
	// what the shell asks of the supervisor: the buttons
	h.method("/ctl/on/pin", (name: string) => {
		const e = entries.get(name)
		if (!e) return
		e.pinned = !e.pinned
		set(name, { pinned: e.pinned })
		if (!e.pinned && e.ready && !(e.running && sameReady(e.running, e.ready))) begin(e, e.ready)
	})
	h.method("/ctl/on/pickup", (name: string) => {
		const e = entries.get(name)
		if (e?.ready) begin(e, e.ready)
	})
	h.method("/ctl/on/stop", (name: string) => untrack(name))
	h.method("/ctl/on/start", (path: string) => {
		if ([...entries.values()].some((e) => e.path === path && !e.box.startsWith("/c/"))) return
		const r = rosterOf(path)
		track((path.split("/").pop() ?? "p").replace(/\.\w+$/, ""), path, r?.[2] ?? {})
	})
	// escape.c again, with secret: the same node placed in /c/vault, a folder that holds keys/secret
	h.method("/ctl/on/vault", () => {
		h.open("/c/vault", null)
		try {
			h.place("/c/vault/escape.c", "/c/sandbox/escape.c")
		} catch { /* placed already */ }
		if (entries.has("escape-vault")) return
		track("escape-vault", "/c/vault/escape.c", { box: "/c/vault", keys: ["print", "secret"] })
	})
})

// a program.ts reload: the files mounted again (only what changed is written), the shell started
// again on the new code. the first one also starts the programs
let booted = false
export function reload(mod: Record<string, any>) {
	mountFiles(mod.files ?? {})
	if (!booted) {
		booted = true
		world.seed(() => {
			for (const [name, path, o] of roster) track(name, path, o)
		})
	}
	world.reload(mod)
} // for scripts (and the screenshots): an edit of a node's code, as the disk would make it

;(globalThis as any).progbuild = {
	edit(path: string, code: string) {
		h.edit(path, [{ path: [], value: code }])
	},
	code: (path: string) => h.read(path),
	api: h,
	entries,
	state,
	tally,
}
