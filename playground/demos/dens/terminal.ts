/// <reference lib="dom" />
// terminal.ts: a little shell on this den's graph, in the page. the cardputer's shell's words
// (playground/cardputer/main/shell.c: name = value, name.key = value, rm name, esc clears the
// line), and a few more for walking the tree and running things: ls, cd, pwd, cat, start, stop.
// output is plain text; a failure says what went wrong in words. up and down walk the history,
// tab finishes a name
//
// reads go through places, untracked (peep: a command reads once, as it runs, and is no run);
// writes are the host's, in its scope, so each carries its site
//
//   createTerminal(host, el)
import createEntry from "@ermine/node/entry"
import { level, type Path, place, PlacesError, unplace } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { members } from "@ermine/places/lib"
import { upsert } from "@ermine/places/upsert"
import { RUNNER } from "@ermine/software"
import { type Host, KINDS, NAME, OUT } from "./host.ts"
import { brief } from "./files.ts"
import { siteHtml } from "./code.ts"
import { sound } from "./sound.ts"

type Tone = "echo" | "ok" | "err" | "said"
type Found = { id?: string; from?: string; names: string[] }

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)
const show = (p: Path) => `/${p.join("/")}`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const short = (name: string) => /^[0-9a-f]{20,}$/.test(name) ? name.slice(0, 6) + "…" : name
const hex4 = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0"))
		.join("")
const a = (kind: string) => `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`

// a value as typed, as the cardputer's parsed(): true, false, null, {}, "text", a number, or text
export function parsed(s: string): unknown {
	if (s === "true") return true
	if (s === "false") return false
	if (s === "null") return null
	if (s === "{}") return {}
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
	if (s !== "" && !Number.isNaN(Number(s))) return Number(s)
	return s
}

// a value on one line, as the cardputer's screen shows one: "text", 3, {2}, [4]
function shown(v: unknown): string {
	if (v === undefined) return ""
	if (v === null) return "null"
	if (typeof v === "string") return `"${v.length > 40 ? v.slice(0, 39) + "…" : v}"`
	if (typeof v === "function") return "(live)"
	if (ArrayBuffer.isView(v)) return `${v.byteLength} bytes`
	if (Array.isArray(v)) return `[${v.length}]`
	if (isMap(v)) return `{${Object.keys(v).length}}`
	return String(v)
}

const HELP = [
	"ls [path]          what's under a folder",
	"cd [path]          go into a folder (cd .. goes up; cd alone, to /)",
	"pwd                where you are",
	"cat path           what a node holds: its value, its attributes",
	'name = value       put a value at name: a number, true, false, null, {}, "text", or any text',
	"name.key = value   set one key of the map at name",
	"rm name            take name out (a thing that runs: stopped)",
	`start kind [name]  start a thing: ${KINDS.join(", ")}`,
	"stop name          stop a thing that runs here",
	"clear              a clean screen (esc clears the line)",
]

export function createTerminal(host: Host, root: HTMLElement) {
	const { places, hosted, table, software } = host
	const out = root.querySelector<HTMLElement>(".term-out")!
	const form = root.querySelector<HTMLFormElement>(".term-line")!
	const field = root.querySelector<HTMLInputElement>(".term-line input")!
	const prompt = root.querySelector<HTMLElement>(".term-prompt")!
	const where = root.querySelector<HTMLElement>(".term-where")

	let cwd: string[] = []
	const KEPT = "dens:terminal:history"
	let history: string[] = []
	try {
		const kept = JSON.parse(localStorage.getItem(KEPT) ?? "[]")
		if (Array.isArray(kept)) history = kept.filter((x) => typeof x === "string").slice(-50)
	} catch { /* none kept */ }
	let back = history.length // where up and down are in the history
	let draft = "" // the line typed before walking the history

	// ---- the screen ----
	function print(text: string, tone: Tone = "said") {
		for (const line of text.split("\n")) {
			const l = document.createElement("div")
			l.className = `l ${tone}`
			l.textContent = line === "" ? " " : line
			out.append(l)
		}
		while (out.childElementCount > 600) out.firstElementChild!.remove()
		out.scrollTop = out.scrollHeight
	}
	const ok = (text: string) => print(text, "ok")
	const no = (text: string) => (sound.no(), print(text, "err"))
	const showWhere = () => {
		prompt.textContent = `${show(cwd.map(short))} ›`
		if (where) where.textContent = show(cwd)
	}

	// ---- reading, through places, untracked ----
	const peep = <T>(f: () => T): T => places.peep(f)
	// a path typed: from / if it starts so, else from where you are; . and .. as a shell's
	function resolve(typed: string): string[] {
		const at = typed.startsWith("/") ? [] : [...cwd]
		for (const step of typed.split("/")) {
			if (step === "" || step === ".") continue
			if (step === "..") at.pop()
			else at.push(step)
		}
		return at
	}
	// what is at a path: its id (a folder of a contributor's: none), who put it there, the names
	// under it; nothing there: undefined
	function look(path: string[]): Found | undefined {
		return peep(() => {
			const names = members(places, path).map((m) => m.name)
			if (path.length === 0) return { id: String(places.root), from: "root", names }
			const m = members(places, path.slice(0, -1)).find((x) => x.name === path.at(-1))
			if (!m) return undefined
			return { id: m.id === level ? undefined : String(m.id), from: m.from, names }
		})
	}
	const value = (id: string) => peep(() => places.readValue("value", id))
	const attributes = (id: string) => {
		const v = peep(() => places.readValue("attributes", id))
		return isMap(v) ? v : undefined
	}
	const thingOf = (id: string) => {
		const r = attributes(id)?.[RUNNER]
		return isMap(r) && Array.isArray(r.at) ? String(r.at.at(-1)) : undefined
	}
	// the den a mirrored thing runs on, by name: its runner is offered under that den's node
	// (<node>/runners/<kind>)
	const runsOn = (id: string) => {
		const r = attributes(id)?.[RUNNER]
		const d = isMap(r) && typeof r.id === "string" ? r.id.split("/runners/")[0] : undefined
		const n = d === undefined ? undefined : attributes(d)?.[NAME]
		return typeof n === "string" ? n : "another den"
	}

	// ---- writing: the host's, in its scope ----
	const header = () => createChangeHeader(host.s)
	const write = <T>(f: () => T): T => {
		try {
			return hosted(f)
		} finally {
			host.soon()
		}
	}
	const why = (e: unknown) =>
		e instanceof PlacesError
			? ({
				"not-a-name": "that isn't a name a node can have",
				"nothing-there": "nothing is there",
				"already-there": "something is already there",
			} as Record<string, string>)[e.code] ?? e.message
			: e instanceof Error
			? e.message
			: String(e)

	// ---- the commands ----
	function ls(arg?: string) {
		const path = arg ? resolve(arg) : cwd
		const f = look(path)
		if (!f) return no(`ls: nothing is at ${show(path)}`)
		const rows = peep(() =>
			members(places, path).map((m) => {
				const at = [...path, m.name]
				const id = m.id === level ? undefined : String(m.id)
				const folder = members(places, at).length > 0
				return { name: m.name, id, from: m.from, folder }
			})
		).sort((x, y) => x.name < y.name ? -1 : 1)
		if (!rows.length) {
			return print(
				f.id && value(f.id) !== undefined
					? `${show(path)} holds a value, and nothing under it: cat it`
					: "(empty)",
			)
		}
		const width = Math.min(26, Math.max(...rows.map((r) => short(r.name).length + 1)))
		for (const r of rows) {
			const name = (short(r.name) + (r.folder ? "/" : "")).padEnd(width)
			let said = ""
			if (r.id) {
				const t = thingOf(r.id)
				const o = attributes(r.id)?.[OUT]
				const n = attributes(r.id)?.[NAME]
				said = t
					? `${a(t)}, running${o === undefined ? "" : ` · out ${brief(o, 24)}`}`
					: typeof n === "string"
					? n
					: shown(value(r.id))
			}
			if (r.from === "away" && r.id) said += `${said ? "  " : ""}(mirrored)`
			print(`${name}  ${said}`.trimEnd())
		}
	}

	function cd(arg?: string) {
		const path = arg ? resolve(arg) : []
		const f = look(path)
		if (!f) return no(`cd: nothing is at ${show(path)}`)
		if (!f.names.length && path.length) {
			return no(
				`cd: ${show(path)} has nothing under it to go into (cat it to see what it holds)`,
			)
		}
		cwd = path
		showWhere()
	}

	function cat(arg?: string) {
		if (!arg) return no("cat: which one? cat name")
		const path = resolve(arg)
		const f = look(path)
		if (!f) return no(`cat: nothing is at ${show(path)}`)
		if (!f.id) {
			return print(
				`${show(path)} is a folder with no node of its own: ls it to see what's under it`,
			)
		}
		const v = value(f.id)
		if (typeof v === "string") print(v)
		else if (typeof v === "function") {
			print("a live function: it runs in this den, and never travels")
		} else if (v === undefined) print("(no value)")
		else {
			try {
				print(JSON.stringify(v, null, 2) ?? String(v))
			} catch {
				print(String(v))
			}
		}
		const attrs = attributes(f.id)
		if (attrs && Object.keys(attrs).length) {
			print("attributes:", "echo")
			for (const [k, x] of Object.entries(attrs).sort(([p], [q]) => p < q ? -1 : 1)) {
				print(`  ${k === OUT ? "out" : k}  ${brief(x, 70)}`)
			}
		}
		// its last change, and the line of code it came from: a link to it
		const id = f.id
		const changes = peep(
			() => [places.readChange("value", id), places.readChange("attributes", id)],
		)
			.filter((c) => c !== undefined)
			.sort((p, q) => q!.time - p!.time)
		const c = changes[0]
		if (c) {
			const secs = Math.max(0, Math.round(Date.now() / 1000 - c.time))
			const when = secs < 10
				? "just now"
				: secs < 60
				? `${secs} s ago`
				: `${Math.round(secs / 60)} min ago`
			const at = c.external?.at(-1)
			const l = document.createElement("div")
			l.className = "l said"
			l.innerHTML = `${esc(`changed ${when}${at ? ", at " : ""}`)}${at ? siteHtml(at) : ""}`
			out.append(l)
			out.scrollTop = out.scrollHeight
		}
	}

	// name = value, and name.key = value: changed to it, else made with it (as the cardputer's)
	function set(name: string, text: string) {
		const dot = name.indexOf(".", name.lastIndexOf("/") + 1)
		const key = dot > 0 ? name.slice(dot + 1) : undefined
		const path = resolve(dot > 0 ? name.slice(0, dot) : name)
		if (!path.length) return no("=: the root can't hold a value here; give it a name: x = 1")
		const v = parsed(text)
		const f = look(path)
		try {
			if (f?.id) {
				const id = f.id
				write(() => places.commit(upsert(table, "value", id, key ? [key] : [], v, header())))
				return ok(`${show(path)}${key ? `.${key}` : ""} = ${shown(v) || "nothing"}`)
			}
			if (f) {
				return no(
					`=: ${show(path)} is a folder with no node of its own, so it can't hold a value`,
				)
			}
			// a new node, placed in the folder it is in
			const up = look(path.slice(0, -1))
			if (!up) {
				return no(
					`=: nothing is at ${show(path.slice(0, -1))}, so ${path.at(-1)} can't go there`,
				)
			}
			if (!up.id) {
				return no(
					`=: ${
						show(path.slice(0, -1))
					} is made by the den (${up.from}), not saved: nothing can be put in it. try / or /things`,
				)
			}
			const folder = up.id
			const id = crypto.randomUUID()
			write(() => {
				const h = header()
				table.add("value", id, createEntry(key ? { [key]: v } : v, h) as never)
				const kids = table.get("children", folder)
				if (kids === undefined) {
					table.add("children", folder, createEntry({ [path.at(-1)!]: id }, h) as never)
				} else places.commit(place(kids, path.at(-1)!, id, h))
			})
			ok(`made ${show(path)}${key ? `.${key}` : ""} = ${shown(v) || "nothing"}`)
		} catch (e) {
			no(`=: ${show(path)}: ${why(e)}`)
		}
	}

	function stopAt(cmd: string, path: string[], f: Found): boolean {
		if (!f.id) return false
		const p = host.find(f.id)
		if (p) {
			write(() => software.stop(p, "removed"))
			ok(`stopped ${show(path)}`)
			return true
		}
		const t = thingOf(f.id)
		if (t && f.from === "away") {
			no(`${cmd}: ${show(path)} runs on ${
				runsOn(f.id)
			}, not here: the × on its box asks that den to take it away`)
			return true
		}
		// running, and not one this den started: the den itself, or what it runs for itself
		if (f.from === "process") {
			no(`${cmd}: ${show(path)} is the den's own: it runs as long as the den does`)
			return true
		}
		return false
	}

	function rm(arg?: string) {
		if (!arg) return no("rm: which one? rm name")
		const path = resolve(arg)
		if (!path.length) return no("rm: the root stays")
		const f = look(path)
		if (!f) return no(`rm: nothing is at ${show(path)}`)
		if (stopAt("rm", path, f)) return
		if (f.from !== "children") {
			const by = f.from === "away"
				? "it is mirrored from another den, and goes when that den takes it away"
				: "the den made it: it isn't saved in a folder"
			return no(`rm: ${show(path)} can't be taken out: ${by}`)
		}
		const up = look(path.slice(0, -1))
		// the folder's own children entry: what is written
		const kids = up?.id ? table.get("children", up.id) : undefined
		if (!kids) return no(`rm: ${show(path)} isn't in a folder it can be taken out of`)
		try {
			write(() => places.commit(unplace(kids, path.at(-1)!, header())))
			ok(`took ${show(path)} out`)
		} catch (e) {
			no(`rm: ${show(path)}: ${why(e)}`)
		}
	}

	function start(kind?: string, name?: string) {
		if (!kind) return no(`start: start what? one of ${KINDS.join(", ")}`)
		if (!(KINDS as readonly string[]).includes(kind)) {
			return no(`start: there's no "${kind}" to start here. you can start: ${KINDS.join(", ")}`)
		}
		const at = name ? resolve(name) : ["home", `${kind}-${hex4()}`]
		if (!at.length) return no("start: give it a name: start counter mine")
		const r = write(() => software.run(`/system/den/runners/${kind}`, `/things/${kind}`, at))
		if (!("refused" in r)) return ok(`started ${a(kind)} at ${show(at)}`)
		switch (r.refused) {
			case "taken":
				return no(`start: something is already at ${show(at)}: pick another name`)
			case "not-a-runner":
				return no(`start: this den has nothing that runs ${a(kind)}`)
			case "not-there":
				return no(`start: /things/${kind} isn't there any more`)
			case "wrong-form":
				return no(`start: /things/${kind} isn't the kind of thing the ${kind} runner runs`)
		}
	}

	function stop(arg?: string) {
		if (!arg) return no("stop: stop what? stop name")
		const path = resolve(arg)
		const f = look(path)
		if (!f) return no(`stop: nothing is at ${show(path)}`)
		if (stopAt("stop", path, f)) return
		no(`stop: ${show(path)} isn't running: nothing to stop`)
	}

	function run(line: string) {
		const eq = line.indexOf("=")
		const [cmd, ...rest] = line.split(/\s+/)
		const arg = rest.join(" ") || undefined
		switch (cmd) {
			case "help":
			case "?":
				return print(HELP.join("\n"))
			case "ls":
				return ls(arg)
			case "cd":
				return cd(arg)
			case "pwd":
				return print(show(cwd))
			case "cat":
				return cat(arg)
			case "rm":
				return rm(arg)
			case "start":
				return start(rest[0], rest[1])
			case "stop":
				return stop(arg)
			case "clear":
				return void out.replaceChildren()
		}
		if (eq > 0) return set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
		no(`I don't know "${cmd}". name = value, rm name, or help for the rest`)
	}

	// ---- typing ----
	form.addEventListener("submit", (e) => {
		e.preventDefault()
		const line = field.value.trim()
		field.value = ""
		draft = ""
		print(`${prompt.textContent} ${line}`, "echo")
		if (!line) return
		if (history.at(-1) !== line) history.push(line)
		history = history.slice(-50)
		back = history.length
		try {
			localStorage.setItem(KEPT, JSON.stringify(history))
		} catch { /* kept for this visit only */ }
		sound.blip()
		try {
			run(line)
		} catch (e) {
			no(`that went wrong: ${why(e)}`)
		}
	})
	field.addEventListener("keydown", (e) => {
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault()
			if (back === history.length) draft = field.value
			back = Math.max(0, Math.min(history.length, back + (e.key === "ArrowUp" ? -1 : 1)))
			field.value = back === history.length ? draft : history[back]
			field.setSelectionRange(field.value.length, field.value.length)
		} else if (e.key === "Escape") {
			e.preventDefault()
			field.value = ""
			back = history.length
		} else if (e.key === "Tab") {
			e.preventDefault()
			complete()
		} else if (e.key === "l" && e.ctrlKey) {
			e.preventDefault()
			out.replaceChildren()
		} else if (e.key.length === 1 || e.key === "Backspace") sound.key()
	})
	// tab: the last word's last name finished from what's in its folder
	function complete() {
		const line = field.value
		const start = line.search(/\S*$/)
		const word = line.slice(start)
		const cut = word.lastIndexOf("/")
		const dir = cut < 0 ? cwd : resolve(word.slice(0, cut + 1) || "/")
		const stem = word.slice(cut + 1)
		const names = peep(() => members(places, dir).map((m) => m.name)).filter((n) =>
			n.startsWith(stem)
		)
		if (!names.length) return sound.no()
		let common = names[0]
		for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1)
		const one = names.length === 1
		const folder = one && peep(() => members(places, [...dir, names[0]]).length > 0)
		field.value = line.slice(0, start) + word.slice(0, cut + 1) + common +
			(one ? (folder ? "/" : " ") : "")
		if (!one) print(names.sort().map(short).join("  "))
		sound.key()
	}
	// a click anywhere in it: typing goes to the line (unless some text is being picked)
	root.addEventListener("click", () => {
		if (!getSelection()?.toString()) field.focus()
	})

	showWhere()
	print("this den's terminal: the cardputer's words, and a few for walking the tree. type help.")
	return { focus: () => field.focus() }
}
