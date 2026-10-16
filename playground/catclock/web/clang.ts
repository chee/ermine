// clang.ts: how the cat is built, said once: each C file compiled into an object, then the objects
// linked. Both compilers are given these: serve.ts' clang (this
// machine's, with wasm-ld) and wasm-clang (clang and wasm-ld built as wasm, @yowasp/clang, in the
// page's worker: clang.worker.ts)
export const CC = [
	"--target=wasm32",
	"-std=c11",
	"-O2",
	"-Wall",
	"-Wextra",
	"-ffreestanding",
	"-nostdlib",
	"-nostdlibinc",
	"-fno-color-diagnostics",
]
export const LD = ["--no-entry", "--export=cc_init", "--export=cc_frame"]

// the C, as the demo seeds its graph with it (sources.json: serve.ts', the demos site's)
export const SOURCES = [
	"catclock.c",
	"colours.h",
	"cat.h",
	"draw.h",
	"maths.h",
	"catclock.h",
	"bitmaps.h",
]

// what wasm-clang is, before it's fetched: deno.json's @yowasp/clang (its clang says 22.1.0)
export const WASM_CLANG = {
	name: "wasm-clang",
	version: "@yowasp/clang 22.0.0-git20542-10",
	target: "wasm32",
	flags: CC,
	link: LD,
}

// what a server compiles, at most: 4 MB of C (asked as JSON)
export const MAX = 4_000_000

// what a compiler is asked: one C file compiled, as a unit (main, and the files it #includes),
// into its object (main's name, .o); or objects linked into out (a .wasm)
export type Ask =
	| { cc: { main: string; files: Record<string, string> } }
	| { ld: { objects: Record<string, Uint8Array>; out: string } }

// an object's name, from its C file's: catclock.c, catclock.o
export const objectOf = (c: string) => c.replace(/\.c$/, ".o")

// the files a C file #includes, and what they #include, as given (blanked: a commented-out
// #include is none): the C file and those, its unit
const INCLUDE = /^\s*#\s*include\s*"([^"]*)"/gm
export function included(main: string, files: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {}
	const go = (name: string) => {
		if (Object.hasOwn(out, name) || !Object.hasOwn(files, name)) return
		out[name] = files[name]
		for (const m of files[name].matchAll(INCLUDE)) go(m[1])
	}
	go(main)
	return out
}

// what a server refuses before compiling, in words; undefined, compile it. main not a file name or
// not given; a file not a file name; an #include of anything but the files given and clang's own
// <stdint.h> <stddef.h> <stdbool.h>; #embed, #import, __has_include (they read files)
const BUILTIN = new Set(["stdint.h", "stddef.h", "stdbool.h"])
function refuseC(main: string, files: Record<string, string>): string | undefined {
	const name = /^[\w-]{1,40}\.[ch]$/
	if (typeof main !== "string" || !name.test(main) || !files || !Object.hasOwn(files, main)) {
		return `no ${main} to compile`
	}
	for (const [file, source] of Object.entries(files)) {
		if (!name.test(file) || typeof source !== "string") return `${file}: not a file name`
		for (const m of source.matchAll(/^\s*#\s*(include|embed|import)\s*([<"])([^>"]*)[>"]/gm)) {
			const ok = m[1] === "include" &&
				(m[2] === '"' ? Object.hasOwn(files, m[3]) : BUILTIN.has(m[3]))
			if (!ok) {
				const said = m[2] === '"' ? `"${m[3]}"` : `<${m[3]}>`
				return `${file}: #${
					m[1]
				} ${said}: only the files beside it, and <stdint.h>, <stddef.h>, <stdbool.h>`
			}
		}
		if (/__has_(include|embed)/.test(source)) return `${file}: no __has_include here`
	}
}
// a link: objects named name.o, bytes each; out named name.wasm
function refuseLd(objects: Record<string, unknown>, out: string): string | undefined {
	if (typeof out !== "string" || !/^[\w-]{1,40}\.wasm$/.test(out)) return `${out}: not a .wasm`
	if (!objects || typeof objects !== "object" || !Object.keys(objects).length) {
		return "no objects to link"
	}
	for (const [file, bytes] of Object.entries(objects)) {
		if (!/^[\w-]{1,40}\.o$/.test(file) || !(bytes instanceof Uint8Array)) {
			return `${file}: not an object`
		}
	}
}
export function refuse(ask: Ask): string | undefined {
	if (ask && typeof ask === "object" && "cc" in ask && ask.cc) {
		return refuseC(ask.cc.main, ask.cc.files)
	}
	if (ask && typeof ask === "object" && "ld" in ask && ask.ld) {
		return refuseLd(ask.ld.objects, ask.ld.out)
	}
	return "ask {cc: {main, files}} or {ld: {objects, out}}"
}

// what a build gives back, from either: serve.ts' POST /compile, or the worker. bytes: the object
// (cc) or the wasm (ld)
export type Answer = {
	ok: boolean
	bytes?: Uint8Array
	error?: string
	warnings?: string
	ms: number
}

// asks and answers as JSON, for a server: bytes gzipped (an object is mostly zeros: the cat's 8.7
// MB is 16 KB), as base64. unzipped, at most MAX_BYTES each
export const MAX_BYTES = 64_000_000
const base64 = (b: Uint8Array) => {
	let s = ""
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
	return btoa(s)
}
async function piped(b: Uint8Array, through: CompressionStream | DecompressionStream) {
	const parts: Uint8Array[] = []
	let n = 0
	const reader = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(through).getReader()
	for (let r = await reader.read(); !r.done; r = await reader.read()) {
		if ((n += r.value.length) > MAX_BYTES) {
			await reader.cancel()
			throw new Error("too many bytes")
		}
		parts.push(r.value)
	}
	const out = new Uint8Array(n)
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
	return out
}
const zip = async (b: Uint8Array) => base64(await piped(b, new CompressionStream("gzip")))
const unzip = (s: string) =>
	piped(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)), new DecompressionStream("gzip"))
const mapped = async <A, B>(o: Record<string, A>, f: (a: A) => Promise<B>) =>
	Object.fromEntries(await Promise.all(Object.entries(o).map(async ([k, v]) => [k, await f(v)])))
export const wire = {
	ask: async (ask: Ask) =>
		JSON.stringify(
			"ld" in ask ? { ld: { ...ask.ld, objects: await mapped(ask.ld.objects, zip) } } : ask,
		),
	// as asked; its objects not zipped: left as they are, refused. not JSON, or not gzip: thrown
	async asked(text: string): Promise<Ask> {
		const ask = JSON.parse(text)
		const o = ask?.ld?.objects
		if (o && typeof o === "object") {
			ask.ld.objects = await mapped(o, async (v) => (typeof v === "string" ? await unzip(v) : v))
		}
		return ask
	},
	answer: async (a: Answer) =>
		JSON.stringify({ ...a, bytes: a.bytes ? await zip(a.bytes) : undefined }),
	async answered(v: Answer & { bytes?: string | Uint8Array }): Promise<Answer> {
		return { ...v, bytes: typeof v.bytes === "string" ? await unzip(v.bytes) : undefined }
	},
}
