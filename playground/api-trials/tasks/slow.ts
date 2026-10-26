import { judge, settle, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"
import type { Ermine } from "@ermine/ermine"

// the value written there: the node made, or (the program made it already) replaced
function fill(e: Ermine, path: string, v: unknown) {
	if (e.entries(path).length) e.edit(path, [{ path: [], value: v }])
	else e.open(path, v)
}

export const slow: Task = {
	key: "slow",
	title: "A slow value",
	statement:
		`/slow/value is filled in some time after the program starts. Show "waiting" while it isn't there, then "got: V".`,
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		try {
			if (!t.start()) return j.result()
			await settle()
			if (!setupOk(j, t, true)) return j.result()
			shows(j, t, "waiting", "before the value")
			await settle()
			shows(j, t, "waiting", "a little later, still no value")
			fill(t.ermine, "/slow/value", "ripe")
			await settle()
			if (!setupOk(j, t)) return j.result()
			shows(j, t, "got: ripe", "after the value came")
			return j.result()
		} finally {
			t.close()
		}
	},
}
