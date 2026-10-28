/** @jsxImportSource @ermine */
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	executeAction,
	hasNode,
	list as childrenOf,
	patch,
	peep,
	read,
	unplace,
} from "@ermine/system"
import { up } from "@ermine/slaygrounds/tools"
import { bind, handler, under } from "@ermine/render/h"

// fancy-lisp: a small lisp where environments are places. every frame is a folder node: base
// (the builtins) holds global, global holds what you define and the frames of the calls of
// closures made in it. a variable is a node in its frame. looking one up is places' lookup from
// the frame, going up the way the frame was reached from base: lexical scope is the graph's own
// lookup. the walk you see highlighted is the reads lookup told (a read sink), replayed a frame
// per step. a closure is a node that remembers its frame's address; a call places a new frame
// under that frame, not under the caller's. define places a node, set! edits one, so a watch (a
// part reading through the same lookup, tracked) runs again when it changes. tail calls drop the
// caller's frame before the callee's comes. after each evaluation, frames no closure can reach
// are collected. the steps are a timer's: an effect runs a setInterval as long as one step takes (the
// speed's), and each tick calls on/beat through a writer made in setup, which takes the next step(s)

const EXAMPLES: [label: string, src: string][] = [
	[
		"define fib",
		"(define (fib n)\n  (if (< n 2)\n      n\n      (+ (fib (- n 1)) (fib (- n 2)))))",
	],
	["(fib 5)", "(fib 5)"],
	["let", "(let ((x 3) (y 4))\n  (sqrt (+ (* x x) (* y y))))"],
	[
		"make-counter",
		"(define (make-counter)\n  (let ((count 0))\n    (lambda ()\n      (set! count (+ count 1))\n      count)))",
	],
	["define tick", "(define tick (make-counter))"],
	["(tick)", "(tick)"],
	[
		"tail loop",
		"(define (count-down n)\n  (if (= n 0)\n      'liftoff\n      (count-down (- n 1))))",
	],
	["(count-down 5)", "(count-down 5)"],
	["define score", "(define score 0)"],
	["watch", "(watch (* score 10))"],
	["set! score", "(set! score (+ score 7))"],
	["map", "(map (lambda (x) (* x x)) (range 1 6))"],
]
const SPEEDS: Record<string, { ms: number; per: number }> = {
	step: { ms: 0, per: 1 },
	slow: { ms: 650, per: 1 },
	walk: { ms: 170, per: 1 },
	run: { ms: 40, per: 1 },
	fast: { ms: 16, per: 5 },
	instant: { ms: 0, per: Infinity },
}
const LIMIT = 400_000

// ---- values: numbers, strings, #t #f, lists (arrays), symbols, closures, builtins ----
type Sym = { sym: string }
type Closure = { lambda: string; params: string[]; rest?: string; body: unknown[]; env: string[] }
type Builtin = { builtin: string }
type Frame = {
	id: string
	path: string[]
	name: string
	parent: string
	label: string
	kind: string
	kept?: boolean
	up?: Frame
}
type Mem = { mem: Map<string, unknown>; parent: Env }
type Env = Frame | Mem
type Step = {
	kind: string
	text: string
	at?: string
	walk?: string[]
	labels?: string[]
	found?: string
	var?: string
	miss?: boolean
	frame?: string
}
type Cx = {
	watch: boolean
	steps: number
	calls: number
	depth: number
	stack: string[]
	printed: string[]
	watches: string[]
}

class LispError extends Error {}
const isSym = (v): v is Sym => typeof v === "object" && v !== null && typeof v.sym === "string"
const isClosure = (v): v is Closure => typeof v === "object" && v !== null && "lambda" in v
const isBuiltin = (v): v is Builtin => typeof v === "object" && v !== null && "builtin" in v
const isFrame = (v) => typeof v === "object" && v !== null && "frame" in v
const isMem = (e: Env): e is Mem => "mem" in e
// a symbol's place name: places reads "/", "." and ".." as steps, h splits paths at "/" and
// cuts them at "#": those are written %2F, %2E, %23 (and % itself %25)
const slot = (s: string) => {
	const x = s.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/#/g, "%23")
	return x === "." || x === ".." || x === "" ? x.replace(/\./g, "%2E") || "%20" : x
}
const unslot = (s: string) =>
	s.replace(/%2F/g, "/").replace(/%23/g, "#").replace(/%2E/g, ".").replace(/%20/g, "").replace(
		/%25/g,
		"%",
	)

export default function program() {
	// a whole value put on a node
	type To = Parameters<typeof read>[0]
	const put = (x: To, value: unknown) => patch(x, [{ path: [], value }])
	// one value at a path in a node's value, the rest left as it is (undefined: taken out)
	const set = (x: To, path: string[], value?: unknown) =>
		patch(x, [value === undefined ? { path } : { path, value }])
	// a node's value now, from an action (nothing tracked)
	const get = <T,>(x: To) => peep(() => read(x)) as T

	// the page's font, once
	if (!document.head.querySelector("link[data-lisp-font]")) {
		document.head.appendChild(Object.assign(document.createElement("link"), {
			rel: "stylesheet",
			href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&display=swap",
		}))
		document.head.lastElementChild!.setAttribute("data-lisp-font", "")
	}

	// ---- the frames: base holds the builtins and global, saved under ./ (a reload finds them) ----
	// a frame's address is its names from base; the graph's own path is base's, then those. a node
	// is written by its path from the root: abs gives it, where gives a path the walk found
	const abs = (path: string[]) => "/" + ["base", ...path].join("/")
	const where = (path: readonly string[]) => "/" + path.join("/")
	ensureNode("./base", { frame: "base", label: "base", path: [] })
	for (const name of Object.keys(BUILTINS)) ensureNode(abs([slot(name)]), { builtin: name })
	ensureNode(abs(["global"]), { frame: "global", label: "global", path: ["global"] })
	const log = ensureNode("./log", [])
	const now = ensureNode("./now", { kind: "idle", text: "" })
	const speed = ensureNode("./speed", "run")
	const watches = ensureNode("./watches", [])
	ensureNode("./watching", null) // the watches' values: a memo each, placed under it

	// the id of a node by its address from the root (told by up, tracked in a run): what the view
	// matches a row of the tree with
	const idAt = (path: string[]) => up(path, [])?.found
	// the node (its id and value) at a frame's address from base, told to whoever runs this (a run
	// tracks it; a call does not)
	const at = (path: string[]) => {
		const id = idAt(["base", ...path])
		return id === undefined ? undefined : { id, value: read(abs(path)) as any }
	}
	// every node under an address, in order: its name, id and value
	const members = (path: string[]) =>
		(hasNode(abs(path)) ? childrenOf(abs(path)) : []).flatMap((name) => {
			const m = at([...path, name])
			return m ? [{ name, id: m.id, value: m.value }] : []
		})
	// a node and all under it taken out (a node no name reaches is gone)
	function wipe(path: string[]) {
		for (const name of [...childrenOf(abs(path))]) wipe([...path, name])
		unplace(abs(path))
	}
	const baseId = String(idAt(["base"]))

	// frames are named <closure>·<n>: n goes on from the largest there
	let made = 0
	const frames = (path: string[], f: (path: string[], v) => void) => {
		for (const m of members(path)) {
			if (isFrame(m.value)) (f([...path, m.name], m.value), frames([...path, m.name], f))
		}
	}
	frames(["global"], (_, v) => (made = Math.max(made, v.n ?? 0)))

	// ---- environments, read from the graph ----
	// the frame at an address from base, as reached from base: its up is the frame around it
	function envOf(path: string[]): Frame {
		const it = at(path)
		if (!it) throw new LispError(`the frame ${path[path.length - 1]} is gone (collected)`)
		const parent = path.length > 1 ? at(path.slice(0, -1)) : undefined
		return {
			id: String(it.id),
			path,
			name: path[path.length - 1],
			parent: String(parent?.id ?? baseId),
			label: path.length > 1 ? String(it.value?.label) : "global",
			kind: path.length > 1 ? String(it.value?.frame) : "global",
			kept: path.length <= 1 || it.value?.kept === true,
		}
	}
	// a frame's label by its address from base ([]: base itself)
	const labelAt = (path: string[]) =>
		path.length === 0
			? "base"
			: hasNode(abs(path))
			? String(read(abs(path), ["label"]) ?? "?")
			: "?"

	// a name looked up from env: the host's walk up (up: the frames it visited told to an array,
	// the walk, or its reads tracked, a watch's). it stops at base: above it is not the program's
	// (a variable called log would find the REPL's). memory frames (a watch's calls) first
	function* find(name: string, env: Env, cx: Cx) {
		let e = env
		while (isMem(e)) {
			if (e.mem.has(name)) return { mem: e.mem }
			e = e.parent
		}
		const walk: string[] = []
		const hit = up([slot(name)], ["base", ...e.path], {
			stop: 1,
			walk: cx.watch ? undefined : walk,
		})
		if (!cx.watch) {
			// the walk's ids go up from e's frame to base: each one's label by its address
			const labels = walk.map((_, i) => labelAt(e.path.slice(0, e.path.length - i)))
			for (let k = 1; k <= walk.length; k++) {
				const last = k === walk.length
				const trail = labels.slice(0, k).map((l, i) =>
					i < k - 1 || !last ? `${l} ✗` : hit ? `${l} ✓` : `${l} ✗`
				)
				yield {
					kind: "look",
					text: `${name}: ${trail.join(" → ")}${last && !hit ? " · bound nowhere" : ""}`,
					at: e.id,
					walk: walk.slice(0, k),
					labels: labels.slice(0, k),
					found: last && hit ? hit.parent : undefined,
					var: last && hit ? String(hit.found) : undefined,
					miss: last && !hit,
				} as Step
			}
		}
		if (!hit) throw new LispError(`${name} is bound nowhere: the walk went up to base`)
		return { item: hit }
	}
	function* look(name: string, env: Env, cx: Cx) {
		const r = yield* find(name, env, cx)
		return "mem" in r ? r.mem.get(name) : read(where(r.item.path))
	}

	// a name placed in a frame (a node), or written again when it is there
	function define(env: Env, name: string, value, cx: Cx): string | undefined {
		if (isMem(env)) return void env.mem.set(name, value)
		if (cx.watch) throw new LispError("a watch only reads: no define in it")
		const path = [...env.path, slot(name)]
		const there = at(path)
		if (there) {
			put(abs(path), value)
			return String(there.id)
		}
		ensureNode(abs(path), value)
		return String(idAt(["base", ...path]))
	}

	// a closure keeps its frame: that frame (and the ones around it) stay after their call
	function keep(env: Env) {
		for (let e: Frame | undefined = env as Frame; e && !isMem(e); e = e.up) {
			if (e.kept) break
			e.kept = true
			if (e.kind !== "global") set(abs(e.path), ["kept"], true)
		}
	}
	function closure(name: string, params, body: unknown[], env: Env, cx: Cx): Closure {
		if (isMem(env) || cx.watch) throw new LispError("a watch makes no lambdas")
		if (!body.length) throw new LispError("a lambda wants a body")
		keep(env)
		const c: Closure = { lambda: name, params: [], body, env: env.path }
		if (isSym(params)) c.rest = params.sym
		else if (Array.isArray(params)) {
			c.params = params.map((p) => (isSym(p) ? p.sym : bad("a parameter", p)))
		} else bad("parameters", params)
		return c
	}

	// a frame placed under parent: a folder node, its bindings nodes in it
	function* enter(
		kind: string,
		label: string,
		short: string,
		parent: Env,
		binds: [string, unknown][],
		cx: Cx,
	) {
		if (isMem(parent) || cx.watch) return { mem: new Map(binds), parent } as Mem
		if (++cx.depth > 250) throw new LispError("too deep: 250 frames at once")
		const name = `${slot(short)}·${++made}`
		const path = [...parent.path, name]
		ensureNode(abs(path), { frame: kind, label, n: made, path, active: true })
		for (const [k, v] of binds) ensureNode(abs([...path, slot(k)]), v)
		const f: Frame = {
			id: String(idAt(["base", ...path])),
			path,
			name,
			parent: parent.id,
			label,
			kind,
			up: parent,
		}
		cx.stack.push(label)
		yield {
			kind: "enter",
			text: `${label}: a frame placed under ${parent.label}`,
			frame: f.id,
			at: f.id,
		} as Step
		return f
	}
	// a frame's call over: it goes, unless a closure keeps it
	function drop(f: Frame, cx: Cx) {
		cx.depth--
		const i = cx.stack.lastIndexOf(f.label)
		if (i >= 0) cx.stack.splice(i, 1)
		if (f.kept) {
			if (hasNode(abs(f.path))) {
				set(abs(f.path), ["active"], false)
				set(abs(f.path), ["returned"])
			}
			return
		}
		wipe(f.path)
	}
	function* leave(owned: Frame[], v, cx: Cx) {
		if (!owned.length || cx.watch) return
		const f = owned[0]
		for (const o of owned) set(abs(o.path), ["active"], false)
		set(abs(f.path), ["returned"], short(v))
		yield { kind: "leave", text: `${f.label} returns ${print(v)}`, frame: f.id, at: f.id } as Step
	}

	// ---- eval: a generator, a step at each yield. tail positions loop instead of recursing ----
	function* ev(x, env: Env, cx: Cx): Generator<Step, unknown> {
		const owned: Frame[] = []
		try {
			const v = yield* run(x, env, cx, owned)
			yield* leave(owned, v, cx)
			return v
		} finally {
			for (let i = owned.length - 1; i >= 0; i--) drop(owned[i], cx)
		}
	}
	function* body(forms: unknown[], env: Env, cx: Cx) {
		for (const f of forms.slice(0, -1)) yield* ev(f, env, cx)
		return forms[forms.length - 1]
	}
	function* run(x, env: Env, cx: Cx, owned: Frame[]): Generator<Step, unknown> {
		outer: for (;;) {
			if (++cx.steps > LIMIT) throw new LispError(`too long: ${LIMIT} steps`)
			if (isSym(x)) return yield* look(x.sym, env, cx)
			if (!Array.isArray(x)) return x
			if (!x.length) return []
			const [op, ...args] = x
			if (isSym(op)) {
				switch (op.sym) {
					case "quote":
						return args[0]
					case "if": {
						const c = yield* ev(args[0], env, cx)
						if (c !== false) x = args[1]
						else if (args.length > 2) x = args[2]
						else return undefined
						continue
					}
					case "define": {
						let target = args[0]
						let value
						if (Array.isArray(target)) {
							const [name, ...params] = target
							if (!isSym(name)) bad("a name", name)
							value = closure(name.sym, params, args.slice(1), env, cx)
							target = name
						} else {
							if (!isSym(target)) bad("a name", target)
							value = yield* ev(args[1], env, cx)
							if (isClosure(value) && !value.lambda) value = { ...value, lambda: target.sym }
						}
						const id = define(env, target.sym, value, cx)
						if (!cx.watch && !isMem(env)) {
							yield {
								kind: "define",
								text: `${target.sym} placed in ${env.label}`,
								var: id,
								at: env.id,
							} as Step
						}
						return { sym: target.sym }
					}
					case "set!": {
						if (!isSym(args[0])) bad("a name", args[0])
						const value = yield* ev(args[1], env, cx)
						if (cx.watch) throw new LispError("a watch only reads: no set! in it")
						const r = yield* find(args[0].sym, env, cx)
						if ("mem" in r) r.mem.set(args[0].sym, value)
						else {
							put(where(r.item.path), value)
							yield {
								kind: "set",
								text: `${args[0].sym} in ${labelAt(r.item.path.slice(1, -1))} is now ${
									print(value)
								}`,
								var: String(r.item.found),
								at: String(r.item.parent),
							} as Step
						}
						return value
					}
					case "lambda":
						return closure("", args[0], args.slice(1), env, cx)
					case "begin":
						if (!args.length) return undefined
						x = yield* body(args, env, cx)
						continue
					case "let":
					case "let*": {
						if (!Array.isArray(args[0])) bad("let's bindings", args[0])
						const pairs = args[0] as [Sym, unknown][]
						const label = `(${op.sym} ${pairs.map((p) => print(p[0])).join(" ")})`
						let f: Env
						if (op.sym === "let") {
							const binds: [string, unknown][] = []
							for (const [n, e] of pairs) binds.push([n.sym, yield* ev(e, env, cx)])
							f = yield* enter("let", label, "let", env, binds, cx)
						} else {
							f = yield* enter("let", label, "let", env, [], cx)
							if (!isMem(f)) owned.push(f)
							for (const [n, e] of pairs) define(f, n.sym, yield* ev(e, f, cx), cx)
						}
						if (!isMem(f) && !owned.includes(f as Frame)) owned.push(f as Frame)
						x = yield* body(args.slice(1), f, cx)
						env = f
						continue
					}
					case "cond":
						for (const clause of args as unknown[][]) {
							const [test, ...then] = clause
							const ok = isSym(test) && test.sym === "else" ? true : yield* ev(test, env, cx)
							if (ok === false) continue
							if (!then.length) return ok
							x = yield* body(then, env, cx)
							continue outer
						}
						return undefined
					case "and":
					case "or": {
						if (!args.length) return op.sym === "and"
						let i = 0
						for (; i < args.length - 1; i++) {
							const v = yield* ev(args[i], env, cx)
							if (op.sym === "and" ? v === false : v !== false) return v
						}
						x = args[i]
						continue
					}
					case "when":
					case "unless": {
						const c = yield* ev(args[0], env, cx)
						if ((c !== false) !== (op.sym === "when")) return undefined
						x = yield* body(args.slice(1), env, cx)
						continue
					}
					case "watch":
						if (cx.watch) throw new LispError("a watch in a watch")
						cx.watches.push(print(args[0]))
						return { sym: "watching" }
				}
			}
			// an application: the operator and the arguments, in the frame we are in
			const f = yield* ev(op, env, cx)
			const vals: unknown[] = []
			for (const a of args) vals.push(yield* ev(a, env, cx))
			if (isBuiltin(f)) return yield* builtin(f.builtin, vals, cx)
			if (!isClosure(f)) throw new LispError(`${print(f)} is not a procedure`)
			// a tail call: the frames this one made go first, then the callee's comes
			if (owned.length) {
				const gone = owned.map((o) => o.label).join(", ")
				for (let i = owned.length - 1; i >= 0; i--) drop(owned[i], cx)
				owned.length = 0
				if (!cx.watch) {
					yield {
						kind: "tail",
						text: `a tail call: ${gone} went before the next came`,
					} as Step
				}
			}
			const frame = yield* call(f, vals, cx)
			if (!isMem(frame)) owned.push(frame)
			x = yield* body(f.body, frame, cx)
			env = frame
		}
	}
	// a closure's frame, placed under the closure's own frame (lexical, not the caller's)
	function* call(f: Closure, vals: unknown[], cx: Cx) {
		cx.calls++
		const name = f.lambda || "λ"
		if (f.rest === undefined ? vals.length !== f.params.length : vals.length < f.params.length) {
			throw new LispError(`${name} wants ${f.params.length} argument(s), got ${vals.length}`)
		}
		const binds: [string, unknown][] = f.params.map((p, i) => [p, vals[i]])
		if (f.rest !== undefined) binds.push([f.rest, vals.slice(f.params.length)])
		const label = `(${name}${vals.map((v) => " " + short(v)).join("")})`
		return yield* enter("call", label, name, envOf(f.env), binds, cx)
	}
	// a procedure called from a builtin (map, apply…): not a tail call
	function* apply(f, vals: unknown[], cx: Cx): Generator<Step, unknown> {
		if (isBuiltin(f)) return yield* builtin(f.builtin, vals, cx)
		if (!isClosure(f)) throw new LispError(`${print(f)} is not a procedure`)
		const frame = yield* call(f, vals, cx)
		const owned = isMem(frame) ? [] : [frame]
		try {
			const v = yield* ev(yield* body(f.body, frame, cx), frame, cx)
			yield* leave(owned, v, cx)
			return v
		} finally {
			for (const o of owned) drop(o, cx)
		}
	}
	function* builtin(name: string, vals: unknown[], cx: Cx): Generator<Step, unknown> {
		const out = BUILTINS[name](vals, { cx, apply })
		return isGenerator(out) ? yield* out : out
	}

	// ---- the REPL: jobs, one at a time, stepped by the header's beat (each beat a call) ----
	type Job = { n: number; gen: Generator<Step, unknown>; cx: Cx; yields: number; last?: Step }
	let job: Job | undefined
	const queue: { n: number; form: unknown }[] = []
	const fresh = (watch: boolean): Cx => ({
		watch,
		steps: 0,
		calls: 0,
		depth: 0,
		stack: [],
		printed: [],
		watches: [],
	})
	const logged = () => (get<any[]>(log) ?? []) as any[]
	const write = (n: number, change) =>
		put(log, logged().map((e) => (e.n === n ? { ...e, ...change } : e)))

	// the log's sources, for ↑ and ↓ in the input (a keydown has nothing open to read the log with)
	let history: string[] = []
	createEffect(
		"history",
		() => ((read(log) ?? []) as any[]).map((x) => x.src as string),
		(srcs) => {
			history = srcs
		},
	)

	function next() {
		if (job || !queue.length) return
		const { n, form } = queue.shift()!
		const cx = fresh(false)
		job = { n, gen: ev(form, envOf(["global"]), cx), cx, yields: 0 }
		write(n, { state: "running" })
		go()
	}
	// steps until per yields, or the end
	function advance(per: number) {
		if (!job) return
		for (let i = 0; i < per; i++) {
			let r: IteratorResult<Step, unknown>
			try {
				r = job.gen.next()
			} catch (e) {
				return finish(undefined, e)
			}
			if (r.done) return finish(r.value)
			job.last = r.value
			job.yields++
		}
		if (job.last) put(now, { ...job.last, stack: [...job.cx.stack], yields: job.yields })
	}
	function finish(v, error?) {
		const j = job!
		job = undefined
		for (const src of j.cx.watches) {
			const ws = (get<any[]>(watches) ?? []) as any[]
			if (!ws.some((w) => w.src === src)) {
				put(watches, [...ws, { id: `w${Date.now().toString(36)}${ws.length}`, src }])
			}
		}
		const gone = collect()
		write(j.n, {
			state: error ? "failed" : "done",
			out: error ? undefined : print(v),
			error: error
				? (error instanceof LispError ? error.message : `${error?.name}: ${error?.message}`)
				: undefined,
			printed: j.cx.printed.join(""),
			steps: j.yields,
			calls: j.cx.calls,
			collected: gone,
		})
		put(now, {
			kind: error ? "failed" : "done",
			text: error ? "✗ " + (error?.message ?? error) : `→ ${print(v)}`,
			stack: [],
			yields: j.yields,
		})
		next()
	}
	// the beat: one tick of the timer, a step's time. on/beat takes the next step(s)
	createAction("on/beat", () => {
		if (!job) return
		advance((SPEEDS[String(get(speed))] ?? SPEEDS.run).per)
	})
	// the timer, as long as one step takes at this speed (none: instant, and the others wait)
	const withWriter = createWriter()
	createEffect("beat", () => (SPEEDS[String(read(speed))] ?? SPEEDS.run).ms, (ms) => {
		if (!ms) return
		const t = setInterval(() => withWriter(() => executeAction("on/beat")), ms)
		return () => clearInterval(t)
	})
	// a job started or sped up: instant runs it to its end at once; the others wait for the beat
	// (step: for on/step)
	function go() {
		if (!job) return
		if ((SPEEDS[String(get(speed))] ?? SPEEDS.run).per === Infinity) advance(Infinity)
	}
	// a reload (or the end) while a job runs: it is stopped, its frames dropped
	addTeardown(() => {
		if (job) stop()
	})

	// after an evaluation: frames no closure reachable from global holds are taken out
	function collect() {
		const live = new Set<string>(["global"])
		const scan = (v) => {
			if (isClosure(v)) {
				for (let k = 2; k <= v.env.length; k++) mark(v.env.slice(0, k))
			} else if (Array.isArray(v)) v.forEach(scan)
		}
		const mark = (path: string[]) => {
			if (live.has(path.join("/"))) return
			live.add(path.join("/"))
			for (const m of members(path)) scan(m.value)
		}
		for (const m of members(["global"])) scan(m.value)
		let gone = 0
		const sweep = (path: string[]) => {
			for (const m of members(path)) {
				if (!isFrame(m.value)) continue
				const p = [...path, m.name]
				if (live.has(p.join("/"))) sweep(p)
				else (wipe(p), gone++)
			}
		}
		sweep(["global"])
		return gone
	}

	createAction("on/eval", (src: string) => {
		const list = logged()
		const n = (list[list.length - 1]?.n ?? 0) + 1
		let forms: unknown[]
		try {
			forms = parse(src)
		} catch (e) {
			put(log, [...list, { n, src, state: "failed", error: (e as Error).message }])
			return
		}
		const added = forms.map((form, i) => ({
			n: n + i,
			src: forms.length > 1 ? print(form) : src,
			state: "queued",
		}))
		put(log, [...list, ...added].slice(-60))
		forms.forEach((form, i) => queue.push({ n: n + i, form }))
		next()
	})
	createAction("on/step", () => advance(1))
	function stop() {
		queue.length = 0
		if (!job) return
		try {
			job.gen.return(undefined)
		} catch { /* a drop that failed: the frame stays */ }
		finish(undefined, new LispError("stopped"))
	}
	createAction("on/stop", stop)
	createAction("on/speed", (s: string) => {
		put(speed, s)
		go()
	})
	createAction("on/clear", () => put(log, []))
	createAction(
		"on/unwatch",
		(id: string) =>
			put(watches, ((get<any[]>(watches) ?? []) as any[]).filter((w) => w.id !== id)),
	)

	// ---- watches: a memo each, evaluating with the walk up tracked. what an effect's act makes goes
	// when it acts again, so the list's change makes them all again, each at ./watching/<id> ----
	createEffect("watchers", () => read(watches) as any[], (ws) => {
		for (const w of ws ?? []) createMemo(`./watching/${w.id}`, () => watch(w.src))
	})
	function watch(src: string) {
		try {
			const [form] = parse(src)
			const cx = fresh(true)
			const g = ev(form, envOf(["global"]), cx)
			for (let r = g.next();; r = g.next()) if (r.done) return { out: print(r.value) }
		} catch (e) {
			// the scheduler's own throws (a stop, pending) are not the watch's to keep
			if (!(e instanceof Error)) throw e
			return { error: e.message }
		}
	}

	// ---- the views ----
	let logBox: HTMLElement | undefined
	let input: HTMLTextAreaElement | undefined
	let back = 0
	// enter runs a whole form; shift+enter, or an open paren, a new line. ↑ ↓ go through what ran
	const keys = (e: KeyboardEvent) => {
		const el = e.target as HTMLTextAreaElement
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !el.value.includes("\n")) {
			const srcs = history
			back = Math.max(0, Math.min(srcs.length, back + (e.key === "ArrowUp" ? 1 : -1)))
			el.value = back ? srcs[srcs.length - back] : ""
			grow(el)
			e.preventDefault()
			return undefined
		}
		if (e.key !== "Enter" || e.shiftKey) return undefined
		const src = el.value.trim()
		if (!src || depth(src) > 0) return undefined
		e.preventDefault()
		el.value = ""
		back = 0
		grow(el)
		return [src]
	}

	const entry = (e) => (
		<div class={`entry ${e.state}`} key={String(e.n)}>
			<pre class="echo">
				<span class="prompt">λ›</span> {colour(e.src)}
			</pre>
			{e.printed ? <pre class="printed">{e.printed}</pre> : null}
			{e.state === "running" || e.state === "queued"
				? (
					<div class="result wait">
						{e.state === "queued" ? "queued" : "running… watch the frames"}
					</div>
				)
				: e.error
				? <div class="result error">✗ {e.error}</div>
				: (
					<div class="result">
						<span class="value">{e.out || "·"}</span>
						<span class="meta">
							{e.steps} step{e.steps === 1 ? "" : "s"} · {e.calls}{" "}
							call{e.calls === 1 ? "" : "s"}
							{e.collected
								? ` · ${e.collected} frame${e.collected === 1 ? "" : "s"} collected`
								: ""}
						</span>
					</div>
				)}
		</div>
	)

	// a frame, drawn: its bindings, then the frames placed in it (nested: lexical)
	const P = (path: string[]) => "./" + ["base", ...path].join("/")
	function frameClass(id: string, v, w) {
		let c = `frame ${v.frame}`
		if (v.active) c += " active"
		if (v.returned !== undefined) c += " returned"
		if (v.kept && v.frame !== "global" && v.frame !== "base") c += " kept"
		const k = w?.walk?.indexOf(id) ?? -1
		if (k >= 0) {
			const last = k === w.walk.length - 1
			c += last ? (w.found === id ? " found" : w.miss ? " miss" : " walking") : " passed"
		}
		if (w?.at === id) c += " here"
		return c
	}
	const badge = (id: string) => (w) => {
		const k = w?.walk?.indexOf(id) ?? -1
		if (k < 0) return null
		const last = k === w.walk.length - 1
		const mark = last ? (w.found === id ? "✓" : w.miss ? "✗" : "…") : "✗"
		return <span class="walkstep">{k + 1} {mark}</span>
	}
	function frameBox(path: string[], id: string, v) {
		const at = P(path)
		// its class reads the frame itself, not v: made again the same, a binding keeps what it closed over
		return (
			<div class={bind("./now", (w) => frameClass(id, read(at), w))} data-path={path.join("/")}>
				<header>
					<strong class="tag">{v.label}</strong>
					{bind("./now", badge(id))}
					{v.returned !== undefined && <em class="ret">↩ {v.returned}</em>}
					{v.kept && v.frame !== "global" && v.frame !== "base" && (
						<em class="kept" title="a closure remembers this frame">📌 kept</em>
					)}
				</header>
				{v.frame === "base"
					? (
						<div class="builtins">
							{under(at, (m) =>
								m.name === "global" ? null : (
									<code
										class={bind(
											"./now",
											(w) => (w?.var === String(idAt(["base", ...path, m.name]))
												? "b hit"
												: "b"),
										)}
									>
										{unslot(m.name)}
									</code>
								))}
						</div>
					)
					: (
						<div class="vars">
							{under(at, (m) =>
								bind(
									`${at}/${m.name}`,
									(mv) => (isFrame(mv)
										? null
										: varRow(String(idAt(["base", ...path, m.name])), m.name, mv)),
								))}
						</div>
					)}
				<div class="kids">
					{under(
						at,
						(m) =>
							bind(`${at}/${m.name}`, (mv) =>
								isFrame(mv)
									? frameBox(
										[...path, m.name],
										String(idAt(["base", ...path, m.name])),
										mv,
									)
									: null),
					)}
				</div>
			</div>
		)
	}
	const varRow = (id: string, name: string, v) => (
		<div class={bind("./now", (w) => (w?.var === id ? `var hit ${w.kind}` : "var"))}>
			<span class="vname">{unslot(name)}</span>
			<span class="val">{value(v)}</span>
		</div>
	)
	// a closure: its parameters, and the frame it remembers (hover: that frame lights up)
	function value(v) {
		if (isClosure(v)) {
			const env = v.env.join("/")
			return (
				<span
					class="lam"
					onPointerEnter={() => glow(env)}
					onPointerLeave={() => glow(undefined)}
					title={`a closure: its frame is ${v.env[v.env.length - 1]}, by address from base`}
				>
					λ({[...v.params, ...(v.rest ? [". " + v.rest] : [])].join(" ")})
					<span class="env">
						↗ {unslot(v.env[v.env.length - 1].replace(/·.*/, "")) || "?"}
					</span>
				</span>
			)
		}
		if (isBuiltin(v)) return <span class="kw">builtin</span>
		if (typeof v === "number") return <span class="num">{print(v)}</span>
		if (typeof v === "string") return <span class="str">{print(v)}</span>
		return <span class="data">{print(v)}</span>
	}
	let world: HTMLElement | undefined
	const glow = (path?: string) => {
		for (const el of world?.querySelectorAll(".glow") ?? []) el.classList.remove("glow")
		if (path) world?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.classList.add("glow")
	}

	const nowLine = (w) => (
		<div class={`nowline ${w?.kind ?? ""}`}>
			<span class="what">{w?.kind === "look" ? "lookup" : w?.kind ?? "idle"}</span>
			<span class="text">{w?.text || "evaluate something: frames appear here as it runs"}</span>
			{w?.yields ? <span class="yields">step {w.yields}</span> : null}
		</div>
	)
	const stack = (w) =>
		w?.stack?.length
			? (
				<div class="stack">
					<span class="what">calls</span>
					{w.stack.map((l, i) => (
						<span class="call">
							{i > 0 ? "› " : ""}
							{l}
						</span>
					))}
				</div>
			)
			: null

	const tile = (w) => (
		<div class="watch" key={w.id}>
			<code>{colour(w.src)}</code>
			<span class="eq">=</span>
			<span
				class="wv"
				ref={(el) => {
					if (el.dataset.on) return
					el.dataset.on = "1"
					el.addEventListener("ermine:change", () => el.animate(POP, 500))
				}}
			>
				{bind(
					`./watching/${w.id}`,
					(r) => (r?.error ? <span class="werr">{r.error}</span> : r?.out),
				)}
			</span>
			<button class="x" title="stop watching" onClick={handler("on/unwatch", [w.id])}>✕</button>
		</div>
	)

	return (
		<div class="lisp">
			<style>{LOOK}</style>
			<header class="top">
				<span class="tag title">λ lisp</span>
				<span class="lede">
					every frame is a folder · a lookup is places' lookup, walking up
				</span>
				<span class="fill" />
				<span class="speeds">
					{bind("./speed", (s) =>
						Object.keys(SPEEDS).map((k) => (
							<button class={k === s ? "on" : ""} onClick={handler("on/speed", [k])}>
								{k}
							</button>
						)))}
				</span>
				<button title="one step" onClick={handler("on/step")}>▸ step</button>
				<button class="stop" title="stop what is running" onClick={handler("on/stop")}>
					■
				</button>
			</header>
			<div class="panes">
				<section class="repl">
					<div class="log" ref={(e) => (logBox = e)}>
						{bind("./log", (list: any[]) => {
							queueMicrotask(() =>
								logBox && (logBox.scrollTop = logBox.scrollHeight)
							)
							return list.length ? list.map(entry) : (
								<p class="hello">
									A lisp whose environments are folders. Pick an example below, or type a
									form and press enter.
								</p>
							)
						})}
					</div>
					<label class="input">
						<span class="prompt">λ›</span>
						<textarea
							rows={1}
							spellcheck={false}
							placeholder="(fib 5)   enter runs it · ↑ what ran"
							ref={(e) => (input = e)}
							onInput={(e) => grow(e.currentTarget)}
							onKeyDown={handler("on/eval", keys)}
						/>
					</label>
					<div class="examples">
						{EXAMPLES.map(([label, src]) => (
							<button title={src} onClick={handler("on/eval", [src])}>{label}</button>
						))}
						<button class="ghost" onClick={handler("on/clear")}>clear</button>
					</div>
				</section>
				<section class="world" ref={(e) => (world = e)}>
					{bind("./now", nowLine)}
					{bind("./now", stack)}
					<div class="tree">{bind("./base", (v) => frameBox([], baseId, v))}</div>
					<div class="watches">
						<b class="tag mint">watching</b>
						{bind("./watches", (list: any[]) =>
							list?.length ? list.map(tile) : (
								<span class="hint">
									(watch expr) makes a part that reads through lookup: set! what it reads
									and it runs again
								</span>
							))}
					</div>
				</section>
			</div>
		</div>
	)
}

// ---- the reader ----
function tokens(src: string): string[] {
	const out: string[] = []
	let i = 0
	while (i < src.length) {
		const c = src[i]
		if (/\s/.test(c)) i++
		else if (c === ";") { while (i < src.length && src[i] !== "\n") i++ }
		else if (c === "(" || c === ")" || c === "'") (out.push(c), i++)
		else if (c === '"') {
			let j = i + 1
			while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1
			if (j >= src.length) throw new LispError("a string never ends")
			out.push(src.slice(i, j + 1))
			i = j + 1
		} else {
			let j = i
			while (j < src.length && !/[\s()';"]/.test(src[j])) j++
			out.push(src.slice(i, j))
			i = j
		}
	}
	return out
}
function parse(src: string): unknown[] {
	const ts = tokens(src)
	let i = 0
	const one = (): unknown => {
		if (i >= ts.length) throw new LispError("a ) is missing")
		const tk = ts[i++]
		if (tk === "(") {
			const list: unknown[] = []
			while (ts[i] !== ")") {
				if (i >= ts.length) throw new LispError("a ) is missing")
				list.push(one())
			}
			i++
			return list
		}
		if (tk === ")") throw new LispError("a ) too many")
		if (tk === "'") return [{ sym: "quote" }, one()]
		if (tk.startsWith('"')) {
			try {
				return JSON.parse(tk)
			} catch {
				return tk.slice(1, -1)
			}
		}
		if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(tk)) return Number(tk)
		if (tk === "#t" || tk === "true") return true
		if (tk === "#f" || tk === "false") return false
		return { sym: tk }
	}
	const forms: unknown[] = []
	while (i < ts.length) forms.push(one())
	return forms
}
// how many parens are open (strings and comments aside)
function depth(src: string) {
	let d = 0
	try {
		for (const tk of tokens(src)) d += tk === "(" ? 1 : tk === ")" ? -1 : 0
	} catch {
		return 1
	}
	return d
}
function print(v): string {
	if (v === undefined) return ""
	if (v === true) return "#t"
	if (v === false) return "#f"
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(+v.toPrecision(10))
	if (typeof v === "string") return JSON.stringify(v)
	if (Array.isArray(v)) {
		if (v.length === 2 && isSym(v[0]) && v[0].sym === "quote") return "'" + print(v[1])
		return "(" + v.map(print).join(" ") + ")"
	}
	if (isSym(v)) return v.sym
	if (isClosure(v)) return `#<λ${v.lambda ? " " + v.lambda : ""}>`
	if (isBuiltin(v)) return `#<builtin ${v.builtin}>`
	return String(v)
}
const short = (v) => {
	const s = isClosure(v) ? (v.lambda || "λ") : print(v)
	return s.length > 14 ? s.slice(0, 13) + "…" : s
}
const bad = (what: string, v): never => {
	throw new LispError(`${what} wanted, got ${print(v)}`)
}
const isGenerator = (v): v is Generator<Step, unknown> =>
	typeof v === "object" && v !== null && typeof v.next === "function" &&
	typeof v.throw === "function"

// a source, coloured: parens by depth, numbers, strings, the special forms
const SPECIAL = new Set([
	"define",
	"lambda",
	"let",
	"let*",
	"if",
	"cond",
	"set!",
	"quote",
	"begin",
	"and",
	"or",
	"when",
	"unless",
	"watch",
	"else",
])
function colour(src: string) {
	const out: unknown[] = []
	let d = 0
	for (const m of src.matchAll(/(\s+|;[^\n]*|"(?:\\.|[^"\\])*"?|[()']|[^\s()';"]+)/g)) {
		const tk = m[0]
		if (tk === "(") out.push(<span class={`p p${d++ % 3}`}>(</span>)
		else if (tk === ")") out.push(<span class={`p p${--d % 3}`}>)</span>)
		else if (/^\s/.test(tk)) out.push(tk)
		else if (tk.startsWith(";")) out.push(<span class="cm">{tk}</span>)
		else if (tk.startsWith('"')) out.push(<span class="str">{tk}</span>)
		else if (/^[+-]?(\d|\.\d)/.test(tk)) out.push(<span class="num">{tk}</span>)
		else if (SPECIAL.has(tk)) out.push(<span class="sp">{tk}</span>)
		else out.push(tk)
	}
	return out
}
function grow(el: HTMLTextAreaElement) {
	el.rows = Math.min(8, Math.max(1, el.value.split("\n").length))
}
const POP = [{ transform: "scale(1.35)", color: "#ff2284" }, { transform: "scale(1)" }]

// ---- the builtins: each a node in base. map, filter, apply… call procedures (generators) ----
type Use = { cx: Cx; apply: (f, vals: unknown[], cx: Cx) => Generator<Step, unknown> }
const num = (name: string) => (v): number => {
	if (typeof v !== "number") throw new LispError(`${name} wants numbers, got ${print(v)}`)
	return v
}
const list = (name: string) => (v): unknown[] => {
	if (!Array.isArray(v)) throw new LispError(`${name} wants a list, got ${print(v)}`)
	return v
}
const compare = (name: string, ok: (a: number, b: number) => boolean) => (a: unknown[]) =>
	a.map(num(name)).every((x, i, all) => i === 0 || ok(all[i - 1], x))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const BUILTINS: Record<string, (a: unknown[], use: Use) => unknown> = {
	"+": (a) => a.map(num("+")).reduce((x, y) => x + y, 0),
	"-": (a) => {
		const n = a.map(num("-"))
		return n.length === 1 ? -n[0] : n.slice(1).reduce((x, y) => x - y, n[0])
	},
	"*": (a) => a.map(num("*")).reduce((x, y) => x * y, 1),
	"/": (a) => {
		const n = a.map(num("/"))
		if (n.slice(1).includes(0)) throw new LispError("/ by zero")
		return n.length === 1 ? 1 / n[0] : n.slice(1).reduce((x, y) => x / y, n[0])
	},
	quotient: ([a, b]) => Math.trunc(num("quotient")(a) / num("quotient")(b)),
	remainder: ([a, b]) => num("remainder")(a) % num("remainder")(b),
	modulo: ([a, b]) => ((num("modulo")(a) % (b as number)) + (b as number)) % (b as number),
	"=": compare("=", (a, b) => a === b),
	"<": compare("<", (a, b) => a < b),
	">": compare(">", (a, b) => a > b),
	"<=": compare("<=", (a, b) => a <= b),
	">=": compare(">=", (a, b) => a >= b),
	abs: ([a]) => Math.abs(num("abs")(a)),
	min: (a) => Math.min(...a.map(num("min"))),
	max: (a) => Math.max(...a.map(num("max"))),
	sqrt: ([a]) => Math.sqrt(num("sqrt")(a)),
	expt: ([a, b]) => num("expt")(a) ** num("expt")(b),
	floor: ([a]) => Math.floor(num("floor")(a)),
	round: ([a]) => Math.round(num("round")(a)),
	"even?": ([a]) => num("even?")(a) % 2 === 0,
	"odd?": ([a]) => Math.abs(num("odd?")(a) % 2) === 1,
	"zero?": ([a]) => num("zero?")(a) === 0,
	not: ([a]) => a === false,
	"eq?": ([a, b]) => (isSym(a) && isSym(b) ? a.sym === b.sym : Object.is(a, b)),
	"equal?": ([a, b]) => same(a, b),
	"null?": ([a]) => Array.isArray(a) && a.length === 0,
	"pair?": ([a]) => Array.isArray(a) && a.length > 0,
	"list?": ([a]) => Array.isArray(a),
	"number?": ([a]) => typeof a === "number",
	"string?": ([a]) => typeof a === "string",
	"symbol?": ([a]) => isSym(a),
	"procedure?": ([a]) => isClosure(a) || isBuiltin(a),
	car: ([a]) => {
		const l = list("car")(a)
		if (!l.length) throw new LispError("car of ()")
		return l[0]
	},
	cdr: ([a]) => {
		const l = list("cdr")(a)
		if (!l.length) throw new LispError("cdr of ()")
		return l.slice(1)
	},
	cons: ([a, b]) => {
		if (!Array.isArray(b)) throw new LispError("cons wants a list after (no dotted pairs here)")
		return [a, ...b]
	},
	list: (a) => a,
	length: ([a]) => list("length")(a).length,
	append: (a) => a.flatMap((l) => list("append")(l)),
	reverse: ([a]) => [...list("reverse")(a)].reverse(),
	"list-ref": ([a, i]) => list("list-ref")(a)[num("list-ref")(i)],
	range: ([a, b]) => {
		const lo = num("range")(a), hi = num("range")(b)
		if (hi - lo > 10000) throw new LispError("range: more than 10000")
		return Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i)
	},
	map: function* ([f, xs], { cx, apply }) {
		const out: unknown[] = []
		for (const x of list("map")(xs)) out.push(yield* apply(f, [x], cx))
		return out
	},
	filter: function* ([f, xs], { cx, apply }) {
		const out: unknown[] = []
		for (const x of list("filter")(xs)) if ((yield* apply(f, [x], cx)) !== false) out.push(x)
		return out
	},
	reduce: function* ([f, init, xs], { cx, apply }) {
		let acc = init
		for (const x of list("reduce")(xs)) acc = yield* apply(f, [acc, x], cx)
		return acc
	},
	"for-each": function* ([f, xs], { cx, apply }) {
		for (const x of list("for-each")(xs)) yield* apply(f, [x], cx)
		return undefined
	},
	apply: function* ([f, xs], { cx, apply }) {
		return yield* apply(f, list("apply")(xs), cx)
	},
	display: ([a], { cx }) => void cx.printed.push(typeof a === "string" ? a : print(a)),
	newline: (_, { cx }) => void cx.printed.push("\n"),
	"string-append": (a) => a.map((s) => (typeof s === "string" ? s : print(s))).join(""),
	"number->string": ([a]) => print(num("number->string")(a)),
	"symbol->string": ([a]) => (isSym(a) ? a.sym : bad("a symbol", a)),
	random: ([a]) => Math.floor(Math.random() * num("random")(a)),
}

// ---- the look: lemon paper, black lines, white frames glowing pink ----
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 15px/1.4 Jost, system-ui, sans-serif; color: #000 }
.lisp { display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; padding: 10px 12px 12px }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px }
.fill { flex: 1 }
.tag { display: inline-block; background: #ffff88; border: 1px solid #000; padding: 0 9px;
	transform: skew(-8deg); font-weight: 600; font-size: 13px; white-space: nowrap }
.tag.title { background: #ff2284; color: #fff; font-size: 17px; padding: 1px 12px }
.tag.mint { background: #40dcba }
.lede { font-size: 13px; color: #000b }
button { font: inherit; font-size: 13px; color: #000; background: #fff; border: 1px solid #000; border-radius: 2px;
	padding: 0 9px; box-shadow: 2px 2px 0 #000; cursor: pointer; transition: transform 90ms, box-shadow 90ms }
button:hover { transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #000 }
button:active { transform: translate(1px, 1px); box-shadow: 0 0 0 #000 }
.speeds { display: inline-flex; gap: 0 } .speeds > span { display: contents }
.speeds button { box-shadow: none; border-radius: 0; margin-left: -1px; font-size: 12px }
.speeds button:hover { transform: none; background: #ffff88 }
.speeds button.on { background: #2269ff; color: #fff }
.stop:hover { background: #ff2284; color: #fff }
.panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(250px, 0.85fr) minmax(320px, 1.3fr); gap: 12px }
@media (max-width: 720px) { .panes { grid-template-columns: 1fr; grid-template-rows: 1fr 1.3fr } }
section { min-height: 0; background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 0 0 14px 2px #ff228426 }
.repl { display: flex; flex-direction: column }
.log { flex: 1; overflow-y: auto; padding: 8px 10px; font: 13px/1.45 ui-monospace, Menlo, monospace }
.hello { font: 14px/1.4 Jost, sans-serif; color: #0009; margin: 4px 0 }
.entry { margin: 0 0 8px; animation: in 200ms ease-out }
@keyframes in { from { opacity: 0; transform: translateY(4px) } }
.echo, .printed { margin: 0; white-space: pre-wrap; word-break: break-word }
.prompt { color: #ff2284; font-weight: 700 }
.printed { color: #14a888 }
.result { padding-left: 22px }
.result .value { color: #2269ff; font-weight: 600 }
.result .meta { color: #0007; font: 11.5px Jost, sans-serif; margin-left: 10px }
.result.error { color: #d1006a }
.result.wait { color: #0008; animation: blink 700ms infinite alternate }
@keyframes blink { to { opacity: .4 } }
.input { display: flex; align-items: flex-start; gap: 6px; border-top: 1px solid #000; padding: 6px 10px; background: #fffdf0 }
.input .prompt { font: 700 14px/1.5 ui-monospace, Menlo, monospace }
.input textarea { flex: 1; font: 14px/1.5 ui-monospace, Menlo, monospace; border: 0; outline: none; resize: none; background: none; padding: 0 }
.examples { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-top: 1px dashed #0004 }
.examples button { font-size: 12px; padding: 0 7px; box-shadow: 1px 1px 0 #000 }
.examples .ghost { margin-left: auto; box-shadow: none; border-style: dashed }
.p0 { color: #ff2284 } .p1 { color: #2269ff } .p2 { color: #14a888 }
.num { color: #2269ff } .str { color: #c4006a } .sp { font-weight: 700 } .cm { color: #0006 } .kw { color: #0008; font-style: italic }
.world { display: flex; flex-direction: column; gap: 8px; padding: 8px; overflow: auto }
.world > span { display: contents }
.nowline, .stack { display: flex; gap: 8px; align-items: baseline; font-size: 13px; min-height: 20px }
.nowline .what, .stack .what { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
	background: #000; color: #ffff88; padding: 0 6px; flex: none }
.nowline.look .what { background: #ff2284; color: #fff } .nowline.enter .what { background: #2269ff; color: #fff }
.nowline.leave .what, .nowline.done .what { background: #40dcba; color: #000 }
.nowline.failed .what { background: #ff2284; color: #fff }
.nowline .text { font: 12.5px ui-monospace, Menlo, monospace }
.nowline .yields { margin-left: auto; color: #0007; font-size: 12px; font-variant-numeric: tabular-nums }
.stack { flex-wrap: wrap; font: 12px ui-monospace, Menlo, monospace; color: #0009 }
.stack .call:last-child { color: #ff2284; font-weight: 700 }
.tree { flex: 1 }
.frame { position: relative; border: 1px solid #000; border-radius: 3px; background: #fff; padding: 5px 7px 6px;
	margin: 4px 0; transition: opacity 200ms, outline-color 120ms; outline: 0 solid transparent }
.frame.base { background: #fffdf0 }
.frame.global { background: #fff }
.frame.call, .frame.let { animation: born 300ms ease-out; background: #fff }
.frame.let { background: #f6fffc }
@keyframes born { from { transform: scale(.9); box-shadow: 0 0 0 4px #2269ff88 } }
.frame header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 3px }
.frame header > span { display: contents }
.frame header .tag { font-size: 12.5px }
.frame.base > header .tag { background: #000; color: #ffff88 }
.frame.global > header .tag { background: #40dcba }
.frame.active { border: 2px solid #ff2284; padding: 4px 6px 5px }
.frame.here { box-shadow: 0 0 12px 2px #ff228466 }
.frame.returned { opacity: .6; border-style: dashed }
.frame.kept { border-color: #2269ff }
.frame.passed { outline: 2px dashed #ff2284; outline-offset: 2px }
.frame.walking { outline: 3px solid #ff2284; outline-offset: 2px }
.frame.found { outline: 3px solid #14a888; outline-offset: 2px }
.frame.miss { outline: 3px solid #ff2284; outline-offset: 2px; background: #ffe0ee }
.frame.glow { box-shadow: 0 0 0 4px #2269ff, 0 0 16px 4px #2269ff66 }
.walkstep { font: 700 11px Jost, sans-serif; background: #ff2284; color: #fff; padding: 0 6px; border-radius: 9px }
.frame.found .walkstep { background: #14a888 }
.ret { font-style: normal; font: 12px ui-monospace, Menlo, monospace; background: #40dcba; border: 1px solid #000; padding: 0 5px }
.kept { font-style: normal; font-size: 11px; color: #2269ff; font-weight: 600 }
.builtins { display: flex; flex-wrap: wrap; gap: 3px; max-height: 37px; overflow: hidden; transition: max-height 200ms;
	-webkit-mask-image: linear-gradient(#000 60%, #0000) }
.builtins:hover { -webkit-mask-image: none }
.builtins:hover { max-height: 400px }
.builtins > span { display: contents }
.b { font: 11px ui-monospace, Menlo, monospace; border: 1px solid #0003; padding: 0 4px; border-radius: 2px; background: #fff }
.b.hit { background: #40dcba; border-color: #000; font-weight: 700 }
.vars { display: grid; grid-template-columns: max-content 1fr; gap: 1px 10px; font: 13px ui-monospace, Menlo, monospace }
.vars > span { display: contents }
.var { display: contents }
.var > span { padding: 0 4px; border-radius: 2px }
.var.hit > span { background: #c8f6ea } .var.hit .vname::after { content: " ✓"; color: #14a888 }
.var.hit.set > span, .var.hit.define > span { background: #ffff88 }
.vname { font-weight: 700 }
.val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.lam { background: #ffe0ee; border: 1px solid #000; border-radius: 9px; padding: 0 7px; cursor: help; font-size: 12px }
.lam .env { color: #2269ff; margin-left: 5px }
.data { color: #000 }
.kids { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start }
.kids > span { display: contents }
.kids .frame { flex: 0 1 auto; min-width: 120px }
.watches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; border-top: 1px dashed #0004; padding-top: 8px }
.watches > span { display: contents }
.hint { font-size: 12.5px; color: #0008 }
.watch { display: inline-flex; gap: 6px; align-items: center; border: 1px solid #000; border-radius: 2px;
	background: #fffdf0; padding: 2px 4px 2px 8px; box-shadow: 2px 2px 0 #000; font: 13px ui-monospace, Menlo, monospace }
.watch .eq { color: #0006 }
.wv { font-weight: 700; color: #2269ff; display: inline-block; font-size: 16px }
.werr { color: #d1006a; font-size: 12px; font-weight: 400 }
.watch .x { font-size: 11px; padding: 0 5px; box-shadow: none; border-color: #0004 }
`
