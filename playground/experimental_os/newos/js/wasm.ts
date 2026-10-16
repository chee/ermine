// wasm.ts: "ermine:wasm", the loader of programs compiled to wasm (CLOADER.md,
// The wasm loader): C, by /c (loader.c, cc.c). jsc.c's jscWasm gives a
// module's bytes once; load compiles it once and gives a setup, which
// instantiates it for each process, so each has its own statics, and calls
// the module's setup. The module's imports (module "ermine", ../image/lib/c/
// ermine.h) act through the part running: in a handler, the call's own.
//
// A value crosses as a number naming it in the part's table, good until the
// part returns, as a JavaScript part's values are; 0 is null. Strings and
// addresses are read out of the module's memory, text copied into it. A trap,
// or an operation that throws, ends the part: the stack pointer is put back
// as it was, so the instance goes on with its next part, and the error names
// what was running ("crashed in click: out of bounds memory access"); it is
// kept at <process>/failed until the program says a line or starts over.

import { handler, idAt, put, val, whole } from "./kit.ts"
import type { Api } from "./kit.ts"
import type { os as makeOs } from "./os.ts"
import { TextDecoder, TextEncoder } from "./text.ts"

type Given = {
	api: Api & {
		pop?: (id: string, name: string, slot: unknown) => number
		set?: (address: string[], name: string, patches: unknown) => number
		info?: (address: string[], name: string) => unknown
		lookup?: (path: string[]) => unknown
		lookups?: (path: string[]) => unknown
	}
	self?: string
	name?: string
	args?: unknown
	start?: (op: unknown) => string
	call?: (address: string[], args?: unknown) => unknown
	onCleanup?: (f: (given: Given) => unknown) => void
}
type Os = ReturnType<typeof makeOs>
type Exports = {
	memory: WebAssembly.Memory
	setup?: () => number
	__stack_pointer?: WebAssembly.Global
	__indirect_function_table?: WebAssembly.Table
}

/** <process>/log keeps this many of what the program said */
const LOG = 50
const encoder = new TextEncoder(), decoder = new TextDecoder()

// ermine.h's er_kind
const NULL = 0, BOOL = 1, NUM = 2, TEXT = 3, BYTES = 4, LIST = 5, MAP = 6, OTHER = 7
const isMap = (x: unknown): x is Record<string, unknown> =>
	!!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype
/** bytes (a Uint8Array), or a typed array's elements as bytes */
const bytesOf = (
	x: unknown,
):
	| Uint8Array
	| null => (ArrayBuffer.isView(x) ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : null)
const kindOf = (x: unknown) =>
	x === null || x === undefined
		? NULL
		: typeof x === "boolean"
		? BOOL
		: typeof x === "number"
		? NUM
		: typeof x === "string"
		? TEXT
		: bytesOf(x)
		? BYTES
		: Array.isArray(x)
		? LIST
		: isMap(x)
		? MAP
		: OTHER

/** a value as JSON text, for er_say's %v: bytes as their count, a live value as what it is */
const shown = (x: unknown) => {
	try {
		return JSON.stringify(
			x,
			(
				_,
				v,
			) => (bytesOf(v)
				? `<${bytesOf(v)!.length} bytes>`
				: typeof v === "function"
				? "<live>"
				: v),
		) ?? "null"
	} catch {
		return String(x)
	}
}

/** a thrown error with a code, as the scheduler's are; no name, so it says only its message */
const wrong = (code: string, message: string) =>
	Object.assign(new Error(message), { code, name: "" })

export function wasm(os: Os) {
	/** a module's setup: compiled once here, instantiated per process */
	const load = (bytes: ArrayBuffer, url: string) => {
		const module = new WebAssembly.Module(bytes)
		return (given: Given) => instance(module, url).setup(given)
	}

	/** one process's instance: its memory, its parts' tables of values, what it said */
	const instance = (module: WebAssembly.Module, url: string) => {
		type Frame = { given: Given; values: unknown[]; cause?: unknown }
		const frames: Frame[] = []
		const lines: string[] = []
		let ex: Exports

		const frame = () => {
			const f = frames[frames.length - 1]
			if (!f) throw wrong("stopped", "no part of this program is running")
			return f
		}
		const hold = (v: unknown) => frame().values.push(v === undefined ? null : v) - 1
		const at = (h: number) => (h > 0 ? frame().values[h] ?? null : null)
		const memory = () => new Uint8Array(ex.memory.buffer)
		const text = (p: number, n: number) => decoder.decode(memory().slice(p, p + n))
		const cText = (p: number) => {
			const m = memory()
			let e = p
			while (m[e]) e++
			return decoder.decode(m.slice(p, e))
		}
		const names = (p: number, n: number) => {
			const d = new DataView(ex.memory.buffer)
			return Array.from({ length: n }, (_, i) => cText(d.getUint32(p + 4 * i, true)))
		}
		/** bytes into the module's memory at p, room long; their whole count */
		const copy = (b: Uint8Array, p: number, room: number) => {
			memory().set(b.subarray(0, Math.max(0, Math.min(room, b.length))), p)
			return b.length
		}
		const call = (index: number, args: number) => {
			const f = ex.__indirect_function_table?.get(index)
			if (typeof f !== "function") {
				throw wrong("not-a-handler", `no function ${index} in its table`)
			}
			f(args)
		}

		/** a part of the program run: its own table of values; on a trap or a throw the stack pointer put back */
		const enter = <T>(given: Given, what: string, run: () => T): T => {
			const top = ex.__stack_pointer?.value as number | undefined
			frames.push({ given, values: [null] })
			try {
				return run()
			} catch (e) {
				if (top !== undefined && ex.__stack_pointer) ex.__stack_pointer.value = top
				// what the trap was, without JavaScriptCore's "(evaluating 'f(args)')"
				const out = e instanceof WebAssembly.RuntimeError
					? wrong(
						"crashed",
						`crashed in ${what}: ${
							e.message.replace(/ \(evaluating .*\)$/, "").toLowerCase()
						}`,
					)
					: e as { code?: string; message?: string }
				failed(
					given,
					out.code === "crashed"
						? String(out.message)
						: `failed in ${what}: ${out.code ? `${out.code}: ` : ""}${out.message ?? out}`,
				)
				throw out
			} finally {
				frames.pop()
			}
		}
		/**
		 * A part that ended with an error, said at <process>/failed until the program says a line or
		 * starts over: a handler's error reaches neither the process's status nor its run, so an
		 * editor reads it here (ermine:program). null: none
		 */
		let failing = false
		const failed = (g: Given, text: string | null) => {
			const { api, self, name } = g
			if (!self || !name || (text === null && !failing)) return
			try {
				if (idAt(api, [name, "failed"])) api.write([name, "failed"], whole(text))
				else if (text !== null) put(api, self, "failed", text, { ephemeral: true })
				failing = text !== null
			} catch {
				// the part is ending with its own error
			}
		}
		/** a function of the program's as a part of the process: a handler, a timer, a cleanup */
		const part = (what: string, index: number) => (given: Given) =>
			enter(given, what, () => call(index, hold(given.args ?? [])))

		/** where the process is: its place, for an address read from there */
		const absolute = (g: Given, address: string[]) => {
			if (address[0] === "/") return address
			const out = os.here(g.self!).slice(0, -1)
			for (const n of address) n === ".." ? out.length > 1 && out.pop() : out.push(n)
			return out
		}

		/** a line said: <process>/log, its last LOG */
		const say = (line: string) => {
			lines.push(line)
			while (lines.length > LOG) lines.shift()
			const { api, self, name } = frame().given
			if (!self || !name) return
			if (idAt(api, [name, "log"])) api.write([name, "log"], whole([...lines]))
			else put(api, self, "log", [...lines], { ephemeral: true })
			failed(frame().given, null)
		}

		/** er__op: core's words, and the process's own (ermine.h) */
		const op = (word: string, address: string[] | null, a: unknown[]): unknown => {
			const f = frame(), g = f.given
			const api = (f.cause !== undefined ? g.api.as({ cause: f.cause }) : g.api) as Given["api"]
			const where = () => {
				if (!address) throw wrong("wrong-field", `${word} takes an address`)
				return address
			}
			switch (word) {
				case "read":
					return val(api, where())
				case "id":
					return idAt(api, where()) ?? null
				case "write": {
					// written whole, or made in its parent by its last name
					if (idAt(api, where())) return api.write(where(), whole(a[0]))
					const to = absolute(g, where())
					const parent = idAt(api, to.slice(0, -1))
					if (!parent) {
						throw wrong(
							"nothing-there",
							`write: nothing at ${to.slice(0, -1).join("/").replace(/^\/\/?/, "/")}`,
						)
					}
					return api.insert(parent, to[to.length - 1], api.create(a[0]))
				}
				case "patch":
					return api.write(where(), a[0] as never)
				case "set":
					return api.set!(where(), a[0] as string, whole(a[1]))
				case "look":
					return api.look(where())
				case "lookup":
					return api.lookup!(where())
				case "lookups":
					return api.lookups!(where())
				case "content":
					return api.content(where())
				case "info":
					return api.info!(where(), a[0] as string)
				case "children":
					return a.length ? api.children(where(), a[0] as string) : api.children(where())
				case "create":
					return api.create(a[0], { ephemeral: !!a[1] })
				case "insert":
					return api.insert(a[0] as string, a[1] as string, a[2] as string)
				case "remove":
					return api.remove(a[0] as string, a[1] as string, a[2] as number)
				case "pop":
					return api.pop!(a[0] as string, a[1] as string, a[2])
				case "rename":
					return api.rename(a[0] as string, a[1] as string, a[2] as string)
				case "move":
					return api.move(
						a[0] as string,
						a[1] as string,
						a[2] as number,
						a[3] as string,
						a[4] as string,
					)
				case "node":
					return api.node(a[0] as string)
				case "as":
					f.cause = a[0] ?? undefined
					return null
				case "self":
					return g.self ?? null
				case "name":
					return g.name ?? null
				case "handler":
					return handler(
						g as never,
						a[0] as string,
						part(a[0] as string, a[1] as number) as never,
					)
				case "after":
					os.after(g as never, a[0] as number, part("a timer", a[1] as number) as never)
					return null
				case "cleanup":
					if (!g.onCleanup) {
						throw wrong("wrong-field", "a cleanup is set up by a setup or a handler")
					}
					g.onCleanup(part("cleanup", a[0] as number))
					return null
				case "start": {
					if (!g.start) throw wrong("wrong-field", "this part starts nothing")
					return g.start({
						address: where(),
						program: a[0],
						...(typeof a[1] === "string" ? { name: a[1] } : {}),
					})
				}
				case "call":
					if (!g.call) throw wrong("wrong-field", "this part calls nothing")
					return g.call(where(), a[0]) ?? null
				case "end":
					os.end(g as never)
					return null
			}
			throw wrong("wrong-field", `no such operation: ${word}`)
		}

		const imports = {
			ermine: {
				num: (n: number) => hold(n),
				text: (p: number, n: number) => hold(text(p, n)),
				bytes: (p: number, n: number) => hold(memory().slice(p, p + n)),
				bool: (b: number) => hold(!!b),
				list: () => hold([]),
				map: () => hold({}),
				push: (l: number, v: number) => {
					const x = at(l)
					if (Array.isArray(x)) x.push(at(v))
				},
				put: (m: number, k: number, n: number, v: number) => {
					const x = at(m)
					if (isMap(x)) x[text(k, n)] = at(v)
				},
				kind: (h: number) => kindOf(at(h)),
				number: (h: number) => {
					const x = at(h)
					return typeof x === "number" ? x : typeof x === "boolean" ? Number(x) : 0
				},
				length: (h: number) => {
					const x = at(h)
					return typeof x === "string" ? encoder.encode(x).length : bytesOf(x)?.length ??
						(Array.isArray(x) ? x.length : isMap(x) ? Object.keys(x).length : 0)
				},
				copy: (h: number, p: number, room: number) => {
					const x = at(h)
					if (typeof x === "string") {
						const b = encoder.encode(x)
						if (b.length < room) memory()[p + b.length] = 0
						return copy(b, p, room)
					}
					const b = bytesOf(x)
					return b ? copy(b, p, room) : 0
				},
				item: (h: number, i: number) => {
					const x = at(h)
					return hold(Array.isArray(x) ? x[i] : null)
				},
				get: (h: number, k: number, n: number) => {
					const x = at(h)
					return hold(isMap(x) ? x[text(k, n)] : null)
				},
				keys: (h: number) => {
					const x = at(h)
					return hold(isMap(x) ? Object.keys(x) : [])
				},
				show: (h: number, p: number, room: number) =>
					copy(encoder.encode(shown(at(h))), p, room),
				op: (o: number, no: number, p: number, n: number, args: number) => {
					const a = at(args)
					return hold(op(text(o, no), n >= 0 ? names(p, n) : null, Array.isArray(a) ? a : []))
				},
				say: (p: number, n: number) => say(text(p, n)),
			},
		}

		/** the process's setup: the module's own, its value the process's */
		const setup = (given: Given) => {
			try {
				ex = new WebAssembly.Instance(module, imports).exports as unknown as Exports
			} catch (e) {
				throw wrong("not-a-program", `${url}: ${(e as Error).message}`)
			}
			if (typeof ex.setup !== "function") {
				throw wrong("not-a-program", "a program starts at setup(), and this one has none")
			}
			// started over: what failed before is gone
			failing = true
			failed(given, null)
			return enter(given, "setup", () => at(ex.setup!()))
		}
		return { setup }
	}

	return { load }
}
