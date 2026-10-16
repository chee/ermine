// dlopen: a host runner whose load treats the code as a shared library for this machine, the
// native ABI (c/native.h says it once), through Deno.dlopen: --allow-ffi; its files, --allow-write;
// signing, --allow-run=/usr/bin/codesign. c/dlopen.h is the C's; conformance/native holds both
//
//   const dlopen = createDlopen({ dir, pointer, note })
//   table.sub("value", "DL", createEntry(dlopen, header))   // start.ts' Runner: a by's last step
//
// load(code): code bytes (else Error "not bytes"), written to a file of its own in dir (none: the
// system's temp folder), ermine-<random>.so, and opened (Deno.dlopen). its live form (start.ts'
// Loaded), each there only when the library exports it:
//   compile(input)  input bytes, or a string's UTF-8 (else Error "not bytes"); its output bytes.
//                   non-zero: Error "compile failed: <n>"
//   run(code, api)  code as compile's input; api handed on through pointer (none: null). non-zero:
//                   Error "run failed: <n>". its handle's stop: the library's stop (none: nothing)
//   [Symbol.dispose]  the library closed, its file removed: start.ts calls it as the last process
//                   holding it stops. compile, run or stop after: Error "unloaded"
// failing: the file removed, Error "dlopen failed", its cause what was thrown, noted ("not written",
// "dlopen failed"). dlopen failing for a missing code signature (macOS): the file signed ad hoc
// (codesign -s - -f), noted ("signed", the file), opened again
// run(code, api): the code is a library run as a program: loaded, its run called with no code (0
// bytes) and the api, its stop then the library let go as the process stops. fails as load does,
// or Error "no run in the library", or "run failed: <n>"
//
// mine, open: a string as UTF-8 and every output as bytes; the library's run as the runner's own
import type { Handle, Loaded } from "./start.ts"

export type Options = {
	// where the files go; none: the system's temp folder
	dir?: string
	// how the api reaches native code: a pointer to what the host made of it; none: null
	pointer?: (api: unknown) => Deno.PointerValue
	// told what is worth telling: what ("signed", "not written", "dlopen failed") and its detail;
	// none: a line to stderr
	note?: (what: string, detail: string) => void
}

// a library's live form, as load gives it
export type Live = Loaded & Disposable

// the runner: a library run as a program, and load (start.ts' Runner)
export type Dlopen = ((code: unknown, api: unknown) => Handle) & {
	readonly load: (code: unknown) => Live
}

const exports = {
	compile: { parameters: ["buffer", "usize", "buffer", "buffer"], result: "i32", optional: true },
	run: { parameters: ["buffer", "usize", "pointer", "buffer"], result: "i32", optional: true },
	stop: { parameters: ["pointer"], result: "void", optional: true },
} as const

type Library = Deno.DynamicLibrary<typeof exports>

const CODESIGN = "/usr/bin/codesign"

// free, for what a library's compile malloc'd
let libc: Deno.DynamicLibrary<{ free: { parameters: ["pointer"]; result: "void" } }> | undefined
function free(p: Deno.PointerValue) {
	libc ??= Deno.dlopen(
		Deno.build.os === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{ free: { parameters: ["pointer"], result: "void" } },
	)
	libc.symbols.free(p)
}

// a value's bytes: bytes as they are, a string's UTF-8
function bytesOf(v: unknown): Uint8Array<ArrayBuffer> {
	if (v instanceof Uint8Array) return new Uint8Array(v)
	if (typeof v === "string") return new TextEncoder().encode(v)
	throw new Error("not bytes")
}

// the file signed ad hoc: whether codesign says so
function sign(path: string): boolean {
	try {
		const args = ["-s", "-", "-f", path]
		return new Deno.Command(CODESIGN, { args, stdout: "null", stderr: "null" }).outputSync()
			.success
	} catch {
		return false
	}
}

export function createDlopen(options: Options = {}): Dlopen {
	const pointer = options.pointer ?? (() => null)
	const note = options.note ??
		((what: string, detail: string) => console.error(`dlopen: ${what}: ${detail}`))

	function open(path: string): Library {
		try {
			return Deno.dlopen(path, exports)
		} catch (e) {
			if (!String((e as Error)?.message).includes("code signature") || !sign(path)) throw e
			note("signed", path)
			return Deno.dlopen(path, exports)
		}
	}

	function load(code: unknown): Live {
		if (!(code instanceof Uint8Array)) throw new Error("not bytes")
		let path: string | undefined
		try {
			path = Deno.makeTempFileSync({ dir: options.dir, prefix: "ermine-", suffix: ".so" })
			Deno.writeFileSync(path, code)
		} catch (cause) {
			note("not written", String((cause as Error)?.message ?? cause))
			if (path !== undefined) remove(path)
			throw new Error("dlopen failed", { cause })
		}
		let lib: Library
		try {
			lib = open(path)
		} catch (cause) {
			note("dlopen failed", String((cause as Error)?.message ?? cause))
			remove(path)
			throw new Error("dlopen failed", { cause })
		}
		const file = path
		let closed = false
		const symbols = () => {
			if (closed) throw new Error("unloaded")
			return lib.symbols
		}
		const live: { -readonly [K in keyof Live]: Live[K] } = {
			[Symbol.dispose]() {
				if (closed) return
				closed = true
				lib.close()
				remove(file)
			},
		}
		if (lib.symbols.compile !== null) live.compile = (input) => compile(symbols, input)
		if (lib.symbols.run !== null) live.run = (code, api) => run(symbols, code, api)
		return live
	}

	function compile(symbols: () => Library["symbols"], input: unknown): Uint8Array {
		const bytes = bytesOf(input)
		const out = new BigUint64Array(1)
		const outn = new BigUint64Array(1)
		const rc = symbols().compile!(bytes, BigInt(bytes.length), out, outn)
		if (rc !== 0) throw new Error(`compile failed: ${rc}`)
		const p = Deno.UnsafePointer.create(out[0])
		const n = Number(outn[0])
		const got = p === null || n === 0
			? new Uint8Array(0)
			: new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(p, n).slice(0))
		if (p !== null) free(p)
		return got
	}

	function run(symbols: () => Library["symbols"], code: unknown, api: unknown): Handle {
		const bytes = bytesOf(code)
		const state = new BigUint64Array(1)
		const rc = symbols().run!(bytes, BigInt(bytes.length), pointer(api), state)
		if (rc !== 0) throw new Error(`run failed: ${rc}`)
		const st = Deno.UnsafePointer.create(state[0])
		return { stop: () => void symbols().stop?.(st) }
	}

	// the library as a program
	const runner = (code: unknown, api: unknown): Handle => {
		const live = load(code)
		if (live.run === undefined) {
			live[Symbol.dispose]()
			throw new Error("no run in the library")
		}
		let h: Handle
		try {
			h = live.run(new Uint8Array(0), api) as Handle
		} catch (e) {
			live[Symbol.dispose]()
			throw e
		}
		return {
			stop: () => {
				try {
					h.stop()
				} finally {
					live[Symbol.dispose]()
				}
			},
		}
	}
	return Object.assign(runner, { load })
}

function remove(path: string) {
	try {
		Deno.removeSync(path)
	} catch { /* gone */ }
}
