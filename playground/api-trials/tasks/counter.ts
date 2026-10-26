import { judge, settle, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

export const counter: Task = {
	key: "counter",
	title: "A counter",
	statement:
		`Keep a number at ./count, starting at 0. A handler at ./on/click adds 1. An effect shows "count: N" whenever it changes.`,
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		try {
			if (!t.start()) return j.result()
			await settle()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/work/count"), 0, "./count at start")
			shows(j, t, "count: 0", "at start")
			for (const n of [1, 2, 3]) {
				if (!t.send("/work/on/click").ok) return j.result()
				await settle()
				j.is(t.peep("/work/count"), n, `./count after ${n} clicks`)
				shows(j, t, `count: ${n}`, `after ${n} clicks`)
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
