// performance conformance: how an implementation's cost GROWS with size, not how fast it is.
//   deno task perf [suite...] [--c] [--known <file>]
// no suite: every suite that has a perf folder. the TypeScript harness is the suite's own; --c is
// the C binary <package>/c/<suite>-harness; HARNESS, a command, is any other (one suite), with
// --known the file of its known misses. --check and --leaks: refused (a sanitizer build is far too
// slow to time).
//
// a scenario (<package>/conformance/<suite>-perf/NN-name.json) is
//   { title, sizes: [n1, n2, n3], bound, template }
// bound: how the cost may grow with n: "1", "log", "n" or "n log n". template: the requests to send
// at size n, the same lines a conformance scenario has (the suite's harness answers them), written
// as a template. a step with fails: true is answered with an error; any other with none.
// answers are not compared.
//
// the template language (JSON, expanded for each n; nothing else is read into it):
//   steps and lists: a list may hold { "for": v, "from": a, "to": b, "do": [..] } (v from a up to
//     but not b, a and b expressions, from 0 if none); it is replaced by its `do`, once for each v.
//     any list at all, a patch list, a map's value, an expression of the program under test
//   { "map": { "for": v, "from"?: a, "to": b, "key": s, "value": x } }   a map of each v's key and
//     value (a key a string with substitutions)
//   { "repeat": [s, count] }   the string s count times (count an expression)
//   { "=": "e" }   the number e is
//   substitution: in any string, {e} is the number e, in text ("k{i}", "k{i-1}", "k{n-1}")
//   e: a whole number, n, a loop variable, + - * / % and parentheses (a quotient must come out whole) ("n-1", "(i+1)*2")
// a size 0 template is the baseline: what a run costs besides n (process start-up and the little
// that does not grow), taken off each size's time. so it must be good at n = 0.
//
// measuring: each size is run in a fresh harness process, up to RUNS times (not again past
// AGAIN_MS: a slow run is not noisy), the least CPU time taken (user + system, by /usr/bin/time -p:
// a busy machine does not count), the baseline's off (not under FLOOR_MS).
// each step to the next size is judged on its own: the growth of the time is allowed SLACK times
// the growth the bound has for those sizes (n 4n: linear x4, so x10 allowed; log: log 4n / log n;
// n log n: both). a step whose larger size nets under QUICK_MS is not judged (all noise).
// results:
//   ok      the growth is within what is allowed
//   slow    a step grew more: "x15.8 for x4, wanted <= x10"
//   broken  a crash, a non-zero exit, an error answer where none is asked, a missing or extra
//           answer, or a run past CAP_MS
// known misses: <package>/typescript/perf.sadly_known_fail, <package>/c/perf.sadly_known_fail, or
// --known <file> (HARNESS). a line is `<suite>-perf/<NN-name> reason`, # starts a comment. a miss
// listed there is "sadly known" and does not fail; a listed one that passes is reported (take it
// off the list) and does not fail; a miss not listed fails the run.
import { command, type Suite, suites } from "./typescript/ask.ts"
import { line } from "./typescript/form.ts"

const SLACK = 3
const RUNS = 3
const AGAIN_MS = 4000
const FLOOR_MS = 10
const QUICK_MS = 50
const CAP_MS = 20000

// ---- the template language
type Vars = Record<string, number>
const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)

function num(e: unknown, v: Vars): number {
	if (typeof e === "number") return e
	const text = String(e)
	if (!/^[\w+\-*/%() ]+$/.test(text)) throw new Error(`bad expression ${text}`)
	const r = new Function(...Object.keys(v), `return (${text})`)(...Object.values(v))
	if (!Number.isInteger(r)) throw new Error(`${text} is not a whole number`)
	return r
}

function text(s: string, v: Vars): string {
	return s.replace(/\{([^{}]*)\}/g, (_, e) => String(num(e, v)))
}

function loop(m: Record<string, unknown>, v: Vars, each: (v: Vars) => void) {
	const name = m.for as string
	const to = num(m.to, v)
	for (let i = m.from === undefined ? 0 : num(m.from, v); i < to; i++) each({ ...v, [name]: i })
}

function expand(x: unknown, v: Vars): unknown {
	if (typeof x === "string") return text(x, v)
	if (Array.isArray(x)) {
		const out: unknown[] = []
		for (const e of x) {
			if (isMap(e) && "for" in e) {
				loop(e, v, (w) => out.push(...(expand(e.do, w) as unknown[])))
			} else out.push(expand(e, v))
		}
		return out
	}
	if (isMap(x)) {
		const keys = Object.keys(x)
		if (keys.length === 1) {
			const a = x[keys[0]]
			if (keys[0] === "=") return num(a, v)
			if (keys[0] === "repeat") {
				const [s, count] = a as [string, unknown]
				return text(s, v).repeat(num(count, v))
			}
			if (keys[0] === "map") {
				const m = a as Record<string, unknown>
				const out: Record<string, unknown> = {}
				loop(m, v, (w) => out[text(m.key as string, w)] = expand(m.value, w))
				return out
			}
		}
		return Object.fromEntries(keys.map((k) => [k, expand(x[k], v)]))
	}
	return x
}

// ---- running
type Scenario = {
	title: string
	sizes: number[]
	bound: "1" | "log" | "n" | "n log n"
	template: unknown[]
}
type Result = { ok: true } | { ok: false; kind: "slow" | "broken"; why: string }

const root = new URL("../", import.meta.url).pathname
const args = Deno.args
const flags = args.filter((a) => a.startsWith("--"))
const known = args.includes("--known") ? args[args.indexOf("--known") + 1] : undefined
const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--known")
	.map((n) => n.replace(/-perf$/, ""))

// the requests for size n as lines to send, and which of them should fail
function lines(template: unknown[], n: number): { text: string; fails: boolean[] } {
	const steps = expand(template, { n }) as Record<string, unknown>[]
	const fails = steps.map((s) => isMap(s) && s.fails === true)
	const out = steps.map((s) => {
		if (isMap(s) && "fails" in s) {
			const { fails: _, ...rest } = s
			return line(rest)
		}
		return line(s)
	})
	return { text: out.join("\n") + "\n", fails }
}

class Broken extends Error {}

// the time of a run is its CPU time (user and system, as `time -p` reports): a busy machine slows
// the clock, not the work. without /usr/bin/time, the clock's
const timer = (() => {
	try {
		return Deno.statSync("/usr/bin/time").isFile
	} catch {
		return false
	}
})()

async function once(cmd: string[], input: Uint8Array, fails: boolean[]): Promise<number> {
	const started = performance.now()
	let child: Deno.ChildProcess | undefined
	let stuck: ReturnType<typeof setTimeout> | undefined
	let timedOut = false
	const run = timer ? ["/usr/bin/time", "-p", ...cmd] : cmd
	try {
		child = new Deno.Command(run[0], {
			args: run.slice(1),
			stdin: "piped",
			stdout: "piped",
			stderr: "piped",
		}).spawn()
		// a backstop only (the cap is on the work): the harness under `time` is killed first
		stuck = setTimeout(() => {
			timedOut = true
			try {
				new Deno.Command("pkill", { args: ["-9", "-P", String(child!.pid)] }).outputSync()
			} catch { /* none */ }
			try {
				child!.kill("SIGKILL")
			} catch { /* gone */ }
		}, CAP_MS * 3)
	} catch (e) {
		throw new Broken(`cannot run ${cmd[0]}: ${e}`)
	}
	const done = child.output()
	done.catch(() => {})
	const w = child.stdin.getWriter()
	try {
		await w.write(input)
		await w.close()
	} catch { /* its exit says why */ }
	const out = await done
	clearTimeout(stuck)
	if (timedOut) throw new Broken(`past ${CAP_MS * 3 / 1000}s of the clock`)
	let ms = performance.now() - started
	let err = new TextDecoder().decode(out.stderr)
	if (timer) {
		const m = err.match(/\nreal [\d.]+\nuser ([\d.]+)\nsys ([\d.]+)\n?$/)
		if (m) {
			ms = (Number(m[1]) + Number(m[2])) * 1000
			err = err.slice(0, m.index)
		}
	}
	if (ms >= CAP_MS) throw new Broken(`past ${CAP_MS / 1000}s`)
	if (out.code !== 0) {
		throw new Broken(`exited ${out.code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ""}`)
	}
	const answers = new TextDecoder().decode(out.stdout).split("\n").filter((l) => l !== "")
	if (answers.length !== fails.length) {
		throw new Broken(`${answers.length} answers for ${fails.length} requests`)
	}
	for (let i = 0; i < answers.length; i++) {
		const a = answers[i]
		// a cheap look first: only a line that mentions an error is parsed
		const error = a.includes('"error"') && JSON.parse(a).error !== undefined
		if (error && !fails[i]) throw new Broken(`step ${i}: an error: ${a.slice(0, 200)}`)
		if (!error && fails[i]) throw new Broken(`step ${i}: no error`)
	}
	return ms
}

async function least(cmd: string[], template: unknown[], n: number): Promise<number> {
	const { text, fails } = lines(template, n)
	const input = new TextEncoder().encode(text)
	let best = Infinity
	for (let r = 0; r < RUNS; r++) {
		const ms = await once(cmd, input, fails)
		best = Math.min(best, ms)
		if (ms > AGAIN_MS) break
	}
	return best
}

const grow = (bound: string, a: number, b: number) => {
	const la = Math.log(Math.max(a, 2)), lb = Math.log(Math.max(b, 2))
	switch (bound) {
		case "1":
			return 1
		case "log":
			return lb / la
		case "n":
			return b / a
		case "n log n":
			return (b / a) * (lb / la)
	}
	throw new Error(`no bound ${bound}`)
}

async function measure(cmd: string[], sc: Scenario): Promise<Result & { times?: number[] }> {
	try {
		const base = await least(cmd, sc.template, 0)
		const net: number[] = []
		for (const n of sc.sizes) {
			try {
				net.push(await least(cmd, sc.template, n) - base)
			} catch (e) {
				if (e instanceof Broken) {
					const before = net.map((t, i) => `n = ${sc.sizes[i]}: ${t.toFixed(0)}ms`)
					e.message += ` at n = ${n}${before.length ? ` (${before.join(", ")})` : ""}`
				}
				throw e
			}
		}
		for (let i = 1; i < sc.sizes.length; i++) {
			if (net[i] < QUICK_MS) continue
			const got = net[i] / Math.max(net[i - 1], FLOOR_MS)
			const want = SLACK * grow(sc.bound, sc.sizes[i - 1], sc.sizes[i])
			if (got > want) {
				const r = (x: number) => x.toFixed(x < 10 ? 1 : 0)
				return {
					ok: false,
					kind: "slow",
					why: `x${r(got)} for x${r(sc.sizes[i] / sc.sizes[i - 1])}, wanted <= x${r(want)}` +
						` (${net.map((t) => `${t.toFixed(0)}ms`).join(", ")})`,
				}
			}
		}
		return { ok: true, times: net }
	} catch (e) {
		if (e instanceof Broken) return { ok: false, kind: "broken", why: e.message }
		throw e
	}
}

function knownFile(s: Suite): string | undefined {
	if (known) return known
	if (Deno.env.get("HARNESS")) return undefined
	return `${root}${s.package}/${flags.includes("--c") ? "c" : "typescript"}/perf.sadly_known_fail`
}

function listed(file: string | undefined): Map<string, string> {
	const m = new Map<string, string>()
	if (!file) return m
	let t: string
	try {
		t = Deno.readTextFileSync(file)
	} catch {
		return m
	}
	for (const l of t.split("\n")) {
		const s = l.trim()
		if (s === "" || s.startsWith("#")) continue
		const i = s.search(/\s/)
		m.set(i < 0 ? s : s.slice(0, i), i < 0 ? "" : s.slice(i + 1).trim())
	}
	return m
}

if (flags.includes("--check") || flags.includes("--leaks")) {
	console.log("perf: sanitizer and leak builds are far too slow to time: skipped")
	Deno.exit(0)
}

const all = suites()
const withPerf = (s: Suite) => {
	try {
		return Deno.statSync(`${root}${s.package}/conformance/${s.name}-perf`).isDirectory
	} catch {
		return false
	}
}
const chosen = names.length ? names.map((n) => all.find((s) => s.name === n)) : all.filter(withPerf)
for (const [i, s] of chosen.entries()) {
	if (!s || !withPerf(s)) throw new Error(`no perf suite ${names[i]}`)
}
if (Deno.env.get("HARNESS") && chosen.length !== 1) {
	throw new Error("HARNESS runs one suite: name it")
}

let failed = 0
for (const s of chosen as Suite[]) {
	const dir = `${root}${s.package}/conformance/${s.name}-perf/`
	let cmd: string[]
	if (Deno.env.get("HARNESS")) cmd = command(s.name)
	else if (flags.includes("--c")) {
		cmd = [s.binary]
		try {
			Deno.statSync(s.binary)
		} catch {
			console.log(`${s.name}-perf: no binary ${s.binary} (make -s ${s.package}/c/...-harness)`)
			failed++
			continue
		}
	} else cmd = command(s.name)
	const list = listed(knownFile(s))
	const files = [...Deno.readDirSync(dir)].map((f) => f.name).filter((n) => /^\d.*\.json$/.test(n))
		.sort()
	for (const file of files) {
		const id = `${s.name}-perf/${file.replace(/\.json$/, "")}`
		const sc = JSON.parse(Deno.readTextFileSync(dir + file)) as Scenario
		const r = await measure(cmd, sc)
		const why = list.get(id)
		let verdict: string
		if (r.ok) {
			verdict = why === undefined ? "ok" : `passes now: take it off the list (${why})`
		} else if (why !== undefined) {
			verdict = `sadly known: ${r.kind}: ${r.why}`
		} else {
			verdict = `${r.kind.toUpperCase()}: ${r.why}`
			failed++
		}
		const times = r.ok && r.times
			? `  (${r.times.map((t) => `${t.toFixed(0)}ms`).join(", ")})`
			: ""
		console.log(`${id}: ${sc.title}\n    ${verdict}${times}`)
	}
}
if (failed) {
	console.log(`${failed} failed`)
	Deno.exit(1)
}
