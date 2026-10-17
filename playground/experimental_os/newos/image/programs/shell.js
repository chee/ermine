// /programs/shell: a shell on a line. A line is a node with rx (the last
// bytes typed), stats ({"rx": how many in all}) and tx (bytes to send): the
// serial line, /dev/uart0, or a terminal window's. Its data names the line.
// It runs as the person at the Mac. Each command is the graph's operation,
// made through this process's api, so protect sees the person and this
// program, and every change it makes says so.
//
// Depth is where the view starts, and the prompt says it: an app (go bar),
// dev> (the whole graph), hw> (/hw), stack> (rules, replacing code).
// Anything else is a line as /etc/keys has them: an address called, or a
// program started. Going deeper takes another tool: to
// edit a driver, a rule that allows it; to send the metal raw commands, the
// service flag at power-on; for the bare graph, booting bare.
import { data, drop, effect, first, idAt, isStatus, make, put, val, whole } from "ermine:kit"
import { here, kill } from "ermine:os"
import * as readline from "ermine:readline"
import * as views from "ermine:views"

export default (given) => {
	const { api, self, name } = given
	const enc = new TextEncoder()
	// this process's own node, from the root: its effects are placed inside it, so they read it by this
	const ME = here(self)
	const LINE = ["/", ...(data(given)?.line ?? ["dev", "uart0"])]
	const me = val(api, ["/", "hw"])?.user ?? "?"
	// the line being edited, readline's way: pos the cursor in it, kill what C-k, C-u and C-w took,
	// hist the lines run, at where up and down are in it (hist.length: the line being typed, kept in
	// draft), search a C-r in progress
	const s = {
		line: "",
		pos: 0,
		kill: "",
		seen: null,
		aside: false,
		depth: "dev",
		root: [],
		cwd: [],
		hist: [],
		at: 0,
		draft: "",
		esc: "",
		search: null,
	}
	// the lines run, every shell's, newest last: a document, kept on the card, so a shell started again,
	// or another, has them; hist is its copy, as the keys read it
	const HISTORY = ["/", "apps", "shell", "history"]
	make(api, HISTORY.slice(0, -2), "shell", null)
	make(api, HISTORY.slice(0, -1), "history", [])
	s.hist = [...(val(api, HISTORY) ?? [])]
	s.at = s.hist.length

	// --- output

	const out = (api, text) => {
		const tx = val(api, [...LINE, "tx"])
		if (tx === undefined) return
		const old = new Uint8Array(tx)
		const add = enc.encode(text)
		const all = new Uint8Array(old.length + add.length)
		all.set(old)
		all.set(add, old.length)
		api.write([...LINE, "tx"], whole(all))
	}
	const NL = "\r\n"
	const dim = (t) => `\x1b[2m${t}\x1b[0m`
	const bold = (t) => `\x1b[1m${t}\x1b[0m`
	const red = (t) => `\x1b[31m${t}\x1b[0m`
	const cyan = (t) => `\x1b[36m${t}\x1b[0m`
	const prompt = () => bold(s.depth === "app" ? `${s.root[1]}> ` : `${s.depth}> `)

	/** a value as one line: bytes, typed arrays and live values named, not shown */
	const show = (v) =>
		JSON.stringify(v, (_k, x) => {
			if (x instanceof Uint8Array) return `<bytes ${x.byteLength}>`
			if (ArrayBuffer.isView(x)) {
				return `<${x.constructor.name.replace("Array", "").toLowerCase()}[${x.length}]>`
			}
			if (typeof x === "function") return "<live function>"
			if (
				x && typeof x === "object" && !Array.isArray(x) &&
				Object.getPrototypeOf(x) !== Object.prototype
			) {
				return `<live ${String(x)}>`
			}
			return x
		}) ?? "undefined"
	const clip = (t, n = 60) => (t.length > n ? t.slice(0, n - 1) + "…" : t)

	// --- paths: from the depth's root, as names, and as the graph's address

	const names = (path = "") => {
		const base = path.startsWith("/") ? [] : [...s.cwd]
		for (const n of path.split("/")) {
			if (!n || n === ".") continue
			if (n === "..") base.pop()
			else base.push(n)
		}
		return base
	}
	const addr = (path) => ["/", ...s.root, ...names(path)]
	/** the id of the node at an address, which must be there */
	const idOf = (api, address) => {
		const id = idAt(api, address)
		if (!id) throw new Error(`nothing at ${views.shown(address)}`)
		return id
	}
	/** a path's slot: the address of the node it is in, and its last name */
	const slot = (path) => {
		const at = names(path ?? "")
		if (!at.length) throw new Error("a path that names a node, as /n/notes")
		return [["/", ...s.root, ...at.slice(0, -1)], at.at(-1)]
	}
	/** every path a pattern with * in it reaches, from the depth's root; a path without one is itself */
	const glob = (api, path = "") => {
		if (!path.includes("*")) return [path]
		let found = [[]]
		for (const part of names(path)) {
			const next = []
			for (const at of found) {
				if (!part.includes("*")) {
					next.push([...at, part])
					continue
				}
				const re = new RegExp(
					"^" + part.split("*").map((x) =>
						x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
					).join(".*") + "$",
				)
				for (const n of api.children(["/", ...s.root, ...at])) {
					if (re.test(n)) next.push([...at, n])
				}
			}
			found = next
		}
		return found.map((ns) => "/" + ns.join("/"))
	}
	const each = (api, path, f) => glob(api, path).map((p) => f(p)).join(NL)
	const shown = (path) => "/" + names(path).join("/")
	const json = (text) => {
		try {
			return JSON.parse(text)
		} catch {
			throw new Error(`not JSON: ${text}`)
		}
	}
	// a version's change, one line: when, and the process that made it (the change gives its time, node and reader)
	const header = (ids, v) =>
		[views.clock(v.change?.time), v.change?.reader ? short(ids, v.change.reader) : null].filter(
			Boolean,
		).join(" · ")
	const short = (ids, pid) => `${ids.pids[pid] ?? "?"} ${views.short(pid)}`
	const route = (item) => (item?.route ?? []).map((st) => st.name).join("/")
	/** the item at an address that has a value: the first, with its versions */
	const item = (api, address) => api.content(address).find((i) => i.versions)
	/** an item's version that is its value, not a process's status in front of it */
	const current = (i) => i?.versions?.find((v) => !isStatus(v))

	// --- commands

	const help = () =>
		[
			bold("anywhere"),
			"  ls [path]               the directory: names, ids (… pending), values",
			"  tree [path] [depth]     what is below",
			"  read [path]             every item: value, route, and the change that made it",
			"  cat [path]  why [path]  the value; who made it and why",
			"  write path json   set path key json   patch path json   mk path [json]   ln from to   mount path id   rm path",
			'  info path name [json]   a node\'s info of that name, or set: info hello ermine.program.provisions {"needs":["c"]}',
			dim('  a name with spaces: "My Computer" or My\\ Computer'),
			dim(
				'  patch /etc/desktop {"type":"set","path":[],"key":"hint","value":"hi"}   a list of patches is one change',
			),
			"  share path [live] [nopresence]   share path, and print its id: a document both machines write, and what it holds",
			"                          on another machine: mount path id [live] [nopresence], as mount /n/mac1 id",
			"                          live: this machine's live state (pointer, focus, drags, presence) goes to its peers,",
			"                          while /etc/sync's live is on (Control Panels, Sync); theirs shows in /dev/sync/presence",
			"                          while /etc/sync's presence is on; nopresence: not for this document (presence: again)",
			"  cd path   pwd   start dir program [name]   kill pid   call path [json...]",
			"  src path   sed path s/old/new/   replace pid|path runs a program's new code (stack>)",
			"  go <app>|dev|hw|stack   help   clear",
			"  graph [path]   edit path   say text   beep   copy text   browse [url]   windows [off]",
			"  erminex <channel or name>   this window shows what erminex shares there, until cmd-w (erminex <name> <cmd>, in a terminal)",
			"  erminex <name>|- <cmd...>   cmd run on a pty and its window shared under name (-: a fresh id), till it exits",
			"  pty [argv...]           a Mac program on a pseudo-terminal, on this line ($SHELL -l if none), until it exits",
			"  term [path]             a terminal window; given a line, a session's (/dev/pty/1), it shows that",
			"  wm <ctl line>: view 2, select left, send sel right, colmode sel stack, tag sel 3, kill",
			"  exit (or ctrl-d): on the console, power off; in a window, close it      off: power off",
			"  /address [words]   call it, as /etc/keys does      <program> [words]   start /programs/<program>",
			bold("stack>") + " rules   rule n json   unrule n   replace pid|path",
			dim(
				"keys: /etc/keys binds them (Keys, in the world menu): A-return a shell, s-w close, A-tab next; ctrl-cmd-w each window a Mac window",
			),
		].join(NL)

	/** the value at an address as one line: "" if none, red if protect refused it */
	const peek = (api, address, n) => {
		const i = api.content(address).find((i) => i.versions || i.refused)
		return !i ? "" : i.refused ? red("refused") : clip(show(first(i.versions)), n)
	}
	const ls = (api, path) => {
		const rows = []
		for (const name of api.children(addr(path))) {
			const ids = api.children(addr(path), name).map((i) => (i.node ? "" : "…") + i.id).join(
				", ",
			)
			rows.push(
				`${cyan(name.padEnd(14))} ${dim(clip(ids, 30).padEnd(30))} ${
					peek(api, [...addr(path), name], 48)
				}`,
			)
		}
		return rows.join(NL)
	}

	const tree = (api, path, depth) => {
		const rows = []
		const seen = new Set()
		const walk = (address, indent, d) => {
			for (const name of api.children(address)) {
				const it = api.children(address, name)[0]
				if (!it) continue
				const tag = (it.node ? "" : " …") + (seen.has(it.id) ? " (again)" : "")
				const v = peek(api, [...address, name], 40)
				rows.push(`${indent}${cyan(name)}${dim(tag)}  ${v === "null" ? "" : dim(v)}`)
				if (seen.has(it.id) || !it.node || d >= depth) continue
				seen.add(it.id)
				walk([...address, name], indent + "  ", d + 1)
			}
		}
		walk(addr(path), "", 1)
		return rows.join(NL)
	}

	// every item at the path, each with its versions: the value, where it was reached by, the change that made it
	const read = (api, path) => {
		const ids = views.ids(api)
		return api.content(addr(path)).map((i) =>
			i.refused
				? red(`refused`) + dim(`  from   ${route(i)}`)
				: !i.versions
				? dim(`  from   ${route(i)}  (pending: not here yet)`)
				: [
					show(first(i.versions)),
					dim(`  from   ${route(i)}`),
					...i.versions.map((v, n) =>
						dim(
							`  ${n ? "or    " : "change"} ${header(ids, v)}${
								isStatus(v) ? "  (status)" : ""
							}`,
						)
					),
				].join(NL)
		).join(NL) || dim("(nothing: no node is here)")
	}

	const why = (api, path) => {
		const v = current(item(api, addr(path)))
		if (!v) return dim("(nothing here)")
		const c = v.change
		if (!c) return dim("no change made it")
		const ids = views.ids(api)
		const lines = [header(ids, v)]
		lines.push(`${bold("time")}    ${views.clock(c.time)}`)
		if (c.reader) lines.push(`${bold("reader")}  ${short(ids, c.reader)}`)
		lines.push(`${bold("node")}    ${c.node}`)
		// the change's header would also say the actor (and the processes and handlers it came through), the
		// site and the cause; the runner gives a program the time, node and reader
		for (const k of ["actor", "site", "cause"]) {
			if (c[k] !== undefined) lines.push(`${bold(k.padEnd(7))} ${show(c[k])}`)
		}
		return lines.join(NL)
	}

	// a program's source: a string, or a {kind, source} map's
	const program = (api, path) => {
		const v = first(item(api, addr(path))?.versions)
		const src = typeof v === "string" ? v : v?.source
		if (typeof src !== "string") throw new Error(`${shown(path)} holds no program`)
		return src
	}

	const sed = (api, path, expr) => {
		if (!expr?.startsWith("s") || expr.length < 4) throw new Error("sed path s/old/new/[g]")
		const d = expr[1]
		const [, from, to, flags = ""] = expr.split(d)
		const src = program(api, path)
		if (!src.includes(from)) throw new Error(`"${from}" is not in ${shown(path)}`)
		const next = flags.includes("g") ? src.split(from).join(to) : src.replace(from, to)
		const bare = typeof first(item(api, addr(path))?.versions) === "string"
		const c = api.write(addr(path), bare ? whole(next) : [{ path: ["source"], value: next }])
		return `${shown(path)}: new code at t=${c}; stack> replace <pid> runs it.`
	}

	const rules = (api) => val(api, ["/", "etc", "rules"]) ?? []
	const setRules = (api, list) => api.write(["/", "etc", "rules"], whole(list))

	// --- sharing (layers/subduction/SYNC.tex, Making and mounting; PRESENCE.tex). Every node made
	// by name is a document, its id from sync, the image's and the root among them, and sharing one
	// is letting another machine follow it: both write it, and what it holds. An ephemeral node is
	// never a document; one in a shared document is shown there, live. /dev/sync/shared holds what
	// this machine shares and mounts, a slot each, by its hex; its value, each one's choices,
	// {<hex>: {live, presence}}: live, whether this machine's live state (its pointer, focus, a
	// window mid-drag, its presence) goes to the document's peers, with /etc/sync's live and each
	// device's switch; presence, whether the peers' shows here, in /dev/sync/presence, with
	// /etc/sync's presence (card/drv_sync.c, Live state). The words after share or mount choose:
	// live (not without it), presence (so without it), nolive, nopresence.

	const DOC = /^ermine:\/\/([0-9a-f]{64})$/
	const SHARED = ["/", "dev", "sync", "shared"]
	/** the choices the words make: a word chooses, "no" before it unchooses, none the default */
	const choices = (words) => ({
		live: words.includes("live") && !words.includes("nolive"),
		presence: !words.includes("nopresence"),
	})
	const shared = (api, id, choice) => {
		const hex = DOC.exec(id)[1]
		if (!api.children(SHARED, hex).some((i) => i.id === id)) {
			api.insert(idAt(api, SHARED), hex, id)
		}
		const all = val(api, SHARED)
		if (all && typeof all === "object") {
			api.write(SHARED, [{ path: [hex], value: choice }])
		} else api.write(SHARED, whole({ [hex]: choice }))
	}
	const liveSaid = (api, id) => {
		const c = val(api, SHARED)?.[DOC.exec(id)[1]] ?? {}
		return (c.live === true
			? "live state goes with it (pointer, focus, drags, presence: with /etc/sync's live on)"
			: "live state does not go with it (share or mount it with the word live)") +
			(c.presence === false
				? "; peers' live state not shown (the word presence shows it)"
				: "; peers' live state shown in /dev/sync/presence (nopresence hides it)")
	}
	/** share path [live] [nopresence]: made if nothing is there; a document is shared as itself */
	const share = (api, path, choice) => {
		const at = names(path)
		const where = "/" + [...s.root, ...at].join("/")
		if (!at.length) {
			throw new Error("share a path, as share /n/notes: the root holds the whole machine")
		}
		const parent = ["/", ...s.root, ...at.slice(0, -1)]
		const name = at.at(-1)
		// a member that is arriving has an item in front of it, with no node yet (sync)
		const found = api.children(parent, name)[0]
		if (!found) {
			const id = put(api, idOf(api, parent), name, null)
			shared(api, id, choice)
			return id + NL +
				dim(
					`${where}: made, a document, and shared: both machines write it. There: mount <path> ${id}`,
				) + NL + dim(liveSaid(api, id))
		}
		if (!DOC.test(found.id)) {
			throw new Error(
				`${where} is ${found.id}, ephemeral: not a document, so not shared (it is shown live in a shared document that holds it)`,
			)
		}
		shared(api, found.id, choice)
		return found.id + NL +
			dim(
				`${where}: a document, shared: both machines write it, and what it holds. There: mount <path> ${found.id}`,
			) + NL + dim(liveSaid(api, found.id))
	}

	// leaving: on the console the machine powers off, as a console login's exit ends the session;
	// anywhere else this shell ends itself, and its window with it
	// a program started by the window manager's policy (/dev/wm/launch), so it outlives the run of this
	// shell that started it (SCHEDULER.tex, Children); op is {address, program (a path), name?, data?}. A call
	// made in a part answers nothing, so its pid is said only when this started the program itself
	const launch = (g, op) => {
		const at = val(g.api, ["/", "dev", "wm", "launch"])
		if (Array.isArray(at)) return g.call(at, [op])
		const pid = g.start({
			address: op.address,
			program: op.program,
			...(op.name ? { name: op.name } : {}),
		})
		if (op.data != null) put(g.api, pid, "data", op.data)
		return pid
	}

	// a process the window manager started, by its pid: its node, from /dev/wm/client/*
	const proc = (api, pid) => {
		const WM = ["/", "dev", "wm", "client"]
		for (const id of api.children(WM)) {
			const c = val(api, [...WM, id])
			if (c?.pid === pid && Array.isArray(c.node) && !c.away) {
				return c.node[0] === "/" ? c.node : ["/", ...c.node]
			}
		}
		throw new Error(`no window's process is ${pid}`)
	}

	const leave = (api) => {
		if (LINE.join("/") === "//dev/uart0") {
			api.write(["/", "dev", "power", "switch"], whole({ off: true }))
			return dim("powering off")
		}
		// ended once what the keys before it said is written (the keys' effect), as a script's lines and exit come together
		s.left = true
		return ""
	}

	// a line's words: spaces part them, but not in "double quotes" or after a backslash (/home/desktop/My\ Computer);
	// each with where it ends, so the rest of a line (json, a ctl line) is taken as typed
	const words = (line) => {
		const out = []
		let w = null, q = false
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]
			if (ch === "\\" && i + 1 < line.length) (w ??= { text: "" }).text += line[++i]
			else if (ch === '"' && (q || w === null || w.quoted)) {
				q = !q
				;(w ??= { text: "" }).quoted = true
			} else if (!q && /\s/.test(ch)) { if (w) out.push({ ...w, end: i }), (w = null) }
			else (w ??= { text: "" }).text += ch
		}
		if (w) out.push({ ...w, end: line.length })
		return out
	}
	const run = (g, line) => {
		const { api } = g
		line = line.trim()
		const ws = words(line)
		const [cmd = "", ...args] = ws.map((w) => w.text)
		const rest = (k) => (ws[k] ? line.slice(ws[k].end).trim() : "")
		switch (cmd) {
			case "":
				return ""
			case "help":
			case "?":
				return help()
			case "clear":
				return "\x1b[2J\x1b[H"
			case "pwd":
				return "/" + s.cwd.join("/") + dim(`   (the view starts at /${s.root.join("/")})`)
			case "cd": {
				const to = names(args[0] ?? "/")
				if (to.length && !idAt(api, ["/", ...s.root, ...to])) {
					throw new Error(`nothing at /${to.join("/")}`)
				}
				s.cwd = to
				return ""
			}
			case "ls":
				return each(api, args[0], (p) => ls(api, p))
			case "tree":
				return tree(api, args[0], Number(args[1] ?? 3))
			case "read":
				return each(api, args[0], (p) => read(api, p))
			case "cat":
				return each(
					api,
					args[0],
					(p) =>
						api.content(addr(p)).filter((i) => i.versions).map((i) => show(first(i.versions)))
							.join(NL),
				)
			case "why":
				return each(api, args[0], (p) => why(api, p))
			case "write": {
				const c = api.write(addr(args[0]), whole(json(rest(1))))
				return dim(`t=${c}`)
			}
			case "patch": {
				// patches as GRAPH.tex has them: one, or a list, sent into the node
				const p = json(rest(1))
				const c = api.write(addr(args[0]), Array.isArray(p) ? p : [p])
				return dim(`t=${c}`)
			}
			case "set": {
				const c = api.write(addr(args[0]), [{ path: [args[1]], value: json(rest(2)) }])
				return dim(`t=${c}`)
			}
			case "info": {
				// info path name [json]: what a node says of itself under name (as a program its provisions), or that set
				if (!args[1]) throw new Error("info path name [json]")
				if (args.length > 2) {
					return dim(`t=${api.set(addr(args[0]), args[1], whole(json(rest(2))))}`)
				}
				return each(
					api,
					args[0],
					(p) =>
						api.info(addr(p), args[1]).filter((i) => i.versions).map((i) =>
							show(i.versions[0]?.content ?? null)
						).join(NL),
				)
			}
			case "mk": {
				// mk path [json]: a node made at path, holding json, or null
				const [parent, name] = slot(args[0])
				const id = put(api, idOf(api, parent), name, args.length > 1 ? json(rest(1)) : null)
				return dim(`id ${id}`)
			}
			case "mount": {
				// mount path id [live] [presence]: the node of that id placed at path; live: this machine's live
				// state goes to it; nopresence: its peers' not shown here
				const [parent, name] = slot(args[0])
				if (!args[1]) throw new Error("mount path id [live] [nopresence]")
				// mounted there already: only its choices change
				const there = api.children(parent, name).some((i) => i.id === args[1])
				const c = there ? null : api.insert(idOf(api, parent), name, args[1])
				if (!DOC.test(args[1])) return dim(`t=${c}`)
				// a document this machine does not have is followed from the server: /dev/sync/shared holds it
				const arriving = api.children(parent, name).find((i) => i.id === args[1])
				shared(api, args[1], choices(args.slice(2)))
				const said = liveSaid(api, args[1])
				if (there) return dim(`mounted already; ${said}`)
				if (arriving?.node) return dim(`t=${c}; ${said}`)
				return dim(
					`t=${c}; arriving from the server (cat /dev/sync/link); it reads pending until it comes; ${said}`,
				)
			}
			case "ln": {
				// ln from to: the node at from placed at to as well, one node in two places (a link, not a copy)
				if (!args[1]) throw new Error("ln from to")
				const [fp, fn] = slot(args[0])
				const id = api.children(fp, fn)[0]?.id
				if (!id) return `ln: nothing at ${args[0]}`
				const [parent, name] = slot(args[1])
				const c = api.insert(idOf(api, parent), name, id)
				return dim(`t=${c} id ${id}`)
			}
			case "share":
				return share(api, args[0], choices(args.slice(1)))
			case "rm": {
				// rm path: what the path's last name holds, its first member, let go from its slot
				const [parent, name] = slot(args[0])
				if (!api.children(parent, name).length) throw new Error(`nothing at ${shown(args[0])}`)
				drop(api, parent, name)
				return dim(`let go: ${shown(args[0])}`)
			}
			case "start": {
				const pid = launch(g, {
					address: addr(args[0]),
					program: args[1].split("/").filter((n) => n),
					name: args[2],
				})
				return `${pid ? `${pid} ` : "started "}in ${shown(args[0])}`
			}
			case "kill": {
				proc(api, args[0])
				kill(args[0])
				return dim(`killed: ${args[0]}`)
			}
			case "call": {
				// a "quoted" word is a string: words took its quotes
				const got = g.call(
					addr(args[0]),
					ws.slice(2).map((w) => (w.quoted ? w.text : json(w.text))),
				)
				// a call made in a part answers nothing: it runs once this ends
				return got == null ? "" : show(got)
			}
			case "src":
				return program(api, args[0]).split("\n").map((l, i) =>
					dim(String(i + 1).padStart(3)) + " " + l
				).join(NL)
			case "sed":
				return sed(api, args[0], rest(1))
			case "go": {
				const to = args[0]
				if (to === "dev" || to === "stack") {
					s.depth = to
					s.root = []
				} else if (to === "hw") {
					s.depth = "hw"
					s.root = ["hw"]
				} else if (to && idAt(api, ["/", "apps", to])) {
					s.depth = "app"
					s.root = ["apps", to]
				} else throw new Error("go <app>|dev|hw|stack")
				s.cwd = []
				return dim(
					{
						app: `the view starts at /apps/${to}, as that app's does`,
						dev: "the whole graph; driver code is behind a rule (stack> rules)",
						hw: "/hw, made from the device tree the metal handed over at boot",
						stack: "rules and replacing code: what everything above stands on",
					}[s.depth],
				)
			}
			case "say":
			case "beep":
			case "copy": {
				if (cmd === "copy") {
					api.write(
						["/", "dev", "clip", "text"],
						whole({ text: rest(0), count: 0, from: "shell" }),
					)
					return dim("on the Mac's pasteboard")
				}
				const old = val(api, ["/", "dev", "sound", cmd]) ?? {}
				api.write(["/", "dev", "sound", cmd], whole({ text: rest(0), n: (old?.n ?? 0) + 1 }))
				return ""
			}
			case "wm": {
				// the window manager's ctl, as wmiir xwrite /ctl; a call answers nothing, so ctl says its answer in /dev/wm/said
				const to = val(api, ["/", "dev", "wm", "ctl"])
				if (!to) throw new Error("no window manager serves /dev/wm")
				const n = val(api, ["/", "dev", "wm", "said"])?.n ?? 0
				g.call(to, [rest(0)])
				const said = val(api, ["/", "dev", "wm", "said"])
				if (said && said.n !== n) return String(said.answer)
				// the call queued: the said effect prints the answer when it comes
				s.wm = { n, line: rest(0) }
				return ""
			}
			case "graph": {
				const pid = launch(g, {
					address: ["/", "apps", "graph"],
					program: ["programs", "graph"],
					data: { path: names(args[0] ?? "").length ? [...s.root, ...names(args[0])] : [] },
				})
				return dim(`${pid ? `${pid}: ` : ""}the graph`)
			}
			case "edit": {
				if (!args[0]) throw new Error("edit path")
				const pid = launch(g, {
					address: ["/", "apps", "edit"],
					program: ["programs", "edit"],
					data: { path: [...s.root, ...names(args[0])] },
				})
				return dim(`${pid ? `${pid}: ` : ""}editing ${shown(args[0])}`)
			}
			case "browse": {
				const pid = launch(g, {
					address: ["/", "apps", "browser"],
					program: ["programs", "browser"],
					data: args[0] ? { url: rest(0) } : null,
				})
				return dim(`${pid ? `${pid}: ` : ""}a browser`)
			}
			case "erminex": {
				// what erminex shares on a channel: in this shell's window, as a program run in a rio window is,
				// until it ends (cmd-w), and the shell has the window back; from the console, a window of its own
				if (!args[0]) {
					throw new Error(
						"erminex <channel or name>   (shared from a terminal: erminex <name> <cmd>)",
					)
				}
				if (!idAt(api, ["/", "dev", "link", "views"])) {
					throw new Error("erminex needs /dev/link, the link driver, which is not running")
				}
				if (args.length > 1) {
					// erminex <name> <cmd>: cmd run on a pty here and its window shared under name ("-": a fresh id), as
					// erminex shares one from a terminal (drivers/link, on/share); a call answers nothing: the share says its id
					const name = args[0] === "-" ? null : args[0]
					g.call(["/", "dev", "link", "driver", "on", "share"], [{
						argv: args.slice(1),
						...(name ? { name } : {}),
					}])
					return dim(
						`sharing ${args.slice(1).join(" ")}${
							name ? ` as ${name}: erminex ${name} on another machine shows it` : ""
						}; its window's id: ls /dev/link/shares`,
					)
				}
				const layer = `term-${LINE.at(-1)}`
				const shown_ = !!idAt(api, ["/", "dev", "display", "layers", layer])
				const pid = launch(g, {
					address: ["/", "apps", "erminex"],
					program: ["programs", "erminex"],
					data: { channel: args[0], ...(shown_ ? { layer } : {}) },
				})
				return dim(
					`${pid ? `${pid}: ` : ""}erminex ${args[0]}${
						shown_ ? ", in this window: cmd-w gives it back" : ""
					}`,
				)
			}
			case "pty": {
				// a session on this line (/dev/pty, drivers/pty): what it prints comes here, what is typed here goes to it,
				// and this shell stands aside until it ends; as big as the window, its terminal's vt says
				if (!idAt(api, ["/", "dev", "pty", "driver", "on", "new"])) {
					throw new Error("pty needs /dev/pty, the pty driver")
				}
				const vt = val(api, [...LINE, "vt"])
				// and its screen starts as the terminal's is (this line as typed: the terminal may not have shown all of it
				// yet), the program on the row after, as a terminal's goes on
				const screen = vt?.text
					? {
						lines: [
							...vt.text.slice(0, vt.row).map((t) => t.replace(/ +$/, "")),
							prompt().replace(/\x1b\[[0-9;]*m/g, "") + line.trim(),
						],
						cursor: { row: vt.row + 1, col: 0 },
					}
					: null
				const request = {
					to: [LINE],
					cols: vt?.cols ?? 80,
					rows: vt?.rows ?? 24,
					...(screen ? { screen } : {}),
					...(args.length ? { argv: args } : {}),
				}
				// a call answers nothing, and the session is made after this run: it says where it is, /dev/pty
				g.call(["/", "dev", "pty", "driver", "on", "new"], [request])
				return dim(
					`${
						args.length
							? args.join(" ")
							: "a login shell"
					}, in /dev/pty: this shell stands aside until it exits`,
				)
			}
			case "term": {
				// a terminal window; given a line, as a session's address, it shows that one, and typing there types to it
				const at = args[0] ? [...s.root, ...names(args[0])] : null
				const pid = launch(g, {
					address: ["/", "apps", "term"],
					program: ["programs", "term"],
					...(at ? { data: { line: at } } : {}),
				})
				return dim(`${pid ? `${pid}: ` : ""}a terminal${at ? ` on /${at.join("/")}` : ""}`)
			}
			case "windows": {
				api.write(
					["/", "dev", "display", "want"],
					whole({ windows: args[0] !== "off", n: Date.now() }),
				)
				return dim(args[0] === "off" ? "back to the monitor" : "each window a Mac window")
			}
			case "exit":
			case "quit":
			case "logout":
				return leave(api)
			case "off":
				api.write(["/", "dev", "power", "switch"], whole({ off: true }))
				return dim("powering off")
			case "rules":
			case "rule":
			case "unrule":
			case "replace": {
				if (s.depth !== "stack") throw new Error(`${cmd} is at stack>: go stack`)
				if (cmd === "rules") {
					return rules(api).map((r, i) => `${dim(String(i).padStart(3))} ${show(r)}`).join(NL)
				}
				if (cmd === "rule") {
					const list = [...rules(api)]
					list.splice(Number(args[0]), 0, json(rest(1)))
					setRules(api, list)
					return dim(`rule ${args[0]} added`)
				}
				if (cmd === "unrule") {
					const list = [...rules(api)]
					const [gone] = list.splice(Number(args[0]), 1)
					setRules(api, list)
					return dim(`gone: ${show(gone)}`)
				}
				// a window's pid, or a process's node by its path
				if (!args[0]) throw new Error("replace pid|path")
				const at = args[0].includes("/") ? addr(args[0]) : proc(api, args[0])
				// a process's node holds its latest run (SCHEDULER.tex)
				if (!idAt(api, [...at, "run"])) {
					throw new Error(`${"/" + at.slice(1).join("/")} is not a process`)
				}
				g.call(["/", "stack", "on", "replace"], [at])
				return dim(`${"/" + at.slice(1).join("/")} runs its program's code as it is now`)
			}
		}
		// a line as /etc/keys and /etc/menu run it (wmiirc's run): an address, a handler or a node holding
		// one's, called with the rest of the line; or /programs/<cmd> (a path from the root) started in /apps/<its name>
		if (cmd.startsWith("/")) {
			const at = ["/", ...cmd.split("/").filter((n) => n)]
			const held = val(api, at)
			if (held === undefined) throw new Error(`nothing at ${cmd}`)
			const to = Array.isArray(held) && held.every((n) => typeof n === "string") ? held : at
			g.call(to, args.length ? [rest(0)] : [])
			return ""
		}
		const path = cmd.includes("/") ? cmd : `programs/${cmd}`
		const ns = path.split("/").filter((n) => n)
		if (!idAt(api, ["/", ...ns])) return `${cmd}: no such command (help)`
		const folder = ns.at(-1)
		make(api, ["/", "apps"], folder, null)
		const pid = launch(g, {
			address: ["/", "apps", folder],
			program: ns,
			...(args.length ? { data: { args } } : {}),
		})
		return dim(`${pid ? `${pid}: ` : ""}${path}`)
	}

	const fail = (e) =>
		red(
			e?.code
				? (String(e.message).startsWith(e.code) ? e.message : `${e.code}: ${e.message}`)
				: `error: ${e?.message ?? e}`,
		)

	// --- keys: what the console sent since the last run, edited as readline edits a line
	// (emacs keys; M- is escape then the key, or option where the window manager leaves it). The
	// editing keys are the readline tool's, every program's (tools.ts): the line its field; history,
	// completion, search and the keys that wait for another are this shell's

	// what the editor keeps beside the line: the kill ring (C-y, M-y), the undo list (C-_, C-x C-u),
	// what the last key did (so kills in a row join, and M-y and M-. follow C-y and M-.), and a key
	// that waits for the next (C-q, C-], C-x)
	const ed = {
		ring: [],
		yank: null,
		arg: null,
		undo: [],
		last: "",
		was: "",
		wait: "",
		tabbed: false,
		next: -1,
	}
	// all of that but hist is the node line, inside this process's node (ephemeral, as the shell is), so
	// replaced the shell takes it up, and another program sees the line being typed; s and ed its copy,
	// written back once a run of the keys
	const TYPING = [...ME, "line"]
	const held = () => {
		const { hist, ...rest } = s
		return { ...rest, ...ed }
	}
	{
		const was = val(api, TYPING)
		if (was) {
			for (const k of Object.keys(s)) if (k !== "hist" && k in was) s[k] = was[k]
			for (const k of Object.keys(ed)) if (k in was) ed[k] = was[k]
		}
	}
	let kept = JSON.parse(JSON.stringify(held()))
	make(api, ME, "line", kept, { ephemeral: true })
	// the patches from one map to the next: a list spliced where it changed, anything else set
	const delta = (was, now) => {
		const out = []
		for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
			const a = was[k], b = now[k]
			if (JSON.stringify(a) === JSON.stringify(b)) continue
			if (Array.isArray(a) && Array.isArray(b)) {
				const same = (i, j) => JSON.stringify(a[i]) === JSON.stringify(b[j])
				let p = 0, q = 0
				while (p < a.length && p < b.length && same(p, p)) p++
				while (
					q < a.length - p && q < b.length - p && same(a.length - 1 - q, b.length - 1 - q)
				) q++
				out.push({ path: [k], range: [p, a.length - q], value: b.slice(p, b.length - q) })
			} else out.push({ path: [k], value: b ?? null })
		}
		return out
	}
	const keep = (api) => {
		const now = JSON.parse(JSON.stringify(held()))
		const patches = delta(kept, now)
		if (patches.length) api.write(TYPING, patches)
		kept = now
	}
	const COMMANDS = [
		"help",
		"clear",
		"pwd",
		"cd",
		"ls",
		"tree",
		"read",
		"cat",
		"why",
		"write",
		"patch",
		"set",
		"mk",
		"ln",
		"mount",
		"share",
		"rm",
		"start",
		"kill",
		"call",
		"src",
		"sed",
		"go",
		"say",
		"beep",
		"copy",
		"wm",
		"graph",
		"edit",
		"browse",
		"erminex",
		"pty",
		"term",
		"windows",
		"exit",
		"quit",
		"logout",
		"off",
		"rules",
		"rule",
		"unrule",
		"replace",
	]

	/** the line drawn again, the cursor put back at pos: the terminal's \r, \b and erase to the end */
	const redraw = () => "\r" + prompt() + s.line + "\x1b[K" + "\b".repeat(s.line.length - s.pos)
	/** the cursor moved */
	const go = (pos) => {
		s.pos = Math.max(0, Math.min(s.line.length, pos))
		return redraw()
	}
	/** the line changed, what it was kept to undo */
	const edit = (line, pos = line.length) => {
		const top = ed.undo.at(-1)
		if (!top || top.text !== s.line) ed.undo.push({ text: s.line, pos: s.pos })
		if (ed.undo.length > 200) ed.undo.shift()
		s.line = line
		return go(pos)
	}
	/** an editing key, as a chord (C-k, A-f, left), done by the readline tool to the line, with the kill
	 * ring, the undo list and what the key before did beside it; drawn again if it moved or changed */
	const rl = (k) => {
		const f = readline.key({
			text: s.line,
			pos: s.pos,
			ring: ed.ring,
			undo: ed.undo,
			yank: ed.yank,
			last: ed.was,
		}, k)
		if (!f) return ""
		const moved = f.text !== s.line || f.pos !== s.pos
		Object.assign(s, { line: f.text, pos: f.pos })
		Object.assign(ed, { ring: f.ring, undo: f.undo, yank: f.yank, last: f.last })
		return moved ? redraw() : ""
	}
	/** a line put in place whole, as history gives one: nothing to undo across it */
	const set = (line, pos = line.length) => {
		ed.undo = []
		s.line = line
		return go(pos)
	}
	/** text put in at the cursor */
	const insert = (text) =>
		edit(s.line.slice(0, s.pos) + text + s.line.slice(s.pos), s.pos + text.length)
	/** history: back (-1) or on (+1); the line being typed is kept while it is left */
	const recall = (step) => {
		const to = s.at + step
		if (to < 0 || to > s.hist.length) return ""
		if (s.at === s.hist.length) s.draft = s.line
		s.at = to
		return set(to === s.hist.length ? s.draft : s.hist[to])
	}
	/** M-. and M-_: the last word of the line before, and again for the one before that */
	const lastArg = () => {
		const from = ed.was === "arg" && ed.arg ? ed.arg.from - 1 : s.at - 1
		for (let i = from; i >= 0; i--) {
			const word = s.hist[i]?.trim().split(/\s+/).at(-1)
			if (!word) continue
			const at = ed.was === "arg" && ed.arg ? ed.arg.at : s.pos
			const length = ed.was === "arg" && ed.arg ? ed.arg.length : 0
			ed.arg = { from: i, at, length: word.length }
			ed.last = "arg"
			return edit(s.line.slice(0, at) + word + s.line.slice(at + length), at + word.length)
		}
		return ""
	}
	/** Tab: what the word at the cursor can be, a command first, a path after; again, the choices listed */
	const complete = (api) => {
		const start = s.line.lastIndexOf(" ", s.pos - 1) + 1
		const word = s.line.slice(start, s.pos)
		const first = !s.line.slice(0, start).trim()
		let choices, base = "", dir = null
		if (first) choices = COMMANDS.filter((c) => c.startsWith(word))
		else {
			const slash = word.lastIndexOf("/")
			base = word.slice(0, slash + 1)
			const prefix = word.slice(slash + 1)
			dir = base === "" ? "." : base
			let listed = []
			try {
				listed = api.children(addr(dir))
			} catch {
				listed = []
			}
			choices = listed.filter((n) => n.startsWith(prefix)).map((n) => base + n)
		}
		if (!choices.length) return ""
		let common = choices[0]
		for (const c of choices) while (!c.startsWith(common)) common = common.slice(0, -1)
		if (choices.length === 1) {
			// a folder goes on with "/", anything else with a space
			let end = " "
			if (!first) {
				try {
					if (api.children(addr(choices[0])).length) end = "/"
				} catch {
					end = " "
				}
			}
			return insert(choices[0].slice(word.length) + end)
		}
		if (common.length > word.length) return insert(common.slice(word.length))
		if (ed.was !== "tab") {
			ed.last = "tab"
			return ""
		}
		ed.last = "tab"
		const names = choices.map((c) => c.slice(base.length))
		return NL + names.join("  ") + NL + redraw()
	}

	// C-r: the newest line run before `from` that holds the query
	const find = (query, from) => {
		for (let i = from; i >= 0; i--) if (s.hist[i]?.includes(query)) return i
		return -1
	}
	const searching = () => {
		const { query, at } = s.search
		const found = at >= 0 ? s.hist[at] : ""
		return "\r" + dim(`(reverse-i-search)\`${query}': `) + found + "\x1b[K"
	}

	// a sequence after escape: CSI's (ESC [ params final) and SS3's (ESC O final), or M- and a key
	const escaped = (seq) => {
		const m = /^.(?:\[([0-9;]*)|O)(.)$/.exec(seq)
		if (!m) {
			const k = seq[1]
			if (k === "<") return recall(-s.at)
			if (k === ">") return recall(s.hist.length - s.at)
			if (k === "." || k === "_") return lastArg()
			// M- and a key: the tool's A- and it (A-f, A-backspace, A-backslash)
			if (k === "\x7f" || k === "\b") return rl("A-backspace")
			return /[A-Z]/.test(k) ? "" : rl(`A-${k}`)
		}
		const [params, final] = [m[1] ?? "", m[2]]
		// a modifier (as ;3, option, or ;5, control) makes left and right go by words
		const mod = /;3$/.test(params) ? "A-" : /;5$/.test(params) ? "C-" : ""
		if (final === "A") return recall(-1)
		if (final === "B") return recall(1)
		if (final === "C") return rl(`${mod}right`)
		if (final === "D") return rl(`${mod}left`)
		if (final === "H" || (final === "~" && (params === "1" || params === "7"))) return rl("home")
		if (final === "F" || (final === "~" && (params === "4" || params === "8"))) return rl("end")
		if (final === "~" && params === "3") return rl("delete")
		return ""
	}

	const enter = (g) => {
		const { api } = g
		const line = s.line
		// C-o: the line after this one in history comes up next
		const next = ed.next
		ed.next = -1
		s.line = ""
		s.pos = 0
		s.draft = ""
		ed.undo = []
		if (line.trim() && s.hist.at(-1) !== line) {
			// into the history, a line on its end, the oldest gone past a thousand
			const patches = [{ path: [], range: [s.hist.length, s.hist.length], value: [line] }]
			s.hist.push(line)
			if (s.hist.length > 1000) {
				s.hist.shift()
				patches.push({ path: [], range: [0, 1] })
			}
			try {
				api.write(HISTORY, patches)
			} catch {
				// a history that cannot be written: this shell keeps its own
			}
		}
		s.at = s.hist.length
		let said
		try {
			said = run(g, line)
		} catch (e) {
			said = fail(e)
		}
		let after = ""
		if (next >= 0 && next < s.hist.length) {
			s.at = next
			s.line = s.hist[next]
			s.pos = s.line.length
			after = s.line
		}
		return NL + (said ? said + (said.endsWith("\x1b[H") ? "" : NL) : "") + prompt() + after
	}

	const key = (g, b) => {
		const { api } = g
		const ch = String.fromCharCode(b)
		// what the key before did, for the kills, yanks, M-. and tabs that go on from it
		if (!s.esc) {
			ed.was = ed.last
			ed.last = ""
		}
		if (ed.wait) {
			const wait = ed.wait
			ed.wait = ""
			// C-q, C-v: the key as it is; C-]: to the next of that character; C-x C-u: undo
			if (wait === "quote") return insert(ch)
			if (wait === "find") {
				const at = s.line.indexOf(ch, s.pos + 1)
				return at < 0 ? "" : go(at)
			}
			if (wait === "x") return b === 21 ? rl("C-_") : ""
		}
		if (s.esc) {
			s.esc += ch
			// CSI goes on to its final byte; SS3 takes one more; anything else is M- and that key
			if (
				s.esc === "\x1b[" || s.esc === "\x1bO" ||
				(s.esc.startsWith("\x1b[") && /[0-9;]$/.test(s.esc))
			) return ""
			const seq = s.esc
			s.esc = ""
			if (s.search) {
				// a key that is not the search's own takes what it found, then does what it does
				const found = s.search.at >= 0 ? s.hist[s.search.at] : s.line
				s.search = null
				set(found)
				return redraw() + escaped(seq)
			}
			return escaped(seq)
		}
		if (b === 27) {
			s.esc = ch
			return ""
		}
		if (s.search) {
			const q = s.search
			if (b === 18) {
				// C-r again: an older line that holds it
				const at = find(q.query, (q.at >= 0 ? q.at : s.hist.length) - 1)
				if (at >= 0) q.at = at
				return searching()
			}
			if (b === 7) {
				// C-g: as it was before the search
				s.search = null
				return set(q.line, q.pos)
			}
			if (b === 127 || b === 8) {
				q.query = q.query.slice(0, -1)
				q.at = q.query ? find(q.query, s.hist.length - 1) : -1
				return searching()
			}
			if (b >= 32 && b < 127) {
				q.query += ch
				q.at = find(q.query, q.at >= 0 ? q.at : s.hist.length - 1)
				return searching()
			}
			// any other key takes what it found, then does what it does
			const found = q.at >= 0 ? s.hist[q.at] : q.line
			s.search = null
			s.at = q.at >= 0 ? q.at : s.at
			set(found)
			if (b === 13 || b === 10) return redraw() + enter(g)
			return redraw() + key(g, b)
		}
		if (b === 13 || b === 10) return enter(g)
		if (b === 9) return complete(api)
		if (b === 127 || b === 8) return rl("backspace")
		if (b === 4) {
			// C-d: the character under the cursor; on an empty line, the end
			if (!s.line) return NL + leave(api)
			return rl("C-d")
		}
		if (b === 3) {
			s.line = ""
			s.pos = 0
			s.at = s.hist.length
			ed.undo = []
			return "^C" + NL + prompt()
		}
		// the editing keys, the tool's: C-a C-e C-b C-f C-k C-u C-w C-y C-_
		const CTRL = {
			1: "C-a",
			5: "C-e",
			2: "C-b",
			6: "C-f",
			11: "C-k",
			21: "C-u",
			23: "C-w",
			25: "C-y",
			31: "C-_",
			20: "C-t",
		}
		if (CTRL[b]) return rl(CTRL[b])
		if (b === 24) {
			ed.wait = "x"
			return ""
		}
		if (b === 17 || b === 22) {
			ed.wait = "quote"
			return ""
		}
		if (b === 29) {
			ed.wait = "find"
			return ""
		}
		if (b === 7) return ""
		if (b === 16) return recall(-1)
		if (b === 14) return recall(1)
		if (b === 15) {
			// C-o: this line runs, and the one after it in history comes up
			ed.next = s.at < s.hist.length ? s.at + 1 : -1
			return enter(g)
		}
		if (b === 18) {
			s.search = { query: "", at: -1, line: s.line, pos: s.pos }
			return searching()
		}
		if (b === 12) return "\x1b[2J\x1b[H" + redraw()
		if (b >= 32 && b < 127 || b >= 160) {
			if (s.pos === s.line.length) {
				edit(s.line + ch, s.pos + 1)
				return ch
			}
			return insert(ch)
		}
		return ""
	}

	// the sessions (/dev/pty/<n>; one made elsewhere says where, {at}), each with whether its to lists this line,
	// read tracked: while one does, it is the line's machine side, and this shell stands aside
	const LINED = JSON.stringify(LINE)
	const PTY = ["/", "dev", "pty"]
	const sessions = (api) =>
		api.children(PTY).flatMap((n) => {
			if (n === "driver" || !api.children(PTY, n).length) return []
			const at = val(api, [...PTY, n])?.at
			const base = Array.isArray(at) ? at : [...PTY, n]
			const to = val(api, [...base, "to"])
			return [{
				name: n,
				base,
				to: Array.isArray(to) && to.some((l) => JSON.stringify(l) === LINED),
			}]
		})
	// wm's answer, come after its prompt: printed over that prompt, then the prompt again
	effect(
		given,
		"said",
		({ api }) => val(api, ["/", "dev", "wm", "said"]) ?? null,
		({ value: said, api }) => {
			if (!s.wm || !said || said.n === s.wm.n || said.line !== s.wm.line) return
			s.wm = null
			out(api, "\r\x1b[K" + String(said.answer) + NL + prompt() + s.line)
		},
	)
	effect(given, "keys", ({ api }) => ({
		aside: sessions(api).some((x) => x.to),
		total: val(api, [...LINE, "stats"])?.rx ?? 0,
		rx: val(api, [...LINE, "rx"]) ?? new Uint8Array(0),
		hist: val(api, HISTORY) ?? [],
	}), (g) => {
		const { api, value: { aside, total, rx, hist } } = g
		// stood aside: what is typed is the session's; this keeps up with it, interprets nothing, and prompts when it ends
		if (aside || s.aside) {
			if (s.seen !== null) s.seen = total
			if (aside !== s.aside) {
				s.aside = aside
				if (!aside) out(api, NL + prompt() + s.line)
			}
			if (aside) return keep(api)
		}
		// the history as it is now, another shell's lines with it; the line being typed stays the one after the last
		if (s.at === s.hist.length) s.at = hist.length
		s.hist = [...hist]
		s.at = Math.min(s.at, s.hist.length)
		if (s.seen === null) {
			s.seen = total
			out(
				api,
				[
					"",
					bold(`ermine, on ${val(api, ["/", "hw"])?.model ?? "a Mac"}.`) +
					` You are ${bold(String(me))}.`,
					dim(
						"This shell is a process: " + views.shown(ME) +
							". Each command is a graph operation, as you, through it.",
					),
					dim(
						"Depths: an app (go bar), dev, hw, stack; the bare graph needs booting bare. help lists commands.",
					),
					dim(
						LINE.join("/") === "//dev/uart0"
							? "exit, or ctrl-d, powers off; off does too."
							: LINE[2] === "sock"
							? "exit, or ctrl-d, ends this connection; ermineOS goes on."
							: "exit, or ctrl-d, closes this window.",
					),
					"",
				].join(NL) + prompt(),
			)
			keep(api)
			return
		}
		const n = Math.min(total - s.seen, rx.byteLength)
		s.seen = total
		if (n <= 0) return keep(api)
		let said = ""
		for (const b of new Uint8Array(rx).slice(rx.byteLength - n)) {
			said += key(g, b)
			if (s.left) break
		}
		if (said) out(api, said)
		if (s.left) return kill(self)
		keep(api)
	})

	return "shell"
}
