import { type Adapter, judge, type Program, settle, setupOk, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

const greet = (name: unknown) => `hello, ${name}`

// once with the service there before the program starts, once placed after
async function once(
	j: ReturnType<typeof judge>,
	adapter: Adapter,
	program: Program,
	late: boolean,
) {
	const when = late ? "(service placed after start)" : "(service there at start)"
	const t = trial(j, adapter, program)
	try {
		if (!late) t.ermine.method("/services/greet", greet)
		if (!t.start()) return
		await settle()
		if (late) {
			const st = t.status()
			if (st?.state === "failed") return void setupOk(j, t)
			t.ermine.method("/services/greet", greet)
			await settle()
		}
		if (!setupOk(j, t)) return
		j.is(t.peep("/work/greeting"), "hello, mimi", `./greeting ${when}`)
	} finally {
		t.close()
	}
}

export const service: Task = {
	key: "service",
	title: "Asking a service",
	statement:
		`A service at /services/greet answers a name with "hello, NAME". Use it to get the greeting for "mimi", and keep the reply at ./greeting. The harness places the service, sometimes after your program starts.`,
	async check(adapter, program) {
		const j = judge()
		await once(j, adapter, program, false)
		await once(j, adapter, program, true)
		return j.result()
	},
}
