// What a store asks of macOS's Foundation (FILES.tex, Building it), through
// FFI into the Objective-C runtime: libobjc's objc_getClass, sel_registerName
// and objc_msgSend, with Foundation loaded by dlopen. Four things, each a
// no-op or nothing on Linux:
//
//   coordinate  runs a function under NSFileCoordinator, so an app with the
//               file open, as TextEdit or Preview, is told before it changes
//   bookmark    an NSURL bookmark of a path, which follows it when it moves,
//               and resolve, which leads a bookmark back to a path
//   ubiquitous  whether macOS says a path is in iCloud (NSURLIsUbiquitousItemKey)
//   alias       the path a Finder alias file leads to
//
// Every call is made on the main thread, as sys.ts's are, and objects are
// made and released in an autorelease pool of each call's own.
//
// coordinate gives the coordinator a block, which is built by hand: a global
// block (the runtime's _NSConcreteGlobalBlock, no captured state) whose
// function is a Deno.UnsafeCallback. NSFileCoordinator runs its accessor
// synchronously, on the calling thread, before the method returns, so the
// function runs there, and must itself be synchronous: a promise it returns is
// given back as it is, and what it does after its first await is not
// coordinated. The store uses it around its sys calls, whose effect is made by
// the time they return their promise.

/** What a store asks of Foundation. A host or a test may give another. */
export interface Foundation {
	/** Runs fn under NSFileCoordinator for the item at path, writing or reading; fn runs once, synchronously. options are coordinator's: WRITING.* or READING.*. */
	coordinate<T>(path: string, writing: boolean, fn: () => T, options?: number): T
	/** A bookmark of the item at path; undefined where there are none, or the path is not there. */
	bookmark(path: string): Uint8Array | undefined
	/** The path a bookmark leads to now, without asking a person or mounting anything; undefined if it leads nowhere. */
	resolve(bookmark: Uint8Array): string | undefined
	/** Whether macOS says the item is in iCloud: NSURLIsUbiquitousItemKey. A path that is not there is not. */
	ubiquitous(path: string): boolean
	/** The path a Finder alias file leads to; undefined for anything else. */
	alias(path: string): string | undefined
}

/** NSFileCoordinatorWritingOptions. */
export const WRITING = { deleting: 1, moving: 2, merging: 4, replacing: 8 } as const
/** NSFileCoordinatorReadingOptions. */
export const READING = { withoutChanges: 1, resolving: 2, forUploading: 8 } as const

const mac = Deno.build.os === "darwin"

// <Foundation/NSURL.h>
const BOOKMARK_WITHOUT_UI = 1 << 8
const BOOKMARK_WITHOUT_MOUNTING = 1 << 9
const BOOKMARK_FOR_FILE = 1 << 10
// <objc/runtime.h>: a block that is global has this flag, and no state
const BLOCK_IS_GLOBAL = 1 << 28

type Type = "pointer" | "buffer" | "u64" | "u8"
type Send = (...args: unknown[]) => unknown

const utf8 = new TextEncoder()
const cstr = (s: string) => utf8.encode(s + "\0")

const runtime = "/usr/lib/libobjc.A.dylib"
const foundation = "/System/Library/Frameworks/Foundation.framework/Foundation"

type Libs = {
	getClass(name: Uint8Array): Deno.PointerValue
	register(name: Uint8Array): Deno.PointerValue
	push(): Deno.PointerValue
	pop(pool: Deno.PointerValue): void
	dlsym(handle: Deno.PointerValue, name: Uint8Array): Deno.PointerValue
}
let libs: Libs | undefined
const senders = new Map<string, Send>()
const classes = new Map<string, Deno.PointerValue>()
const selectors = new Map<string, Deno.PointerValue>()

/** libobjc and Foundation, opened once, when first needed. */
function open(): Libs {
	if (libs) return libs
	// loaded for its classes; nothing is called through this handle
	Deno.dlopen(foundation, {})
	const o = Deno.dlopen(runtime, {
		objc_getClass: { parameters: ["buffer"], result: "pointer" },
		sel_registerName: { parameters: ["buffer"], result: "pointer" },
		objc_autoreleasePoolPush: { parameters: [], result: "pointer" },
		objc_autoreleasePoolPop: { parameters: ["pointer"], result: "void" },
	}).symbols
	const c = Deno.dlopen("/usr/lib/libSystem.B.dylib", {
		dlsym: { parameters: ["pointer", "buffer"], result: "pointer" },
	}).symbols
	return libs = {
		getClass: o.objc_getClass,
		register: o.sel_registerName,
		push: o.objc_autoreleasePoolPush,
		pop: o.objc_autoreleasePoolPop,
		dlsym: c.dlsym,
	}
}

function cls(name: string): Deno.PointerValue {
	let c = classes.get(name)
	if (c === undefined) {
		c = open().getClass(cstr(name))
		if (c === null) throw new Error(`no Objective-C class ${name}`)
		classes.set(name, c)
	}
	return c
}

function sel(name: string): Deno.PointerValue {
	let s = selectors.get(name)
	if (s === undefined) selectors.set(name, s = open().register(cstr(name)))
	return s
}

/** objc_msgSend as a call of the given result and argument types, made once for each kind. */
function sender(result: Type | "void", args: readonly Type[]): Send {
	open()
	const key = `${result}(${args.join(",")})`
	let f = senders.get(key)
	if (!f) {
		const lib = Deno.dlopen(runtime, {
			send: {
				name: "objc_msgSend",
				parameters: ["pointer", "pointer", ...args],
				result,
			},
		})
		f = lib.symbols.send as unknown as Send
		senders.set(key, f)
	}
	return f
}

/** Sends a message: receiver, selector, then each argument with its type. */
function send(
	result: Type | "void",
	to: Deno.PointerValue,
	selector: string,
	...args: [Type, unknown][]
): unknown {
	return sender(result, args.map(([t]) => t))(to, sel(selector), ...args.map(([, v]) => v))
}

const object = (to: Deno.PointerValue, selector: string, ...args: [Type, unknown][]) =>
	send("pointer", to, selector, ...args) as Deno.PointerValue

/** Runs fn with an autorelease pool of its own. */
function pooled<T>(fn: () => T): T {
	const l = open()
	const pool = l.push()
	try {
		return fn()
	} finally {
		l.pop(pool)
	}
}

/** An NSString. */
const string = (s: string) =>
	object(cls("NSString"), "stringWithUTF8String:", ["buffer", cstr(s.replaceAll("\0", ""))])

const url = (path: string) => object(cls("NSURL"), "fileURLWithPath:", ["pointer", string(path)])

/** The text of an NSString, which is nil for nothing. */
function text(s: Deno.PointerValue): string | undefined {
	if (s === null) return
	const c = object(s, "UTF8String")
	return c === null ? undefined : Deno.UnsafePointerView.getCString(c)
}

/** An NSData's bytes, copied. */
function bytesOf(data: Deno.PointerValue): Uint8Array {
	const n = Number(send("u64", data, "length"))
	const p = object(data, "bytes")
	return n === 0 || p === null
		? new Uint8Array()
		: new Uint8Array(Deno.UnsafePointerView.getArrayBuffer(p, n)).slice()
}

/** An NSData holding bytes. */
const data = (b: Uint8Array) =>
	object(cls("NSData"), "dataWithBytes:length:", ["buffer", b.length ? b : new Uint8Array(1)], [
		"u64",
		BigInt(b.length),
	])

/** Memory for an out parameter, a pointer; its address, and what it holds after. */
function cell() {
	const mem = new BigUint64Array(1)
	return {
		at: Deno.UnsafePointer.of(mem) as Deno.PointerValue,
		get: () => Deno.UnsafePointer.create(mem[0]),
	}
}

/** The path a URL has. */
const pathOf = (u: Deno.PointerValue) => (u === null ? undefined : text(object(u, "path")))

/** The URL a bookmark's data resolves to, or null. */
function resolved(d: Deno.PointerValue): Deno.PointerValue {
	const stale = new Uint8Array(1)
	const err = cell()
	return object(
		cls("NSURL"),
		"URLByResolvingBookmarkData:options:relativeToURL:bookmarkDataIsStale:error:",
		["pointer", d],
		["u64", BigInt(BOOKMARK_WITHOUT_UI | BOOKMARK_WITHOUT_MOUNTING)],
		["pointer", null],
		["buffer", stale],
		["pointer", err.at],
	)
}

/** A global block calling fn, which takes the block's one pointer argument; memory is kept until released. */
function block(fn: Deno.PointerValue) {
	const l = open()
	// struct Block { void *isa; int flags; int reserved; void *invoke; struct Descriptor *descriptor }
	// struct Descriptor { unsigned long reserved; unsigned long size }
	const mem = new ArrayBuffer(48)
	const view = new DataView(mem)
	const isa = l.dlsym(
		Deno.UnsafePointer.create(0xfffffffffffffffen),
		cstr("_NSConcreteGlobalBlock"),
	)
	if (isa === null) throw new Error("no _NSConcreteGlobalBlock")
	const descriptor = Deno.UnsafePointer.of(mem)!
	const at = Deno.UnsafePointer.value(descriptor)
	view.setBigUint64(0, 0n, true)
	view.setBigUint64(8, 32n, true)
	view.setBigUint64(16, Deno.UnsafePointer.value(isa), true)
	view.setInt32(24, BLOCK_IS_GLOBAL, true)
	view.setInt32(28, 0, true)
	view.setBigUint64(32, Deno.UnsafePointer.value(fn), true)
	view.setBigUint64(40, at, true)
	return { pointer: Deno.UnsafePointer.create(at + 16n), mem }
}

const real: Foundation = {
	coordinate<T>(path: string, writing: boolean, fn: () => T, options = 0): T {
		if (!mac) return fn()
		let result: { ok: T } | { err: unknown } | undefined
		pooled(() => {
			const coordinator = object(
				object(cls("NSFileCoordinator"), "alloc"),
				"initWithFilePresenter:",
				["pointer", null],
			)
			// an exception must not cross back into the runtime
			const callback = new Deno.UnsafeCallback(
				{ parameters: ["pointer", "pointer"], result: "void" },
				() => {
					try {
						result = { ok: fn() }
					} catch (err) {
						result = { err }
					}
				},
			)
			try {
				const b = block(callback.pointer)
				const err = cell()
				send(
					"void",
					coordinator,
					writing
						? "coordinateWritingItemAtURL:options:error:byAccessor:"
						: "coordinateReadingItemAtURL:options:error:byAccessor:",
					["pointer", url(path)],
					["u64", BigInt(options)],
					["pointer", err.at],
					["pointer", b.pointer],
				)
				// kept until the call has returned
				void b.mem
			} finally {
				callback.close()
				send("void", coordinator, "release")
			}
		})
		// the coordinator refused without running the accessor: plain
		if (!result) return fn()
		if ("err" in result) throw result.err
		return result.ok
	},
	bookmark(path) {
		if (!mac) return
		return pooled(() => {
			const err = cell()
			const d = object(
				url(path),
				"bookmarkDataWithOptions:includingResourceValuesForKeys:relativeToURL:error:",
				["u64", 0n],
				["pointer", null],
				["pointer", null],
				["pointer", err.at],
			)
			return d === null ? undefined : bytesOf(d)
		})
	},
	resolve(bookmark) {
		if (!mac) return
		return pooled(() => pathOf(resolved(data(bookmark))))
	},
	ubiquitous(path) {
		if (!mac) return false
		return pooled(() => {
			const v = ubiquity(path)
			return v !== null && send("u8", v, "boolValue") !== 0
		})
	},
	alias(path) {
		if (!mac) return
		return pooled(() => {
			const err = cell()
			const d = object(cls("NSURL"), "bookmarkDataWithContentsOfURL:error:", [
				"pointer",
				url(path),
			], ["pointer", err.at])
			return d === null ? undefined : pathOf(resolved(d))
		})
	},
}

/** NSURLIsUbiquitousItemKey's value for path: an NSNumber, or null when Foundation gives none (no such item, or the iCloud daemon is out of reach). */
function ubiquity(path: string): Deno.PointerValue {
	const value = cell()
	const err = cell()
	const ok = send(
		"u8",
		url(path),
		"getResourceValue:forKey:error:",
		["pointer", value.at],
		["pointer", string("NSURLIsUbiquitousItemKey")],
		["pointer", err.at],
	)
	return ok !== 0 ? value.get() : null
}

/** Whether Foundation can answer ubiquitous at all here: it gives a value for path, which must be there. False where it gives none, as in a sandbox or background job that cannot reach the iCloud daemon (bird), and always off macOS. For tests and hosts that want to say why they skip. */
export function answers(path: string): boolean {
	if (!mac) return false
	return pooled(() => ubiquity(path) !== null)
}

/** Makes a Finder alias file at path leading to target, as Finder would, without asking Finder. For tests and hosts. */
export function makealias(target: string, path: string): boolean {
	if (!mac) return false
	return pooled(() => {
		const err = cell()
		const d = object(
			url(target),
			"bookmarkDataWithOptions:includingResourceValuesForKeys:relativeToURL:error:",
			["u64", BigInt(BOOKMARK_FOR_FILE)],
			["pointer", null],
			["pointer", null],
			["pointer", err.at],
		)
		if (d === null) return false
		const written = send(
			"u8",
			cls("NSURL"),
			"writeBookmarkData:toURL:options:error:",
			["pointer", d],
			["pointer", url(path)],
			["u64", 0n],
			["pointer", err.at],
		)
		return written !== 0
	})
}

/** The real Foundation: macOS's, or on Linux calls that do nothing. */
export const system: Foundation = real
