// hedgehog2-notebook's host: the world (@ermine/slaygrounds/world), one process, notebook, running
// program.ts. the notebook itself is seeded here, at /nb, beside the process: a program.ts edit
// stops the process and starts it again, and the cells are still there
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode, hasNode, patchAttributes } from "@ermine/system"
import { render } from "@ermine/render/dom"

// kind: code | markdown | slider | text | chart. code and markdown hold their source in `code`; a
// slider min/max/step/value; a text input its value; a chart the name it draws (`of`). attrs: how a
// cell looks (fold, chart type), kept on the node as attributes: not part of what it computes
type Seed =
	& { name: string; kind: string; attrs?: Record<string, unknown> }
	& Record<string, unknown>
const SEED: Seed[] = [
	{
		name: "intro",
		kind: "markdown",
		code: `# a reactive notebook
Cells read each other by name, \`cell("n")\`. Edit a cell, drag a slider, type a city: only the cells that
read it run again, and they light up. The arrows on the left are what each run really read.

Try it: drag **n** (now \${cell("n")}), or retype the city and change it back (the weather is cached).`,
	},
	{ name: "n", kind: "slider", min: 3, max: 80, step: 1, value: 50 },
	{ name: "wobble", kind: "slider", min: 0, max: 8, step: 0.5, value: 2.5 },
	{
		name: "wave",
		kind: "code",
		code: `// n points of a sine, plus wobble times another sine
const n = cell("n"), w = cell("wobble")
return Array.from({ length: n }, (_, i) => {
  const t = (i / (n - 1)) * Math.PI * 4
  return Math.sin(t) * 10 + w * Math.sin(t * 5.3)
})`,
	},
	{ name: "waveplot", kind: "chart", of: "wave", attrs: { chart: "area" } },
	{
		name: "stats",
		kind: "code",
		code: `const w = cell("wave")
const sum = w.reduce((a, b) => a + b, 0)
return { min: Math.min(...w), max: Math.max(...w), mean: sum / w.length }`,
	},
	{
		name: "summary",
		kind: "markdown",
		code:
			`**\${cell("n")} points**, the highest \${cell("stats").max}, the lowest \${cell("stats").min}, the mean \${cell("stats").mean}.`,
	},
	{ name: "city", kind: "text", value: "Lisbon" },
	{
		name: "weather",
		kind: "code",
		code: `// a fake fetch: two seconds, then made-up temperatures
const city = cell("city")
return await fetch("weather", city)`,
	},
	{ name: "weatherplot", kind: "chart", of: "weather", attrs: { chart: "bars" } },
	{
		name: "stamp",
		kind: "code",
		code: `// nocache
new Date().toLocaleTimeString() + "  (n = " + cell("n") + ")"`,
	},
]

const world = createWorld({ render, processes: [{ name: "notebook" }] })
world.seed(() => {
	ensureNode("/nb/order", SEED.map(({ name, kind }) => ({ name, kind })))
	ensureNode("/nb/note", "")
	for (const { name, attrs, ...spec } of SEED) {
		const at = `/nb/cells/${name}`
		if (hasNode(at)) continue
		const node = ensureNode(at, spec)
		if (attrs) patchAttributes(node, [{ path: [], value: attrs }])
	}
})

export const reload = world.reload
