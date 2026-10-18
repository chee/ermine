// two passes, two models: a fixer is handed another model's answer and asked to correct it
//   guided: only answers a host could see were broken, with what it saw
//   blind: any answer, passing or not, with nothing but the task (does review fix more than it breaks?)
//   deno run -A fix.ts --fixer qwen2.5-coder-1.5b [--blind] [--from results/] [--dir models/] [--server llama-server]

import { parseArgs } from "jsr:@std/cli@^1/parse-args"
import { extract } from "./extract.ts"
import { fence, kits, system, wrapping } from "./kits.ts"
import { chat, models, PARALLEL, startServer, stopServer } from "./llm.ts"
import { ask, type Attempt, type Cell, pool } from "./run.ts"
import { createSandbox, type Outcome } from "./sandbox.ts"
import { taskById } from "./tasks.ts"

export type Fix = {
	fixer: string
	model: string
	how: "guided" | "blind"
	exp: string
	task: string
	kit: string
	before: boolean
	after: boolean
	code?: string
	tokens: number
	ms: number
}

const here = (p: string) => new URL(p, import.meta.url).pathname
const args = parseArgs(Deno.args, {
	string: ["fixer", "from", "dir", "server", "only"],
	boolean: ["blind"],
})
const from = args.from ?? here("./results")
const dir = args.dir ?? Deno.env.get("LITTLE_LLMS_MODELS") ?? here("./models")
const server = args.server ?? Deno.env.get("LITTLE_LLMS_SERVER") ??
	"llama-server"
const fixer = models.find((m) => m.name == args.fixer)
if (!fixer) {
	throw new Error(
		"--fixer must be one of " + models.map((m) => m.name).join(", "),
	)
}
const how = args.blind ? "blind" : "guided"
const only = args.only?.split(",")

const cells: Cell[] = []
for await (const f of Deno.readDir(from)) {
	if (!f.name.endsWith(".jsonl") || f.name.startsWith("fix-")) continue
	if (only && !only.includes(f.name.replace(/\.jsonl$/, ""))) continue
	for (
		const line of (await Deno.readTextFile(`${from}/${f.name}`)).split("\n")
	) if (line) cells.push(JSON.parse(line))
}
// the example-prompted single answers, which every model has; a fixer does not review its own
const candidates = cells.filter((c) =>
	c.model != fixer.name && c.mode == "single" && c.prompting == "example" &&
	c.wrap == "fence" && ["data", "ui", "canvas"].includes(c.exp) &&
	c.first.code !== undefined &&
	(how == "blind" || (!c.first.pass && c.first.signal))
)

const out = `${from}/fix-${how}-${fixer.name}.jsonl`
const have = new Set<string>()
try {
	for (const l of (await Deno.readTextFile(out)).split("\n")) {
		if (l) {
			const f: Fix = JSON.parse(l)
			have.add([f.model, f.exp, f.task, f.kit].join("|"))
		}
	}
} catch { /* first run */ }
const todo = candidates.filter((c) => !have.has([c.model, c.exp, c.task, c.kit].join("|")))
	.sort((a, b) => a.kit.localeCompare(b.kit))
console.log(`${fixer.name} ${how}: ${todo.length} answers to fix`)

const sandbox = createSandbox(PARALLEL)
const passed = (o?: Outcome) => !!o?.checks && o.checks.every((c) => c.ok || !c.required)

async function fix(c: Cell): Promise<Fix> {
	const task = taskById(c.task)
	const kit = kits[c.kit]
	const first = c.first as Attempt
	const note = how == "guided" ? `It does not work. ${first.signal}` : `It may or may not be correct. Check it carefully against the task.`
	const r = await chat(fixer!, [
		{ role: "system", content: system(kit, "example", "fence") },
		{
			role: "user",
			content: `${ask(task, "single")}\n\nHere is a first attempt:\n${
				fence(kit.lang, first.code!)
			}\n\n${note}\n\nWrite the whole corrected program. ${wrapping("fence", [kit.lang])}`,
		},
	], { wrap: "fence", blocks: 1, maxTokens: kit.role == "data" ? 500 : 1000 })
	const code = extract(r.text, "fence", kit.lang).code
	let after = false
	if (code !== undefined) {
		const job = (data: unknown) => ({
			task: task.id,
			kit: c.kit,
			code,
			data,
			mode: "check" as const,
		})
		after = passed(await sandbox.run(job(task.data))) &&
			passed(await sandbox.run(job((task as { hidden?: unknown }).hidden)))
	}
	return {
		fixer: fixer!.name,
		model: c.model,
		how,
		exp: c.exp,
		task: c.task,
		kit: c.kit,
		before: first.pass,
		after,
		code,
		tokens: r.tokens,
		ms: r.ms,
	}
}

if (todo.length) {
	const child = await startServer(fixer, dir, server)
	let n = 0
	try {
		await pool(todo, PARALLEL, fix, (f) => {
			Deno.writeTextFileSync(out, JSON.stringify(f) + "\n", { append: true })
			if (++n % 25 == 0) console.log(`  ${n}/${todo.length}`)
		})
	} finally {
		await stopServer(child)
	}
}
sandbox.close()
Deno.exit(0)
