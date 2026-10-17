// runner.ts: JavaScript programs' side of ../jsc.c, bundled into runner.js,
// the script the OS evaluates once:
//
//   deno bundle --format iife -o playground/experimental_os/newos/js/runner.js playground/experimental_os/newos/js/runner.ts
//
// A program is a module whose default export is its setup. It is given
// exactly what core gives a part (ermine/programs/typescript/process-api.ts):
//
//   setup, effect, handler   { api, start, call, onCleanup, self, name } (an effect: value,
//                            previous; a handler: args)
//   compute                  { api, peep, start, by, pending, self, name }
//   cleanup                  { killed, api }
//
// api's operations are core's words (and api.as({cause}), api.node(id)), each a call into the OS through
// __ermineOp(handle, op, ...); a map works until its part returns. A program
// imports helpers: `import { handler } from "ermine:kit"` (kit.ts), made into
// a lookup here, as programs are scripts to JavaScriptCore.
//
// The OS takes back __ermine, {load, wasm, run, stand, isStand, pending}, and the
// natives go from the global object, so programs never see them.

import * as kit from "./kit.ts"
import { os as makeOs } from "./os.ts"
import { wasm as makeWasm } from "./wasm.ts"
import { draw as makeDraw } from "./draw.ts"
import * as views from "./views.ts"
import * as icons from "./icons.ts"
import * as readline from "./readline.ts"
import * as program from "./program.ts"
import { TextDecoder, TextEncoder } from "./text.ts"
import { BUDGET, budget, STEP } from "./budget.ts"

type Op = (handle: number, op: string, ...args: unknown[]) => unknown
type Native = typeof globalThis & {
	__ermineOp?: Op
	__ermineSay?: (text: string) => void
	__ermineVram?: (id: number) => Uint32Array | null
	__ermineEval?: (source: string, url: string) => unknown
	__ermineHere?: (pid: string) => string[] | null
	__ermineAfter?: (ms: number, address: string[]) => void
	__ermineKill?: (pid: string) => void
	__ermine?: unknown
}
const g = globalThis as Native
const opOn = g.__ermineOp!,
	say = g.__ermineSay!,
	evaluate = g.__ermineEval!,
	vram = g.__ermineVram!,
	here = g.__ermineHere!,
	after = g.__ermineAfter!,
	kill = g.__ermineKill!
delete g.__ermineOp
delete g.__ermineSay
delete g.__ermineEval
delete g.__ermineVram
delete g.__ermineHere
delete g.__ermineAfter
delete g.__ermineKill

const PENDING = Symbol.for("ermine.pending")

/** a stand-in (ENCODING.tex): what a value is when it cannot be carried, over its kind */
class Stand {
	constructor(readonly kind: unknown) {}
}

// --- libraries a program imports, "ermine:<name>"

/** the part running, innermost: what a font reads its pages through */
const parts: Record<string, unknown>[] = []
const running = () =>
	(parts[parts.length - 1] ?? null) as ReturnType<Parameters<typeof makeDraw>[0]>

// "ermine:os" (os.ts): where a process is, timers, video memory; "ermine:draw" (draw.ts): the blitter, fonts;
// "ermine:views", "ermine:icons", "ermine:readline": views.ts, icons.ts, readline.ts (from deno/, on core's words);
// "ermine:wasm" (wasm.ts): programs compiled to wasm, as C is (CLOADER.md); "ermine:program" (program.ts): a
// program node's processes and its compile, as an editor shows them
const os = makeOs({ here, after, vram, kill })
const wasm = makeWasm(os)
const libraries: Record<string, unknown> = {
	kit,
	os,
	wasm,
	draw: makeDraw(running),
	views,
	icons,
	readline,
	program,
}

/** a module's source as a script: its imports of ermine:<name> lookups, its default export kept */
function script(source: string): string {
	const named = (names: string) => names.replace(/\s+as\s+/g, ": ")
	return source
		.replace(
			/import\s*\{([^}]*)\}\s*from\s*["']ermine:([\w-]+)["'];?/g,
			(_, n, l) => `const {${named(n)}} = __library("${l}");`,
		)
		.replace(
			/import\s+\*\s+as\s+(\w+)\s+from\s*["']ermine:([\w-]+)["'];?/g,
			(_, n, l) => `const ${n} = __library("${l}");`,
		)
		.replace(
			/import\s+(\w+)\s+from\s*["']ermine:([\w-]+)["'];?/g,
			(_, n, l) => `const ${n} = __library("${l}").default;`,
		)
		.replace(/\bexport\s+default\s+/, "__default = ")
		.replace(/\bexport\s+(?=(async\s+)?(function|const|let|class)\b)/g, "")
}

// --- the loop budget (budget.ts): steps left to the run going on; each run of a part starts with BUDGET

let steps = BUDGET

/** a step of the program's: one loop turn, one function entered; past the budget the program is thrown "budget" */
function step(): void {
	if (--steps < 0) {
		steps = 0
		const e = new Error(`the run took more than ${BUDGET} steps (loop turns and functions entered), and was stopped`)
		e.name = "budget"
		throw e
	}
}

/** a program's setup: its module evaluated once, with its URL so its frames say where, the budget's steps in its code */
function load(source: string, url: string): unknown {
	const wrapped = `(function (__library, ${STEP}) { let __default;\n${budget(script(source))}\n;return __default })`
	const f = evaluate(wrapped, url) as (lib: (name: string) => unknown, step: () => void) => unknown
	steps = BUDGET
	return f((name) => {
		if (!(name in libraries)) throw new Error(`no library ermine:${name}`)
		return libraries[name]
	}, step)
}

// --- what a part is given

/** the graph's operations through interface handle; with a cause, each change carries it (api.as) */
function apiOf(h: number, cause?: unknown): Record<string, unknown> {
	const op = cause === undefined
		? opOn
		: (h: number, name: string, ...a: unknown[]) => opOn(h, `@${name}`, cause, ...a)
	return {
		as: (o: { cause: unknown }) => apiOf(h, o.cause),
		node: (id: string) => op(h, "node", id),
		look: (address: unknown) => op(h, "look", address),
		lookup: (path: unknown) => op(h, "lookup", path),
		lookups: (path: unknown) => op(h, "lookups", path),
		children: (address: unknown, name?: string) => op(h, "children", address, name),
		content: (address: unknown) => op(h, "content", address),
		info: (address: unknown, name: string) => op(h, "info", address, name),
		write: (address: unknown, patches: unknown, index?: number, slotindex?: unknown) =>
			op(h, "write", address, patches, index, slotindex),
		set: (
			address: unknown,
			name: string,
			patches: unknown,
			index?: number,
			slotindex?: unknown,
		) => op(h, "set", address, name, patches, index, slotindex),
		insert: (id: string, name: string, child: string, index?: unknown, slotindex?: unknown) =>
			op(h, "insert", id, name, child, index, slotindex),
		remove: (id: string, name: string, index: unknown, slotindex?: unknown) =>
			op(h, "remove", id, name, index, slotindex),
		pop: (id: string, name: string, slotindex: unknown) => op(h, "pop", id, name, slotindex),
		rename: (id: string, name: string, to: string) => op(h, "rename", id, name, to),
		move: (
			id: string,
			name: string,
			index: number,
			toid: string,
			toname: string,
			toindex?: number,
		) => op(h, "move", id, name, index, toid, toname, toindex),
		create: (value?: unknown, o?: unknown) => op(h, "create", value, o),
	}
}

type Info = {
	part: string
	handle: number
	self?: string
	name?: string
	value?: unknown
	previous?: unknown
	args?: unknown
	killed?: boolean
	by?: unknown[]
}

/** a part called with its map */
function run(f: (given: unknown) => unknown, info: Info): unknown {
	const h = info.handle
	const start = (o: unknown) => opOn(h, "start", o)
	let given: Record<string, unknown>
	if (info.part === "cleanup") given = { killed: info.killed, api: apiOf(h) }
	else if (info.part === "compute") {
		given = {
			api: apiOf(h),
			peep: apiOf(h + 1),
			start,
			by: info.by ?? [],
			pending: PENDING,
			self: info.self,
			name: info.name,
		}
	} else {
		given = {
			api: apiOf(h),
			start,
			call: (address: unknown, args?: unknown) => opOn(h, "call", address, args),
			onCleanup: (c: unknown) => opOn(h, "onCleanup", c),
			self: info.self,
			name: info.name,
		}
		if ("value" in info) given.value = info.value
		if ("previous" in info) given.previous = info.previous
		if ("args" in info) given.args = info.args
	}
	parts.push(given)
	// a run of its own: its own budget; a part it was called from (a handler) takes its own back after
	const left = steps
	steps = BUDGET
	try {
		return f(given)
	} finally {
		parts.pop()
		steps = left
	}
}

// --- what JavaScriptCore alone lacks

const show = (args: unknown[]) =>
	args.map((a) => {
		if (typeof a === "string") return a
		try {
			return JSON.stringify(a) ?? String(a)
		} catch {
			return String(a)
		}
	}).join(" ")
const console = {
	log: (...a: unknown[]) => say(show(a)),
	info: (...a: unknown[]) => say(show(a)),
	debug: (...a: unknown[]) => say(show(a)),
	warn: (...a: unknown[]) => say(show(a)),
	error: (...a: unknown[]) => say(show(a)),
}
Object.assign(globalThis, { TextEncoder, TextDecoder, console })

g.__ermine = {
	load,
	wasm: (bytes: ArrayBuffer, url: string) => wasm.load(bytes, url),
	run,
	stand: (kind: unknown) => new Stand(kind),
	isStand: (v: unknown) => (v instanceof Stand ? v : null),
	pending: PENDING,
}
