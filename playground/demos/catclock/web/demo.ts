/// <reference lib="dom" />
// demo.ts: the catclock demo, on ermine's programs. The cat's C, the types, the loaders and the
// cache are nodes in a graph (world.ts); a map draws them (map.ts), an editor opens them
// (editor.ts). He runs in a box made from /catclock, the loaders and the types boxed in. satisfy
// finds what runs catclock.c there: a compiler, then canvas, the page's runner (a live function
// running the wasm on the canvas, with canvas.js's code). The compilers are live functions too:
// wasm-clang (clang as wasm, in the page's worker: clang.worker.ts), and with serve.ts, clang
// (asking serve.ts' clang); the map's switch says which chain is started. start starts him on it,
// at /clock in the box, its compile through build.ts' cache: each C file's object a step, then
// the objects linked (the compiler's output, the wasm); each a hit, or a miss the compiler builds.
// A save stops him and starts him again. What changed is drawn travelling to him as it happens
// (flow.ts).
import { createWorld } from "./world.ts"
import { type Build, CACHE, createMap, LOADERS, type MapState, SRC } from "./map.ts"
import { createEditor } from "./editor.ts"
import { createFiles } from "./files.ts"
import { createFlow } from "./flow.ts"
import { digest, keyOf, short, unit } from "./program.ts"
import { type Answer, type Ask, included, objectOf, WASM_CLANG, wire } from "./clang.ts"
import { installTypes, type Known } from "@ermine/types"
import { ATTRIBUTES as A, satisfy } from "@ermine/programs"
import { COMPILER, type Compiler, createBuilds } from "@ermine/compilers"
import { createPrograms, type Process, type Runner } from "@ermine/programs/start"
import { box, createBox } from "@ermine/boxes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { PENDING } from "@ermine/scheduler"
import { answer } from "../../devtools.ts"

const $ = <T extends Element = HTMLElement>(q: string) => document.querySelector(q) as T
const C = "public.c-source", H = "public.c-header", WASM = "public.wasm-executable"
// what satisfy looks up, from where in his box; where he runs in it
const PROGRAM = "catclock.c", FROM = ["src"], AT = ["clock"]
const TYPES = ["ermine", "types"]
type Id = string | symbol
type Problem = { file: string; line: number; col: number; message: string }

// ---- the seed: the C, the runner's code, and the compiler a server has: serve.ts' clang, or
// Netlify's wasm-clang (functions/compile.mts), its name and what it is (none: no server) ----
type Served = { compiler: string; identity: unknown }
const [sources, runnerCode, served] = await Promise.all([
	fetch("sources.json").then((r) => r.json() as Promise<{ name: string; text: string }[]>),
	fetch("canvas.js").then((r) => r.text()),
	fetch("compile").then((r) => (r.ok ? r.json() as Promise<Served> : undefined)).catch(() =>
		undefined
	),
])
const world = createWorld()
const at = (path: string[]) => world.peek(() => world.id(path))!

// the types this graph's nodes are, and what each conforms to, as the well-known list says them
// (all 151 would fill the files window). public.c-header is Apple's: the list lacks it
const KINDS: Known[] = [
	{ name: "public.item" },
	{ name: "public.content" },
	{ name: "public.data", conformsTo: "public.item" },
	{ name: "public.text", conformsTo: ["public.data", "public.content"] },
	{ name: "public.plain-text", conformsTo: "public.text", fileNameExtension: [".txt", ".text"] },
	{ name: "public.source-code", conformsTo: "public.plain-text" },
	{ name: C, conformsTo: "public.source-code", fileNameExtension: ".c" },
	{ name: H, conformsTo: "public.source-code", fileNameExtension: ".h" },
	{ name: "public.executable", conformsTo: "public.item" },
	{ name: WASM, conformsTo: "public.executable", fileNameExtension: ".wasm" },
]
world.writing(() =>
	world.commit(installTypes(world.table, "root", createChangeHeader(world.s), KINDS))
)

// ---- the compilers, live functions. each miss is handed an ask (clang.ts): a C file's unit
// (program.ts) compiled, or objects linked. a miss the start now doesn't want is cancelled when
// another is asked. their errors thrown, word for word: never cached ----
// the keys the start now wants: its objects', then its link's
let wanted = new Set<string>()
const cancelled = () => new Error("cancelled: a newer build asked")
// an object: its bytes and what clang said (a step's output, kept in the cache); a link: the wasm
type Made = { object: Uint8Array; warnings?: string }
const answered = (ask: Ask, out: Answer): Made | Uint8Array => {
	if (!out.ok || !out.bytes) throw new Error(out.error ?? "the compiler said nothing")
	if ("ld" in ask) return out.bytes
	const warnings = out.warnings?.trim()
	return warnings ? { object: out.bytes, warnings } : { object: out.bytes }
}

// the server's: asks it, as many at once as are wanted; one no longer wanted stopped (serve.ts
// stops its clang then; Netlify's builds on, its answer dropped)
const asking = new Map<string, AbortController>()
const clang: Compiler = async (input, ctx) => {
	for (const [key, ask] of asking) if (!wanted.has(key)) (ask.abort(), asking.delete(key))
	const ask = new AbortController()
	asking.set(ctx.key, ask)
	const r = await fetch("compile", {
		method: "POST",
		body: await wire.ask(input as Ask),
		signal: ask.signal,
	}).catch(() => undefined)
	if (asking.get(ctx.key) === ask) asking.delete(ctx.key)
	if (ask.signal.aborted) throw cancelled()
	if (!r || !(r.headers.get("content-type") ?? "").includes("json")) {
		throw new Error(`${served?.compiler}'s server isn't answering`)
	}
	return answered(input as Ask, await wire.answered(await r.json()))
}

// wasm-clang: the worker, made the first time it's asked; it fetches clang then (wasm.fetched
// says how far). one build at a time, the rest waiting in turn: asked again, the ones no longer
// wanted are cancelled (the one building builds on, its answer dropped)
const wasm: { worker?: Worker; fetched?: number; total?: number } = {}
type Asked = {
	id: number
	key: string
	ask: Ask
	done: (a: Answer) => void
	fail: (e: Error) => void
}
let building: Asked | undefined, asks = 0
const waiting: Asked[] = []
function next() {
	if (building || !waiting.length) return
	building = waiting.shift()!
	if (!wasm.worker) {
		wasm.worker = new Worker(new URL("./clang.worker.ts", import.meta.url), { type: "module" })
		wasm.worker.onmessage = (e: MessageEvent) => {
			const m = e.data as { id?: number; fetched?: number; total?: number } & Answer
			if (m.id === undefined) {
				wasm.fetched = m.fetched
				wasm.total = m.total
				return void showProblems()
			}
			const was = building
			building = undefined
			if (was?.id === m.id) was.done(m)
			next()
		}
		wasm.worker.onerror = (e) => {
			const was = building
			building = undefined
			wasm.worker = undefined
			was?.fail(new Error(`wasm-clang's worker: ${e.message || "it stopped"}`))
			next()
		}
	}
	wasm.worker.postMessage({ id: building.id, ask: building.ask })
}
const wasmClang: Compiler = (input, ctx) =>
	new Promise<Answer>((done, fail) => {
		for (const w of waiting.splice(0)) {
			if (wanted.has(w.key)) waiting.push(w)
			else w.fail(cancelled())
		}
		if (building && !wanted.has(building.key)) {
			building.fail(cancelled())
			building.done = building.fail = () => {}
		}
		waiting.push({ id: ++asks, key: ctx.key, ask: input as Ask, done, fail })
		next()
	}).then((out) => answered(input as Ask, out))

// ---- canvas: the page's runner, live (@ermine/software's shape). it runs /loaders/canvas.js's
// code on the cat's canvas with the wasm it's given, and gives back how to stop ----
const canvas = $<HTMLCanvasElement>("#clock")
const canvasRunner: Runner = { start: (code, start) => draw(code, start.process.id) }
async function draw(code: unknown, me: Id) {
	try {
		const text = world.table.get("value", RUNNER)?.value
		if (typeof text !== "string") throw new Error("canvas.js has no code to run")
		const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }))
		const mod = await import(url).finally(() => URL.revokeObjectURL(url))
		const stop = await mod.default({ wasm: code, canvas })
		if (me === state.proc) queueMicrotask(arrived)
		return { stop }
	} catch (e) {
		if (me === state.proc) queueMicrotask(() => trouble(String((e as Error)?.message ?? e)))
		throw e
	}
}

// ---- the graph: the C, typed; the loaders; the cache ----
for (const { name, text } of sources) {
	world.make([...SRC, name], text, { [A.type]: name.endsWith(".h") ? H : C })
}
world.make(LOADERS, undefined, { [A.loaders]: true })
// the compilers: wasm-clang always, and the server's where it said what it is
world.make([...LOADERS, "wasm-clang"], wasmClang, {
	[A.takes]: [C],
	[A.gives]: WASM,
	[COMPILER]: WASM_CLANG,
})
if (served && /^[\w-]+$/.test(served.compiler) && served.compiler !== "wasm-clang") {
	world.make([...LOADERS, served.compiler], clang, {
		[A.takes]: [C],
		[A.gives]: WASM,
		[COMPILER]: served.identity,
	})
}
world.make([...LOADERS, "canvas"], canvasRunner, { [A.takes]: [WASM] })
world.make([...LOADERS, "canvas.js"], runnerCode)
world.make(CACHE)
const COMPILERS = new Map(
	world.peek(() => world.list(LOADERS)).filter((n) =>
		world.peek(() => world.attributes([...LOADERS, n]))?.[COMPILER]
	).map((n) => [at([...LOADERS, n]), n]),
)
const RUNNER = at([...LOADERS, "canvas.js"])
const CACHED = at(CACHE)

// ---- the clock's box: /catclock, a plain folder; the loaders, the types and the cache placed in
// it too ----
const cat = createBox(
	{ places: world.places, table: world.table, scheduler: world.s },
	{ id: at(["catclock"]) },
)
world.writing(() => {
	box(cat, LOADERS, at(LOADERS))
	box(cat, TYPES, at(TYPES))
	// the builds, boxed in to be found: a cached output is typed (its compiler's gives)
	box(cat, CACHE, at(CACHE))
})

// ---- the builds and the processes. start is given the builds through steps: the C's input made
// the program's unit first (the files beside it, as they were when he started: program.ts). Each
// C file there compiled, a step each: its unit main and the files it #includes, so a file it
// doesn't read is not in its key; its output its object and what clang said, kept in /cache. Then
// the objects linked, a step keyed by each object's hash (not its bytes: the same object from
// other C, the same link), its output the wasm (typed as the compiler gives), kept in /cache. Each answer
// noted for the log: a value at once, a hit; PENDING, then a value, a miss; an Error, failed ----
const scopes = createScopeNodes({ scheduler: world.s, table: world.table })
const writes = { readValue: world.places.readValue, commit: world.commit }
const builds = world.peek(() =>
	createBuilds({ scheduler: world.s, table: world.table, places: writes, cache: CACHED })
)
// every start, newest first; the latest, with the files its build reads
const log: Build[] = []
type Start = Build & { main: string; files: Record<string, string>; since: number }
let now: Start | undefined
// a C file's ask: it compiled, with what it #includes
const ccOf = (main: string, files: Record<string, string>): Ask => ({
	cc: { main, files: included(main, files) },
})
// the C files a unit compiles: every .c beside main, as make's *.c
const sourcesOf = (files: Record<string, string>) =>
	Object.keys(files).filter((n) => n.endsWith(".c")).sort()
const isMade = (v: unknown): v is Made =>
	typeof v === "object" && v !== null && (v as Made).object instanceof Uint8Array
// a link's code: the objects by hash, and what it's named
const linkOf = (objects: Record<string, Uint8Array>, out: string) => ({
	ld: {
		objects: Object.fromEntries(Object.entries(objects).map(([n, o]) => [n, digest(o)])),
		out,
	},
})
// the start's compile: its objects, then the link. PENDING while one is out; an Error, the first
function build(b: Start, compiler: Id, input: string): unknown {
	const identity = world.places.readValue("attributes", compiler, [COMPILER]) ?? compiler
	const fn = world.table.get("value", compiler)?.value as Compiler | undefined
	const u = unit(b.main, { ...b.files, [b.main]: input })
	const asks = sourcesOf(u.files).map((c) => ccOf(c, u.files))
	b.objects ??= asks.map((a) => keyOf(identity, a))
	wanted = new Set(b.objects)
	if (b.key) wanted.add(b.key)
	const objects: Record<string, Uint8Array> = {}
	const said: string[] = []
	let out: unknown
	for (const [i, ask] of asks.entries()) {
		const key = b.objects[i]
		const made = builds.step(identity, ask, () => {
			if (typeof fn !== "function") throw new Error("not a compiler")
			return fn(ask, { key, id: compiler, identity })
		})
		if (made instanceof Error) return made
		if (made === PENDING) out = PENDING
		else if (isMade(made)) {
			const name = objectOf((ask as { cc: { main: string } }).cc.main)
			objects[name] = made.object
			if (made.warnings) said.push(made.warnings)
		}
	}
	b.warnings = said.join("\n") || undefined
	if (out === PENDING) return out
	const ld: Ask = { ld: { objects, out: b.main.replace(/\.c$/, ".wasm") } }
	const code = linkOf(objects, ld.ld.out)
	const key = b.key ??= keyOf(identity, code)
	wanted.add(key)
	const gives = world.table.get("attributes", compiler)?.value as Record<string, unknown>
	return builds.step(identity, code, () => {
		if (typeof fn !== "function") throw new Error("not a compiler")
		return fn(ld, { key, id: compiler, identity })
	}, { type: typeof gives?.[A.gives] === "string" ? gives[A.gives] as string : undefined })
}
const steps = {
	compile(compiler: Id, input: unknown) {
		const b = now
		if (!COMPILERS.has(compiler) || typeof input !== "string" || !b) {
			return builds.compile(compiler, input)
		}
		const out = build(b, compiler, input)
		const was = b.state
		if (out === PENDING) b.state = was === "asking" ? "building" : was
		else if (out instanceof Error) (b.state = "failed", b.error = out.message)
		else if (was === "asking") (b.state = "hit", b.ms = performance.now() - b.since)
		else if (was === "building") (b.state = "miss", b.ms = performance.now() - b.since)
		// told out of the run
		if (b.state !== was) queueMicrotask(told)
		return out
	},
}
const programs = world.peek(() =>
	createPrograms({
		scheduler: world.s,
		table: world.table,
		places: world.places,
		builds: steps,
		scopes,
	})
)

// ---- (re)starting the clock: the one running stopped, satisfy asked again, the first chain
// started ----
let proc: Process | undefined
// the clock stopped: its process, and a build still on its way (its answer no longer wanted)
function halt() {
	if (proc) programs.stop(proc)
	if (now && (now.state === "asking" || now.state === "building")) now.state = "cancelled"
	proc =
		state.proc =
		now =
		state.current =
			undefined
}
function restart() {
	world.writing(() => {
		halt()
		const n = (log[0]?.n ?? 0) + 1
		// the first way: the search stops there. none: the search's own whynot says why
		let refused: string | undefined
		// the chain through the compiler picked; not there, the first
		const ways = [
			...satisfy(cat.places, PROGRAM, FROM, {
				onwhynot: (w) => void (!("for" in w) && (refused = w.why)),
			}),
		]
		const way = ways.find((w) => COMPILERS.get(w.chain[0]?.id) === state.compiler) ?? ways[0]
		if (!way) {
			const r: Build = { n, state: "refused", error: refused ?? "nothing" }
			log.unshift(r)
			return void (state.current = r)
		}
		const folder = way.program.at.slice(0, -1)
		const files: Record<string, string> = {}
		for (const name of lib.list(cat.places, folder)) {
			const id = lib.get(cat.places, [...folder, name])
			const v = id === undefined ? undefined : cat.places.readValue("value", id)
			if (typeof v === "string") files[name] = v
		}
		const b: Start = {
			n,
			state: "asking",
			by: COMPILERS.get(way.chain[0]?.id),
			main: way.program.at.at(-1)!,
			files,
			since: performance.now(),
		}
		log.unshift(now = state.current = b)
		const p = programs.start(cat, way, AT)
		if ("refused" in p) return void (b.state = "refused", b.error = p.refused)
		proc = p
		state.proc = p.id
	})
	told()
}

// run an old build: a node in the cache, typed wasm-executable. satisfy on it finds the runner
// (one step, no compile); the one running is stopped and the runner started on it. Nothing is
// logged: the cache's order is when each build was last made or saved to, never when it was
// clicked. The editor is left as it is
function wear(key: string) {
	// already running it, and nothing went wrong: nothing to do
	if (key === state.wearing && now?.key === key && proc && $("#trouble").hidden) return
	let refused: string | undefined
	world.writing(() => {
		halt()
		const [way] = satisfy(cat.places, key, CACHE, {
			onwhynot: (w) => void (!("for" in w) && (refused = w.why)),
		})
		if (!way) return void (refused ??= "nothing")
		const b: Start = {
			n: 0,
			key,
			state: "hit",
			ms: 0,
			main: key,
			files: {},
			since: performance.now(),
		}
		now = state.current = b
		const p = programs.start(cat, way, AT)
		if ("refused" in p) return void (b.state = "refused", refused = b.error = p.refused)
		proc = p
		state.proc = p.id
	})
	told()
	if (refused) trouble(refused, "not started")
}

// clang's lines: file:line:col: error: what
const problems = (text = ""): Problem[] =>
	[...text.matchAll(/^(?:\.\/)?([\w-]+\.[ch]):(\d+):(\d+): (?:fatal )?error: (.*)$/gm)].map((
		m,
	) => ({
		file: m[1],
		line: +m[2],
		col: +m[3],
		message: m[4],
	}))

// how the latest start went, shown: the map, the note under the editor, the editor's footer. a
// build clang just made flashes in the cache, once
let popped: Build | undefined
function told() {
	const b = log[0]
	state.failed = new Set(b?.state === "failed" ? problems(b.error).map((p) => p.file) : [])
	map.redraw()
	showProblems()
	print()
	if (b?.state === "miss" && b.key && b !== popped) map.pop([...CACHE, (popped = b).key!])
}

// the runner has it: the clock runs this build now. not the first: a dot down the line from the
// build into the runner, then out to the clock
let ran = 0
function arrived() {
	state.wearing = now?.key
	trouble(undefined)
	map.redraw()
	print()
	if (ran++) map.travel("cache-runner").then(flow.toCat)
}

// ---- the map, the editor and what they show ----
// the compiler picked: as last picked, if it's here; else the server's (the quicker), or wasm-clang
const names = [...COMPILERS.values()]
let picked: string | undefined
try {
	picked = localStorage.getItem("catclock:compiler") ?? undefined
} catch { /* the default */ }
const state: MapState = {
	compiler: names.find((n) => n === picked) ?? names.find((n) => n !== "wasm-clang") ?? names[0],
	failed: new Set(),
	builds: log,
	box: cat,
	program: PROGRAM,
	from: FROM,
	outside: new Map<Id, string>([
		[at(["catclock"]), "/catclock"],
		[at(LOADERS), "/loaders"],
		[at(TYPES), "/ermine/types"],
		[at(CACHE), "/cache"],
	]),
}
const map = createMap($<SVGSVGElement>("#map svg"), world, state, (path) => {
	// a build in the cache: run, the editor left be; any other row (an object too): opened
	if (
		path.length === CACHE.length + 1 && under(path, CACHE) &&
		world.peek(() => world.read(path)) instanceof Uint8Array
	) return wear(path[CACHE.length])
	open(path)
}, (name) => {
	// another compiler: the clock started again on its chain
	if (name === state.compiler || !names.includes(name)) return
	state.compiler = name
	try {
		localStorage.setItem("catclock:compiler", name)
	} catch { /* this visit only */ }
	restart()
})
const flow = createFlow($<SVGSVGElement>("#flow"), {
	card: () => map.exit("canvas"),
	pane: $("#map"),
	window: $("#desk"),
	cat: $("#stage .window.star"),
})
let opened: string[] | undefined
const win = $("#window"), hint = $("#hint")
const under = (path: string[], folder: string[]) => folder.every((n, i) => path[i] === n)
// a save of these starts him again: his C, and the runner's code
const restarts = (path: string[]) =>
	under(path, SRC) || path.join("/") === [...LOADERS, "canvas.js"].join("/")
// autosave: every keystroke saved as it's made (and so a start: the build before it cancelled)
const autosave = $<HTMLInputElement>("#autosave")
try {
	autosave.checked = localStorage.getItem("catclock:autosave") === "on"
} catch { /* off */ }
autosave.addEventListener("change", () => {
	try {
		localStorage.setItem("catclock:autosave", autosave.checked ? "on" : "off")
	} catch { /* this visit only */ }
	if (autosave.checked) editor.save()
})
const editor = createEditor($("#code"), (text) => {
	if (!opened) return
	const path = opened
	world.edit(path, text)
	// what was saved, into its card (a keystroke's own save: the card just feels it)
	if (autosave.checked) map.press(path)
	else flow.toss($("#save"), map.box(path.at(-1)!)).then(() => map.press(path))
	if (restarts(path)) restart()
}, (dirty) => {
	win.classList.toggle("dirty", dirty)
	// out of the editor's own update, so a save can tell the editor
	if (dirty && autosave.checked) queueMicrotask(() => editor.save())
	queueMicrotask(print)
})

// the editor's C, unsaved, as the picked compiler's build would take it: its key, and whether saving it would
// compile (saved, it's the note's)
function print() {
	const el = $("#program")
	const path = opened
	const dirty = win.classList.contains("dirty")
	if (!path || !under(path, SRC) || !dirty) return void (el.hidden = true)
	const files: Record<string, string> = {}
	for (const n of world.peek(() => world.list(SRC))) {
		files[n] = String(world.peek(() => world.read([...SRC, n])) ?? "")
	}
	files[path.at(-1)!] = editor.text()
	const by = at([...LOADERS, state.compiler!])
	const identity = world.peek(() => world.places.readValue("attributes", by, [COMPILER])) ?? by
	const u = unit(PROGRAM, files)
	// its objects' keys; all kept, the link's: what saving it would ask the cache for
	const cached = (key: string) =>
		world.peek(() => world.places.readValue("children", CACHED, [key])) !== undefined
	const objects: Record<string, Uint8Array> = {}
	let key: string | undefined, kept = true
	for (const c of sourcesOf(u.files)) {
		const k = keyOf(identity, ccOf(c, u.files))
		const made = cached(k) ? world.peek(() => world.read([...CACHE, k])) : undefined
		if (isMade(made)) objects[objectOf(c)] = made.object
		else (key ??= k, kept = false)
	}
	if (kept) key = keyOf(identity, linkOf(objects, PROGRAM.replace(/\.c$/, ".wasm")))
	kept &&= cached(key!)
	el.hidden = false
	el.className = "fp" + (kept ? " same" : "")
	el.innerHTML = `<code>${short(key)}</code> · ${
		key === state.wearing ? "running" : kept ? "cached" : "not cached"
	}`
}

function open(path: string[], reveal = true) {
	opened = path
	const name = path.at(-1)!
	const value = world.peek(() => world.read(path))
	const attrs = world.peek(() => world.attributes(path))
	const isText = typeof value === "string"
	editor.open(name, isText ? value : describe(value, attrs), isText)
	if (reveal) files.reveal(path)
	state.open = path.join("/")
	map.redraw()
	hint.hidden = true
	win.hidden = false
	$("#close").hidden = false
	$("#title").textContent = name
	$("#title").classList.remove("idle")
	const size = value instanceof Uint8Array
		? `${value.length.toLocaleString()} bytes`
		: isText
		? `${value.split("\n").length} lines`
		: typeof value === "function"
		? "a live function"
		: value === undefined
		? "empty"
		: "a record"
	$("#where").textContent = `/${path.join("/")} · ${size}`
	// what it is: its type; a loader, what it takes and gives
	const takes = attrs?.[A.takes] as string[] | undefined
	const said = typeof attrs?.[A.type] === "string"
		? `${A.type}: ${attrs[A.type]}`
		: takes
		? `takes ${takes.join(", ")} → ${attrs?.[A.gives] ?? "runs it"}`
		: ""
	$("#load").hidden = !said
	$("#load").textContent = said
	win.classList.toggle("readonly", !isText)
	showProblems()
	print()
	win.classList.remove("hello")
	void win.offsetWidth
	win.classList.add("hello")
	// below the fold (a narrower window): brought into view
	const r = win.getBoundingClientRect()
	if (r.top > innerHeight - 120) win.scrollIntoView({ behavior: "smooth", block: "start" })
}
$("#close").addEventListener("click", () => {
	opened = undefined
	state.open = undefined
	map.redraw()
	win.hidden = true
	hint.hidden = false
	$("#close").hidden = true
	$("#title").textContent = "nothing open"
	$("#title").classList.add("idle")
})
$("#save").addEventListener("click", () => editor.save())
// the whole graph, as files: a double click opens a node here
const files = createFiles($("#files"), world, open)
$("#start").addEventListener("click", () => open([...SRC, "colours.h"])) // to poke at from the console
;(globalThis as Record<string, unknown>).demo = {
	world,
	editor,
	open,
	cat,
	programs,
	restart,
	wear,
	log,
}

// a node changed while open (a build landing): shown again, unless it's being typed in
world.effect("the editor", () => opened && world.read(opened), (v) => {
	if (!opened) return
	editor.replace(
		typeof v === "string" ? v : describe(v, world.peek(() => world.attributes(opened!))),
	)
})

// what isn't text, said as text: a live function, by what it says of itself; bytes, the first
// few hundred; anything else as JSON
function describe(v: unknown, attrs?: Record<string, unknown>) {
	if (v === undefined) return "(nothing here yet)"
	if (typeof v === "function") {
		return `// a live function the page holds: never saved, so the graph has only what it says\n// of itself, its attributes:\n\n${
			JSON.stringify(attrs ?? {}, null, 2)
		}`
	}
	if (isMade(v)) {
		return `// an object a compiler made from a C file: kept in /cache by its key, linked into a\n// build\n${
			v.warnings ? `\n// what it said:\n${v.warnings.replace(/^/gm, "//   ")}\n` : ""
		}\n${hexdump(v.object)}`
	}
	if (!(v instanceof Uint8Array)) return JSON.stringify(v, null, 2) ?? String(v)
	return `// ${v.length} bytes of WebAssembly: a build a compiler made, kept in /cache by its key\n${
		hexdump(v)
	}`
}
// the first 512 bytes, as hex and as text
function hexdump(v: Uint8Array) {
	const rows = []
	for (let i = 0; i < Math.min(v.length, 512); i += 16) {
		const bytes = [...v.subarray(i, i + 16)]
		rows.push(
			i.toString(16).padStart(6, "0") + "  " + bytes.map((b) =>
				b.toString(16).padStart(2, "0")
			).join(" ").padEnd(48) +
				"  " + bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join(""),
		)
	}
	return `// ${v.length} bytes (the first 512 below)\n\n${rows.join("\n")}\n…`
}

// ---- how the latest start went: the note under the editor ----
function showProblems() {
	const note = $("#note")
	const b = log[0]
	note.className = "note " +
		(!b
			? "quiet"
			: b.state === "hit" || b.state === "miss"
			? "built"
			: b.state === "failed" || b.state === "refused"
			? "failed"
			: "building")
	if (!b) {
		note.innerHTML = ""
		editor.errors([])
		return
	}
	// one line: the key, who, how long, how it went
	const line = (...parts: (string | undefined)[]) =>
		parts.filter(Boolean).map((p) => `<span>${p}</span>`).join(`<i>·</i>`)
	const key = b.key ? `<code>${short(b.key)}</code>` : undefined
	const here = opened?.at(-1)
	editor.errors(b.state === "failed" ? problems(b.error).filter((p) => p.file === here) : [])
	const by = b.by ?? state.compiler ?? "the compiler"
	if (b.state === "asking" || b.state === "building") {
		// wasm-clang, the first time: fetched first
		const fetching = by === "wasm-clang" && wasm.total !== undefined &&
			(wasm.fetched ?? 0) < wasm.total
		note.innerHTML = fetching
			? line(
				key,
				by,
				`<b>fetching clang</b> ${Math.round(((wasm.fetched ?? 0) / wasm.total!) * 100)}% of ${
					Math.round(wasm.total! / 1e6)
				} MB`,
			)
			: line(key, by, "<b>compiling</b>")
	} else if (b.state === "cancelled") {
		note.innerHTML = line(key, by, "<b>cancelled</b>")
	} else if (b.state === "hit" || b.state === "miss") {
		// what clang said, kept with each object: a hit's too
		const notes = b.warnings
		const n = notes?.split("\n").filter((l) => /warning:/.test(l)).length ?? 0
		note.innerHTML = (b.state === "hit"
			? line(key, "<b>cache hit</b>")
			: line(key, by, `${Math.round(b.ms ?? 0)} ms`, "<b>miss</b>")) +
			(notes
				? `<details><summary>${
					n ? `${n} ${n === 1 ? "warning" : "warnings"}` : `${by}'s notes`
				}</summary><pre>${esc(notes)}</pre></details>`
				: "")
	} else if (b.state === "refused") {
		note.innerHTML = line("<b>not started</b>", `<code>${esc(b.error ?? "")}</code>`)
	} else {
		note.innerHTML = line(key, by, "<b>error</b>") + `<pre>${esc(b.error ?? "")}</pre>`
	}
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)

// under the clock: the runner's error, or why a build picked in the cache didn't start
function trouble(text: string | undefined, what = "runner error") {
	const el = $("#trouble")
	el.hidden = !text
	if (text) el.innerHTML = `${what}: <code>${esc(text)}</code>`
}

// colours.h, open in the editor from the start; the files start at the root; and the clock starts
open([...SRC, "colours.h"], false)
restart()

// the devtools extension: this graph, through a process api at its root (playground/devtools)
answer(
	{
		scheduler: world.s,
		table: world.table,
		places: world.places,
		scope: world.host,
		commit: world.commit,
	},
	{ name: "catclock", processes: () => proc ? [proc] : [] },
)
