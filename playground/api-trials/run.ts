// deno run -A playground/api-trials/run.ts <design> <task> <file>
//   one program through its design's adapter and its task's check: a JSON result printed, with
//   hints (lib/hints.ts: what the program could see, as instructions) and the facts they came from
// deno run -A playground/api-trials/run.ts --all <dir>
//   every <dir>/<design>/<task>/<try>.ts (or .jsx; or <dir>/<design>/<task>.ts, one try), each in its own
//   deno, killed after a while: <dir>/results.json and <dir>/results.org (design × task, passes).
//   a task of more than one file (components): a try is a folder, <dir>/<design>/<task>/<try>/main.jsx
//   beside its other files (or <dir>/<design>/<task>/main.jsx, one try)
// every program runs with "ermine" importable (design L's words, lib/importmap.ts): run.ts started
// without the map starts itself again with it
// deno run -A playground/api-trials/run.ts --prompt <design> <task> [--sheet whole]
//   what a model is given: the design's sheet, then the task's statement. --sheet whole: the sheet
//   with a whole program at the top (sheet-whole.md)
import { design, designs } from "./designs/index.ts"
import { task, tasks } from "./tasks/index.ts"
import { gathered, load, message, type Result, type Seen, seen } from "./lib/trial.ts"
import { hints, programAt, type RunFacts, type Source } from "./lib/hints.ts"
import { again, dropMap, importMap, mapped } from "./lib/importmap.ts"

const TIMEOUT = 20_000
// a try's file: a program, or (a task with JSX) a .jsx one
const EXTS = [".ts", ".jsx"]
// a try of more than one file: the folder holding main.ts or main.jsx
const MAINS = EXTS.map((x) => `main${x}`)
const isFile = async (p: string) => (await Deno.stat(p).catch(() => undefined))?.isFile === true
async function mainIn(dir: string): Promise<string | undefined> {
	for (const m of MAINS) if (await isFile(`${dir}/${m}`)) return `${dir}/${m}`
	return undefined
}

type Row = Result & { design: string; task: string; try: string; file: string }
// one run: the judge's result, and what the program could see turned into instructions (hints),
// with those facts (lib/hints.ts)
type Out = Result & { hints?: string[]; facts?: RunFacts }

// a fact's error as JSON: its stack cut down to the program's line and column in it
function lined(s: Seen, url: string): Seen {
	const { stack: _, ...rest } = s
	const at = programAt(s, url)
	return at ? { ...rest, ...at } : rest
}

function facts(run: RunFacts, url: string): RunFacts {
	const l = (s: Seen) => lined(s, url)
	return {
		...(run.load ? { load: l(run.load) } : {}),
		rejected: run.rejected.map(l),
		uncaught: (run.uncaught ?? []).map(l),
		trials: run.trials.map((t) => ({
			...t,
			errors: t.errors.map((e) => ({ at: e.at, error: l(e.error) })),
			...(t.setup
				? { setup: { ...t.setup, ...(t.setup.error ? { error: l(t.setup.error) } : {}) } }
				: {}),
			computers: t.computers.map((c) => ({ ...c, ...(c.error ? { error: l(c.error) } : {}) })),
		})),
	}
}

async function withHints(d: string, k: string, file: string): Promise<Out> {
	const url = new URL(file, `file://${Deno.cwd()}/`).href
	const run: RunFacts = { rejected: [], uncaught: [], trials: gathered }
	const r: Out = await one(d, k, file, run)
	const text = await Deno.readTextFile(file).catch(() => undefined)
	r.hints = hints(
		run,
		design(d)?.key ?? d,
		text === undefined ? undefined : { url, text, others: await beside(file) },
	)
	r.facts = facts(run, url)
	return r
}

// a main file's other files (a try of more than one file), for hints naming their lines
async function beside(file: string): Promise<Source[]> {
	const name = file.split("/").at(-1) ?? ""
	if (!MAINS.includes(name)) return []
	const dir = file.slice(0, -name.length - 1)
	const out: Source[] = []
	for await (const f of Deno.readDir(dir)) {
		if (!f.isFile || f.name === name || !EXTS.some((x) => f.name.endsWith(x))) continue
		const path = `${dir}/${f.name}`
		const url = new URL(path, `file://${Deno.cwd()}/`).href
		out.push({ url, text: await Deno.readTextFile(path), name: f.name })
	}
	return out
}

async function one(d: string, k: string, file: string, run?: RunFacts): Promise<Result> {
	const des = design(d)
	const t = task(k)
	if (des === undefined) return { ran: false, correct: false, notes: [`no design ${d}`] }
	if (t === undefined) return { ran: false, correct: false, notes: [`no task ${k}`] }
	// an async handler's rejection nobody awaits: a note, not a crash
	const rejected: string[] = []
	globalThis.addEventListener("unhandledrejection", (e) => {
		e.preventDefault()
		rejected.push(message(e.reason))
		run?.rejected.push(seen(e.reason))
	})
	// a throw from code nobody called (a timer, a listener): a note, not a crash
	globalThis.addEventListener("error", (e) => {
		e.preventDefault()
		rejected.push(`uncaught: ${message(e.error)}`)
		run?.uncaught?.push(seen(e.error))
	})
	let program
	try {
		program = await load(file)
	} catch (e) {
		if (run) run.load = seen(e)
		return { ran: false, correct: false, notes: [`load: ${message(e)}`] }
	}
	let r: Result
	try {
		r = await t.check(des.adapter, program)
	} catch (e) {
		r = { ran: false, correct: false, notes: [`check threw ${message(e)}`] }
	}
	for (const x of rejected) {
		r.notes.push(x.startsWith("uncaught: ") ? x : `unhandled rejection: ${x}`)
	}
	return r
}

// one try in a deno of its own
async function apart(d: string, k: string, file: string): Promise<Result> {
	const cmd = new Deno.Command(Deno.execPath(), {
		args: [
			"run",
			"-A",
			"--quiet",
			"--import-map",
			await importMap(),
			new URL(import.meta.url).pathname,
			d,
			k,
			file,
		],
		stdout: "piped",
		stderr: "piped",
	})
	const child = cmd.spawn()
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL")
		} catch { /* gone */ }
	}, TIMEOUT)
	const out = await child.output()
	clearTimeout(timer)
	const text = new TextDecoder().decode(out.stdout).trim()
	try {
		return JSON.parse(text.split("\n").at(-1) ?? "")
	} catch {
		const err = new TextDecoder().decode(out.stderr).trim().split("\n").slice(-3).join(" / ")
		return {
			ran: false,
			correct: false,
			notes: [out.signal ? `killed (${out.signal}) after ${TIMEOUT}ms` : `no result: ${err}`],
		}
	}
}

async function* tries(
	dir: string,
): AsyncGenerator<{ design: string; task: string; try: string; file: string }> {
	for (const des of designs) {
		for (const t of tasks) {
			const base = `${dir}/${des.key}/${t.key}`
			for (const ext of EXTS) {
				if (await isFile(`${base}${ext}`)) {
					yield { design: des.key, task: t.key, try: "1", file: `${base}${ext}` }
				}
			}
			const folder = await Deno.stat(base).catch(() => undefined)
			if (!folder?.isDirectory) continue
			// the task's folder is one try of several files (main.jsx beside them)
			const main = await mainIn(base)
			if (main !== undefined) {
				yield { design: des.key, task: t.key, try: "1", file: main }
				continue
			}
			// else each file is a try, and each folder with a main in it
			const names: string[] = []
			for await (const f of Deno.readDir(base)) {
				if (f.isFile && EXTS.some((x) => f.name.endsWith(x))) names.push(f.name)
				else if (f.isDirectory && await mainIn(`${base}/${f.name}`)) names.push(`${f.name}/`)
			}
			for (const n of names.sort()) {
				if (n.endsWith("/")) {
					const name = n.slice(0, -1)
					const file = (await mainIn(`${base}/${name}`))!
					yield { design: des.key, task: t.key, try: name, file }
					continue
				}
				const name = n.slice(0, n.lastIndexOf("."))
				yield { design: des.key, task: t.key, try: name, file: `${base}/${n}` }
			}
		}
	}
}

function table(rows: Row[]): string {
	const head = `| design | ${tasks.map((t) => t.key).join(" | ")} | all |`
	const lines = [head, `|${Array(tasks.length + 2).fill("---").join("+")}|`]
	for (const des of designs) {
		const mine = rows.filter((r) => r.design === des.key)
		if (mine.length === 0) continue
		const cell = (rs: Row[]) =>
			rs.length === 0 ? "" : `${rs.filter((r) => r.correct).length}/${rs.length}`
		const cells = tasks.map((t) => cell(mine.filter((r) => r.task === t.key)))
		lines.push(`| ${des.key} ${des.name} | ${cells.join(" | ")} | ${cell(mine)} |`)
	}
	return lines.join("\n")
}

async function all(dir: string) {
	const rows: Row[] = []
	for await (const x of tries(dir)) {
		const r = await apart(x.design, x.task, x.file)
		rows.push({ ...x, ...r })
		const mark = r.correct ? "pass" : r.ran ? "FAIL" : "BROKE"
		console.error(
			`${mark} ${x.design}/${x.task}/${x.try}${r.correct ? "" : `: ${r.notes.join("; ")}`}`,
		)
	}
	await Deno.writeTextFile(`${dir}/results.json`, JSON.stringify(rows, null, "\t") + "\n")
	const t = table(rows)
	await Deno.writeTextFile(
		`${dir}/results.org`,
		`passes per design × task (passed/tries)\n\n${t}\n`,
	)
	console.log(t)
	await dropMap()
}

if (import.meta.main) {
	const [a, b, c, d, e] = Deno.args
	// one program: under the map, so "ermine" imports (--all's tries are started under it)
	if (a !== "--all" && a !== "--prompt" && !mapped()) await again(import.meta.url, Deno.args)
	if (a === "--all" && b !== undefined) await all(b.replace(/\/$/, ""))
	else if (a === "--prompt" && design(b ?? "") && task(c ?? "")) {
		if (d !== undefined && !(d === "--sheet" && e === "whole")) {
			console.error(`--prompt takes only --sheet whole after the task, not ${d} ${e ?? ""}`)
			Deno.exit(2)
		}
		const sheet = d === undefined ? design(b)!.sheet : new URL("sheet-whole.md", design(b)!.sheet)
		console.log(await Deno.readTextFile(sheet))
		// where a task's extra functions are: api's for A–D, e's and me's for E and F (10-25: the first
		// Haiku round said "in api" for all six, which E and F have no name for)
		// G's (and G2–G3's, H–K's): a global, and in api too. L's: the program function's argument
		const key = design(b)!.key
		const fn = task(c)!.given?.[0] ?? "save"
		const where = key === "e"
			? `on \`e\` (e.${fn})`
			: key === "f"
			? `on \`me\` (me.${fn})`
			: ["g", "g2", "g3", "h", "i", "j", "k"].includes(key)
			? "as a global and in `api`"
			: key === "l"
			? `as an argument of the program's function (\`export default function ({ ${fn} })\`)`
			: "in `api`"
		// E's and F's show is on e and me (the view task names show in code)
		const own = key === "e" ? "e." : key === "f" ? "me." : ""
		let statement = task(c)!.statement.replaceAll("provides in api", `provides ${where}`)
			.replaceAll("`show(", `\`${own}show(`)
		// L's words are imported: "no imports" is no other module
		if (key === "l") {
			statement = statement.replaceAll("; no imports)", '; import the words from "ermine")')
		}
		const files = task(c)!.files
		const file = files !== undefined
			? `Write ${files.length === 2 ? "two" : files.length} files: ${
				files.map((f, i) => i === 0 ? `${f} (the program)` : f).join(", ")
			}, each in its own fenced block headed by its name.`
			: task(c)!.jsx
			? "Write the program file (a .jsx file)."
			: "Write the program file."
		console.log(`## The task\n\n${statement}\n\n${file}`)
	} else if (a !== undefined && b !== undefined && c !== undefined) {
		console.log(JSON.stringify(await withHints(a, b, c)))
		// timers a program left behind don't keep the run going
		Deno.exit(0)
	} else {
		console.error(
			"run.ts <design> <task> <file> | --all <dir> | --prompt <design> <task> [--sheet whole]",
		)
		Deno.exit(2)
	}
}
