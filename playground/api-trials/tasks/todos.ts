import { judge, settle, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

export const todos: Task = {
	key: "todos",
	title: "A todo list",
	statement:
		`Keep a list of strings at ./todos, starting empty. Handlers at ./on/add (text) and ./on/remove (index). Show the items joined by ", " whenever the list changes.`,
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		try {
			if (!t.start()) return j.result()
			await settle()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/work/todos"), [], "./todos at start")
			const want: string[] = []
			for (const text of ["milk", "eggs", "bread"]) {
				if (!t.send("/work/on/add", text).ok) return j.result()
				want.push(text)
				await settle()
				j.is(t.peep("/work/todos"), want, `./todos after adding ${text}`)
				shows(j, t, want.join(", "), `after adding ${text}`)
			}
			for (const i of [1, 0]) {
				if (!t.send("/work/on/remove", i).ok) return j.result()
				want.splice(i, 1)
				await settle()
				j.is(t.peep("/work/todos"), want, `./todos after removing ${i}`)
				shows(j, t, want.join(", "), `after removing ${i}`)
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
