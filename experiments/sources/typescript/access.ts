// a file, as three functions given: so one holder (file.ts) or mirror (mirror.ts) works over
// Deno's files (deno.ts), the web's File System Access API (web.ts), or a file in memory (below)
// deno-lint-ignore-file require-await -- a file in memory answers at once; async as a real one is
export type FileAccess = {
	// the file's bytes; undefined: there is no file yet
	read(): Promise<Uint8Array | undefined>
	// the file's bytes made these, whole
	write(bytes: Uint8Array): Promise<void>
	// poke told when the file may have changed (by anyone: its own writes too, as a real watch
	// is); gives back the stop
	watch(poke: () => void): () => void
}

// a file in memory, for tests: edit is another process writing it. fail: writes throw
export type FakeFile = FileAccess & {
	bytes: Uint8Array | undefined
	edit(bytes: Uint8Array): void
	fail: boolean
}

export function createFakeFile(): FakeFile {
	const pokes = new Set<() => void>()
	// a watch hears later, never in the write's own call
	const tell = () => queueMicrotask(() => [...pokes].forEach((p) => p()))
	const file: FakeFile = {
		bytes: undefined,
		fail: false,
		read: async () => file.bytes && file.bytes.slice(),
		async write(bytes) {
			if (file.fail) throw new Error("the disk said no")
			file.bytes = bytes.slice()
			tell()
		},
		watch(poke) {
			pokes.add(poke)
			return () => void pokes.delete(poke)
		},
		edit(bytes) {
			file.bytes = bytes.slice()
			tell()
		},
	}
	return file
}
