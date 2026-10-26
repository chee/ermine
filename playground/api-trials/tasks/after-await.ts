import { judge, message, rest, setupOk, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

export const afterAwait: Task = {
	key: "after-await",
	title: "Writing after an await",
	given: ["title"],
	statement:
		`A handler at ./on/fetch takes a url. It awaits title(url), an async function the harness provides in api, which resolves to "Title of URL"; then it writes the title to ./title, adds the url to the end of ./history (a list, starting empty), and returns the title to the caller.`,
	async check(adapter, program) {
		const j = judge()
		const asked: unknown[] = []
		const title = (url: unknown) => {
			asked.push(url)
			return new Promise<string>((r) => setTimeout(() => r(`Title of ${url}`), 5))
		}
		const t = trial(j, adapter, program, { title })
		try {
			if (!t.start()) return j.result()
			await rest()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/work/history"), [], "./history at start")
			const urls: string[] = []
			for (const url of ["a.example", "b.example"]) {
				const sent = t.send("/work/on/fetch", url)
				if (!sent.ok) return j.result()
				urls.push(url)
				let got: unknown
				try {
					got = await sent.value
				} catch (e) {
					t.saw("send /work/on/fetch", e)
					j.broke(`the handler threw ${message(e)}`)
					return j.result()
				}
				await rest()
				j.is(got, `Title of ${url}`, `what the handler returned for ${url}`)
				j.is(t.peep("/work/title"), `Title of ${url}`, `./title after fetching ${url}`)
				j.is(t.peep("/work/history"), urls, `./history after fetching ${url}`)
			}
			j.is(asked, urls, "title called with")
			return j.result()
		} finally {
			t.close()
		}
	},
}
