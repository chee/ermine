// every suite's scenarios against a harness, on one rule.
//   deno task conformance [suite...] [--c | --check | --leaks]
// no suite: all of them. the TypeScript harness is <package>/typescript/<suite>_harness.ts; --c is
// the C binary <package>/c/<suite>-harness, --check its sanitizer build, --leaks the binary under
// leaks (conformance/leaks.sh); HARNESS, a command, is any other (one suite).
//
// a scenario (<package>/conformance/<suite>/NN-name.json) is { title, steps }, a step a request
// and what it says of the answer. each scenario is one run of the harness, the steps its lines.
//   expect: the answer's fields, deep-equal; the answer has no others
//   fails: true: the answer is an error ({ error }); without it, no answer is, but one expect asks for
//   skip: fields of the answer left out of the comparing
// no expect: the answer is not compared. <suite>/suite.json, if there, is the suite's one other say:
//   loose: the answer may have fields beyond expect's (protect: its reads)
//   unordered: fields compared as sets (paths: its spots)
//   now: "now" in an expect is a whole number of seconds since 1970 as of the run (node)
//   again: the scenarios run once more with a request that has the field given more fields
//   harness: the adapter and binary of another suite are this one's (invert speaks apply's)
//   typescript: only the TypeScript harness runs it; --c, --check and --leaks skip it (load)
//   allow: deno flags the TypeScript harness is run with beyond --allow-read (native: --allow-ffi)
import { assert, assertEquals } from "@std/assert"
import { ask, command, type Options, type Suite, suites } from "./typescript/ask.ts"

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
const show = (x: unknown) => JSON.stringify(x)

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
			want = want.map(show).sort()
			have = have.map(show).sort()
		}
		const d = differs(want, have, o, window)
		if (d) return `${k}: ${d}`
	}
}

const asked = ({ expect: _, fails: __, skip: ___, ...request }: Step) => request

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
		const { title, steps } = JSON.parse(Deno.readTextFileSync(s.fixtures + file)) as {
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
				const answers = await ask(harness(s), steps.map((st) => run.change(asked(st))))
				const window: [number, number] = [from, Math.floor(Date.now() / 1000)]
				assertEquals(answers.length, steps.length, "one answer per request")
				steps.forEach((st, i) => {
					const why = check(st, answers[i], s.options, window)
					assert(why === undefined, `step ${i}: ${why}: ${show(asked(st))}`)
				})
			})
		}
	}
}
