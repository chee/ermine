// a file through the web's File System Access API, as access.ts's three functions: a handle the
// person granted (showOpenFilePicker, showSaveFilePicker), watched with FileSystemObserver where
// the browser has one. not run by any test here (Deno has no such API): it is the second set of
// functions the holder and mirror take, written to show they fit
import type { FileAccess } from "./access.ts"

// the parts of the API used, typed here: Deno's libraries don't have them
type Handle = {
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
	createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>
}
type Observer = { observe(handle: Handle): Promise<void>; disconnect(): void }
type Observers = new (callback: () => void) => Observer

export function webFile(
	handle: Handle,
	observers = (globalThis as { FileSystemObserver?: Observers }).FileSystemObserver,
): FileAccess {
	return {
		async read() {
			try {
				return new Uint8Array(await (await handle.getFile()).arrayBuffer())
			} catch (e) {
				if (e instanceof DOMException && e.name === "NotFoundError") return undefined
				throw e
			}
		},
		async write(bytes) {
			const out = await handle.createWritable()
			await out.write(bytes)
			await out.close()
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
