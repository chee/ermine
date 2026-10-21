/// <reference lib="dom" />
// the page: code on the left (host.ts and program.ts), the world's iframe on the right, its
// console and graph below. host.ts runs once per restart (a fresh iframe); an edit of program.ts
// is a reload: the module is imported again (a new blob url) and the host decides what that means.
// the files are typescript with the types stripped, modules whose import map resolves @ermine/*
// (vite.config.ts: the sources while serving, the build's own modules when built)
import { basicSetup } from "codemirror"
import { EditorView, keymap } from "@codemirror/view"
import { javascript } from "@codemirror/lang-javascript"
import { syntaxHighlighting } from "@codemirror/language"
import { indentWithTab } from "@codemirror/commands"
import { Prec } from "@codemirror/state"
import { lycheeHighlightStyle, lycheeTheme } from "./lychee.ts"
import { transform } from "sucrase"
import { h, render } from "./values.ts"
import { createInspector } from "./inspector.ts"
import { createLook } from "./inspect.ts"
import { createExplain } from "./explain.ts"
import { createMenu } from "./menu.ts"
import { save } from "./graph-file.ts"
import { devtools } from "../../../devtools/answer.ts"
import { languageServerExtensions, LSPClient, type Transport } from "@codemirror/lsp-client"

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const frame = $("frame")
const lines = $("lines")
const state = $("state")

// ---- the editor: chee's own lychee theme (copied from slaygrounds) ----
// the map from vite.config.ts: ermine's modules, and the playground's own view library (ermine-h)
// under plain names
// one base, worked out at load: the folder this page is in (/ locally, /slaygrounds/ on the site),
// so nothing here names an absolute path. the iframe's import map needs absolute urls
const base = new URL("./", location.href).href
const at = (path: string) => new URL(path, base).href
;(globalThis as unknown as Record<string, unknown>).__base = base
const built: Record<string, string> =
	JSON.parse(await (await fetch(at("importmap.json"))).text()).imports
const importmap = JSON.stringify({
	imports: Object.fromEntries(Object.entries(built).map(([k, v]) => [k, at(v)])),
})
// ---- type hints: tsgo in a worker, the modules' sources under their specifiers ----
const worker = new Worker(new URL("./typescript.ts", import.meta.url), { type: "module" })
const handlers = new Set<(message: string) => void>()
const types = $("types")
const started = performance.now()
types.textContent = "types: starting…"
worker.onmessage = (e) => {
	if (typeof e.data?.lsp === "string") {
		// the first answer is the server up: its 49MB wasm is compiled
		if (types.dataset.state !== "ready") {
			types.dataset.state = "ready"
			types.textContent = `types: ready (${((performance.now() - started) / 1000).toFixed(1)}s)`
		}
		handlers.forEach((h) => h(e.data.lsp))
	} else if (e.data?.failed) {
		const off = String(e.data.failed).includes("off: no tsgo.wasm")
		types.dataset.state = "failed"
		types.textContent = off ? "types: off on this host" : "types: failed"
		types.title = e.data.failed
		if (!off) line("error", "type hints failed to start: " + e.data.failed)
	}
}
worker.onerror = (e) => {
	types.dataset.state = "failed"
	types.textContent = "types: failed"
	line("error", "type hints worker: " + e.message)
}
const transport: Transport = {
	send: (lsp) => worker.postMessage({ lsp }),
	subscribe: (h) => handlers.add(h),
	unsubscribe: (h) => handlers.delete(h),
}
const client = new LSPClient({
	rootUri: "file:///",
	// the first answers wait on a 49MB wasm compiling
	timeout: 30_000,
	extensions: languageServerExtensions(),
}).connect(transport)
{
	const { files, paths } = await (await fetch(at("types.json"))).json()
	worker.postMessage({ types: files, paths })
}

// ---- the two files, each its own editor, both known to the language server ----
const files = ["host.ts", "program.ts"] as const
type File = typeof files[number]
// each module's url, its file: a site in it (a memo's line) opens that file
const ran = new Map<string, File>()
const views = {} as Record<File, EditorView>
for (const name of files) {
	views[name] = new EditorView({
		doc: "",
		parent: $("code"),
		extensions: [
			basicSetup,
			// the program is tsx to the language server: jsx parses only there
			name === "program.ts"
				? client.plugin("file:///program.tsx", "typescriptreact")
				: client.plugin(`file:///${name}`, "typescript"),
			javascript({ typescript: true }),
			lycheeTheme,
			syntaxHighlighting(lycheeHighlightStyle),
			keymap.of([indentWithTab]),
			Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => (restart(), true) }])),
			EditorView.updateListener.of((u) => u.docChanged && !loading && edited(name)),
		],
	})
}
let loading = false
function show(name: File) {
	for (const f of files) views[f].dom.hidden = f !== name
	for (const b of document.querySelectorAll<HTMLButtonElement>("#files button")) {
		b.setAttribute("aria-selected", String(b.dataset.file === name))
	}
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#files button")) {
	b.onclick = () => show(b.dataset.file as File)
}
show("program.ts")

// ---- the examples: examples/<name>/{host,program}.ts ----
const examples: { name: string; title: string }[] = await (await fetch(at("examples/index.json")))
	.json()
const menu = createMenu($("example"), examples, (name) => openExample(name))
async function openExample(name: string) {
	loading = true
	for (const f of files) {
		const text = await (await fetch(at(`examples/${name}/${f}`))).text()
		views[f].dispatch({ changes: { from: 0, to: views[f].state.doc.length, insert: text } })
	}
	loading = false
	window.history.replaceState(null, "", "#" + name)
	restart()
}

// ---- a run: a new iframe, so a new scheduler, store and document ----
let id = 0
let timer: number | undefined
// goes first in the frame: console, errors and rejections go to the page's console with their
// real values (the frame is the page's own origin, so a call reaches across)
const bridge = (run: number) => `
const send = (level, args) => parent.__console(${run}, level, args)
for (const level of ["log", "info", "warn", "error", "debug"]) {
	const was = console[level].bind(console)
	console[level] = (...args) => (was(...args), send(level, args))
}
addEventListener("error", (e) => send("error", ["Uncaught", e.error ?? e.message]))
addEventListener("unhandledrejection", (e) => send("error", ["Unhandled rejection", e.reason]))
// the host says "here is my world" by assigning globalThis.ermine: the page is told, not polling
let world
Object.defineProperty(globalThis, "ermine", {
	configurable: true,
	get: () => world,
	set(v) { world = v; parent.__world(${run}, v) },
})
`

// the program's module: types stripped, a blob url of its own each time. a file saying
// @jsxImportSource has its jsx made calls to that runtime (sucrase reads no pragma: it is read
// here); the dev runtime, so each element knows its line
function moduleUrl(name: File) {
	const text = views[name].state.doc.toString()
	const jsx = /@jsxImportSource\s+(\S+)/.exec(text)?.[1]
	const code = transform(
		text,
		jsx
			? {
				transforms: ["typescript", "jsx"],
				jsxRuntime: "automatic",
				jsxImportSource: jsx,
				production: false,
				filePath: name,
			}
			: { transforms: ["typescript"] },
	).code
	const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
	ran.set(url, name)
	return url
}

// restart: a fresh iframe, host.ts run once in it, then the program loaded
function restart() {
	clearTimeout(timer)
	const mine = ++id
	frame.replaceChildren()
	inspector.setWorld(undefined)
	answer(undefined)
	look.attach()
	explain.attach(undefined, undefined)
	state.textContent = ""
	note(`restart ${mine}`)
	let hostUrl: string, programUrl: string
	try {
		hostUrl = moduleUrl("host.ts")
		programUrl = moduleUrl("program.ts")
	} catch (e) {
		line("error", "transform: " + (e as Error).message)
		return
	}
	const iframe = document.createElement("iframe")
	iframe.allow = "camera" // live-camera: the world asks for getUserMedia
	iframe.srcdoc = `<!doctype html><meta charset="utf-8">
<style>body { font: 14px Jost, system-ui, sans-serif; margin: 14px; color: #000; background: #fff }
button { font: inherit; padding: 2px 12px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	box-shadow: 1px 1px 0 #000; cursor: pointer; transition: transform 100ms, box-shadow 100ms }
button:hover { transform: translateY(-1px); box-shadow: 2px 2px 0 #000 }
button:active { transform: none; box-shadow: none }
input { font: inherit; border: 1px solid #000; border-radius: 2px; padding: 2px 6px }
li { margin: 3px 0 }</style>
<script type="importmap">${importmap}</script>
<script>${bridge(mine)}</script>
<script type="module">
const host = await import(${JSON.stringify(hostUrl)})
globalThis.__host = host
// the frame imports, so its import map resolves @ermine/*
globalThis.__import = (url) => import(url)
host.reload(await import(${JSON.stringify(programUrl)}))
</script>`
	frame.append(iframe)
}

// a reload: the program imported again into the world that is running; the host decides
async function reload() {
	clearTimeout(timer)
	const w = win() as
		| (Window & {
			__host?: { reload: (m: unknown) => void }
			__import?: (url: string) => Promise<unknown>
		})
		| null
	if (!w?.__host) return restart()
	try {
		const next = await w.__import!(moduleUrl("program.ts"))
		w.__host.reload(next)
		state.textContent = "reloaded"
		note("reload")
	} catch (e) {
		entry("error", ["reload", e])
	}
} // a bound text in the frame asks for its node to be picked in the graph

;(globalThis as unknown as Record<string, unknown>).__pick = (address: string[]) => {
	document.querySelector<HTMLButtonElement>("#tabs [data-tab=graph]")!.click() // a bound text picks in the graph tab
	inspector.pickAddress(address)
}
;(globalThis as unknown as Record<string, unknown>).__world = (run: number, w: unknown) => {
	if (run !== id) return
	inspector.setWorld(w)
	answer(w)
	look.attach()
	explain.attach(w, win()?.document)
}
const win = () =>
	frame.querySelector("iframe")?.contentWindow as (Window & typeof globalThis) | null
// the devtools extension: the running world answers when it asks (playground/devtools), read and
// written through its host's process api (world.api); a restart takes it out, the next world in
let hide: (() => void) | undefined
function answer(w: unknown) {
	hide?.()
	const api = (w as { api?: { entries?: unknown } } | undefined)?.api
	hide = typeof api?.entries === "function" ? devtools(w, { name: "slaygrounds" }) : undefined
}
;(globalThis as unknown as Record<string, unknown>).__console = (
	run: number,
	level: string,
	args: unknown[],
) => {
	if (run === id) entry(level, args)
}

// ---- the console: real values, expandable; levels; clear; input run in the frame ----
// a new line keeps the console at its end only when it was at its end: scrolled up to read, it
// stays where it is, and back at the end it follows again. a scroll up is the reader's (new lines
// and the follow only ever scroll down). one scroll a frame however many lines come
let follow = true
let scrolling = 0
let top = 0
lines.addEventListener("scroll", () => {
	if (lines.scrollTop < top) follow = false
	else if (lines.scrollHeight - lines.scrollTop - lines.clientHeight < 48) follow = true
	top = lines.scrollTop
}, { passive: true })
lines.addEventListener("wheel", (e) => e.deltaY < 0 && (follow = false), { passive: true })
function entry(level: string, args: unknown[]) {
	const li = lines.appendChild(h("li", level))
	args.forEach((a, n) => {
		if (n) li.append(" ")
		li.append(render(a, undefined, true))
	})
	if (!follow || scrolling) return
	scrolling = requestAnimationFrame(() => {
		scrolling = 0
		if (follow) lines.scrollTop = lines.scrollHeight
	})
}
const line = (level: string, text: string) => entry(level, [text])
const note = (text: string) => line("note", text)
$("clear").onclick = () => (lines.replaceChildren(), follow = true, top = 0)

const history: string[] = []
let back = 0
const input = $<HTMLInputElement>("expr")
input.onkeydown = (e) => {
	if (e.key === "ArrowUp" || e.key === "ArrowDown") {
		back = Math.max(0, Math.min(history.length, back + (e.key === "ArrowUp" ? 1 : -1)))
		input.value = history[history.length - back] ?? ""
		e.preventDefault()
	}
	if (e.key !== "Enter" || !input.value.trim()) return
	const code = input.value
	history.push(code)
	back = 0
	input.value = ""
	const echo = lines.appendChild(h("li", "echo", "› " + code))
	echo.scrollIntoView()
	const w = win()
	if (!w) return line("error", "nothing is running")
	try {
		// indirect eval: the frame's global scope (globalThis.ermine is there)
		entry("result", [w.eval(code)])
	} catch (err) {
		entry("error", [err])
	}
}

// ---- tabs: the console, and the inspector in three modes: graph, map, files ----
const inspector = createInspector(
	$("tab-graph"),
	() => win() ?? undefined,
	(level, args) => entry(level, args),
	{
		// a node picked anywhere: what is bound to it in the render is ringed
		picked: (path, value, id) => look.mark(path, value, id),
		goto: (where) => goto(where),
		fileOf: (url) => ran.get(url),
	},
)
// the graph tab, unless the map or the files are showing already
const toGraph = () => {
	const on = document.querySelector<HTMLButtonElement>("#tabs [aria-selected=true]")
	if (on?.dataset.tab === "console") {
		document.querySelector<HTMLButtonElement>("#tabs [data-tab=graph]")!.click()
	}
}

// ---- inspect element: the crosshair picks something in the render; the inspector shows what it
// says it does and jumps to the node it is bound to ----
const pickButton = $<HTMLButtonElement>("pick")
const look = createLook({
	iframe: () => frame.querySelector("iframe") ?? undefined,
	picking: (on) => pickButton.setAttribute("aria-pressed", String(on)),
	picked: (said) => {
		toGraph()
		inspector.showElement(said)
	},
})
pickButton.onclick = () => look.pick()

// ---- explain: badges on what is bound, a flash when its node changes, what just happened ----
const explainButton = $<HTMLButtonElement>("explain")
const explain = createExplain({
	line: $("happened"),
	go: (path) => {
		toGraph()
		inspector.pickAddress(path.split("/").filter(Boolean))
	},
})
function explaining(on: boolean) {
	explainButton.setAttribute("aria-pressed", String(on))
	look.explain(on)
	explain.show(on)
	try {
		localStorage.setItem("slay-explain", on ? "1" : "")
	} catch { /* no storage: it is not remembered */ }
}
explainButton.onclick = () => explaining(explainButton.getAttribute("aria-pressed") !== "true")
try {
	explaining(localStorage.getItem("slay-explain") === "1")
} catch {
	explaining(false)
}

// a line of a file shown in its editor: "program.ts:12"
function goto(where: string) {
	const [file, n] = where.split(":")
	if (!(files as readonly string[]).includes(file)) return
	show(file as File)
	const view = views[file as File]
	const line = view.state.doc.line(Math.max(1, Math.min(Number(n) || 1, view.state.doc.lines)))
	view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true })
	view.focus()
}
for (const tab of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
	tab.onclick = () => {
		const name = tab.dataset.tab!
		for (const t of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
			t.setAttribute("aria-selected", String(t === tab))
		}
		$("tab-console").hidden = name !== "console"
		$("tab-graph").hidden = name === "console"
		$("clear").hidden = name !== "console"
		// a hidden inspector draws nothing: its views go quiet until it is shown again
		inspector.setVisible(name !== "console")
		if (name !== "console") inspector.setMode(name as "graph" | "map" | "files")
	}
}

// ---- when to run: a program.ts edit reloads, a host.ts edit restarts ----
function edited(name: File) {
	state.textContent = "edited"
	clearTimeout(timer)
	if (!$<HTMLInputElement>("auto").checked) return
	timer = setTimeout(name === "program.ts" ? reload : restart, name === "program.ts" ? 400 : 900)
}
$("run").onclick = restart

// ---- save graph: the running world's graph, packed (graph-file.ts), downloaded as
// <example>.ermine; what could not be carried is said in the console ----
$("save").onclick = () => {
	const w = win() as (Window & { ermine?: { table: Parameters<typeof save>[0] } }) | null
	if (!w?.ermine) return line("error", "save graph: nothing is running")
	const name = `${location.hash.slice(1) || "graph"}.ermine`
	try {
		const saved = save(w.ermine.table)
		const a = document.createElement("a")
		a.href = URL.createObjectURL(new Blob([saved.bytes], { type: "application/cbor" }))
		a.download = name
		a.click()
		setTimeout(() => URL.revokeObjectURL(a.href), 1000)
		const stands = saved.stands.map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
		note(
			`saved ${name}: ${saved.bytes.length} bytes, ${saved.ids} ids, ${saved.nodes} nodes` +
				(stands.length ? `; stand-ins: ${stands.slice(0, 8).join(", ")}` : "") +
				(stands.length > 8 ? `, and ${stands.length - 8} more kinds` : "") +
				(saved.symbols ? `; ${saved.symbols} names with a symbol id left out` : ""),
		)
	} catch (e) {
		entry("error", ["save graph", e])
	}
}
// a file dropped on the page outside a drop zone is never opened in its place (lab-load asks for
// one: a near miss would lose the edits)
addEventListener("dragover", (e) => {
	if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
})
addEventListener("drop", (e) => {
	if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
})

addEventListener("keydown", (e) => {
	// the editor restarts itself (and says so by preventing default)
	if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
		;(e.preventDefault(), restart())
	}
})

// ---- the grabbers: drag sets a css variable, so nothing else moves ----
function grab(button: HTMLElement, axis: "x" | "y", variable: string, of: () => HTMLElement) {
	button.onpointerdown = (down) => {
		button.setPointerCapture(down.pointerId)
		button.classList.add("dragging")
		document.body.classList.add("dragging")
		const box = of().getBoundingClientRect()
		const move = (e: PointerEvent) => {
			const at = axis === "x"
				? (e.clientX - box.left) / box.width
				: (e.clientY - box.top) / box.height
			document.querySelector("main")!.style.setProperty(
				variable,
				`${Math.min(85, Math.max(15, at * 100))}%`,
			)
		}
		const up = () => {
			button.classList.remove("dragging")
			document.body.classList.remove("dragging")
			button.removeEventListener("pointermove", move)
			button.removeEventListener("pointerup", up)
		}
		button.addEventListener("pointermove", move)
		button.addEventListener("pointerup", up)
	}
}
grab($("across"), "x", "--across", () => document.querySelector("main")!)
grab($("down"), "y", "--down", () => $("right"))

menu.setCurrent(location.hash.slice(1) || "counter")
openExample(location.hash.slice(1) || "counter")
