// a file on disk through Deno, as access.ts's three functions. a write goes to a file beside it
// first, then is renamed over it, so a reader never sees half a write. the watch is of the folder
// (a rename takes the file's place, so a watch of the file alone would lose it), told only of
// events naming the file
import type { FileAccess } from "./access.ts"

export function denoFile(path: string): FileAccess {
	const slash = path.lastIndexOf("/")
	const folder = slash === -1 ? "." : path.slice(0, slash) || "/"
	const base = path.slice(slash + 1)
	return {
		async read() {
			try {
				return await Deno.readFile(path)
			} catch (e) {
				if (e instanceof Deno.errors.NotFound) return undefined
				throw e
			}
		},
		async write(bytes) {
			const beside = `${folder}/.${base}.${crypto.randomUUID()}`
			await Deno.writeFile(beside, bytes)
			await Deno.rename(beside, path)
		},
		watch(poke) {
			const watcher = Deno.watchFs(folder, { recursive: false })
			;(async () => {
				try {
					for await (const e of watcher) {
						if (e.paths.some((p) => p.endsWith(`/${base}`))) poke()
					}
				} catch { /* closed */ }
			})()
			return () => {
				try {
					watcher.close()
				} catch { /* closed already */ }
			}
		},
	}
}
