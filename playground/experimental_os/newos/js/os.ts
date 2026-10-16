// os.ts: "ermine:os", what only this OS's host knows or does: where a process
// is, timers, and video memory. Made by the runner with the natives it took.

import { drop, handler, idAt, make, val } from "./kit.ts"
import type { Api } from "./kit.ts"

type Part = { api: Api; self: string; name: string }
export type Natives = {
	here: (pid: string) => string[] | null
	after: (ms: number, address: string[]) => void
	vram: (id: number) => Uint32Array | null
	kill: (pid: string) => void
}

export function os(n: Natives) {
	/** the process's own node from the root (a part is given no place) */
	const here = (self: string): string[] => {
		const at = n.here(self)
		if (!at) throw new Error(`ermine:os: where ${self} is is not known`)
		return at
	}

	let timers = 0
	/**
	 * f called in ms, as a handler of the process (on/timer.<n>), so it runs as a part, with its own
	 * map; the handler's node goes once it is called. Gives cancel(api).
	 */
	const after = (part: Part, ms: number, f: (given: { api: Api }) => unknown) => {
		const list = `timer.${++timers}`
		const me = here(part.self)
		handler(part, list, (given) => {
			drop((given as { api: Api }).api, [...me, "on"], list)
			return f(given as { api: Api })
		})
		n.after(ms, [...me, "on", list])
		return (api: Api) => drop(api, [...me, "on"], list)
	}

	/**
	 * A plane of video memory (/dev/vram/planes/<name>, made by the vram driver) w × h, whose
	 * pixels a layer shows. Each call takes the part's api.
	 */
	const PLANES = ["/", "dev", "vram", "planes"]
	const plane = (api: Api, name: string, w: number, h: number) => {
		make(api, PLANES, name, { w, h }, { ephemeral: true })
		let bits: Uint32Array | null = null, id = -1, stride = w, serial = 0, copy = false
		const ready = (api: Api) => {
			if (bits) return true
			const v = val<{ shm?: string; id: number; stride: number }>(api, [...PLANES, name])
			if (typeof v?.shm !== "string") return false
			id = v.id, stride = v.stride
			bits = n.vram(id)
			if (!bits) bits = new Uint32Array(stride * h), copy = true
			return true
		}
		return {
			w,
			h,
			bits: (api: Api) => (ready(api) ? bits : null),
			stride: (api: Api) => (ready(api), stride),
			/** what a layer holds as its plane to show it, or null before the driver has made it */
			value: (api: Api) => (ready(api) ? { source: "vram", id, serial } : null),
			/** x, y, dw × dh was drawn: the layer at address shows it; false before the plane is made */
			drawn(
				api: Api & { call?: never },
				call: (address: string[], args: unknown) => unknown,
				layer: string[],
				x = 0,
				y = 0,
				dw = w,
				dh = h,
			) {
				if (!ready(api)) return false
				if (copy) {
					const part = new Uint32Array(dw * dh)
					for (let r = 0; r < dh; r++) {
						part.set(bits!.subarray((y + r) * stride + x, (y + r) * stride + x + dw), r * dw)
					}
					call(["/", "dev", "vram", "driver", "on", "put"], [id, x, y, dw, dh, part])
				}
				if (idAt(api, layer)) {
					api.write(layer, [
						{ path: ["plane", "serial"], value: ++serial },
						{ path: ["plane", "dirty"], value: { x, y, w: dw, h: dh } },
					])
				}
				return true
			},
		}
	}

	/**
	 * a process killed (core kills by hand, with outro): once the part asking returns, it is taken
	 * out of its list and outro'd, which ends its children, runs its cleanups, lets its ephemeral nodes go
	 */
	const kill = (pid: string) => n.kill(pid)
	/** the process asking, killed: a program ending itself */
	const end = (part: { self: string }) => n.kill(part.self)

	return { here, after, plane, kill, end }
}
