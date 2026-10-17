// differential fuzzing: random request streams sent to every implementation of a suite, answers
// diffed line by line; no reference, the odd one out is named by majority.
//   deno task differ [suite...] [--seeds N] [--impl a,b,c] [--out dir] [--wild] [--budget N]
//                    [--timeout s]
// defaults: every suite with a generator (differ/<suite>.ts), 30 seeds, all impls, a temp --out,
// 200 harness runs per shrink, 30 s per run. --wild: malformed and edge input too.
//
// implementations.json (or IMPLEMENTATIONS): { name: { suite: command } }.
// a missing binary is skipped and said. a dashed name votes with its family (c-check with c).
// compared as run.ts compares (maps by content, -0 not 0); string error codes compared, other
// strings not; a non-zero exit, sanitizer report, non-JSON line or timeout is a finding.
// a finding: first differing line, signed suite + odd one out + op + first differing field.
// invariants (per implementation, agreeing or not): undo undoes (apply, invert, update, unread),
// squish keeps meaning, models for update/unread/table/paths/tracker/node/scheduler (scheduler:
// values from scratch, acts, sets, ticks, refusals exact; moments as invariants).
// each signature: its first stream shrunk, printed with every answer, written to --out as a
// scenario expecting the majority's answers.
// deno-lint-ignore-file no-explicit-any
import { line } from "./typescript/form.ts"
import { ordered, read } from "./typescript/json.ts"
import { suites } from "./typescript/ask.ts"
import { type Answer, differs, type Generator, type Request } from "./differ/kit.ts"

const root = new URL("../", import.meta.url).pathname
const here = new URL(".", import.meta.url).pathname

// the arguments
const valued = new Set(["--seeds", "--impl", "--out", "--budget", "--timeout"])
const named: Record<string, string> = {}
const positional: string[] = []
const flags = new Set<string>()
for (let i = 0; i < Deno.args.length; i++) {
	const a = Deno.args[i]
	const [k, v] = a.split("=", 2)
	if (valued.has(k)) named[k] = v ?? Deno.args[++i]
	else if (a.startsWith("--")) flags.add(a)
	else positional.push(a)
}
for (const f of flags) if (f !== "--wild") throw new Error(`no flag ${f}`)
const SEEDS = Number(named["--seeds"] ?? 30)
const BUDGET = Number(named["--budget"] ?? 200)
const TIMEOUT = Number(named["--timeout"] ?? 30) * 1000
const WILD = flags.has("--wild")
const OUT = named["--out"] ?? Deno.makeTempDirSync({ prefix: "differ-" })
Deno.mkdirSync(OUT, { recursive: true })

const registry: Record<string, Record<string, string>> = JSON.parse(
	Deno.readTextFileSync(Deno.env.get("IMPLEMENTATIONS") ?? `${here}implementations.json`),
)
const impls = named["--impl"] ? named["--impl"].split(",") : Object.keys(registry)
for (const i of impls) if (!registry[i]) throw new Error(`no implementation ${i}`)
const family = (impl: string) => impl.split("-")[0]

const generators = [...Deno.readDirSync(`${here}differ`)]
	.map((f) => f.name.match(/^(.*)\.ts$/)?.[1])
	.filter((n): n is string => !!n && n !== "kit")
	.sort()
const chosen = positional.length ? positional : generators
for (const s of chosen) if (!generators.includes(s)) throw new Error(`no generator for ${s}`)
const now = new Map(suites().map((s) => [s.name, s.options.now === true]))

// --- running a harness

type Ran = { answers: (Answer | undefined)[]; failure?: { kind: string; why: string } }
const sanitized = /runtime error:|Sanitizer/

function exists(cmd: string[]): string | undefined {
	const file = cmd[0] === "deno" ? cmd.find((t) => t.endsWith(".ts")) : cmd[0]
	if (!file || (cmd[0] !== "deno" && !file.includes("/"))) return
	const path = file.startsWith("/") ? file : root + file
	try {
		Deno.statSync(path)
	} catch {
		return path
	}
}

async function run(cmd: string[], requests: Request[]): Promise<Ran> {
	// a request that cannot be written is the generator's fault, not the harness's
	const sent = requests.map((r) => line(r)).join("\n") + "\n"
	const child = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		cwd: root,
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn()
	let late = false
	const timer = setTimeout(() => {
		late = true
		try {
			child.kill("SIGKILL")
		} catch { /* gone */ }
	}, TIMEOUT)
	const done = child.output()
	const w = child.stdin.getWriter()
	try {
		await w.write(new TextEncoder().encode(sent))
		await w.close()
	} catch { /* told by its exit */ }
	const { stdout, stderr, code } = await done
	clearTimeout(timer)
	const err = new TextDecoder().decode(stderr)
	const answers = new TextDecoder().decode(stdout).split("\n").filter((l) => l.trim() !== "")
		.map((l) => {
			try {
				return read(l) as any
			} catch {
				return { "(not JSON)": l }
			}
		})
	const tail = err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)
	const failure = late
		? { kind: "timeout", why: `no end after ${TIMEOUT / 1000}s` }
		: sanitized.test(err)
		? { kind: "sanitizer", why: tail }
		: code !== 0
		? { kind: `exit ${code}`, why: tail }
		: answers.length > requests.length
		? { kind: "extra answers", why: `${answers.length} for ${requests.length}` }
		: answers.some((a) => "(not JSON)" in a)
		? { kind: "not JSON", why: answers.find((a) => "(not JSON)" in a)["(not JSON)"] }
		: undefined
	return { answers, failure }
}

// --- comparing

const isMap = (x: unknown): x is Record<string, any> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const isCode = (s: string) => /^[A-Za-z][A-Za-z0-9-]*$/.test(s)

function compare(a: Answer | undefined, b: Answer | undefined, window?: [number, number]) {
	if (a === undefined || b === undefined) {
		return a === b ? undefined : { path: "", kind: "no answer" }
	}
	if (isMap(a) && isMap(b) && ("error" in a) !== ("error" in b)) {
		return { path: ".error", kind: "error or not" }
	}
	if (isMap(a) && isMap(b) && typeof a.error === "string" && typeof b.error === "string") {
		if (isCode(a.error) && isCode(b.error) && a.error !== b.error) {
			return { path: ".error", kind: "error code" }
		}
		a = { ...a, error: "" }, b = { ...b, error: "" }
	}
	return differs(a, b, window)
}

type Group = { impls: string[]; answer: Answer | undefined }
type Finding = {
	signature: string
	at: number
	groups?: Group[]
	why?: string
}

const top = (path: string) => path.match(/^\.([^.[]*)/)?.[1] ?? "(answer)"

// what one stream's answers say: the first disagreement, failures, broken invariants
async function findings(
	suite: string,
	gen: Generator,
	stream: Request[],
	asked: string[],
): Promise<{ found: Finding[]; ran: Map<string, Ran>; window: [number, number] }> {
	const from = Math.floor(Date.now() / 1000)
	const ran = new Map(
		await Promise.all(
			asked.map(async (i) => [i, await run(registry[i][suite].split(" "), stream)] as const),
		),
	)
	const window: [number, number] = [from, Math.floor(Date.now() / 1000)]
	const w = now.get(suite) ? window : undefined
	const found: Finding[] = []
	for (let i = 0; i < stream.length; i++) {
		const groups: Group[] = []
		for (const impl of asked) {
			const a = ran.get(impl)!.answers[i]
			const g = groups.find((g) => compare(g.answer, a, w) === undefined)
			if (g) g.impls.push(impl)
			else groups.push({ impls: [impl], answer: a })
		}
		if (groups.length === 1) continue
		const weight = (g: Group) => new Set(g.impls.map(family)).size
		groups.sort((a, b) => weight(b) - weight(a))
		const majority = weight(groups[0]) > weight(groups[1])
		const odd = majority
			? groups.slice(1).flatMap((g) => g.impls).sort().join(",")
			: "no majority"
		const d = compare(groups[0].answer, groups[1].answer, w)!
		const field = d.kind === "no answer" ? "no answer" : `${top(d.path)}: ${d.kind}`
		found.push({
			signature: `${suite} | ${odd} | ${stream[i]?.op} | ${field}`,
			at: i,
			groups,
		})
		break
	}
	// failures, one per kind: the implementations that had it
	const failed = new Map<string, { impls: string[]; at: number; why: string }>()
	for (const [impl, r] of ran) {
		if (!r.failure) continue
		const at = Math.min(r.answers.length, stream.length - 1)
		const f = failed.get(r.failure.kind)
		if (f) f.impls.push(impl), f.at = Math.max(f.at, at)
		else failed.set(r.failure.kind, { impls: [impl], at, why: `${impl}: ${r.failure.why}` })
	}
	// a disagreement that is only the failed ones' missing answers is the failure
	if (
		found[0]?.groups &&
		found[0].groups.slice(1).every((g) =>
			g.answer === undefined && g.impls.every((i) => ran.get(i)!.failure)
		)
	) found.pop()
	for (const [kind, f] of failed) {
		found.push({ signature: `${suite} | ${f.impls.join(",")} | ${kind}`, at: f.at, why: f.why })
	}
	if (gen.invariant) {
		const broken = new Map<string, { impls: string[]; at: number; why: string }>()
		for (const impl of asked) {
			const ask = async (s: string, rs: Request[]) => {
				const cmd = registry[impl][s]
				return cmd ? (await run(cmd.split(" "), rs)).answers : []
			}
			for (const v of await gen.invariant(stream, ran.get(impl)!.answers, ask)) {
				const b = broken.get(v.kind)
				if (b) b.impls.push(impl)
				else broken.set(v.kind, { impls: [impl], at: v.at, why: `${impl}: ${v.why}` })
			}
		}
		for (const [kind, b] of broken) {
			found.push({
				signature: `${suite} | ${b.impls.join(",")} | invariant: ${kind}`,
				at: b.at,
				why: b.why,
			})
		}
	}
	return { found, ran, window }
}

// --- shrinking

// a map made again from its entries, in their order ("__proto__" a key like any, "2" where it was)
const rebuild = (entries: [string, unknown][]) => ordered(entries)
// x made a little smaller, every way: an element or key dropped, a string or number cut
function* smaller(x: unknown, depth = 0): IterableIterator<unknown> {
	if (Array.isArray(x)) {
		for (let i = 0; i < x.length; i++) yield [...x.slice(0, i), ...x.slice(i + 1)]
		for (let i = 0; i < x.length; i++) {
			for (const v of smaller(x[i], depth + 1)) yield [...x.slice(0, i), v, ...x.slice(i + 1)]
		}
	} else if (isMap(x)) {
		const es = Object.entries(x)
		for (let i = 0; i < es.length; i++) {
			if (depth === 0 && es[i][0] === "op") continue
			yield rebuild([...es.slice(0, i), ...es.slice(i + 1)])
		}
		for (let i = 0; i < es.length; i++) {
			if (depth === 0 && es[i][0] === "op") continue
			for (const v of smaller(es[i][1], depth + 1)) {
				yield rebuild(es.map(([k, w], j) => [k, j === i ? v : w]))
			}
		}
	} else if (typeof x === "string" && x.length > 0) {
		yield ""
		const first = [...x][0]
		if (first !== x) yield first
	} else if (typeof x === "number" && x !== 0) {
		yield 0
		if (Math.abs(x) > 1 && Number.isInteger(x)) yield Math.trunc(x / 2)
	}
}

async function shrink(
	suite: string,
	gen: Generator,
	stream: Request[],
	signature: string,
	asked: string[],
): Promise<{ stream: Request[]; runs: number }> {
	let runs = 0
	const holds = async (s: Request[]) => {
		if (runs >= BUDGET || s.length === 0) return false
		runs++
		const { found } = await findings(suite, gen, s, asked)
		return found.some((f) => f.signature === signature)
	}
	// delta debugging over the lines
	let n = 2
	while (stream.length >= 2 && runs < BUDGET) {
		const size = Math.ceil(stream.length / n)
		let cut = false
		for (let i = 0; i < stream.length; i += size) {
			const rest = [...stream.slice(0, i), ...stream.slice(i + size)]
			if (await holds(rest)) {
				stream = rest, n = Math.max(n - 1, 2), cut = true
				break
			}
		}
		if (!cut) {
			if (n >= stream.length) break
			n = Math.min(stream.length, n * 2)
		}
	}
	// each line's values made smaller
	for (let i = 0; i < stream.length && runs < BUDGET; i++) {
		let better = true
		while (better && runs < BUDGET) {
			better = false
			for (const v of smaller(stream[i])) {
				const s = [...stream.slice(0, i), v as Request, ...stream.slice(i + 1)]
				if (await holds(s)) {
					stream = s, better = true
					break
				}
				if (runs >= BUDGET) break
			}
		}
	}
	return { stream, runs }
}

// --- the run

async function pool<T>(xs: T[], size: number, f: (x: T) => Promise<void>) {
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(size, xs.length) }, async () => {
			while (next < xs.length) await f(xs[next++])
		}),
	)
}

// a whole number in the run's seconds, in an expect: "now"
function nowed(x: unknown, w: [number, number]): unknown {
	if (Array.isArray(x)) return x.map((y) => nowed(y, w))
	if (isMap(x)) return rebuild(Object.entries(x).map(([k, v]) => [k, nowed(v, w)]))
	return Number.isInteger(x) && (x as number) >= w[0] - 1 && (x as number) <= w[1] + 1 ? "now" : x
}

// indented, -0 written -0
const MINUS = "\u2063minus zero\u2063"
const pretty = (x: unknown) =>
	JSON.stringify(x, (_, v) => Object.is(v, -0) ? MINUS : v, "\t").replaceAll(`"${MINUS}"`, "-0")

type Seen = { count: number; stream: Request[]; finding: Finding; asked: string[] }
const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80)
let total = 0
console.log(`differ: seeds 1..${SEEDS}${WILD ? ", wild" : ""}; scenarios to ${OUT}`)

for (const suite of chosen) {
	const gen: Generator = (await import(`./differ/${suite}.ts`)).default
	const asked: string[] = []
	for (const impl of impls) {
		const cmd = registry[impl][suite]
		if (!cmd) {
			console.log(`  ${suite}: ${impl} has no ${suite}: skipped`)
			continue
		}
		const missing = exists(cmd.split(" "))
		if (missing) console.log(`  ${suite}: ${impl} skipped, missing ${missing}`)
		else asked.push(impl)
	}
	if (asked.length < (gen.invariant ? 1 : 2)) {
		console.log(`${suite}: fewer than two implementations; nothing to compare`)
		continue
	}
	const streams: Request[][] = []
	for (let seed = 1; seed <= SEEDS; seed++) streams.push(...gen.streams(seed, { wild: WILD }))
	const seen = new Map<string, Seen>()
	await pool(streams, 4, async (stream) => {
		const { found } = await findings(suite, gen, stream, asked)
		for (const f of found) {
			const s = seen.get(f.signature)
			if (s) s.count++
			else seen.set(f.signature, { count: 1, stream, finding: f, asked })
		}
	})
	const lines = streams.reduce((n, s) => n + s.length, 0)
	console.log(
		`\n${suite}: ${streams.length} streams, ${lines} lines, asked of ${asked.join(", ")}: ${
			seen.size ? `${seen.size} signatures` : "all agree"
		}`,
	)
	const groups = [...seen.entries()]
	await pool(groups, 3, async ([signature, s]) => {
		const start = s.finding.why === undefined || signature.includes("invariant")
			? s.stream.slice(0, s.finding.at + 1)
			: s.stream
		const { stream, runs } = await shrink(suite, gen, start, signature, s.asked)
		const { found, ran, window } = await findings(suite, gen, stream, s.asked)
		const f = found.find((f) => f.signature === signature)
		const out: string[] = [
			`\n# ${signature}`,
			`  ${s.count} of ${streams.length} streams; shrunk ${s.stream.length} -> ${stream.length} lines in ${runs} runs`,
		]
		if (f?.why) out.push(`  ${f.why}`)
		const steps: Record<string, unknown>[] = []
		stream.forEach((r, i) => {
			out.push(`  > ${line(r)}`)
			const groups: Group[] = []
			for (const impl of s.asked) {
				const a = ran.get(impl)!.answers[i]
				const w = now.get(suite) ? window : undefined
				const g = groups.find((g) => compare(g.answer, a, w) === undefined)
				if (g) g.impls.push(impl)
				else groups.push({ impls: [impl], answer: a })
			}
			const weight = (g: Group) => new Set(g.impls.map(family)).size
			groups.sort((a, b) => weight(b) - weight(a))
			for (const g of groups) {
				out.push(
					`    ${groups.length === 1 ? "all" : g.impls.join(",")}: ${
						g.answer === undefined ? "(no answer)" : line(g.answer)
					}`,
				)
			}
			const agreed = groups.length === 1 || weight(groups[0]) > weight(groups[1])
			const a = groups[0].answer
			const step: Record<string, unknown> = { ...r }
			if (agreed && a !== undefined) {
				if (typeof a.error === "string") step.fails = true
				else step.expect = now.get(suite) ? nowed(a, window) : a
			}
			steps.push(step)
		})
		const file = `${OUT}/${slug(signature)}.json`
		Deno.writeTextFileSync(
			file,
			pretty({ title: `differ: ${signature}`, steps }) + "\n",
		)
		out.push(`  scenario: ${file}`)
		console.log(out.join("\n"))
		total++
	})
}
console.log(`\n${total} signatures; scenarios in ${OUT}`)
