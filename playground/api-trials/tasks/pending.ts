import { type Adapter, judge, type Program, rest, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

// where a derived value named "label" may be: inside the program's node, or at the cwd
const PLACES = ["/code/trial/label", "/work/label"]

// one trial. filled: /slow/value comes, twice; else the trial closes with it still pending (so
// its facts, for hints, are what a program waiting on it could see)
async function once(
	j: ReturnType<typeof judge>,
	adapter: Adapter,
	program: Program,
	filled: boolean,
) {
	const t = trial(j, adapter, program)
	const e = t.ermine
	const named = (want: string, when: string) => {
		if (PLACES.some((p) => t.peep(p) === want)) return
		const got = PLACES.map((p) => t.peep(p)).find((v) => v !== undefined)
		j.fail(
			`no node named label holding ${JSON.stringify(want)} ${when}${
				got === undefined ? "" : ` (label holds ${JSON.stringify(got)})`
			}`,
		)
	}
	try {
		// /slow/value: the harness's memo, pending (no value yet) till /slow/in is written
		e.make("/slow")
		e.memo("/slow/value", () => e.read("/slow/in") ?? e.PENDING)
		if (!t.start()) return
		await rest()
		if (!setupOk(j, t, true)) return
		if (!filled) return
		named("loading", "before the value")
		shows(j, t, "loading", "before the value")
		await rest()
		shows(j, t, "loading", "a little later, still no value")
		for (const v of ["ripe", "ready"]) {
			if (e.entries("/slow/in").length) e.edit("/slow/in", [{ path: [], value: v }])
			else e.open("/slow/in", v)
			await rest()
			if (!setupOk(j, t)) return
			named(`got: ${v}`, `after the value ${v} came`)
			shows(j, t, `got: ${v}`, `after the value ${v} came`)
		}
		// nothing else shown on the way ("got: undefined", say)
		const ok = new Set(["loading", "got: ripe", "got: ready"])
		const odd = t.shown.filter((l) => !ok.has(l))
		if (odd.length) j.fail(`shown besides the labels: ${JSON.stringify(odd)}`)
	} finally {
		t.close()
	}
}

export const pending: Task = {
	key: "pending",
	title: "Reading something pending",
	statement:
		`A derived value named "label" reads /slow/value, which the harness works out slowly. While /slow/value isn't there yet, label is "loading"; once it is, label is "got: V". An effect shows label whenever it changes.`,
	async check(adapter, program) {
		const j = judge()
		await once(j, adapter, program, false)
		await once(j, adapter, program, true)
		return j.result()
	},
}
