import { judge, rest, setupOk, type Trial, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

const view = (a: number, b: number) => `<div><p>count: ${a}</p><p>count: ${b}</p></div>`

// what was shown last, if it isn't want: what it was, and why it is wrong
function seen(t: Trial, want: string): string | undefined {
	const last = t.last()
	if (last === want && t.jsx.at(-1)) return undefined
	if (last === undefined) return "nothing was shown"
	const saw = `saw ${JSON.stringify(last.length > 100 ? last.slice(0, 99) + "…" : last)}`
	if (/\[object \w+\]|\[node /.test(last)) {
		return `${saw}: an object (a node's handle?) in the view`
	}
	if (/=>|\bfunction\b|\[native code\]/.test(last)) {
		return `${saw}: a function's source in the view`
	}
	if (/\bundefined\b/.test(last)) return `${saw}: undefined in the view`
	if (/\bNaN\b/.test(last)) return `${saw}: NaN in the view`
	if (last === want) return `${saw}, but as a string: show was given text, not a JSX element`
	return saw
}

export const components: Task = {
	key: "components",
	title: "Components in another file",
	jsx: true,
	files: ["main.jsx", "counter.jsx"],
	statement:
		'Write two files. counter.jsx exports a component, `Counter({ name })` (its props may carry whatever else it needs to reach your design\'s words): each Counter keeps a number at ./<name>/count, starting at 0, has a handler at ./<name>/on/click that adds 1, and renders `<p>count: N</p>`. main.jsx is the program: it imports Counter from "./counter.jsx" and, whenever either count changes, shows `<div><Counter name="a" /><Counter name="b" /></div>` by passing that JSX element to show. JSX works in both files as it is (the harness provides `h` as a global); a component is called with its props as its element is made.',
	async check(adapter, program) {
		const j = judge()
		const t = trial(j, adapter, program)
		const shows = (a: number, b: number, when: string) => {
			const want = view(a, b)
			const bad = seen(t, want)
			if (bad !== undefined) j.fail(`the view ${when}: wanted ${want}, ${bad}`)
		}
		const counts = (a: number, b: number, when: string) => {
			j.is(t.peep("/work/a/count"), a, `./a/count ${when}`)
			j.is(t.peep("/work/b/count"), b, `./b/count ${when}`)
		}
		try {
			if (!t.start()) return j.result()
			await rest()
			if (!setupOk(j, t)) return j.result()
			counts(0, 0, "at start")
			shows(0, 0, "at start")
			const clicks: [string, number, number][] = [["a", 1, 0], ["a", 2, 0], ["b", 2, 1]]
			for (const [who, a, b] of clicks) {
				if (!t.send(`/work/${who}/on/click`).ok) return j.result()
				await rest()
				const when = `after clicking ${who} (a ${a}, b ${b})`
				counts(a, b, when)
				shows(a, b, when)
			}
			return j.result()
		} finally {
			t.close()
		}
	},
}
