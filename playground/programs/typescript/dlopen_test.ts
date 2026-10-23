// the dlopen runner on the native fixtures (c/fixtures), built here with cc into a folder of the
// test's own: reverse (compile), runner (run, stop), unsigned (runner, macOS: not signed). skipped
// without --allow-ffi, --allow-write and --allow-run
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert"
import { createDlopen, type Live } from "./dlopen.ts"
import type { Start } from "./start.ts"

const fixtures = new URL("../c/fixtures/", import.meta.url).pathname
const darwin = Deno.build.os === "darwin"
const allowed = (["ffi", "write", "run"] as const).every((name) =>
	Deno.permissions.querySync({ name }).state === "granted"
)

let folder: string | undefined
function built(): string {
	if (folder !== undefined) return folder
	const dir = folder = Deno.makeTempDirSync({ prefix: "ermine-dlopen-test-" })
	globalThis.addEventListener("unload", () => Deno.removeSync(dir, { recursive: true }))
	return dir
}
const made = new Map<string, Uint8Array>()
function build(name: string, source = name, flags: string[] = []): Uint8Array {
	const had = made.get(name)
	if (had !== undefined) return had
	const out = `${built()}/${name}.so`
	const shared = darwin ? ["-dynamiclib"] : ["-shared", "-fPIC"]
	const { success, stderr } = new Deno.Command("cc", {
		args: [...shared, ...flags, "-o", out, `${fixtures}${source}.c`],
		stdout: "null",
		stderr: "piped",
	}).outputSync()
	if (!success) throw new Error(new TextDecoder().decode(stderr))
	const bytes = Deno.readFileSync(out)
	made.set(name, bytes)
	return bytes
}
const reverse = () => build("reverse")
const runner = () => build("runner")
const test = (name: string, fn: () => void, ignore = false) =>
	Deno.test({ name, ignore: ignore || !allowed, fn })
// the start's facts a runner is handed: none of them read here (no api given: they are the api)
const start = {} as Start

// a runner with its files in a folder of its own, its notes kept
function world(pointer?: (api: unknown) => Deno.PointerValue) {
	const dir = Deno.makeTempDirSync({ dir: built(), prefix: "files-" })
	const notes: string[] = []
	const dl = createDlopen({ dir, pointer, note: (what) => void notes.push(what) })
	const files = () => [...Deno.readDirSync(dir)].length
	return { dl, notes, files }
}

// a native api: { ctx, write }, what is written kept as text
function api() {
	const wrote: string[] = []
	const write = new Deno.UnsafeCallback(
		{ parameters: ["pointer", "pointer", "usize"], result: "void" } as const,
		(_ctx, bytes, n) => {
			const len = Number(n)
			wrote.push(
				bytes === null || len === 0
					? ""
					: new TextDecoder().decode(Deno.UnsafePointerView.getArrayBuffer(bytes, len)),
			)
		},
	)
	const struct = new BigUint64Array([1n, BigInt(Deno.UnsafePointer.value(write.pointer))])
	return { wrote, pointer: () => Deno.UnsafePointer.of(struct), close: () => write.close() }
}

test("load: compile there, start not; bytes reversed, a string's UTF-8 too; disposed, the file gone and compile unloaded", () => {
	const w = world()
	const live: Live = w.dl.load(reverse())
	assertEquals([typeof live.compile, live.start, w.files()], ["function", undefined, 1])
	assertEquals(live.compile!(new Uint8Array([1, 2, 3])), new Uint8Array([3, 2, 1]))
	assertEquals(live.compile!("hé"), new Uint8Array([0xa9, 0xc3, 0x68]))
	assertEquals(live.compile!(""), new Uint8Array(0))
	assertThrows(() => live.compile!({}), Error, "not bytes")
	live[Symbol.dispose]()
	live[Symbol.dispose]()
	assertEquals(w.files(), 0)
	assertThrows(() => live.compile!("hi"), Error, "unloaded")
})

test("load: bytes that are no library, an Error dlopen failed (its cause dlopen's), noted, the file gone; no bytes, not bytes", () => {
	const w = world()
	const e = assertThrows(() => w.dl.load(new TextEncoder().encode("not a library")), Error)
	assertEquals(e.message, "dlopen failed")
	assertInstanceOf(e.cause, Error)
	assertEquals([w.notes, w.files()], [["dlopen failed"], 0])
	assertThrows(() => w.dl.load("a string"), Error, "not bytes")
})

test("load: a runner's start given the code and the api through pointer, its stop the library's", () => {
	const a = api()
	const w = world(a.pointer)
	const live = w.dl.load(runner())
	assertEquals(live.compile, undefined)
	const h = live.start!("tick", start)
	h.stop()
	assertEquals(a.wrote, ["tick", "stop"])
	live[Symbol.dispose]()
	assertEquals(w.files(), 0)
	a.close()
})

test("load: a run failing (no api: null), an Error run failed with its number", () => {
	const w = world()
	const live = w.dl.load(runner())
	assertThrows(() => live.start!("tick", start), Error, "run failed: 2")
	live[Symbol.dispose]()
})

test("the runner's own start: the library run as a program, no code; stopped, its stop then the library let go", () => {
	const a = api()
	const w = world(a.pointer)
	const h = w.dl.start(runner(), start)
	assertEquals([a.wrote, w.files()], [[""], 1])
	h.stop()
	assertEquals([a.wrote, w.files()], [["", "stop"], 0])
	assertThrows(() => w.dl.start(reverse(), start), Error, "no run in the library")
	assertEquals(w.files(), 0)
	a.close()
})

test("an unsigned library (macOS on arm64): signed ad hoc, noted, then opened", () => {
	const unsigned = build("unsigned", "runner", ["-Wl,-no_adhoc_codesign"])
	const a = api()
	const w = world(a.pointer)
	const live = w.dl.load(unsigned)
	assertEquals(w.notes, ["signed"])
	const h = live.start!("hi", start)
	h.stop()
	assertEquals(a.wrote, ["hi", "stop"])
	live[Symbol.dispose]()
	a.close()
}, !darwin || Deno.build.arch !== "aarch64")
