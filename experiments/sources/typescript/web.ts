// a file through the web's File System Access API, as access.ts's functions: a handle the person
// granted (showOpenFilePicker, showSaveFilePicker), watched with FileSystemObserver where the
// browser has one. not run by any test here (Deno has no such API): it is the second set of
// functions the holder and mirror take, written to show they fit
//
// a checked write: the new bytes written to the handle's writable (a copy the browser swaps in at
// close), then the file read and compared, then closed, or aborted when it changed. a save landing
// between that read and the close is still written over
import { alike, type FileAccess } from "./access.ts"

// the parts of the API used, typed here: Deno's libraries don't have them
type Handle = {
	readonly name: string
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
	createWritable(): Promise<
		{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
	>
}
type Observer = { observe(handle: Handle): Promise<void>; disconnect(): void }
type Observers = new (callback: () => void) => Observer

export function webFile(
	handle: Handle,
	observers = (globalThis as { FileSystemObserver?: Observers }).FileSystemObserver,
): FileAccess {
	async function read() {
		try {
			return new Uint8Array(await (await handle.getFile()).arrayBuffer())
		} catch (e) {
			if (e instanceof DOMException && e.name === "NotFoundError") return undefined
			throw e
		}
	}
	return {
		name: handle.name,
		read,
		async write(bytes, check) {
			const out = await handle.createWritable()
			try {
				await out.write(bytes)
				if (check && !alike(await read(), check.holds)) {
					await out.abort()
					return false
				}
			} catch (e) {
				await out.abort().catch(() => {})
				throw e
			}
			await out.close()
			return true
		},
		watch(poke) {
			// no observer in this browser: never told (a host may poll load() instead)
			if (observers === undefined) return () => {}
			const observer = new observers(() => poke())
			observer.observe(handle)
			return () => observer.disconnect()
		},
	}
}
