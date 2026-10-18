// the benchmark: every model through every setup, results as one JSON line per cell
//   deno task bench [--models a,b] [--exp data,ui] [--dir models/] [--server llama-server]

import { parseArgs } from "jsr:@std/cli@^1/parse-args"
import { extract, type Extracted } from "./extract.ts"
import { fence, type Kit, type KitName, kits, type Prompting, system, type Wrap, wrapping } from "./kits.ts"
import { chat, type Message, type Model, models, PARALLEL, type Reply, startServer, stopServer } from "./llm.ts"
import { createSandbox, type Job, type Outcome } from "./sandbox.ts"
import { compoundTasks, dataTasks, type Task, taskById, viewTasks } from "./tasks.ts"

export type Mode =
	| "single"
	| "oneshot-js"
	| "oneshot-sql"
	| "split-js"
	| "split-sql"
export type Spec = {
	exp: string
	task: string
	kit: KitName
	prompting: Prompting
	wrap: Wrap
	mode: Mode
}
export type Attempt = {
	code?: string
	how: string
	pass: boolean
	seen?: Outcome
	hidden?: Outcome
	signal?: string
}
export type Cell = Spec & {
	model: string
	first: Attempt
	repaired?: Attempt
	calls: {
		tokens: number
		promptTokens: number
		ms: number
		stopped: boolean
		error?: string
		text: string
	}[]
	before?: { kit: "js" | "sql"; code?: string; how: string; value?: unknown }
}

export const keyOf = (s: Spec) => [s.exp, s.task, s.kit, s.prompting, s.wrap, s.mode].join("|")

const ui = viewTasks.filter((t) => t.kind == "ui").map((t) => t.id)
const canvas = viewTasks.filter((t) => t.kind == "canvas").map((t) => t.id)

export function specs(m: Model): Spec[] {
	const out: Spec[] = []
	const medium = m.tier == "medium"
	const add = (
		exp: string,
		task: string,
		kit: KitName,
		prompting: Prompting,
		wrap: Wrap = "fence",
		mode: Mode = "single",
	) => out.push({ exp, task, kit, prompting, wrap, mode })
	const promptings = (
		all: Prompting[],
	): Prompting[] => (medium ? ["example"] : all)
	for (const p of promptings(["min", "example"])) {
		for (const kit of ["js", "sql"] as const) {
			for (const t of dataTasks) add("data", t.id, kit, p)
		}
	}
	for (const p of promptings(["min", "example", "scaffold"])) {
		for (const kit of ["dom", "html", "jsx", "reactive", "ermine"] as const) {
			for (const t of ui) add("ui", t, kit, p)
		}
	}
	for (const p of promptings(["min", "example"])) {
		for (const kit of ["canvas", "dom", "html", "jsx"] as const) {
			for (const t of canvas) {
				add("canvas", t, kit, p)
			}
		}
	}
	for (
		const mode of [
			"oneshot-js",
			"oneshot-sql",
			"split-js",
			"split-sql",
		] as const
	) {
		for (const t of compoundTasks) {
			for (
				const kit of [
					"dom",
					"html",
					"reactive",
					...(t.id == "spend-chart" ? ["canvas" as const] : []),
				] as const
			) {
				add("compound", t.id, kit, "example", "fence", mode)
			}
		}
	}
	if (!medium) {
		for (const w of ["raw", "json"] as const) {
			for (const t of dataTasks) add("wrap", t.id, "js", "example", w)
			for (const kit of ["reactive", "dom"] as const) {
				for (const t of ["counter", "todo"]) {
					add("wrap", t, kit, "example", w)
				}
			}
		}
	}
	return out
}

// what the model is asked

const tablesText = (tables: Record<string, Record<string, unknown>[]>) =>
	Object.entries(tables).map(([name, rows]) =>
		`Table \`${name}\` (columns: ${Object.keys(rows[0] ?? {}).join(", ")}):\n` +
		fence(
			"json",
			"[\n" + rows.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n]",
		)
	).join("\n\n")

const dataText = (data: unknown) =>
	"`data` is:\n" +
	fence(
		"json",
		JSON.stringify(data, null, 1).replace(/\n\s*/g, " ").replace(
			/\} \{/g,
			"},\n {",
		),
	)

export function ask(task: Task, mode: Mode, value?: unknown) {
	if (task.kind == "data") return `${task.ask}\n\n${tablesText(task.data)}`
	if (task.kind != "compound") {
		return task.data === undefined ? task.ask : `${task.ask}\n\n${dataText(task.data)}`
	}
	const tables = task.data as Record<string, Record<string, unknown>[]>
	if (mode == "oneshot-js") {
		return `${task.ask}\n\n\`data\` is an object of tables, like data.${Object.keys(tables)[0]}.\n\n${tablesText(tables)}`
	}
	if (mode == "oneshot-sql") {
		return `${task.ask}\n\nThe tables:\n\n${tablesText(tables)}`
	}
	if (value === undefined) {
		return `The user wants this view: ${task.ask}\n\nYour job now is only the data step: get exactly the data that view needs, ready to draw. A later step will draw it.\n\n${
			tablesText(tables)
		}`
	}
	return `${task.ask}\n\nThe data was already prepared for you. ${dataText(value)}`
}

const maxTokens = (k: Kit) => (k.role == "data" ? 500 : 1000)

// running answers

const sandbox = createSandbox(PARALLEL)

const passed = (o?: Outcome) => !!o?.checks && o.checks.every((c) => c.ok || !c.required)

async function judge(
	task: Task,
	kit: KitName,
	code: string | undefined,
	before?: Job["before"],
) {
	if (code === undefined) return { pass: false }
	const job = (data: unknown): Job => ({
		task: task.id,
		kit,
		code,
		before,
		data,
		mode: "check",
	})
	const seen = await sandbox.run(job(task.data))
	const hidden = await sandbox.run(job((task as { hidden?: unknown }).hidden))
	return { pass: passed(seen) && passed(hidden), seen, hidden }
}

// what a host could tell the model without knowing the answer
async function signal(
	task: Task,
	kit: KitName,
	x: Extracted,
	before?: Job["before"],
): Promise<string | undefined> {
	if (x.code === undefined) return "I could not find any code in your reply."
	const smoke = await sandbox.run({
		task: task.id,
		kit,
		code: x.code,
		before,
		data: task.data,
		mode: task.kind == "data" ? "eval" : "smoke",
	})
	if (smoke.errors.length) {
		return "Running it gave this error:\n" +
			smoke.errors.slice(0, 2).join("\n")
	}
	if (task.kind == "data") {
		return smoke.result == null ? "It returned nothing." : undefined
	}
	if (task.kind == "canvas" && smoke.drew == 0) {
		return "Nothing was drawn on the canvas."
	}
	if (!smoke.rendered && smoke.drew == 0) {
		return "The page stayed empty: nothing was rendered."
	}
}

async function attempt(
	task: Task,
	kit: KitName,
	x: Extracted,
	before?: Job["before"],
): Promise<Attempt> {
	const j = await judge(task, kit, x.code, before)
	const s = j.pass ? undefined : await signal(task, kit, x, before)
	return { code: x.code, how: x.how, ...j, signal: s }
}

const record = (r: Reply) => ({
	tokens: r.tokens,
	promptTokens: r.promptTokens,
	ms: r.ms,
	stopped: r.stopped,
	error: r.error,
	text: r.text,
})

export async function cell(model: Model, spec: Spec): Promise<Cell> {
	const task = taskById(spec.task)
	const kit = kits[spec.kit]
	const calls: Cell["calls"] = []
	const talk = async (messages: Message[], k: Kit, blocks = 1) => {
		const r = await chat(model, messages, {
			wrap: spec.wrap,
			blocks,
			maxTokens: maxTokens(k) + (blocks - 1) * 400,
		})
		calls.push(record(r))
		return r
	}
	if (spec.mode == "single" || spec.mode == "oneshot-js") {
		const messages: Message[] = [
			{ role: "system", content: system(kit, spec.prompting, spec.wrap) },
			{ role: "user", content: ask(task, spec.mode) },
		]
		const r = await talk(messages, kit)
		const first = await attempt(
			task,
			spec.kit,
			extract(r.text, spec.wrap, kit.lang),
		)
		let repaired: Attempt | undefined
		if (!first.pass && first.signal && spec.exp != "compound") {
			const again = await talk([
				...messages,
				{ role: "assistant", content: r.text },
				{
					role: "user",
					content: `That did not work. ${first.signal}\n\nWrite the whole corrected program. ${wrapping(spec.wrap, [kit.lang])}`,
				},
			], kit)
			repaired = await attempt(
				task,
				spec.kit,
				extract(again.text, spec.wrap, kit.lang),
			)
		}
		return { ...spec, model: model.name, first, repaired, calls }
	}
	if (spec.mode == "oneshot-sql") {
		const r = await talk(
			[
				{
					role: "system",
					content: system(kit, spec.prompting, spec.wrap, kits.sql),
				},
				{ role: "user", content: ask(task, spec.mode) },
			],
			kit,
			2,
		)
		const sql = extract(r.text, spec.wrap, "sql")
		const view = extract(
			r.text,
			spec.wrap,
			kit.lang,
			kit.lang == "sql" ? 1 : 0,
		)
		const before = sql.code === undefined ? undefined : { kit: "sql" as const, code: sql.code }
		const first = before ? await attempt(task, spec.kit, view, before) : { how: "no sql", pass: false }
		return {
			...spec,
			model: model.name,
			first,
			calls,
			before: { kit: "sql", code: sql.code, how: sql.how },
		}
	}
	// split: a data step, run for real, then a view of what it made
	const dk = spec.mode == "split-sql" ? kits.sql : kits.js
	const r1 = await talk([
		{ role: "system", content: system(dk, spec.prompting, spec.wrap) },
		{ role: "user", content: ask(task, spec.mode) },
	], dk)
	const q = extract(r1.text, spec.wrap, dk.lang)
	const before = { kit: dk.name as "js" | "sql", code: q.code ?? "" }
	const value = q.code === undefined ? undefined : await sandbox.run({
		task: task.id,
		kit: dk.name,
		code: q.code,
		data: task.data,
		mode: "eval",
	})
	if (!value || value.errors.length || value.result === undefined) {
		return {
			...spec,
			model: model.name,
			first: { how: "data step failed", pass: false, signal: value?.errors[0] },
			calls,
			before: { ...before, how: q.how },
		}
	}
	const r2 = await talk([
		{ role: "system", content: system(kit, spec.prompting, spec.wrap) },
		{ role: "user", content: ask(task, spec.mode, value.result) },
	], kit)
	const first = await attempt(
		task,
		spec.kit,
		extract(r2.text, spec.wrap, kit.lang),
		before,
	)
	return {
		...spec,
		model: model.name,
		first,
		calls,
		before: { ...before, how: q.how, value: value.result },
	}
}

// a fixed number at a time, in order, so cells with the same system prompt share the server's cache
export async function pool<T, R>(
	items: T[],
	n: number,
	f: (t: T) => Promise<R>,
	done: (r: R, t: T) => void,
) {
	let next = 0
	await Promise.all(Array.from({ length: n }, async () => {
		while (next < items.length) {
			const t = items[next++]
			done(await f(t), t)
		}
	}))
}

const here = (p: string) => new URL(p, import.meta.url).pathname

if (import.meta.main) {
	const args = parseArgs(Deno.args, {
		string: ["models", "exp", "dir", "server", "out"],
	})
	const dir = args.dir ?? Deno.env.get("LITTLE_LLMS_MODELS") ??
		here("./models")
	const server = args.server ?? Deno.env.get("LITTLE_LLMS_SERVER") ??
		"llama-server"
	const outDir = args.out ?? here("./results")
	await Deno.mkdir(outDir, { recursive: true })
	const chosen = args.models ? models.filter((m) => args.models!.split(",").includes(m.name)) : models
	const exps = args.exp?.split(",")
	for (const m of chosen) {
		const file = `${outDir}/${m.name}.jsonl`
		const have = new Set<string>()
		try {
			for (const line of (await Deno.readTextFile(file)).split("\n")) {
				if (line) have.add(keyOf(JSON.parse(line)))
			}
		} catch { /* first run */ }
		const todo = specs(m).filter((s) => !have.has(keyOf(s)) && (!exps || exps.includes(s.exp)))
			.sort((a, b) =>
				[a.kit, a.prompting, a.wrap, a.mode].join().localeCompare(
					[b.kit, b.prompting, b.wrap, b.mode].join(),
				)
			)
		if (!todo.length) continue
		console.log(`${m.name}: ${todo.length} cells`)
		const child = await startServer(m, dir, server)
		const start = Date.now()
		let n = 0, ok = 0
		try {
			await pool(todo, m.slots ?? PARALLEL, (s) => cell(m, s), (c) => {
				// a call that never reached the model (the server went away) is not a result: leave it for the next run
				if (c.calls.some((x) => x.error && !x.tokens)) return console.log(`  lost: ${keyOf(c)}: ${c.calls.find((x) => x.error)?.error}`)
				n++
				if (c.first.pass) ok++
				Deno.writeTextFileSync(file, JSON.stringify(c) + "\n", {
					append: true,
				})
				if (n % 10 == 0) {
					console.log(
						`  ${n}/${todo.length}, ${ok} passed first time, ${Math.round((Date.now() - start) / 1000)}s`,
					)
				}
			})
		} finally {
			await stopServer(child)
		}
		console.log(
			`  done: ${ok}/${n} in ${Math.round((Date.now() - start) / 1000)}s`,
		)
	}
	sandbox.close()
}
