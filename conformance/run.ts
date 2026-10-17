// every suite's scenarios against a harness, on one rule.
//   deno task conformance [suite...] [--c | --check | --leaks]
// no suite: all. default <package>/typescript/<suite>_harness.ts; --c <package>/c/<suite>-harness,
// --check its sanitizer build, --leaks under leaks (conformance/leaks.sh); HARNESS: any other.
//
// a harness: one run per scenario, one JSON request per line in, one answer per line out, exit 0.
// a non-zero exit or sanitizer report ("runtime error:", "Sanitizer") fails the scenario.
// its JSON must keep lone surrogates, NUL, -0, integers to 2^53, doubles; "/" forms: form.ts.
// key order is kept on the way out, ignored when comparing (maps by content).
//
// scenario <package>/conformance/<suite>/NN-name.json: { title, steps }
//   expect: answer fields, deep-equal; no others   fails: true: answer is { error }
//   skip: fields not compared                      no expect: not compared
// <suite>/suite.json:
//   loose       answers may have fields beyond expect
//   unordered   fields compared as sets
//   now         "now" in expect: seconds since 1970 as of the run
//   again       run once more with these fields added to every request
//   undoes      { op: "invert" } answers must be { undo } and undo, checked by applying both ways
//   reads       requests asked before and after each failing step; answers must match. "$name"
//               stands for each value name takes in the scenario
//   harness     another suite's harness (invert speaks apply's)
//   typescript  TypeScript harness only
//   allow       extra deno flags for the TypeScript harness (native: --allow-ffi)
import { assert, assertEquals } from "@std/assert"
import { ask, command, type Options, type Suite, suites } from "./typescript/ask.ts"
import { line } from "./typescript/form.ts"
import { read } from "./typescript/json.ts"

type Step = Record<string, any> & {
	expect?: Record<string, unknown>
	fails?: boolean
	skip?: string[]
}

const here = new URL(".", import.meta.url).pathname
const flags = Deno.args.filter((a) => a.startsWith("--"))
const names = Deno.args.filter((a) => !a.startsWith("--"))
const all = suites()
const chosen = names.length ? names.map((n) => all.find((s) => s.name === n)!) : all
for (const [i, s] of chosen.entries()) if (!s) throw new Error(`no suite ${names[i]}`)

function harness(s: Suite): string[] {
	if (Deno.env.get("HARNESS")) return command(s.name)
	if (flags.includes("--c")) return [s.binary]
	if (flags.includes("--check")) return [`${s.binary}-check`]
	if (flags.includes("--leaks")) {
		return ["sh", `${here}leaks.sh`, s.binary]
	}
	return command(s.name)
}

const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
// -0 shown as -0: JSON says 0
const show = (x: unknown) => line(x)
// a map's keys sorted, at every depth (line's also): maps by content
const sortKeys = (v: unknown) =>
	isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
// a set's element as compared: by content
const member = (x: unknown) => line(x, sortKeys)

// whether the answer says what is expected; the first thing it does not, or undefined
function differs(
	want: unknown,
	got: unknown,
	o: Options,
	window: [number, number],
): string | undefined {
	if (want === "now" && o.now) {
		const ok = Number.isInteger(got) && (got as number) >= window[0] - 1 &&
			(got as number) <= window[1] + 1
		return ok ? undefined : `${show(got)} is not now`
	}
	if (Array.isArray(want)) {
		if (!Array.isArray(got) || got.length !== want.length) {
			return `${show(got)}, not ${show(want)}`
		}
		for (let i = 0; i < want.length; i++) {
			const d = differs(want[i], got[i], o, window)
			if (d) return `[${i}] ${d}`
		}
		return
	}
	if (isMap(want)) {
		if (!isMap(got)) return `${show(got)}, not ${show(want)}`
		const keys = Object.keys(want)
		if (Object.keys(got).length !== keys.length) return `${show(got)}, not ${show(want)}`
		for (const k of keys) {
			if (!Object.hasOwn(got, k)) return `${show(got)}, not ${show(want)}`
			const d = differs(want[k], got[k], o, window)
			if (d) return `${k}: ${d}`
		}
		return
	}
	// a number as Object.is has it: 0 and -0 differ
	return Object.is(want, got) ? undefined : `${show(got)}, not ${show(want)}`
}

function check(
	step: Step,
	got: Record<string, unknown> | undefined,
	o: Options,
	window: [number, number],
) {
	if (got === undefined) return "no answer"
	if (step.fails) return got.error === undefined ? "no error" : undefined
	if (got.error !== undefined && !(step.expect && "error" in step.expect)) {
		return `an error: ${show(got.error)}`
	}
	if (step.expect === undefined) return
	const skip = step.skip ?? []
	const keys = Object.keys(step.expect).filter((k) => !skip.includes(k))
	if (!o.loose) {
		const extra = Object.keys(got).filter((k) => !skip.includes(k) && !keys.includes(k))
		if (extra.length) return `${extra.join(", ")}: not expected, in ${show(got)}`
	}
	for (const k of keys) {
		let want = step.expect[k], have = got[k]
		if (o.unordered?.includes(k) && Array.isArray(want) && Array.isArray(have)) {
			want = want.map(member).sort()
			have = have.map(member).sort()
		}
		const d = differs(want, have, o, window)
		if (d) return `${k}: ${d}`
	}
}

// whether a step's answer is checked as undoing: an invert of a suite that undoes, not one that
// says it fails or has an error in its expect (those are pinned as ever)
const undoing = (o: Options, st: Step) =>
	o.undoes === true && st.op === "invert" && !st.fails && !(st.expect && "error" in st.expect)

// the answers of the undoing steps, walked back with the harness (one ask for each stage): why not
// for each step, or undefined. the run's changes are in every request (cow: false too)
// nothing there is no value; maps by content
const same = (a?: Record<string, any>, b?: Record<string, any>) =>
	line(a && "value" in a ? a.value : undefined, sortKeys) ===
		line(b && "value" in b ? b.value : undefined, sortKeys)
const held = (r?: Record<string, any>) => (r && "value" in r ? { value: r.value } : {})

async function undone(
	cmd: string[],
	run: (r: Record<string, unknown>) => Record<string, unknown>,
	steps: Step[],
	answers: Record<string, any>[],
	o: Options,
): Promise<(string | undefined)[]> {
	const why: (string | undefined)[] = steps.map(() => undefined)
	const fail = (i: number, s: string) => (why[i] = s, false)
	const request = (op: string, from: Record<string, any> | undefined, patches: unknown) =>
		run({ op, ...held(from), patches })
	let live = steps.flatMap((st, i) => undoing(o, st) ? [i] : [])
	live = live.filter((i) =>
		Array.isArray(answers[i]?.undo) || fail(i, `not an undo: ${show(answers[i])}`)
	)
	// the change
	const changed: Record<number, Record<string, any>> = {}
	const done = await ask(cmd, live.map((i) => request("apply", steps[i], steps[i].patches)))
	live = live.filter((i, k) => {
		if (done[k]?.error !== undefined) {
			return fail(i, `the patches: an error: ${show(done[k].error)}`)
		}
		changed[i] = done[k] ?? {}
		return true
	})
	// the undo applied to it; its undo
	const back = await ask(
		cmd,
		live.flatMap((i) => [
			request("apply", changed[i], answers[i].undo),
			request("invert", changed[i], answers[i].undo),
		]),
	)
	const unwound: Record<number, unknown> = {}
	live = live.filter((i, k) => {
		const b = back[2 * k], u = back[2 * k + 1]
		if (b?.error !== undefined) return fail(i, `the undo: an error: ${show(b.error)}`)
		if (!same(b, steps[i] as Record<string, any>)) {
			return fail(i, `the undo gives ${show(held(b))}, not ${show(held(steps[i]))}`)
		}
		if (!Array.isArray(u?.undo)) return fail(i, `the undo's undo: ${show(u)}`)
		unwound[i] = u.undo
		return true
	})
	// the undo of the undo, applied to the value given
	const last = await ask(cmd, live.map((i) => request("apply", steps[i], unwound[i])))
	live.forEach((i, k) => {
		if (last[k]?.error !== undefined) {
			why[i] = `the undo's undo: an error: ${show(last[k].error)}`
		} else if (!same(last[k], changed[i])) {
			why[i] = `the undo's undo gives ${show(held(last[k]))}, not ${show(held(changed[i]))}`
		}
	})
	return why
}

const asked = ({ expect: _, fails: __, skip: ___, ...request }: Step) => request

// the suite's reads for a scenario: each "$name" field made every value name has in its requests
function reads(o: Options, requests: Record<string, unknown>[]): Record<string, unknown>[] {
	const values = (name: string) => {
		const seen = new Map<string, unknown>()
		for (const r of requests) {
			if (Object.hasOwn(r, name) && !seen.has(line(r[name]))) seen.set(line(r[name]), r[name])
		}
		return [...seen.values()]
	}
	return (o.reads ?? []).flatMap((read) =>
		Object.entries(read).reduce<Record<string, unknown>[]>(
			(out, [k, v]) =>
				typeof v === "string" && v.startsWith("$")
					? out.flatMap((r) => values(v.slice(1)).map((x) => ({ ...r, [k]: x })))
					: out.map((r) => ({ ...r, [k]: v })),
			[{}],
		)
	)
}
// a step a refused request: the reads are asked around it
const refused = (st: Step) => st.fails === true || (st.expect !== undefined && "error" in st.expect)
// an answer as compared to itself: maps by content, unordered fields as sets
function settled(a: Record<string, unknown> | undefined, o: Options) {
	if (a === undefined) return "no answer"
	const set = (k: string, v: unknown) =>
		o.unordered?.includes(k) && Array.isArray(v) ? v.map(member).sort() : v
	const sets = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, set(k, v)]))
	return line(sets, sortKeys)
}

for (const s of chosen) {
	const files = [...Deno.readDirSync(s.fixtures)].map((f) => f.name).filter((n) =>
		/^\d.*\.json$/.test(n)
	)
		.sort()
	const runs = [{ name: "", change: (r: Record<string, unknown>) => r }]
	const again = s.options.again
	if (again) {
		runs.push({
			name: ` (${again.name})`,
			change: (r) =>
				(again.has && again.has in r) || (again.op && r.op === again.op)
					? { ...r, ...again.set }
					: r,
		})
	}
	for (const file of files) {
		const { title, steps } = read(Deno.readTextFileSync(s.fixtures + file)) as {
			title: string
			steps: Step[]
		}
		for (const run of runs) {
			Deno.test({
				name: `${s.name}/${file}: ${title}${run.name}`,
				ignore: s.options.typescript === true &&
					flags.some((f) => f === "--c" || f === "--check" || f === "--leaks"),
			}, async () => {
				const from = Math.floor(Date.now() / 1000)
				// the steps, the reads around each refused one: where each step's answer is
				const around = reads(s.options, steps.map(asked))
				const sent: Record<string, unknown>[] = [], at: number[] = []
				for (const st of steps) {
					const guard = around.length > 0 && refused(st)
					if (guard) sent.push(...around)
					at.push(sent.length)
					sent.push(run.change(asked(st)))
					if (guard) sent.push(...around)
				}
				const all = await ask(harness(s), sent)
				const window: [number, number] = [from, Math.floor(Date.now() / 1000)]
				assertEquals(all.length, sent.length, "one answer per request")
				const answers = at.map((k) => all[k])
				const walked = s.options.undoes
					? await undone(harness(s), run.change, steps, answers, s.options)
					: []
				steps.forEach((st, i) => {
					const why = undoing(s.options, st)
						? (answers[i] === undefined ? "no answer" : walked[i])
						: check(st, answers[i], s.options, window)
					assert(why === undefined, `step ${i}: ${why}: ${show(asked(st))}`)
					if (!(around.length > 0 && refused(st))) return
					around.forEach((r, j) => {
						const before = settled(all[at[i] - around.length + j], s.options)
						const after = settled(all[at[i] + 1 + j], s.options)
						assert(
							before === after,
							`step ${i} changed ${show(r)}: ${before} before, ${after} after: ${
								show(asked(st))
							}`,
						)
					})
				})
			})
		}
	}
}
