import { judge, rest, setupOk, type Trial, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

// what was shown last, if it isn't want: what it was, and why it is wrong
function seen(t: Trial, want: string): string | undefined {
	const last = t.last()
	if (last === want && t.jsx.at(-1)) return undefined
	if (last === undefined) return "nothing was shown"
	const saw = `saw ${JSON.stringify(last.length > 80 ? last.slice(0, 79) + "…" : last)}`
	if (/\[object \w+\]|\[node /.test(last)) {
		return `${saw}: an object (a node's handle?) in the view`
	}
	if (/=>|\bfunction\b|\[native code\]/.test(last)) {
		return `${saw}: a function's source in the view`
	}
	if (/\bundefined\b/.test(last)) return `${saw}: undefined in the view`
	if (/\bNaN\b/.test(last)) return `${saw}: NaN in the view`
	if (last === want) return `${saw}, but as a string: show was given text, not a JSX element`
	const n = /count: (-?\d+)/.exec(last)?.[1]
	const w = /count: (-?\d+)/.exec(want)?.[1]
	if (n !== undefined && n !== w) return `${saw}: a stale number (count is ${w})`
	return saw
}

export const view: Task = {
	key: "view",
	title: "A JSX view",
	jsx: true,
	statement:
		"Keep a number at ./count, starting at 0. A handler at ./on/click adds 1. Whenever count changes, show the view `<p>count: N</p>` by passing a JSX element to show (`show(<p>count: {…}</p>)`). Write the program as a .jsx file: JSX works there as it is (the harness provides `h` as a global; no imports).",
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		const shows = (n: number, when: string) => {
			const bad = seen(t, `<p>count: ${n}</p>`)
			if (bad !== undefined) j.fail(`the view ${when}: wanted <p>count: ${n}</p>, ${bad}`)
		}
		try {
			if (!t.start()) return j.result()
			await rest()
			if (!setupOk(j, t)) return j.result()
			j.is(t.peep("/work/count"), 0, "./count at start")
			shows(0, "at start")
			for (const n of [1, 2, 3]) {
				if (!t.send("/work/on/click").ok) return j.result()
				await rest()
				j.is(t.peep("/work/count"), n, `./count after ${n} clicks`)
				shows(n, `after ${n} clicks`)
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
