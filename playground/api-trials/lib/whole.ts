// deno run -A playground/api-trials/lib/whole.ts
//   each design's sheet-whole.md: its "A whole program" block, run through the design's adapter.
//   it must load, run its setup, show "dim", take sends to ./on/set and show the label after each.
//   run under lib/importmap.ts's map (started without it, it starts itself again with it)
import { designs } from "../designs/index.ts"
import { again, mapped } from "./importmap.ts"
import {
	judge,
	message,
	type Program,
	type Result,
	settle,
	setupOk,
	shows,
	trial,
} from "./trial.ts"

// the fenced block under "## A whole program"
function block(sheet: string): string | undefined {
	const at = sheet.indexOf("## A whole program")
	if (at < 0) return undefined
	return /```js\n([\s\S]*?)```/.exec(sheet.slice(at))?.[1]
}

async function check(key: string): Promise<Result & { lines: number }> {
	const des = designs.find((d) => d.key === key)!
	const sheet = await Deno.readTextFile(new URL("sheet-whole.md", des.sheet))
	const code = block(sheet)
	if (code === undefined) return { ran: false, correct: false, notes: ["no block"], lines: 0 }
	const lines = code.trimEnd().split("\n").length
	const j = judge()
	if (lines >= 20) j.fail(`${lines} lines`)
	let program: Program
	try {
		const mod = await import(`data:application/javascript;base64,${btoa(code)}`)
		program = mod.default
	} catch (e) {
		j.broke(`load: ${message(e)}`)
		return { ...j.result(), lines }
	}
	const t = trial(j, des.adapter, program)
	try {
		if (!t.start()) return { ...j.result(), lines }
		await settle()
		if (!setupOk(j, t)) return { ...j.result(), lines }
		j.is(t.peep("/work/level"), 3, "./level at start")
		shows(j, t, "dim", "at start")
		for (const [n, want] of [[8, "bright"], [2, "dim"], [5, "bright"]] as const) {
			if (!t.send("/work/on/set", n).ok) return { ...j.result(), lines }
			await settle()
			j.is(t.peep("/work/level"), n, `./level after set ${n}`)
			shows(j, t, want, `after set ${n}`)
		}
		j.is(t.shown, ["dim", "bright", "dim", "bright"], "everything shown")
		return { ...j.result(), lines }
	} finally {
		t.close()
	}
}

if (import.meta.main) {
	// design L's whole program imports "ermine": run under the map
	if (!mapped()) await again(import.meta.url, Deno.args)
	let bad = 0
	for (const des of designs) {
		const r = await check(des.key)
		if (!r.correct) bad++
		console.log(
			`${r.correct ? "pass" : r.ran ? "FAIL" : "BROKE"} ${des.key} (${r.lines} lines)${
				r.notes.length ? `: ${r.notes.join("; ")}` : ""
			}`,
		)
	}
	Deno.exit(bad === 0 ? 0 : 1)
}
