// The platform calls a store needs that Deno has no call for (FILES.tex,
// Building it): extended attributes, swaps, exclusive renames, clones, full
// syncs, file ids and the Trash. On macOS system() makes them through FFI
// into libSystem, and trashes by asking Finder over Apple Events, falling
// back to moving the entry into ~/.Trash under a free name. On Linux it
// makes them through FFI into glibc, and trashes by the freedesktop.org spec. A test gives its
// own trash, never the real one.
//
// Every FFI call is made on the main thread, so errno, read right after it,
// is the call's. open and fcntl are variadic in C: they are declared and
// called without the variadic argument, which Apple silicon would pass on
// the stack, and which O_RDONLY and F_FULLFSYNC never read.

/** Sends an entry to the Trash. */
export type Trash = (path: string) => Promise<void>

/** Every platform call the store makes that Deno has none for. Paths are absolute. */
export interface Sys {
	/** An extended attribute of the entry itself, never a link's target; null if it has none. */
	get(path: string, name: string): Promise<Uint8Array | null>
	/** Sets an extended attribute of the entry itself. */
	set(path: string, name: string, value: Uint8Array): Promise<void>
	/** Removes an extended attribute of the entry itself, if it has one. */
	unset(path: string, name: string): Promise<void>
	/** The names of the entry's own extended attributes. */
	names(path: string): Promise<string[]>
	/** Exchanges two entries in one step (RENAME_SWAP). */
	swap(a: string, b: string): Promise<void>
	/** Renames only if nothing is at to (RENAME_EXCL); taken if something is. */
	rename(from: string, to: string): Promise<"done" | "taken">
	/** Clones a file (clonefile), or copies it where the volume cannot clone; to must not exist. */
	clone(from: string, to: string): Promise<void>
	/** F_FULLFSYNC of a file or a folder; syncing a file's folder is the caller's. */
	sync(path: string): Promise<void>
	/** The file id of the entry itself. */
	id(path: string): Promise<number>
	/** Sends an entry to the Trash: Finder over Apple Events, so Put Back works, else into ~/.Trash. */
	trash: Trash
}

/** The extended attributes a store sets: party.chee.ermine.x on macOS, user.ermine.x on Linux. */
export const attr: {
	readonly id: string
	readonly slot: string
	readonly side: string
	readonly store: string
	/** a node's info, party.chee.ermine.info.<name> */
	readonly info: string
	/** every attribute of ermine's starts so */
	readonly own: string
} = (() => {
	const p = Deno.build.os === "linux" ? "user.ermine." : "party.chee.ermine."
	return {
		id: p + "id",
		slot: p + "slot",
		side: p + "side",
		store: p + "store",
		info: p + "info.",
		own: p,
	}
})()

/**
 * The real calls: all of them on macOS, and on Linux what plain Deno calls
 * make. home is a home folder whose Trash to use in place of the person's;
 * Finder, which knows only the real one, is then never asked. A test gives one.
 */
export function system({ home }: { home?: string } = {}): Sys {
	return Deno.build.os === "darwin" ? mac(home) : linux(home)
}

/** A trash for tests: moves each entry into dir, under a name of its own. */
export function fake(dir: string): Trash {
	return async (path) => {
		await Deno.mkdir(dir, { recursive: true })
		await into(dir, path, exclusive)
	}
}

// <sys/xattr.h>, <stdio.h>, <copyfile.h>, <fcntl.h> and <sys/errno.h> on macOS
const XATTR_NOFOLLOW = 0x1
const RENAME_SWAP = 0x2
const RENAME_EXCL = 0x4
const COPYFILE_ALL = 0xf
const COPYFILE_EXCL = 1 << 17
const O_RDONLY = 0
const F_FULLFSYNC = 51
const EEXIST = 17
const EXDEV = 18
const ERANGE = 34
const linuxOS = Deno.build.os === "linux"
// <asm-generic/errno.h> on Linux
const ENOTSUP = linuxOS ? 95 : 45
const ENOATTR = linuxOS ? 61 : 93
const RENAME_NOREPLACE = 1
const RENAME_EXCHANGE = 2
const AT_FDCWD = -100

const symbols = {
	getxattr: { parameters: ["buffer", "buffer", "buffer", "usize", "u32", "i32"], result: "isize" },
	setxattr: { parameters: ["buffer", "buffer", "buffer", "usize", "u32", "i32"], result: "i32" },
	removexattr: { parameters: ["buffer", "buffer", "i32"], result: "i32" },
	listxattr: { parameters: ["buffer", "buffer", "usize", "i32"], result: "isize" },
	renamex_np: { parameters: ["buffer", "buffer", "u32"], result: "i32" },
	clonefile: { parameters: ["buffer", "buffer", "u32"], result: "i32" },
	copyfile: { parameters: ["buffer", "buffer", "pointer", "u32"], result: "i32" },
	open: { parameters: ["buffer", "i32"], result: "i32" },
	fcntl: { parameters: ["i32", "i32"], result: "i32" },
	fsync: { parameters: ["i32"], result: "i32" },
	close: { parameters: ["i32"], result: "i32" },
	__error: { parameters: [], result: "pointer" },
	strerror: { parameters: ["i32"], result: "pointer" },
} as const

let lib: Deno.DynamicLibrary<typeof symbols>["symbols"] | undefined

// glibc's, for Linux: the l- calls never follow a link, and renameat2 does the swap and the exclusive rename
const linuxSymbols = {
	getxattr: {
		parameters: ["buffer", "buffer", "buffer", "usize"],
		result: "isize",
		name: "lgetxattr",
	},
	setxattr: {
		parameters: ["buffer", "buffer", "buffer", "usize", "i32"],
		result: "i32",
		name: "lsetxattr",
	},
	removexattr: { parameters: ["buffer", "buffer"], result: "i32", name: "lremovexattr" },
	listxattr: { parameters: ["buffer", "buffer", "usize"], result: "isize", name: "llistxattr" },
	renameat2: { parameters: ["i32", "buffer", "i32", "buffer", "u32"], result: "i32" },
	__error: { parameters: [], result: "pointer", name: "__errno_location" },
	strerror: { parameters: ["i32"], result: "pointer" },
} as const

let glibc: Deno.DynamicLibrary<typeof linuxSymbols>["symbols"] | undefined

/** glibc, opened once, when first needed. */
function libc6() {
	return glibc ??= Deno.dlopen("libc.so.6", linuxSymbols).symbols
}

/** libSystem, opened once, when first needed. */
function libc() {
	return lib ??= Deno.dlopen("/usr/lib/libSystem.B.dylib", symbols).symbols
}

/** errno's codes, and the class Deno gives each, on macOS. */
const errors: { [n: number]: [code: string, kind?: new (message: string) => Error] } = linuxOS
	? {
		1: ["EPERM", Deno.errors.PermissionDenied],
		2: ["ENOENT", Deno.errors.NotFound],
		13: ["EACCES", Deno.errors.PermissionDenied],
		16: ["EBUSY", Deno.errors.Busy],
		17: ["EEXIST", Deno.errors.AlreadyExists],
		18: ["EXDEV"],
		20: ["ENOTDIR", Deno.errors.NotADirectory],
		21: ["EISDIR", Deno.errors.IsADirectory],
		22: ["EINVAL"],
		28: ["ENOSPC"],
		34: ["ERANGE"],
		30: ["EROFS"],
		95: ["ENOTSUP", Deno.errors.NotSupported],
		40: ["ELOOP", Deno.errors.FilesystemLoop],
		36: ["ENAMETOOLONG"],
		39: ["ENOTEMPTY"],
	}
	: {
		1: ["EPERM", Deno.errors.PermissionDenied],
		2: ["ENOENT", Deno.errors.NotFound],
		13: ["EACCES", Deno.errors.PermissionDenied],
		16: ["EBUSY", Deno.errors.Busy],
		17: ["EEXIST", Deno.errors.AlreadyExists],
		18: ["EXDEV"],
		20: ["ENOTDIR", Deno.errors.NotADirectory],
		21: ["EISDIR", Deno.errors.IsADirectory],
		22: ["EINVAL"],
		28: ["ENOSPC"],
		34: ["ERANGE"],
		30: ["EROFS"],
		45: ["ENOTSUP", Deno.errors.NotSupported],
		62: ["ELOOP", Deno.errors.FilesystemLoop],
		63: ["ENAMETOOLONG"],
		66: ["ENOTEMPTY"],
	}

/** errno, as the call just made left it. */
function errno(): number {
	const c = linuxOS ? libc6() : libc()
	return new Deno.UnsafePointerView(c.__error()!).getInt32()
}

/** The error of the call just made, as Deno gives its own: its class, code and message. */
function failure(what: string, n = errno()): Error {
	const [code, Kind = Error] = errors[n] ?? []
	const text = Deno.UnsafePointerView.getCString((linuxOS ? libc6() : libc()).strerror(n)!)
	const e = new Kind(`${text} (os error ${n}): ${what}`)
	if (code) Object.assign(e, { code })
	return e
}

const utf8 = new TextEncoder()

/** A string as C takes it: UTF-8, ending in NUL. */
function bytes(s: string): Uint8Array {
	if (s.includes("\0")) throw new TypeError(`a name holds NUL: '${s.replaceAll("\0", "\\0")}'`)
	return utf8.encode(s + "\0")
}

function mac(home?: string): Sys {
	const c = libc()

	const rename = (from: string, to: string) =>
		now((): "done" | "taken" => {
			if (c.renamex_np(bytes(from), bytes(to), RENAME_EXCL) === 0) return "done"
			const n = errno()
			if (n === EEXIST) return "taken"
			throw failure(`renamex_np '${from}' -> '${to}'`, n)
		})

	return {
		get: (path, name) =>
			now(() => {
				const p = bytes(path), k = bytes(name)
				for (;;) {
					const size = Number(c.getxattr(p, k, null, 0n, 0, XATTR_NOFOLLOW))
					if (size >= 0) {
						const out = new Uint8Array(size)
						const got = Number(c.getxattr(p, k, out, BigInt(size), 0, XATTR_NOFOLLOW))
						if (got >= 0) return got === size ? out : out.slice(0, got)
					}
					const n = errno()
					if (n === ENOATTR) return null
					// it grew between the two calls
					if (n === ERANGE) continue
					throw failure(`getxattr '${path}' ${name}`, n)
				}
			}),
		set: (path, name, value) =>
			now(() => {
				const size = BigInt(value.length)
				if (c.setxattr(bytes(path), bytes(name), value, size, 0, XATTR_NOFOLLOW) !== 0) {
					throw failure(`setxattr '${path}' ${name}`)
				}
			}),
		unset: (path, name) =>
			now(() => {
				if (c.removexattr(bytes(path), bytes(name), XATTR_NOFOLLOW) === 0) return
				const n = errno()
				if (n !== ENOATTR) throw failure(`removexattr '${path}' ${name}`, n)
			}),
		names: (path) =>
			now(() => {
				const p = bytes(path)
				for (;;) {
					const size = Number(c.listxattr(p, null, 0n, XATTR_NOFOLLOW))
					if (size >= 0) {
						const out = new Uint8Array(size)
						const got = Number(c.listxattr(p, out, BigInt(size), XATTR_NOFOLLOW))
						if (got >= 0) {
							// each name ends in NUL
							return new TextDecoder().decode(out.subarray(0, got)).split("\0").slice(0, -1)
						}
					}
					const n = errno()
					if (n === ERANGE) continue
					throw failure(`listxattr '${path}'`, n)
				}
			}),
		swap: (a, b) =>
			now(() => {
				if (c.renamex_np(bytes(a), bytes(b), RENAME_SWAP) !== 0) {
					throw failure(`renamex_np swap '${a}' <-> '${b}'`)
				}
			}),
		rename,
		clone: (from, to) =>
			now(() => {
				const f = bytes(from), t = bytes(to)
				if (c.clonefile(f, t, 0) === 0) return
				const n = errno()
				if (n !== ENOTSUP && n !== EXDEV) throw failure(`clonefile '${from}' -> '${to}'`, n)
				// a volume that cannot clone: a copy, attributes and all, only if to is free
				if (c.copyfile(f, t, null, COPYFILE_ALL | COPYFILE_EXCL) === 0) return
				const e = failure(`copyfile '${from}' -> '${to}'`)
				if (!(e instanceof Deno.errors.AlreadyExists)) {
					try {
						Deno.removeSync(to)
					} catch {
						// it was never made
					}
				}
				throw e
			}),
		sync: (path) =>
			now(() => {
				const fd = c.open(bytes(path), O_RDONLY)
				if (fd === -1) throw failure(`open '${path}'`)
				// a volume with no F_FULLFSYNC gets fsync
				const ok = c.fcntl(fd, F_FULLFSYNC) !== -1 || c.fsync(fd) !== -1
				const e = ok ? undefined : failure(`fsync '${path}'`)
				c.close(fd)
				if (e) throw e
			}),
		id,
		async trash(path) {
			// Finder trashes only into the person's own Trash, and an alias to a
			// link is to its target, so a link never goes by Finder
			if (home === undefined && !(await Deno.lstat(path)).isSymlink && await finder(path)) return
			await into(`${home ?? user()}/.Trash`, path, rename)
		},
	}
}

/** Runs fn now, on this thread, giving what it returns or throws as a promise. */
function now<T>(fn: () => T): Promise<T> {
	return new Promise((done) => done(fn()))
}

function linux(home?: string): Sys {
	const c = libc6()

	const rename = (from: string, to: string) =>
		now((): "done" | "taken" => {
			if (
				c.renameat2(AT_FDCWD, bytes(from), AT_FDCWD, bytes(to), RENAME_NOREPLACE) === 0
			) return "done"
			const n = errno()
			if (n === EEXIST) return "taken"
			throw failure(`renameat2 '${from}' -> '${to}'`, n)
		})

	return {
		get: (path, name) =>
			now(() => {
				const p = bytes(path), k = bytes(name)
				for (;;) {
					const size = Number(c.getxattr(p, k, null, 0n))
					if (size >= 0) {
						const out = new Uint8Array(size)
						const got = Number(c.getxattr(p, k, out, BigInt(size)))
						if (got >= 0) return got === size ? out : out.slice(0, got)
					}
					const n = errno()
					if (n === ENOATTR) return null
					// it grew between the two calls
					if (n === ERANGE) continue
					throw failure(`getxattr '${path}' ${name}`, n)
				}
			}),
		set: (path, name, value) =>
			now(() => {
				if (c.setxattr(bytes(path), bytes(name), value, BigInt(value.length), 0) === 0) return
				let n = errno()
				// Linux allows no user attribute on a link
				if (n === 1 && Deno.lstatSync(path).isSymlink) n = ENOTSUP
				throw failure(`setxattr '${path}' ${name}`, n)
			}),
		unset: (path, name) =>
			now(() => {
				if (c.removexattr(bytes(path), bytes(name)) === 0) return
				const n = errno()
				if (n !== ENOATTR) throw failure(`removexattr '${path}' ${name}`, n)
			}),
		names: (path) =>
			now(() => {
				const p = bytes(path)
				for (;;) {
					const size = Number(c.listxattr(p, null, 0n))
					if (size >= 0) {
						const out = new Uint8Array(size)
						const got = Number(c.listxattr(p, out, BigInt(size)))
						if (got >= 0) {
							// each name ends in NUL
							return new TextDecoder().decode(out.subarray(0, got)).split("\0").slice(0, -1)
						}
					}
					const n = errno()
					if (n === ERANGE) continue
					throw failure(`listxattr '${path}'`, n)
				}
			}),
		swap: (a, b) =>
			now(() => {
				if (c.renameat2(AT_FDCWD, bytes(a), AT_FDCWD, bytes(b), RENAME_EXCHANGE) !== 0) {
					throw failure(`renameat2 swap '${a}' <-> '${b}'`)
				}
			}),
		rename,
		async clone(from, to) {
			// to is made only if free, then copied over by copy_file_range, which may share blocks
			await Deno.writeFile(to, new Uint8Array(), { createNew: true })
			try {
				await Deno.copyFile(from, to)
			} catch (e) {
				await Deno.remove(to).catch(() => {})
				throw e
			}
		},
		async sync(path) {
			const f = await Deno.open(path)
			try {
				await f.sync()
			} finally {
				f.close()
			}
		},
		id,
		trash: (path) => xdg(home ?? user(), path),
	}
}

/** The file id of the entry itself, never a link's target. */
async function id(path: string): Promise<number> {
	const { ino } = await Deno.lstat(path)
	if (ino === null) throw new Deno.errors.NotSupported(`no file id: '${path}'`)
	return ino
}

/** Renames only if nothing is at to, by plain Deno calls: it looks, then renames, so two at once can race. */
async function exclusive(from: string, to: string): Promise<"done" | "taken"> {
	try {
		await Deno.lstat(to)
		return "taken"
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) throw e
	}
	await Deno.rename(from, to)
	return "done"
}

/** Moves path into dir under its own name, or, if that is taken, "stem 2.ext", "stem 3.ext" and on. */
async function into(
	dir: string,
	path: string,
	rename: (from: string, to: string) => Promise<"done" | "taken">,
): Promise<string> {
	const name = path.slice(path.lastIndexOf("/") + 1)
	const dot = name.lastIndexOf(".")
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
	for (let n = 1;; n++) {
		const to = `${dir}/${n === 1 ? name : `${stem} ${n}${ext}`}`
		if (await rename(path, to) === "done") return to
	}
}

/** Asks Finder to trash an entry, so Put Back works; false if it could not. */
async function finder(path: string): Promise<boolean> {
	const script = [
		"on run argv",
		"set f to (POSIX file (item 1 of argv)) as alias",
		'tell application "Finder" to delete f',
		"end run",
	]
	const { success } = await new Deno.Command("osascript", {
		args: [...script.flatMap((line) => ["-e", line]), path],
		stdin: "null",
		stdout: "null",
		stderr: "null",
	}).output()
	if (!success) return false
	try {
		await Deno.lstat(path)
		return false
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return true
		throw e
	}
}

/** The freedesktop.org trash: the entry in files/, and in info/ where it was and when. */
async function xdg(home: string, path: string) {
	const dir = `${home}/.local/share/Trash`
	await Deno.mkdir(`${dir}/files`, { recursive: true })
	await Deno.mkdir(`${dir}/info`, { recursive: true })
	const at = new Date()
	const two = (n: number) => String(n).padStart(2, "0")
	const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T` +
		`${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
	const text = `[Trash Info]\nPath=${path.split("/").map(encodeURIComponent).join("/")}\n` +
		`DeletionDate=${date}\n`
	await into(`${dir}/files`, path, async (from, to) => {
		// the info file, made only if free, claims the name
		const info = `${dir}/info/${to.slice(to.lastIndexOf("/") + 1)}.trashinfo`
		try {
			await Deno.writeTextFile(info, text, { createNew: true })
		} catch (e) {
			if (e instanceof Deno.errors.AlreadyExists) return "taken"
			throw e
		}
		const done = await exclusive(from, to).catch(async (e) => {
			await Deno.remove(info)
			throw e
		})
		if (done === "taken") await Deno.remove(info)
		return done
	})
}

/** The person's home folder. */
function user(): string {
	const home = Deno.env.get("HOME")
	if (!home) throw new Error("HOME is not set, so there is no Trash")
	return home
}
