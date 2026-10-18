// runs one answer in a fresh page and checks it; one job at a time, and the pool kills it when it loops forever

import { TextLineStream } from "jsr:@std/streams@^1/text-line-stream"
import { JSDOM, VirtualConsole } from "jsdom"
import initSqlJs from "sql.js"
import { transform as sucrase } from "sucrase"
import { createContext, type Drawing } from "./canvas.ts"
import { type Check, compare, type DataTask, type Page, taskById, type ViewTask } from "./tasks.ts"
import type { KitName } from "./kits.ts"

export type Job = {
	task: string
	kit: KitName
	code: string
	// a query or transform that runs first; its result is the view's data
	before?: { kit: "js" | "sql"; code: string }
	data: unknown
	// check: run the task's checker; smoke: only what a host could see; eval: just run a query or transform on data
	mode: "check" | "smoke" | "eval"
}
export type Outcome = {
	errors: string[]
	result?: unknown
	checks?: Check[]
	rendered: boolean
	drew: number
	outlet: unknown[]
}

const here = (path: string) => new URL(path, import.meta.url)
const read = (path: string) => Deno.readTextFileSync(here(path))
const lib = {
	preact: read("./node_modules/preact/dist/preact.umd.js"),
	hooks: read("./node_modules/preact/hooks/dist/hooks.umd.js"),
	morphdom: read("./node_modules/morphdom/dist/morphdom-umd.js"),
}
const SQL = await initSqlJs({
	locateFile: () => here("./node_modules/sql.js/dist/sql-wasm.wasm").pathname,
})

const tick = () => new Promise((r) => setTimeout(r, 0))

function page(data: unknown) {
	const errors: string[] = []
	const vc = new VirtualConsole()
	vc.on("jsdomError", (e: Error) => {
		const m = String(e?.message ?? e)
		if (!/Not implemented/.test(m)) errors.push(m.slice(0, 300))
	})
	vc.on(
		"error",
		(...a: unknown[]) => errors.push(a.map(String).join(" ").slice(0, 300)),
	)
	const dom = new JSDOM(
		`<!doctype html><html><head></head><body><div id="app"></div></body></html>`,
		{
			runScripts: "dangerously",
			url: "http://localhost/",
			virtualConsole: vc,
		},
	)
	const window = dom.window as any
	const document = window.document
	const root = document.getElementById("app")
	const outlet: unknown[] = []
	const drawings: Drawing[] = []
	let frames: ((t: number) => void)[] = []
	let time = 0
	window.requestAnimationFrame = (f: (t: number) => void) => frames.push(f)
	window.cancelAnimationFrame = () => {}
	window.HTMLCanvasElement.prototype.getContext = function (
		this: any,
		type: string,
	) {
		if (!/2d/i.test(type)) return null
		if (!this.__ctx) {
			const { ctx, drawing } = createContext(this)
			this.__ctx = ctx
			drawings.push(drawing)
		}
		return this.__ctx
	}
	window.alert = window.confirm = () => true
	window.prompt = () => ""
	window.data = window.JSON.parse(JSON.stringify(data ?? null))
	window.out = (v: unknown) => outlet.push(JSON.parse(JSON.stringify(v ?? null)))
	window.root = root
	const script = (code: string) => {
		const s = document.createElement("script")
		s.textContent = code
		document.body.appendChild(s)
	}
	const settle = async () => {
		for (let i = 0; i < 3; i++) {
			await tick()
			const now = frames
			frames = []
			time += 16
			for (const f of now) {
				try {
					f(time)
				} catch (e) {
					errors.push(String((e as Error)?.message ?? e))
				}
			}
		}
		await tick()
	}
	const p: Page = {
		window,
		root,
		outlet,
		drawings,
		errors,
		async click(el) {
			el.click()
			await settle()
		},
		async type(el, text) {
			el.focus?.()
			el.value = text
			for (const kind of ["input", "keyup", "change"]) {
				const E = kind == "keyup" ? window.KeyboardEvent : window.Event
				el.dispatchEvent(new E(kind, { bubbles: true, key: text.at(-1) }))
			}
			await settle()
		},
		settle,
	}
	return { dom, window, document, root, script, page: p, errors }
}

// the kits that re-render from a view function: the page's own morphdom, keeping what was typed into inputs
const morph = `
window.__render = function (html) {
	const next = document.createElement("div")
	next.id = "app"
	next.innerHTML = html
	morphdom(root, next, {
		onBeforeElUpdated(from, to) {
			if ((from.tagName == "INPUT" || from.tagName == "TEXTAREA") && !to.hasAttribute("value")) to.value = from.value
			return true
		},
	})
}`

const jsxCode = (code: string) => {
	const stripped = code
		.replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, "")
		.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, "")
		.replace(/export\s+default\s+(?=function|class|\()/g, "")
		.replace(/^\s*export\s+default\s+\w+;?\s*$/gm, "")
		.replace(/export\s+(?=const|let|function|class)/g, "")
	return sucrase(stripped, {
		transforms: ["jsx", "typescript"],
		jsxPragma: "h",
		jsxFragmentPragma: "Fragment",
		production: true,
	}).code
}

function runSql(
	code: string,
	tables: Record<string, Record<string, unknown>[]>,
) {
	const db = new SQL.Database()
	try {
		for (const [name, rows] of Object.entries(tables)) {
			const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
			const type = (c: string) => {
				const vs = rows.map((r) => r[c])
				if (
					vs.every((v) => typeof v == "number" && Number.isInteger(v)) ||
					vs.every((v) => typeof v == "boolean")
				) return "INTEGER"
				return vs.every((v) => typeof v == "number") ? "REAL" : "TEXT"
			}
			db.run(
				`CREATE TABLE ${name} (${cols.map((c) => `${c} ${type(c)}`).join(", ")})`,
			)
			for (const r of rows) {
				db.run(
					`INSERT INTO ${name} VALUES (${cols.map(() => "?").join(", ")})`,
					cols.map((
						c,
					) => (typeof r[c] == "boolean" ? (r[c] ? 1 : 0) : r[c] ?? null)) as any,
				)
			}
		}
		const results = db.exec(code)
		const last = results.at(-1)
		if (!last) return []
		return last.values.map((v: unknown[]) => Object.fromEntries(last.columns.map((c: string, i: number) => [c, v[i]])))
	} finally {
		db.close()
	}
}

async function runJs(code: string, tables: unknown) {
	const { window, script, errors, dom } = page(tables)
	try {
		script(code)
		window.__result = undefined
		script(
			`window.__result = typeof transform == "function" ? transform(window.data) : undefined`,
		)
		let r = await window.__result
		if (r instanceof window.Map) r = Object.fromEntries(r)
		if (r instanceof window.Set) r = [...r]
		const result = r === undefined ? undefined : JSON.parse(window.JSON.stringify(r) ?? "null")
		if (!errors.length && r === undefined) {
			errors.push("transform is not defined or returned undefined")
		}
		return { result, errors }
	} finally {
		dom.window.close()
	}
}

async function mount(kit: KitName, code: string, data: unknown) {
	const it = page(data)
	const { window, document, root, script, errors } = it
	if (kit == "canvas") {
		root.innerHTML = `<canvas id="canvas" width="400" height="300"></canvas>`
		window.canvas = root.firstChild
		window.ctx = window.canvas.getContext("2d")
	}
	if (kit == "reactive" || kit == "ermine") script(lib.morphdom + morph)
	if (kit == "jsx") {
		script(lib.preact)
		script(lib.hooks)
		// window properties, not declarations, so an answer can still declare its own useState
		script(`Object.assign(window, preactHooks, {
			h: preact.h, Fragment: preact.Fragment,
			React: { ...preact, ...preactHooks, createElement: preact.h },
			ReactDOM: { render: preact.render, createRoot: (el) => ({ render: (v) => preact.render(v, el) }) },
		})`)
		try {
			code = jsxCode(code)
		} catch (e) {
			errors.push("JSX: " + String((e as Error).message).slice(0, 200))
			return it
		}
	}
	if (kit == "html") {
		root.innerHTML = code
		for (const old of [...root.querySelectorAll("script")]) {
			const s = document.createElement("script")
			s.textContent = old.textContent
			old.replaceWith(s)
		}
	} else script(code)
	if (kit == "jsx") {
		script(
			`if (!root.hasChildNodes() && typeof App == "function") preact.render(h(App, { data, out }), root)`,
		)
		if (!root.hasChildNodes()) errors.push("App is not defined")
	}
	if (kit == "reactive") {
		script(`{
			if (typeof view != "function") throw new Error("view is not defined")
			let queued = false
			const again = () => {
				if (queued) return
				queued = true
				queueMicrotask(() => { queued = false; __render(String(view())) })
			}
			for (const kind of ["click", "input", "change", "submit", "keyup", "keydown"]) root.addEventListener(kind, again)
			__render(String(view()))
		}`)
	}
	if (kit == "ermine") {
		script(`{
			if (typeof program != "function") throw new Error("program is not defined")
			const nodes = new Map(), methods = {}
			let view, queued = false
			const again = () => {
				if (queued) return
				queued = true
				queueMicrotask(() => { queued = false; if (view) __render(String(view())) })
			}
			const node = (n) => typeof n == "string" ? api.open(n) : n
			const api = {
				data, out,
				open(name, initial) {
					if (!nodes.has(name)) nodes.set(name, { name, value: initial })
					return nodes.get(name)
				},
				read: (n) => node(n)?.value,
				edit(n, f) {
					const it = node(n)
					if (typeof f == "function") {
						const v = f(it.value)
						if (v !== undefined) it.value = v
					} else it.value = f
					again()
				},
				method(name, f) { methods[name] = f },
				send(name, ...args) {
					if (!methods[name]) throw new Error("no method " + name)
					return methods[name](...args)
				},
			}
			window.send = api.send
			const made = program(api)
			view = typeof made == "function" ? made : () => made ?? ""
			__render(String(view()))
		}`)
	}
	document.dispatchEvent(new window.Event("DOMContentLoaded"))
	window.dispatchEvent(new window.Event("load"))
	await it.page.settle()
	return it
}

async function run(job: Job): Promise<Outcome> {
	const view = { rendered: false, drew: 0, outlet: [] as unknown[] }
	if (job.mode == "eval") {
		if (job.kit == "sql") {
			try {
				const result = runSql(job.code, job.data as any)
				return {
					errors: result.length ? [] : ["the query returned no rows"],
					result,
					...view,
				}
			} catch (e) {
				return { errors: ["SQL: " + String((e as Error).message)], ...view }
			}
		}
		return { ...(await runJs(job.code, job.data)), ...view }
	}
	const task = taskById(job.task)
	if (task.kind == "data") {
		const t = task as DataTask
		let result: unknown, errors: string[] = []
		if (job.kit == "sql") {
			try {
				result = runSql(job.code, job.data as any)
			} catch (e) {
				errors.push("SQL: " + String((e as Error).message))
			}
		} else ({ result, errors } = await runJs(job.code, job.data))
		const ok = errors.length == 0 &&
			compare(t.shape, result, t.answer(job.data as any), job.kit == "sql")
		return {
			errors,
			result,
			checks: [{ name: "answer", ok, required: true }],
			...view,
		}
	}
	let data = job.data
	if (job.before) {
		if (job.before.kit == "sql") {
			try {
				data = runSql(job.before.code, job.data as any)
			} catch (e) {
				return { errors: ["SQL: " + String((e as Error).message)], ...view }
			}
		} else {
			const r = await runJs(job.before.code, job.data)
			if (r.errors.length) return { errors: r.errors, ...view }
			data = r.result
		}
	}
	const it = await mount(job.kit, job.code, data)
	try {
		const rendered = it.root.children.length > 0 ||
			it.root.textContent.trim().length > 0
		const drew = it.page.drawings.reduce(
			(n, d) => n + d.shapes.length + d.texts.length,
			0,
		)
		let checks: Check[] | undefined
		if (job.mode == "check") {
			checks = await (task as ViewTask).check(it.page, job.data)
		} else {
			// what a host could see without knowing the task: errors, an empty page, and what clicking around does
			const clickable = [
				...it.document.querySelectorAll("button, [onclick], li"),
			].slice(0, 6)
			for (const b of clickable) await it.page.click(b)
		}
		return {
			errors: it.errors,
			checks,
			rendered,
			drew,
			outlet: it.page.outlet,
		}
	} finally {
		it.dom.window.close()
	}
}

// a process of its own, so a page that never stops can be killed for real (a Worker's terminate leaves some running):
// one job per line on stdin, one outcome per line on stdout
// a page's promise that fails after its job is over must not take the process (and the next job) down with it
let current: string[] | undefined
globalThis.addEventListener("unhandledrejection", (e) => {
	e.preventDefault()
	current?.push(String((e.reason as Error)?.message ?? e.reason).slice(0, 300))
})
globalThis.addEventListener("error", (e) => {
	e.preventDefault()
	current?.push(String(e.message).slice(0, 300))
})
const encoder = new TextEncoder()
const say = async (v: unknown) => {
	const bytes = encoder.encode(JSON.stringify(v) + "\n")
	for (let n = 0; n < bytes.length;) n += await Deno.stdout.write(bytes.subarray(n))
}
await say("ready")
for await (const line of Deno.stdin.readable.pipeThrough(new TextDecoderStream()).pipeThrough(new TextLineStream())) {
	if (!line) continue
	let outcome: Outcome
	try {
		current = []
		outcome = await run(JSON.parse(line))
		outcome.errors.push(...current)
	} catch (err) {
		outcome = {
			errors: ["harness: " + String((err as Error)?.message ?? err)],
			rendered: false,
			drew: 0,
			outlet: [],
		}
	}
	current = undefined
	await say(outcome)
}
