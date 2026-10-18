// a pool of workers that run answers; a job that takes too long is a fail and its worker is replaced

import type { Job, Outcome } from "./worker.ts"

export type { Job, Outcome }

const TIMEOUT = 6000

type Slot = { worker: Worker; busy: boolean; ready: Promise<void> }

export function createSandbox(size = 3) {
	const spawn = (): Slot => {
		const worker = new Worker(new URL("./worker.ts", import.meta.url).href, {
			type: "module",
		})
		const ready = new Promise<void>((r) => worker.onmessage = () => r())
		return { worker, busy: false, ready }
	}
	const slots: Slot[] = Array.from({ length: size }, spawn)
	const waiting: (() => void)[] = []
	const free = async () => {
		for (;;) {
			const i = slots.findIndex((s) => !s.busy)
			if (i >= 0) {
				slots[i].busy = true
				return i
			}
			await new Promise<void>((r) => waiting.push(r))
		}
	}
	async function run(job: Job): Promise<Outcome> {
		const i = await free()
		const slot = slots[i]
		try {
			await slot.ready
			return await new Promise<Outcome>((resolve) => {
				const timer = setTimeout(() => {
					slot.worker.terminate()
					slots[i] = spawn()
					resolve({
						errors: ["timed out (an endless loop?)"],
						rendered: false,
						drew: 0,
						outlet: [],
					})
				}, TIMEOUT)
				slot.worker.onmessage = (e) => {
					clearTimeout(timer)
					resolve(e.data)
				}
				slot.worker.onerror = (e) => {
					e.preventDefault()
					clearTimeout(timer)
					slot.worker.terminate()
					slots[i] = spawn()
					resolve({
						errors: ["harness crashed: " + e.message],
						rendered: false,
						drew: 0,
						outlet: [],
					})
				}
				slot.worker.postMessage(job)
			})
		} finally {
			slots[i].busy = false
			waiting.shift()?.()
		}
	}
	const close = () => slots.forEach((s) => s.worker.terminate())
	return { run, close }
}
