import { judge, message, settle, setupOk, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

export const save: Task = {
	key: "save",
	title: "A save handler",
	given: ["save"],
	statement:
		`./on/save takes text. It writes {state: "saving"} to ./status, waits for the async save(text) the harness provides in api (it resolves to "ok"), then writes {state: "saved", result} to ./status.`,
	async check(adapter, program) {
		const j = judge()
		const asked: unknown[] = []
		let done: ((v: string) => void) | undefined
		const saving = (text: unknown) => {
			asked.push(text)
			return new Promise<string>((resolve) => done = resolve)
		}
		const t = trial(j, adapter, program, { save: saving })
		try {
			if (!t.start()) return j.result()
			await settle()
			if (!setupOk(j, t)) return j.result()
			const sent = t.send("/work/on/save", "draft")
			if (!sent.ok) return j.result()
			await settle()
			j.is(asked, ["draft"], "save called with")
			j.is(t.peep("/work/status"), { state: "saving" }, "./status while saving")
			if (done === undefined) return j.result()
			done("ok")
			try {
				await sent.value
			} catch (e) {
				t.saw("send /work/on/save", e)
				j.broke(`the handler threw ${message(e)}`)
			}
			await settle()
			j.is(t.peep("/work/status"), { state: "saved", result: "ok" }, "./status after the save")
			return j.result()
		} finally {
			t.close()
		}
	},
}
