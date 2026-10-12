// A backend for a device's Subduction storage (storage.ts) on the
// filesystem, for Deno: a directory with one file per record, named by its
// key. A record is written to its name and ".tmp", synced, and renamed over
// its name, so a reader finds the old record or the new one; a ".tmp" left
// by a crash is passed over.

import type { Backend } from "./storage.ts"

const KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function files(dir: string): Backend {
	const path = (key: string) => {
		if (!KEY.test(key) || key.endsWith(".tmp")) {
			throw new Error(`${JSON.stringify(key)} is no key`)
		}
		return `${dir}/${key}`
	}
	return {
		async read() {
			await Deno.mkdir(dir, { recursive: true })
			const out = new Map<string, Uint8Array>()
			for await (const e of Deno.readDir(dir)) {
				if (!e.isFile || e.name.endsWith(".tmp") || !KEY.test(e.name)) continue
				out.set(e.name, await Deno.readFile(`${dir}/${e.name}`))
			}
			return out
		},
		async write(batch) {
			await Deno.mkdir(dir, { recursive: true })
			for (const [k, v] of batch) {
				const p = path(k)
				if (v === null) {
					await Deno.remove(p).catch((e) => {
						if (!(e instanceof Deno.errors.NotFound)) throw e
					})
					continue
				}
				const f = await Deno.open(`${p}.tmp`, { write: true, create: true, truncate: true })
				try {
					for (let at = 0; at < v.length;) at += await f.write(v.subarray(at))
					await f.sync()
				} finally {
					f.close()
				}
				await Deno.rename(`${p}.tmp`, p)
			}
		},
	}
}
