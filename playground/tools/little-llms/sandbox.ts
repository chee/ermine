// a pool of processes that run answers; a job that takes too long is a fail and its process is killed and replaced

import { TextLineStream } from "jsr:@std/streams@^1/text-line-stream"
import type { Job, Outcome } from "./worker.ts"

export type { Job, Outcome }

const TIMEOUT = 6000

type Slot = { child: Deno.ChildProcess; send(job: Job): Promise<void>; next(): Promise<unknown>; busy: boolean; ready: Promise<unknown> }

const lost = (why: string): Outcome => ({ errors: [why], rendered: false, drew: 0, outlet: [] })

export function createSandbox(size = 3) {
	const spawn = (): Slot => {
		const child = new Deno.Command(Deno.execPath(), {
			args: ["run", "-A", "--quiet", new URL("./worker.ts", import.meta.url).pathname],
			cwd: new URL(".", import.meta.url).pathname,
			stdin: "piped",
			stdout: "piped",
			stderr: "null",
		}).spawn()
		const lines = child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream()).getReader()
		const writer = child.stdin.getWriter()
		const encoder = new TextEncoder()
		const next = async () => {
			const { value, done } = await lines.read()
			if (done) throw new Error("the sandbox process exited")
			return JSON.parse(value)
		}
		const ready = next()
		ready.catch(() => {}) // a process killed before it was used
		return { child, next, send: (job) => writer.write(encoder.encode(JSON.stringify(job) + "\n")), busy: false, ready }
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
	const replace = (i: number) => {
		try {
			slots[i].child.kill("SIGKILL")
		} catch { /* already gone */ }
		slots[i] = spawn()
		slots[i].busy = true
	}
	async function run(job: Job): Promise<Outcome> {
		const i = await free()
		try {
			try {
				await slots[i].ready
			} catch {
				replace(i)
				await slots[i].ready
			}
			const slot = slots[i]
			let timer: ReturnType<typeof setTimeout> | undefined
			const timeout = new Promise<Outcome>((r) => timer = setTimeout(() => r(lost("timed out (an endless loop?)")), TIMEOUT))
			const answer = slot.send(job).then(() => slot.next() as Promise<Outcome>).catch((e) => lost("harness crashed: " + e.message))
			const outcome = await Promise.race([answer, timeout])
			clearTimeout(timer)
			if (outcome.errors[0]?.startsWith("timed out") || outcome.errors[0]?.startsWith("harness crashed")) replace(i)
			return outcome
		} finally {
			slots[i].busy = false
			waiting.shift()?.()
		}
	}
	const close = () => {
		for (const s of slots) {
			try {
				s.child.kill("SIGKILL")
			} catch { /* gone */ }
		}
	}
	return { run, close }
}
