// tables from the results: markdown for reading, json for the page
//   deno task report [--from results/] [--md REPORT.md] [--json summary.json]

import { parseArgs } from "jsr:@std/cli@^1/parse-args"
import { models } from "./llm.ts"
import type { Cell } from "./run.ts"
import type { Fix } from "./fix.ts"

const here = (p: string) => new URL(p, import.meta.url).pathname
const args = parseArgs(Deno.args, { string: ["from", "md", "json"] })
const from = args.from ?? here("./results")

const cells: Cell[] = []
const fixes: Fix[] = []
for await (const f of Deno.readDir(from)) {
	if (!f.name.endsWith(".jsonl")) continue
	for (
		const line of (await Deno.readTextFile(`${from}/${f.name}`)).split("\n")
	) {
		if (!line) continue
		if (f.name.startsWith("fix-")) fixes.push(JSON.parse(line))
		else cells.push(JSON.parse(line))
	}
}
const order = models.map((m) => m.name).filter((n) => cells.some((c) => c.model == n))
const tier = (name: string) => models.find((m) => m.name == name)!.tier
const mb = (name: string) => models.find((m) => m.name == name)!.mb

type Rate = { ok: number; n: number }
const rate = (
	cs: Cell[],
	f: (c: Cell) => boolean = (c) => c.first.pass,
): Rate => ({ ok: cs.filter(f).length, n: cs.length })
const pct = (r: Rate) => (r.n ? Math.round((100 * r.ok) / r.n) : NaN)
const show = (r: Rate) => (r.n ? `${r.ok}/${r.n}` : "–")
const showPct = (r: Rate) => (r.n ? `${pct(r)}%` : "–")
const where = (o: Record<string, unknown>) =>
	cells.filter((c) => Object.entries(o).every(([k, v]) => (c as Record<string, unknown>)[k] == v))
const seenOnly = (c: Cell) => !c.first.pass && passedAll(c.first.seen) && !passedAll(c.first.hidden)
const passedAll = (o?: { checks?: { ok: boolean; required?: boolean }[] }) => !!o?.checks && o.checks.every((c) => c.ok || !c.required)
const fixedSelf = (c: Cell) => c.first.pass || !!c.repaired?.pass

const md: string[] = []
const table = (
	title: string,
	note: string,
	head: string[],
	rows: (string | number)[][],
) => {
	md.push(`### ${title}\n`)
	if (note) md.push(note + "\n")
	md.push(
		`| ${head.join(" | ")} |`,
		`| ${head.map((_, i) => (i ? "---:" : "---")).join(" | ")} |`,
	)
	for (const r of rows) md.push(`| ${r.join(" | ")} |`)
	md.push("")
}
const summary: Record<string, unknown> = {}

// overview
const groups = {
	data: (m: string) => where({ model: m, exp: "data" }),
	ui: (m: string) => where({ model: m, exp: "ui" }),
	canvas: (m: string) => where({ model: m, exp: "canvas" }),
	compound: (m: string) => where({ model: m, exp: "compound" }),
}
const bestSetup = (m: string, exp: string) => {
	const by = new Map<string, Cell[]>()
	for (const c of where({ model: m, exp })) {
		const k = exp == "compound" ? `${c.mode} · ${c.kit}` : `${c.kit} · ${c.prompting}`
		by.set(k, [...(by.get(k) ?? []), c])
	}
	return [...by].map(([k, cs]) => ({ k, r: rate(cs) })).sort((a, b) => pct(b.r) - pct(a.r) || b.r.n - a.r.n)[0]
}
const overview = order.map((m) => {
	const all = cells.filter((c) => c.model == m && c.exp != "wrap")
	return {
		model: m,
		tier: tier(m),
		mb: mb(m),
		data: rate(groups.data(m)),
		ui: rate(groups.ui(m)),
		canvas: rate(groups.canvas(m)),
		compound: rate(groups.compound(m)),
		all: rate(all),
		bestData: bestSetup(m, "data"),
		bestUi: bestSetup(m, "ui"),
		tokens: median(all.flatMap((c) => c.calls.map((x) => x.tokens))),
	}
})
summary.overview = overview
table(
	"Overview",
	"First-pass success (answer passes on the data the model saw and on hidden data), every setup pooled. Best setup is the kit · prompting with the highest rate.",
	[
		"model",
		"MB",
		"data",
		"ui",
		"canvas",
		"gather+render",
		"all",
		"best data setup",
		"best ui setup",
		"median answer tokens",
	],
	overview.map((o) => [
		`**${o.model}**`,
		o.mb,
		showPct(o.data),
		showPct(o.ui),
		showPct(o.canvas),
		showPct(o.compound),
		`**${showPct(o.all)}**`,
		o.bestData ? `${o.bestData.k} (${show(o.bestData.r)})` : "–",
		o.bestUi ? `${o.bestUi.k} (${show(o.bestUi.r)})` : "–",
		o.tokens,
	]),
)

function median(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b)
	return s.length ? s[Math.floor(s.length / 2)] : 0
}

// data
const dataCols = [["js", "min"], ["js", "example"], ["sql", "min"], [
	"sql",
	"example",
]]
summary.data = order.map((m) => ({
	model: m,
	cols: dataCols.map(([kit, p]) => rate(where({ model: m, exp: "data", kit, prompting: p }))),
}))
table(
	"Data transforms: JS function vs SQL query",
	"Out of 6 tasks (join names, sum, group totals, top 3, string formatting, count matches). min = API description only, example = plus one worked example.",
	["model", ...dataCols.map(([k, p]) => `${k} · ${p}`)],
	order.map((
		m,
	) => [
		m,
		...dataCols.map(([kit, p]) => show(rate(where({ model: m, exp: "data", kit, prompting: p })))),
	]),
)
const dataTasks = [...new Set(where({ exp: "data" }).map((c) => c.task))]
table(
	"Data transforms by task",
	"Pooled over all models and prompts.",
	["task", "js", "sql"],
	dataTasks.map((
		t,
	) => [
		t,
		showPct(rate(where({ exp: "data", task: t, kit: "js" }))),
		showPct(rate(where({ exp: "data", task: t, kit: "sql" }))),
	]),
)

// ui kits
const uiKits = ["dom", "html", "jsx", "reactive", "ermine"]
summary.ui = order.map((m) => ({
	model: m,
	kits: uiKits.map((k) => rate(where({ model: m, exp: "ui", kit: k }))),
}))
table(
	"UI kits",
	"Out of 6 UI tasks × the prompts each model ran (3: min, example, scaffold; or 1, example, for the medium models and qwen3.5-2b). dom = vanilla JS, html = DOM-0 inline handlers, jsx = Preact hooks, reactive = mutable `state` + `view()` string, re-rendered after each event, ermine = open/read/edit/method.",
	["model", ...uiKits],
	order.map((
		m,
	) => [
		m,
		...uiKits.map((k) => showPct(rate(where({ model: m, exp: "ui", kit: k })))),
	]),
)
const prompts = ["min", "example", "scaffold"]
const full = order.filter((m) => {
	const x = models.find((y) => y.name == m)!
	return x.tier != "medium" && !x.reduced
})
table(
	"Prompt style by kit",
	"UI tasks, the models that ran all three prompt styles.",
	["kit", ...prompts],
	uiKits.map((
		k,
	) => [
		k,
		...prompts.map((p) =>
			showPct(
				rate(cells.filter((c) =>
					full.includes(c.model) && c.exp == "ui" && c.kit == k &&
					c.prompting == p
				)),
			)
		),
	]),
)
const uiTasks = [...new Set(where({ exp: "ui" }).map((c) => c.task))]
table(
	"UI tasks by kit",
	"Pooled over all models and prompts.",
	["task", ...uiKits],
	uiTasks.map((
		t,
	) => [
		t,
		...uiKits.map((k) => showPct(rate(where({ exp: "ui", task: t, kit: k })))),
	]),
)

// canvas
const canvasKits = ["canvas", "dom", "html", "jsx"]
table(
	"Canvas tasks (fish tank, bar chart)",
	"canvas = `ctx` handed over; the rest make their own <canvas>. Out of 2 tasks × prompts.",
	["model", ...canvasKits],
	order.map((
		m,
	) => [
		m,
		...canvasKits.map((k) => show(rate(where({ model: m, exp: "canvas", kit: k })))),
	]),
)

// gather + render
const modes = ["oneshot-js", "oneshot-sql", "split-js", "split-sql"]
summary.compound = order.map((m) => ({
	model: m,
	modes: modes.map((mode) => rate(where({ model: m, exp: "compound", mode }))),
}))
table(
	"Gather + render: one answer vs two steps",
	"3 tasks (spending chart, unpaid-orders table, done-per-person lines) × kits dom/html/reactive (+canvas for the chart). oneshot-js: one program from the raw tables. oneshot-sql: a ```sql block then a view block in one answer. split-*: first a query/transform, run for real, then a separate view prompt that is shown the result's shape and values.",
	["model", ...modes],
	order.map((
		m,
	) => [
		m,
		...modes.map((mode) => show(rate(where({ model: m, exp: "compound", mode })))),
	]),
)
table(
	"Gather + render by kit",
	"Pooled over all models.",
	["kit", ...modes],
	["dom", "html", "reactive", "canvas"].map((
		k,
	) => [
		k,
		...modes.map((mode) => showPct(rate(where({ exp: "compound", kit: k, mode })))),
	]),
)
const dataStep = (mode: string) => {
	const cs = where({ exp: "compound", mode })
	return rate(cs, (c) => c.first.how != "data step failed")
}
table(
	"Split mode: where it fails",
	"How often the data step itself ran (no error, some result) before the view step.",
	["mode", "data step ran", "then passed"],
	["split-js", "split-sql"].map((
		mode,
	) => [
		mode,
		showPct(dataStep(mode)),
		showPct(rate(where({ exp: "compound", mode }))),
	]),
)

// wrapping
const wrapRows = order.filter((m) => where({ model: m, exp: "wrap" }).length)
const fenceTwin = (c: Cell) =>
	where({
		model: c.model,
		task: c.task,
		kit: c.kit,
		prompting: "example",
		wrap: "fence",
		mode: "single",
	})
		.filter((x) => x.exp != "wrap")
const wrapRate = (m: string, w: string) =>
	w == "fence" ? rate(where({ model: m, exp: "wrap", wrap: "raw" }).flatMap(fenceTwin)) : rate(where({ model: m, exp: "wrap", wrap: w }))
summary.wrap = wrapRows.map((m) => ({
	model: m,
	fence: wrapRate(m, "fence"),
	raw: wrapRate(m, "raw"),
	json: wrapRate(m, "json"),
}))
table(
	"Answer wrapping: markdown fence vs bare code vs JSON",
	"Same 10 prompts (6 JS data tasks, counter + todo in dom and reactive), example prompting.",
	["model", "```fence", "raw", '{"code": …}'],
	wrapRows.map((
		m,
	) => [
		m,
		show(wrapRate(m, "fence")),
		show(wrapRate(m, "raw")),
		show(wrapRate(m, "json")),
	]),
)

// repair, same model
const repairable = (m: string) => cells.filter((c) => c.model == m && c.mode == "single" && c.exp != "wrap")
summary.repair = order.map((m) => {
	const cs = repairable(m)
	return {
		model: m,
		before: rate(cs),
		after: rate(cs, fixedSelf),
		signalled: cs.filter((c) => !c.first.pass && c.first.signal).length,
		fixed: cs.filter((c) => !c.first.pass && c.repaired?.pass).length,
	}
})
table(
	"Self-repair from host-visible errors",
	"When an answer failed in a way the host can see without knowing the answer (no code, an exception, an empty page, a blank canvas, no result), the same model got one retry with the error. Wrong-but-quiet answers get no retry.",
	["model", "first pass", "visible failures", "fixed by retry", "after retry"],
	(summary.repair as {
		model: string
		before: Rate
		after: Rate
		signalled: number
		fixed: number
	}[]).map((r) => [
		r.model,
		showPct(r.before),
		r.signalled,
		r.fixed,
		showPct(r.after),
	]),
)

// hardcoding
const viewCells = cells.filter((c) => ["ui", "canvas", "compound"].includes(c.exp))
const hard = (cs: Cell[]) => {
	const seen = cs.filter((c) => passedAll(c.first.seen)).length
	return { seen, only: cs.filter(seenOnly).length }
}
table(
	"Hard-coding the data it was shown",
	"Answers that pass on the data in the prompt but fail on hidden data (usually the values were typed into the code). Share of seen-passes that were hard-coded.",
	["kit / mode", "passed on seen data", "of those, hard-coded"],
	[
		...["dom", "html", "jsx", "reactive", "ermine", "canvas"].map((k) => {
			const h = hard(
				viewCells.filter((c) => c.kit == k && c.exp != "compound"),
			)
			return [
				k,
				h.seen,
				h.seen ? `${Math.round((100 * h.only) / h.seen)}%` : "–",
			]
		}),
		...modes.map((mode) => {
			const h = hard(viewCells.filter((c) => c.mode == mode))
			return [
				`gather+render ${mode}`,
				h.seen,
				h.seen ? `${Math.round((100 * h.only) / h.seen)}%` : "–",
			]
		}),
	],
)

// fixers
if (fixes.length) {
	const keys = [...new Set(fixes.map((f) => `${f.fixer}|${f.how}`))]
	const rows = keys.map((k) => {
		const [fixer, how] = k.split("|")
		const fs = fixes.filter((f) => f.fixer == fixer && f.how == how)
		const failed = fs.filter((f) => !f.before),
			good = fs.filter((f) => f.before)
		return {
			fixer,
			how,
			n: fs.length,
			fixed: failed.filter((f) => f.after).length,
			failed: failed.length,
			broke: good.filter((f) => !f.after).length,
			good: good.length,
		}
	})
	summary.fixers = rows
	table(
		"Second model as fixer",
		"guided: the fixer gets a failing answer plus the host-visible error. blind: the fixer reviews answers (passing or not) with only the task. Example-prompted answers from every other model.",
		["fixer", "mode", "answers", "failing → fixed", "passing → broken"],
		rows.map((
			r,
		) => [
			r.fixer,
			r.how,
			r.n,
			`${r.fixed}/${r.failed} (${r.failed ? Math.round((100 * r.fixed) / r.failed) : 0}%)`,
			r.good ? `${r.broke}/${r.good}` : "–",
		]),
	)
	const byModel = [...new Set(fixes.map((f) => f.model))].sort((a, b) => order.indexOf(a) - order.indexOf(b))
	table(
		"Fixer gains by author model (guided)",
		"Failing answers fixed, per author.",
		[
			"author",
			...keys.filter((k) => k.endsWith("guided")).map((k) => k.split("|")[0]),
		],
		byModel.map((
			m,
		) => [
			m,
			...keys.filter((k) => k.endsWith("guided")).map((k) => {
				const fs = fixes.filter((f) => `${f.fixer}|${f.how}` == k && f.model == m && !f.before)
				return fs.length ? `${fs.filter((f) => f.after).length}/${fs.length}` : "–"
			}),
		]),
	)
}

// task difficulty
const tiers = ["tiny", "small", "medium"]
const allTasks = [
	...new Set(cells.filter((c) => c.exp != "wrap").map((c) => c.task)),
]
table(
	"Task difficulty by model size",
	"Pooled over setups. tiny ≤ 0.8B, small 1–2B, medium 2–4B.",
	["task", ...tiers],
	allTasks.map((
		t,
	) => [
		t,
		...tiers.map((tr) =>
			showPct(
				rate(cells.filter((c) => c.task == t && c.exp != "wrap" && tier(c.model) == tr)),
			)
		),
	]),
)

// how answers came out
const hows = new Map<string, number>()
for (const c of cells) {
	if (c.wrap == "fence") {
		hows.set(c.first.how, (hows.get(c.first.how) ?? 0) + 1)
	}
}
table(
	"How fenced answers were extracted",
	"",
	["how", "answers"],
	[...hows].sort((a, b) => b[1] - a[1]).map(([h, n]) => [h, n]),
)

summary.cells = cells.length
summary.generated = new Date().toISOString()
const text = `# Little LLMs: data transforms and little UIs\n\n${cells.length} cells over ${order.length} models.\n\n${md.join("\n")}`
await Deno.writeTextFile(args.md ?? here("./REPORT.md"), text)
await Deno.writeTextFile(
	args.json ?? here("./summary.json"),
	JSON.stringify(summary, null, 1),
)
console.log(text)
