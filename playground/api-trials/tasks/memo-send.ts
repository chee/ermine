import { type Adapter, judge, type Program, rest, setupOk, shows, trial } from "../lib/trial.ts"
import type { Task } from "./task.ts"

// where a derived value named "loud" may be: inside the program's node, or at the cwd
const PLACES = ["/code/trial/loud", "/work/loud"]

const upper = (t: unknown) => String(t).toUpperCase()
// the async answer: a few ms later
const later = (t: unknown) => new Promise((r) => setTimeout(() => r(upper(t)), 3))

// once per way the service comes: there at start or placed after, answering at once or later
async function once(
	j: ReturnType<typeof judge>,
	adapter: Adapter,
	program: Program,
	late: boolean,
	async: boolean,
) {
	const when = `(service ${late ? "placed after start" : "there at start"}, ${
		async ? "answering later" : "answering at once"
	})`
	const t = trial(j, adapter, program)
	const service = async ? later : upper
	const named = (want: string, at: string) => {
		if (!PLACES.some((p) => t.peep(p) === want)) {
			const got = PLACES.map((p) => t.peep(p)).find((v) => v !== undefined)
			j.fail(
				`no node named loud holding ${JSON.stringify(want)} ${at} ${when}${
					got === undefined ? "" : ` (loud holds ${JSON.stringify(got)})`
				}`,
			)
		}
	}
	try {
		if (!late) t.ermine.method("/services/upper", service)
		if (!t.start()) return
		await rest()
		if (late) {
			if (t.status()?.state === "failed") return void setupOk(j, t)
			t.ermine.method("/services/upper", service)
			await rest()
		}
		if (!setupOk(j, t)) return
		j.is(t.peep("/work/text"), "hi", `./text at start ${when}`)
		named("HI", "at start")
		shows(j, t, "loud: HI", `at start ${when}`)
		for (const text of ["yo", "mimi"]) {
			if (!t.send("/work/on/set", text).ok) return
			await rest()
			j.is(t.peep("/work/text"), text, `./text after set ${text} ${when}`)
			named(upper(text), `after set ${text}`)
			shows(j, t, `loud: ${upper(text)}`, `after set ${text} ${when}`)
		}
		// nothing else shown on the way (a memo with no value yet shown as "loud: undefined")
		const ok = new Set(["hi", "yo", "mimi"].map((x) => `loud: ${upper(x)}`))
		const odd = t.shown.filter((l) => !ok.has(l))
		if (odd.length) j.fail(`shown besides the loud values ${when}: ${JSON.stringify(odd)}`)
	} finally {
		t.close()
	}
}

export const memoSend: Task = {
	key: "memo-send",
	title: "A memo that sends",
	statement:
		`Keep a string at ./text, starting "hi". A derived value named "loud" is what the service at /services/upper answers for text (it answers with the text in upper case). Show "loud: X" whenever it changes. A handler at ./on/set takes a string and sets text. The harness places the service, sometimes after your program starts, and it may answer with a promise.`,
	async check(adapter, program) {
		const j = judge()
		for (const late of [false, true]) {
			for (const async of [false, true]) await once(j, adapter, program, late, async)
		}
		return j.result()
	},
}
