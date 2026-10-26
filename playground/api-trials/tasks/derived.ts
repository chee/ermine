import { judge, settle, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

// where a derived value named "doubled" may be: inside the program's node, or at the cwd
const PLACES = ["/code/trial/doubled", "/work/doubled"]

export const derived: Task = {
	key: "derived",
	title: "A derived value",
	statement:
		`Keep a number at ./n, starting at 2. A derived value named "doubled" is n × 2. Show "doubled: D" whenever it changes. A handler at ./on/set takes a number and sets n.`,
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		const named = (want: number, when: string) => {
			if (!PLACES.some((p) => t.peep(p) === want)) {
				j.fail(`no node named doubled holding ${want} ${when}`)
			}
		}
		try {
			if (!t.start()) return j.result()
			await settle()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/work/n"), 2, "./n at start")
			shows(j, t, "doubled: 4", "at start")
			named(4, "at start")
			for (const n of [5, 7]) {
				if (!t.send("/work/on/set", n).ok) return j.result()
				await settle()
				j.is(t.peep("/work/n"), n, `./n after set ${n}`)
				shows(j, t, `doubled: ${n * 2}`, `after set ${n}`)
				named(n * 2, `after set ${n}`)
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
