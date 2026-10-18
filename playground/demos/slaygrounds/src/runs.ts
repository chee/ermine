/// <reference lib="dom" />
// a computer's or a process's own story, for the detail column: its status
// (ermine.computer.status), its latest run (the runs table: the process api's runs), what that run
// read (each with the write it saw) and wrote, where it was made (the world's sites: ermine/sites)
// and, for a process, its args, cwd and pin (ermine.process.*). live: the status and the rest are attributes
// read through places, the record through the process api's runs, tracked by ermine (feed), so
// each run's record redraws this
import { createRenderEffect } from "@solidjs/signals"
import { h, patch } from "./values.ts"
import { feed } from "./solid-ermine.ts"
import { type Link, sheet, value as shown } from "./sheet.ts"

// deno-lint-ignore no-explicit-any
type Any = any

const STATUS = "ermine.computer.status"
const ARGS = "ermine.process.args"
const CWD = "ermine.process.cwd"
const PIN = "ermine.process.pin"
const PENDING = Symbol.for("ermine.pending")

export type Hooks = {
	link: Link
	// the node with this id picked; not in the tree: undefined
	pick: (id: unknown) => (() => void) | undefined
	// a node's path from the root, else its id cut short
	name: (id: unknown) => string
	// a file's line shown in its editor: "program.ts:12"
	goto?: (where: string) => void
	// an example's file by the url it ran from: "host.ts", "program.ts"; none: undefined
	fileOf?: (url: string) => string | undefined
}

// the values live in the program's frame: kinds told without instanceof
const isError = (v: unknown): v is Error =>
	typeof v === "object" && v !== null && Object.prototype.toString.call(v) === "[object Error]"
// hh:mm:ss, and its milliseconds when the time has them (a change's is whole seconds)
const clock = (ms: number, fine = false) => {
	const d = new Date(ms)
	const two = (n: number) => String(n).padStart(2, "0")
	const s = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
	return fine ? `${s}.${String(d.getMilliseconds()).padStart(3, "0")}` : s
}
const took = (ms: number) => ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`

// rows of a sheet, each value an element or text
function rows(pairs: [string, Node | string][]): HTMLElement {
	const out = h("div", "sheet")
	for (const [k, v] of pairs) {
		const row = out.appendChild(h("div", "srow"))
		const cell = h("span", "sv")
		cell.append(v)
		row.append(h("span", "sk", k), cell)
	}
	return out
}

// a frame: file:line, a link to the editor when the file is the example's own
function frame(f: Any, hooks: Hooks): Node {
	const file = String(f.file)
	const own = hooks.fileOf?.(file)
	if (own && hooks.goto) {
		const at = `${own}:${f.line}`
		const a = h("button", "slink", at)
		a.title = "show in the editor"
		a.onclick = (e) => (e.stopPropagation(), hooks.goto!(at))
		return a
	}
	// a library's url, its last two names
	const short = file.replace(/[?#].*$/, "").split("/").slice(-2).join("/")
	const s = h("span", "sstr", `${own ?? short}:${f.line}`)
	s.title = file
	return s
}
const frames = (list: Any[] | undefined, hooks: Hooks): Node | string => {
	if (!list?.length) return h("span", "snone", "none")
	const box = h("span", "sframes")
	for (const f of list) box.append(frame(f, hooks))
	return box
}

// who and when a change says, in a line
const brief = (c: Any) =>
	c ? `${c.actor ?? "unknown"} ${c.time === undefined ? "" : clock(c.time * 1000)}`.trim() : ""

// the scopes from s up, each with a site: what it is, and where it was made
function chain(sites: Any, scope: Any): [string, Any][] {
	const out: [string, Any][] = []
	for (let s = scope; s !== undefined; s = s.parent) {
		const site = sites.siteOf(s)
		if (!site) continue
		const info = s.info ?? {}
		const what = s.kind === "compute"
			? "memo"
			: s.kind === "effect"
			? "effect"
			: "process" in info
			? "process"
			: "caller" in info
			? "send"
			: Object.keys(info)[0] ?? "scope"
		out.push([what, site])
	}
	return out
}

// the section for the node at id, into an element; call inside a Solid root
export function runSection(w: Any, into: HTMLElement, id: unknown, hooks: Hooks) {
	const box = into.appendChild(h("div", "runs"))
	const at = (k: string) => w.places.readValue("attributes", id, [k])
	const read = feed(w, () => ({
		run: w.apis?.runs(id),
		status: at(STATUS),
		args: at(ARGS),
		cwd: at(CWD),
		pin: at(PIN),
	}))
	// which reads and writes are open: by their place in the list and what they name
	const opened = new Set<string>()
	// each record is built fresh and laid over what is there (values.ts patch): what is kept keeps
	// its place, so the column does not jump while a computer ticks
	createRenderEffect(() => read(), (r: Any) => {
		const fresh = h("div")
		draw(fresh, r)
		patch(box, [...fresh.childNodes])
	})
	function draw(box: HTMLElement, r: Any) {
		if (!r) return
		const computer = [...(w.parts?.keys() ?? [])].find((c: Any) => w.parts.get(c).entry.id === id)
		const process = [...(w.processes?.values() ?? [])].find((p: Any) => p.id === id)
		const isProcess = !!process || r.args !== undefined || r.pin !== undefined
		if (!computer && !isProcess && r.run === undefined && r.status === undefined) return

		// ---- status and the latest run ----
		const run = r.run
		box.append(h("h3", "", "run"))
		const status = r.status === PENDING
			? h("span", "tag pending", "pending")
			: isError(r.status)
			? h("span", "rfail", `failed: ${r.status.message}`)
			: h("span", "snone", run ? "done" : "none")
		const pairs: [string, Node | string][] = [["status", status]]
		if (run) {
			pairs.push(["n", h("span", "snum", String(run.n))])
			const end = run.error && run.end === "failed"
				? h("span", "rfail", `failed: ${run.error.message}`)
				: h("span", run.end === "done" ? "sstr" : "rfail", String(run.end))
			pairs.push(["ended", end])
			pairs.push(["at", clock(run.ended, true)])
			pairs.push([
				"took",
				run.started === undefined
					? h("span", "snone", "its start not seen")
					: took(run.ended - run.started),
			])
		}
		box.append(rows(pairs))

		// ---- what it read, each with the write it saw; what it wrote ----
		if (run) {
			list(box, "read", run.reads ?? [], "nothing", (x: Any, i: number) => {
				if ("key" in x && !("id" in x)) {
					return { key: `r${i}`, head: [String(x.key)], change: null }
				}
				return {
					key: `r${i}:${x.part}:${String(x.id)}`,
					head: where(x, hooks),
					change: x.change,
				}
			})
			list(box, "wrote", run.writes ?? [], "nothing", (x: Any, i: number) => ({
				key: `w${i}:${x.part}:${String(x.id)}`,
				head: where(x, hooks),
				change: x.change ?? null,
			}))
		}

		// ---- where it was made ----
		const scope = computer ?? process?.scope
		if (scope && w.sites) {
			const made = chain(w.sites, scope)
			box.append(h("h3", "", "made at"))
			box.append(
				made.length
					? rows(made.map(([what, site]) => [what, frame(site, hooks)]))
					: h("p", "empty", "no site: made without the world's sites"),
			)
		}

		// ---- a process: its args, working folder and pin ----
		if (isProcess) {
			box.append(h("h3", "", "process"))
			const args = r.args as string[] | undefined
			const ps: [string, Node | string][] = [
				["args", args?.length ? shown([...args]) : h("span", "snone", "none")],
				["cwd", Array.isArray(r.cwd) ? "/" + r.cwd.join("/") : h("span", "snone", "none")],
			]
			box.append(rows(ps))
			if (r.pin) box.append(pin(r.pin, hooks))
		}
	}

	// a folding list: a row each, its head naming where, its body the change there
	function list(
		into: HTMLElement,
		title: string,
		items: Any[],
		none: string,
		row: (x: Any, i: number) => { key: string; head: (Node | string)[]; change: Any },
	) {
		into.append(h("h3", "", `${title} (${items.length})`))
		if (!items.length) return void into.append(h("p", "empty", none))
		const out = into.appendChild(h("div", "allparts"))
		items.forEach((x, i) => {
			const { key, head, change } = row(x, i)
			const el = out.appendChild(h("div", "apart"))
			el.dataset.key = key
			const top = el.appendChild(h("div", "aphead"))
			top.appendChild(h("span", "arrow", change ? (opened.has(key) ? "▾" : "▸") : "·"))
			top.append(...head, h("span", "pv", change ? brief(change) : "nothing there"))
			if (!change) return
			const body = el.appendChild(h("div", "apbody"))
			// the body is found from the click: the row on the page may be an older one, laid over
			const draw = (body: HTMLElement) => {
				body.replaceChildren()
				if (body.hidden) return
				const site = change.external as Any[] | undefined
				body.append(sheet([
					["who", change.actor],
					...(change.reader !== undefined
						? [["reader", change.reader] as [string, unknown]]
						: []),
					["when", change.time === undefined ? undefined : clock(change.time * 1000)],
				], hooks.link))
				if (site?.length) body.append(rows([["site", frames(site, hooks)]]))
			}
			body.hidden = !opened.has(key)
			draw(body)
			top.onclick = (e) => {
				const top = e.currentTarget as HTMLElement
				const body = top.parentElement!.querySelector<HTMLElement>(":scope > .apbody")!
				body.hidden = !body.hidden
				top.querySelector(":scope > .arrow")!.textContent = body.hidden ? "▸" : "▾"
				body.hidden ? opened.delete(key) : opened.add(key)
				draw(body)
			}
		})
	}
}

// a read's or write's place: the node (a link that picks it), and which part of it
function where(x: Any, hooks: Hooks): Node[] {
	const name = hooks.name(x.id)
	const go = hooks.pick(x.id)
	const node = go ? h("button", "slink", name) : h("span", "sstr", name)
	if (go) {
		node.title = "pick this node"
		node.onclick = (e: Event) => (e.stopPropagation(), go())
	}
	const path = (x.path ?? []) as unknown[]
	const part = x.part === "value" && !path.length && !x.keys
		? ""
		: [x.part, ...path.map(String)].join(".") + (x.keys ? " keys" : "")
	return part ? [node, h("span", "rpart", part)] : [node]
}

// the pin: the program, each step of its chain, the box and the cwd
function pin(p: Any, hooks: Hooks): HTMLElement {
	const place = (s: Any) => {
		const span = h("span", "sframes")
		const at = "/" + ((s.at ?? []) as string[]).join("/")
		const go = hooks.pick(s.id)
		const a = go ? h("button", "slink", at) : h("span", "sstr", at)
		if (go) a.onclick = go
		span.append(a)
		const hash = s.hash ?? s.attributes
		if (hash) span.append(h("span", "rpart", String(hash).slice(0, 12)))
		if (s.identity !== undefined) {
			span.append(
				h(
					"span",
					"rpart",
					typeof s.identity === "string" ? s.identity : JSON.stringify(s.identity),
				),
			)
		}
		return span
	}
	const ps: [string, Node | string][] = []
	if (p.program) ps.push(["program", place(p.program)])
	;((p.chain ?? []) as Any[]).forEach((s, i) => ps.push([`step ${i + 1}`, place(s)]))
	if (p.box !== undefined) ps.push(["box", hooks.name(p.box)])
	if (Array.isArray(p.cwd)) ps.push(["pin cwd", "/" + p.cwd.join("/")])
	const fold = h("details", "appatch")
	fold.open = true
	fold.append(h("summary", "", "pin"), rows(ps))
	return fold
}
