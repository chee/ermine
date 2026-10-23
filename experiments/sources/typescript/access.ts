// a file, as three functions and a name given: so one holder (file.ts) or mirror (mirror.ts) works
// over Deno's files (deno.ts), the web's File System Access API (web.ts), or a file in memory
// (below)
// deno-lint-ignore-file require-await -- a file in memory answers at once; async as a real one is
export type FileAccess = {
	// what the file is called, for whoever is shown it (a path, a handle's name)
	readonly name: string
	// the file's bytes; undefined: there is no file
	read(): Promise<Uint8Array | undefined>
	// the file's bytes made these, whole. check: only when the file holds check.holds (undefined:
	// only when there is no file), looked at as near the write as the platform lets; it didn't:
	// nothing written, false
	write(bytes: Uint8Array, check?: { holds: Uint8Array | undefined }): Promise<boolean>
	// poke told when the file may have changed (by anyone: its own writes too, as a real watch
	// is); gives back the stop
	watch(poke: () => void): () => void
}

// whether two files' bytes are the same; both undefined (no file either way): the same
export function alike(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined) return a === b
	return a.length === b.length && a.every((x, i) => x === b[i])
}

// a file in memory, for tests: edit is another process writing it (heard false: a save the watch
// has not told of yet, nor will), remove a person deleting (or renaming) it. fail: writes throw
export type FakeFile = FileAccess & {
	bytes: Uint8Array | undefined
	edit(bytes: Uint8Array, heard?: boolean): void
	remove(): void
	fail: boolean
}

let made = 0

export function createFakeFile(name = `memory-${++made}`): FakeFile {
	const pokes = new Set<() => void>()
	// a watch hears later, never in the write's own call
	const tell = () => queueMicrotask(() => [...pokes].forEach((p) => p()))
	const file: FakeFile = {
		name,
		bytes: undefined,
		fail: false,
		read: async () => file.bytes && file.bytes.slice(),
		async write(bytes, check) {
			if (file.fail) throw new Error("the disk said no")
			if (check && !alike(file.bytes, check.holds)) return false
			file.bytes = bytes.slice()
			tell()
			return true
		},
		watch(poke) {
			pokes.add(poke)
			return () => void pokes.delete(poke)
		},
		edit(bytes, heard = true) {
			file.bytes = bytes.slice()
			if (heard) tell()
		},
		remove() {
			file.bytes = undefined
			tell()
		},
	}
	return file
}
