// a file on disk through Deno, as access.ts's functions. a write goes to a file beside it first,
// (its mode kept, its bytes synced) then is renamed over it, so a reader never sees half a write; one that fails takes the file
// beside away. a checked write looks at the file after the one beside is written, just before the
// rename: a save landing between that look and the rename is still written over (no lock an
// editor takes). the watch is of the folder (a rename takes the file's place, so a watch of the
// file alone would lose it), told only of events naming the file
import { alike, type FileAccess } from "./access.ts"

export function denoFile(path: string): FileAccess {
	const slash = path.lastIndexOf("/")
	const folder = slash === -1 ? "." : path.slice(0, slash) || "/"
	const base = path.slice(slash + 1)
	async function read() {
		try {
			return await Deno.readFile(path)
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) return undefined
			throw e
		}
	}
	return {
		name: path,
		read,
		async write(bytes, check) {
			const beside = `${folder}/.${base}.${crypto.randomUUID()}`
			try {
				// the file's own mode kept, and its bytes on disk before it takes the file's place
				const mode = await Deno.stat(path).then((s) => s.mode, () => null)
				await Deno.writeFile(beside, bytes)
				if (mode !== null) await Deno.chmod(beside, mode & 0o7777)
				const f = await Deno.open(beside, { write: true })
				await f.syncData().finally(() => f.close())
				if (check && !alike(await read(), check.holds)) {
					await Deno.remove(beside)
					return false
				}
				await Deno.rename(beside, path)
				return true
			} catch (e) {
				await Deno.remove(beside).catch(() => {})
				throw e
			}
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
