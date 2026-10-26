import { judge, message, rest, setupOk, trial, TWO } from "../lib/trial.ts"
import type { Task } from "./task.ts"

export const shared: Task = {
	key: "shared",
	title: "Two programs, one list",
	given: ["check"],
	statement:
		`/shared/list holds a list of strings, starting []. A handler at ./on/add takes text: it awaits check(text), an async function the harness provides in api, which resolves to true after a while; then it adds text to the end of /shared/list. The harness starts this program twice, as two processes, each with its own working folder (so each has its own ./on/add), both reaching the same /shared/list.`,
	async check(adapter, program) {
		const j = judge()
		const asked: unknown[] = []
		const check = (text: unknown) => {
			asked.push(text)
			return new Promise<boolean>((r) => setTimeout(() => r(true), 5))
		}
		// two processes: /code/trial with cwd /work, /code/trial2 with cwd /work2
		const t = trial(j, adapter, program, { check }, TWO)
		try {
			t.ermine.open("/shared/list", [])
			if (!t.start()) return j.result()
			await rest()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/shared/list"), [], "/shared/list at start")
			// both at once: each handler's await overlaps the other's
			const a = t.send("/work/on/add", "a")
			const b = t.send("/work2/on/add", "b")
			if (!a.ok || !b.ok) return j.result()
			for (const [s, at] of [[a, "/work/on/add"], [b, "/work2/on/add"]] as const) {
				try {
					await s.value
				} catch (e) {
					t.saw(`send ${at}`, e)
					j.broke(`the handler at ${at} threw ${message(e)}`)
				}
			}
			await rest()
			j.is([...asked].sort(), ["a", "b"], "check called with")
			const list = t.peep("/shared/list")
			const sorted = Array.isArray(list) ? [...list].sort() : list
			if (
				!j.is(sorted, ["a", "b"], "/shared/list after adding a and b at once (either order)")
			) {
				if (Array.isArray(list) && list.length === 1) {
					j.notes.push("one add was lost: a handler wrote a list it read before its await")
				}
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
