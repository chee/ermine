// one trial: a fresh ermine, a program placed at /code/trial through its design's adapter, started
// with cwd /work, driven by a task's check. what the program shows is kept in order (a JSX
// element rendered to its text, lib/jsx.ts). a task may start the program more than once: each
// process a code node of its own (/code/trial2 …) holding the same program, with its own cwd
import * as found from "@ermine/ermine/words"
import { compat, type DataAPI } from "./compat.ts"
import { type API, createErmine, type Ermine, type Started } from "@ermine/ermine"
import { equal } from "@std/assert"
import { isElement, register, showing, useScheduler } from "./jsx.ts"

export const CODE = "/code/trial"
export const CWD = "/work"
// one process of a trial: its code node and its cwd
export type Place = { code: string; cwd: string }
export const ONE: Place[] = [{ code: CODE, cwd: CWD }]
// the program started twice: the second process's code at /code/trial2, its cwd /work2
export const TWO: Place[] = [...ONE, { code: `${CODE}2`, cwd: `${CWD}2` }]
// a trial's own code node (any process's): a path under it is the program's own
export const isCode = (p: string) => /^\/code\/trial\d*$/.test(p)

// what every design's program is given beside the design's words
export type Extras = { show: (text: unknown) => void; [name: string]: unknown }
// what an adapter may reach beside the process's api: the trial's scheduler (L finds the process
// from the scope open; jsx.ts opens a component's scope)
export type Reach = { scheduler: Ermine["scheduler"] }
// a design: the real api, wrapped into the object a program destructures
const imported = found as unknown as API

export type Adapter = (api: DataAPI, extras: Extras, reach: Reach) => Record<string, unknown>
export type Program = (api: Record<string, unknown>) => unknown
export type Result = { ran: boolean; correct: boolean; notes: string[] }

// a judge: notes, and whether it ran and did the job
export type Judge = {
	notes: string[]
	// a wrong answer: correct false
	fail: (note: string) => void
	// the program did not run (load, setup or a handler threw): ran false, correct false
	broke: (note: string) => void
	// actual deep-equals expected, else a failure naming what
	is: (actual: unknown, expected: unknown, what: string) => boolean
	result: () => Result
}

export function judge(): Judge {
	const notes: string[] = []
	let ran = true
	let correct = true
	return {
		notes,
		fail: (note) => {
			correct = false
			notes.push(note)
		},
		broke: (note) => {
			ran = false
			correct = false
			notes.push(note)
		},
		is(actual, expected, what) {
			if (equal(actual, expected)) return true
			correct = false
			notes.push(`${what}: wanted ${show(expected)}, got ${show(actual)}`)
			return false
		},
		result: () => ({ ran, correct, notes }),
	}
}

const show = (v: unknown) => v === undefined ? "nothing" : JSON.stringify(v)
export const message = (e: unknown) =>
	typeof e === "symbol"
		? String(e.description ?? e.toString())
		: e instanceof Error
		? `${e.name}: ${e.message}`
		: String(e)

// a few turns of the event loop: pulses, promises and what they ask for
export async function settle(turns = 8) {
	for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0))
}

// settle generously: turns, then ms of real time (a harness's delays are a few ms), then turns
export async function rest(ms = 40) {
	await settle()
	await new Promise((r) => setTimeout(r, ms))
	await settle()
}

// what a program could see of its own run, for lib/hints.ts: its errors (with their stacks), the
// sends still waiting, its memos and effects not done, its handlers, what it showed, the values it
// wrote. never what a check wants. gathered as a trial closes, one per trial (a task may run more)
export type Seen = {
	name: string
	code?: string
	message: string
	stack?: string
	// in the program's file (run.ts keeps these in place of the stack)
	line?: number
	column?: number
}
export type Computer = {
	path: string
	state: string
	phase?: string
	error?: Seen
	// what it waits on: "send /p", "node /p", "a promise", "PENDING"
	waiting?: string[]
	// the nodes its latest run read
	reads?: string[]
}
export type Facts = {
	// thrown to the host: at "start", or "send /p" (the handler at /p threw)
	errors: { at: string; error: Seen }[]
	// the host's sends that found no handler
	unanswered: string[]
	// the process's setup, when not done
	setup?: { state: string; error?: Seen; waiting?: string[] }
	// sends from the program still waiting on a handler (ermine.records.waits())
	waits: { send: string; since: number }[]
	// memos and effects pending, failed or looping
	computers: Computer[]
	// the nodes holding a function: handlers
	handlers: string[]
	// each handler's latest call (ermine.records.call): how it ended, how many writes it made in
	// the call, what it threw. async: it gave the host's send a promise (writes after an await
	// land outside the call, so aren't counted)
	calls: { handler: string; end: string; writes: number; async?: true; error?: Seen }[]
	// the names the program was given beside the design's words (a task's save)
	given: string[]
	shown: string[]
	// what was shown as a JSX element, rendered (also in shown)
	shownJsx: string[]
	// how many times show was given a promise (shown as "{}")
	shownPromises: number
	// nodes the program wrote holding a promise
	promises: string[]
	// the nodes the program wrote last (its handlers too), at most 100
	wrote: string[]
	// a node the program wrote holding a map of one key
	shapes: { path: string; key: string; value: unknown }[]
}

export const seen = (e: unknown): Seen => {
	if (typeof e === "symbol") return { name: "PENDING", message: String(e.description ?? e) }
	if (e instanceof Error) {
		const code = (e as { code?: unknown }).code
		return {
			name: e.name,
			...(typeof code === "string" ? { code } : {}),
			message: e.message,
			...(e.stack ? { stack: e.stack } : {}),
		}
	}
	return { name: typeof e, message: String(e) }
}

// every trial's facts, in the order they closed
export const gathered: Facts[] = []

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) &&
	Object.getPrototypeOf(v) === Object.prototype

type Kept = {
	errors: Facts["errors"]
	unanswered: string[]
	asyncs: Set<string>
	given: string[]
	shown: string[]
	shownJsx: string[]
	shownPromises: number
}

const isThen = (v: unknown) =>
	(typeof v === "object" || typeof v === "function") && v !== null &&
	typeof (v as { then?: unknown }).then === "function"

function gather(ermine: Ermine, starts: Started[], k: Kept): Facts {
	const f: Facts = {
		errors: k.errors,
		unanswered: k.unanswered,
		waits: [],
		computers: [],
		handlers: [],
		calls: [],
		given: k.given,
		shown: [...k.shown],
		shownJsx: [...k.shownJsx],
		shownPromises: k.shownPromises,
		promises: [],
		wrote: [],
		shapes: [],
	}
	const abs = (p: readonly string[]) => "/" + p.join("/")
	// every node from the root, its id: a read's or a wait's id named by its path
	const nodes: { path: string[]; id?: string }[] = []
	const named = new Map<unknown, string>()
	const walk = (path: string[]) => {
		if (nodes.length > 500 || path.length > 10) return
		let names: string[] = []
		try {
			names = [...ermine.list(abs(path))]
		} catch { /* nothing under it */ }
		for (const name of names) {
			const p = [...path, name]
			let id: string | undefined
			try {
				const node = ermine.entries(abs(p))[0]?.node
				const got = node === undefined ? undefined : ermine.dataOf(node)?.node.id
				if (typeof got === "string") id = got
			} catch { /* refused or gone */ }
			nodes.push({ path: p, id })
			if (id !== undefined && !named.has(id)) named.set(id, abs(p))
			walk(p)
		}
	}
	const waiting = (ws: readonly unknown[] | undefined) =>
		ws?.map((w) => {
			if (typeof w === "string") return w
			const o = w as { send?: unknown; node?: unknown; code?: unknown }
			const at = (x: unknown) => Array.isArray(x) ? abs(x) : named.get(x) ?? String(x)
			if (o.send !== undefined) return `send ${at(o.send)}`
			if (o.node !== undefined) return `node ${at(o.node)}`
			if (o.code !== undefined) return `code ${at(o.code)}`
			return String(w)
		})
	try {
		walk([])
		// the first process whose setup isn't done
		const st = starts.map((s) => s.status()).find((st) => st !== undefined && st.state !== "done")
		if (st !== undefined) {
			f.setup = {
				state: st.state,
				...(st.error !== undefined ? { error: seen(st.error) } : {}),
				...(st.waiting ? { waiting: waiting(st.waiting) } : {}),
			}
		}
		// the program's own: the host's sends that found nothing are unanswered's
		f.waits = ermine.records.waits().filter((w) => w.caller !== ermine.node).map((w) => ({
			send: w.path ? abs(w.path) : named.get(w.id) ?? String(w.id),
			since: w.since,
		}))
		for (const { path, id } of nodes) {
			const p = abs(path)
			const run = id === undefined ? undefined : ermine.records.run(id)
			if (run !== undefined && !isCode(p)) {
				const st = ermine.status(p)
				if (st !== undefined && st.state !== "done") {
					const reads = run.reads.flatMap((r) =>
						"id" in r && named.has(r.id) ? [named.get(r.id)!] : []
					)
					f.computers.push({
						path: p,
						state: st.state,
						...(st.phase ? { phase: st.phase } : {}),
						...(st.error !== undefined ? { error: seen(st.error) } : {}),
						...(st.waiting ? { waiting: waiting(st.waiting) } : {}),
						...(reads.length ? { reads: [...new Set(reads)] } : {}),
					})
				}
			}
			let value: unknown
			try {
				value = ermine.peep(p)
			} catch {
				continue
			}
			// the program's write: its change's metadata names the process
			const by =
				(id === undefined ? undefined : ermine.table.get("value", id)?.change?.metadata) as
					| { process?: unknown }
					| undefined
			const mine = Array.isArray(by?.process) && isCode(abs(by.process as string[]))
			if (mine && f.wrote.length < 100) f.wrote.push(p)
			if (typeof value === "function") {
				f.handlers.push(p)
				const c = id === undefined ? undefined : ermine.records.call(id)
				if (c !== undefined) {
					f.calls.push({
						handler: p,
						end: c.end,
						writes: c.writes.length,
						...(k.asyncs.has(p) ? { async: true as const } : {}),
						...(c.end === "failed" ? { error: seen(c.error) } : {}),
					})
				}
			}
			if (!mine) continue
			if (isThen(value)) f.promises.push(p)
			if (!isMap(value)) continue
			const keys = Object.keys(value)
			if (keys.length === 1) f.shapes.push({ path: p, key: keys[0], value: value[keys[0]] })
		}
	} catch (e) {
		f.errors.push({ at: "gathering facts", error: seen(e) })
	}
	return f
}

export type Trial = {
	ermine: Ermine
	shown: string[]
	// shown[i] was a JSX element
	jsx: boolean[]
	// an error from the program's code that a check caught itself (for hints): where, what
	saw: (at: string, e: unknown) => void
	// the latest line shown; none: undefined
	last: () => string | undefined
	// every process started (one, or a task's places)
	start: () => boolean
	// the i-th process's setup
	status: (i?: number) => ReturnType<Started["status"]>
	// how many processes
	readonly processes: number
	// the host's send; its return, or a note on j and undefined
	send: (path: string, ...args: unknown[]) => { ok: boolean; value?: unknown }
	peep: (path: string) => unknown
	close: () => void
}

// a trial of program under adapter; extras beside show (a task's own functions); places: the
// processes to start (none: one, at /code/trial with cwd /work)
export function trial(
	j: Judge,
	adapter: Adapter,
	program: Program,
	extras: Record<string, unknown> = {},
	places: Place[] = ONE,
): Trial {
	const shown: string[] = []
	const jsx: boolean[] = []
	const ermine = createErmine()
	// a component's scope (lib/jsx.ts) is made on this trial's scheduler
	useScheduler(ermine.scheduler)
	const kept: Kept = {
		errors: [],
		unanswered: [],
		asyncs: new Set(),
		given: Object.keys(extras),
		shown,
		shownJsx: [],
		shownPromises: 0,
	}
	// a JSX tree's text, shown: at show, and again each time a component in it renders again
	const pushJsx = (text: string) => {
		shown.push(text)
		jsx.push(true)
		kept.shownJsx.push(text)
	}
	const out = (t: unknown) => {
		if (isThen(t)) kept.shownPromises++
		// a render that throws (E's handle in the braces) throws at the program's show
		if (isElement(t)) return showing(t, pushJsx)
		shown.push(typeof t === "string" ? t : t === undefined ? "undefined" : JSON.stringify(t))
		jsx.push(false)
	}
	// each process its own code node, the same program: the adapter made again for each
	for (const { code } of places) {
		ermine.open(code, () => {
			// setup is given nothing: the process's api is the imported functions, found from the scope
			// open (each call finds this process while its code runs)
			const api = imported
			// components (lib/jsx.ts) find the process's api from the scope open: the setup's, and
			// its parent, the process's
			const open = ermine.scheduler.getCurrentScope()
			if (open !== undefined) register(open, api)
			if (open?.parent !== undefined) register(open.parent, api)
			const words = adapter(compat(api, ermine), { ...extras, show: out }, {
				scheduler: ermine.scheduler,
			})
			// TRIAL_GLOBALS=1: the design's words also as globals, so a program using a word it didn't
			// take out of api still runs (10-25: small models forget to destructure)
			if (Deno.env.get("TRIAL_GLOBALS") === "1") {
				for (const [k, v] of Object.entries(words)) {
					Object.defineProperty(globalThis, k, {
						value: v,
						configurable: true,
						writable: true,
					})
				}
			}
			return program(words)
		})
	}
	const starts: Started[] = []
	const { errors, unanswered } = kept
	return {
		ermine,
		shown,
		jsx,
		processes: places.length,
		saw: (at, e) => void errors.push({ at, error: seen(e) }),
		last: () => shown.at(-1),
		start() {
			for (const { code, cwd } of places) {
				try {
					const s = ermine.start(code, { cwd })
					if ("refused" in s) {
						j.broke(`start refused: ${s.refused}`)
						return false
					}
					starts.push(s)
				} catch (e) {
					errors.push({ at: "start", error: seen(e) })
					j.broke(`start threw ${message(e)}`)
					return false
				}
			}
			return true
		},
		status: (i = 0) => starts[i]?.status(),
		send(path, ...args) {
			try {
				const value = ermine.send(path, ...args)
				if (isThen(value)) kept.asyncs.add(path)
				return { ok: true, value }
			} catch (e) {
				if (e === ermine.PENDING) {
					unanswered.push(path)
					j.fail(`send ${path}: no handler there`)
				} else {
					errors.push({ at: `send ${path}`, error: seen(e) })
					j.fail(`send ${path} threw ${message(e)}`)
				}
				return { ok: false }
			}
		},
		peep: (path) => {
			try {
				return ermine.peep(path)
			} catch (e) {
				return `(peep threw ${message(e)})`
			}
		},
		close: () => {
			gathered.push(gather(ermine, starts, kept))
			try {
				ermine.close()
			} catch (e) {
				// a teardown's throw: the program's (the facts just gathered share this list)
				kept.errors.push({ at: "close", error: seen(e) })
				j.notes.push(`close threw ${message(e)}`)
			}
		},
	}
}

// each process's setup: failed is a broken run; pending is said
export function setupOk(j: Judge, t: Trial, pendingOk = false): boolean {
	for (let i = 0; i < t.processes; i++) {
		const st = t.status(i)
		if (st === undefined) return false
		const which = t.processes > 1 ? ` (process ${i + 1})` : ""
		if (st.state === "failed") {
			j.broke(`setup failed${which}: ${message(st.error)}`)
			return false
		}
		if (st.state === "pending" && !pendingOk) j.notes.push(`setup still pending${which}`)
	}
	return true
}

// the latest line shown is want
export function shows(j: Judge, t: Trial, want: string, when: string) {
	j.is(t.last(), want, `last shown ${when}`)
}

// a program's default export, from its file
export async function load(file: string): Promise<Program> {
	const url = new URL(file, `file://${Deno.cwd()}/`).href
	const mod = await import(url)
	if (typeof mod.default !== "function") {
		throw new Error("the file's default export is not a function")
	}
	return mod.default as Program
}
