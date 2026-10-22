/** @jsxImportSource ermine-h */
import type { API } from "@ermine/programs/api"
import { bind, handler } from "ermine-h"

// big-shell: a shell over the graph. it's a filesystem: ls, cd, cat, echo > a path, mkdir, mv
// (places' move: the same node, the same id), ln (one node at two places), rm (an unplace),
// tree, stat (who changed it, from where), watch (a live line). commands are nodes in /bin, found
// by lookup from where you are: a bin/ nearer you wins (try: mkdir /home/bin, then
// echo "echo hi from home; date" > /home/bin/hi, cd /home, hi). what runs a command is found too
// (the host's which: satisfy): a function runs as it is; a text echo wrote is typed
// public.plain-text, and /bin/sh takes that type, so sh runs it, handed its path as #! would be
// (/bin offers its children to the search: it is a loaders folder). which hi says all of it,
// and what was passed over and why. run starts a process from this
// file's exports (ticker, lamp, bunny, mirror) at a place; rm or kill its place and it ends.
// the shell's lines, cwd and history are nodes in /var/shell (its working folder, ./): edit this file
// and nothing is lost. the shell starts the others, so it keeps their places (./procs) and starts
// them again after a reload
const LOOK = `
[hidden] { display: none !important }
body { margin: 0; background: #ffff88; font: 14px/1.35 Jost, system-ui, sans-serif; color: #000 }
.app { display: flex; gap: 12px; height: 100vh; padding: 12px; box-sizing: border-box }
.term { flex: 1.35; min-width: 0; display: flex; flex-direction: column; background: #fff;
	border: 1px solid #000; border-radius: 6px; box-shadow: 0 0 10px 2px #66003322; overflow: hidden }
.bar { flex: none; height: 22px; display: flex; align-items: center; justify-content: center;
	border-bottom: 1px solid #000; position: relative;
	background: repeating-linear-gradient(#fff 0 2px, #000 2px 3px) 0 4px / 100% 15px no-repeat }
.bar b { background: #fff; padding: 0 8px; font-weight: 600; font-size: 13px }
.bar button { position: absolute; left: 8px; top: 4px; width: 13px; height: 13px; padding: 0;
	border: 1px solid #000; border-radius: 0; background: #fff; box-shadow: none; cursor: pointer }
.bar button:hover { background: #ff2284 }
.lines { flex: 1; overflow-y: auto; padding: 8px 10px 4px; font: 12.5px/1.45 Monaco, ui-monospace,
	Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere }
.lines > div { min-height: 1.45em }
.lines .in { font-weight: 700; margin-top: 6px }
.lines .in .ps { color: #ff2284 }
.lines .err { color: #ff2284 }
.lines .ok { background: #c8f6ea; display: inline-block; padding: 0 6px; border-radius: 2px }
.lines .hint { color: #0008 }
.lines .head { font-weight: 700; color: #2269ff }
.lines .watch .tag { background: #2269ff; color: #fff; padding: 0 6px; margin-right: 6px;
	display: inline-block; transform: skew(-8deg) }
.lines .watch .v { background: #ffffc2; padding: 0 4px; transition: background 400ms }
.lines .watch .v.fresh { background: #40dcba; transition: none }
.prompt { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 10px;
	border-top: 1px solid #000; font: 12.5px Monaco, ui-monospace, Menlo, monospace }
.prompt .ps { color: #ff2284; font-weight: 700; white-space: nowrap }
.prompt input { flex: 1; font: inherit; border: 0; outline: none; background: none; min-width: 0 }
.complete { flex: none; padding: 2px 10px 6px; font: 11.5px Monaco, ui-monospace, monospace;
	color: #2269ff; min-height: 0 }
.screen { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto }
.screen .empty { border: 1px dashed #000; border-radius: 6px; padding: 12px; background: #fff8;
	font-size: 13px }
.screen .empty code { background: #fff; border: 1px solid #000; padding: 0 4px; font-size: 12px; white-space: nowrap; line-height: 1.9 }
.win { background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 3px 3px 0 #000;
	flex: none; overflow: hidden }
.win .bar b small { font-weight: 400; color: #0009; margin-left: 4px }
.win .body { padding: 10px; display: grid; place-items: center; min-height: 70px }
.win .body > .box { justify-self: stretch; display: grid; place-items: center }
.ticker { font: 700 40px/1 Monaco, ui-monospace, monospace; letter-spacing: 2px; color: #2269ff;
	background: #ffffc2; border: 1px solid #000; padding: 6px 12px; border-radius: 2px }
.lamp { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer;
	user-select: none; font-size: 12px }
.bulb { width: 46px; height: 46px; border-radius: 50%; border: 1px solid #000; background: #eee;
	transition: background 150ms, box-shadow 150ms }
.lamp.on .bulb { background: #ffff88; box-shadow: 0 0 22px 8px #ffff88, 0 0 4px 1px #ff2284 inset }
.field { position: relative; width: 100%; height: 64px; border: 1px solid #000; cursor: crosshair;
	background: linear-gradient(#d4e4ff 0 60%, #c8f6ea 60%); border-radius: 2px; overflow: hidden }
.field span { position: absolute; bottom: 4px; font-size: 26px; transition: left 280ms ease-out;
	transform: translateX(-50%) }
.field .carrot { z-index: 1; font-size: 22px }
.field .bunny.left { transform: translateX(-50%) scaleX(-1) }
.field .bunny.hop { bottom: 16px }
.mirror { width: 100%; font-size: 12px }
.mirror .path { background: #ffff88; border: 1px solid #000; padding: 0 6px; display: inline-block;
	transform: skew(-8deg); font-weight: 600; margin-bottom: 6px }
.mirror pre { margin: 0; font: 12px Monaco, ui-monospace, monospace; background: #ffd9ea;
	border: 1px solid #000; padding: 6px; white-space: pre-wrap; max-height: 90px; overflow: auto }
`

// what `help` says of each command
const DOCS = {
	help: "these words",
	ls: "ls [path]: the names at a place",
	cd: "cd path: go there (.. and / work)",
	pwd: "where you are",
	cat: "cat path: the value",
	echo: "echo words [> path | >> path]: say it, or put it in a node (json if it parses)",
	mkdir: "mkdir path: a new node",
	rm: "rm path: unplace (the node stays in the store, unreachable)",
	mv: "mv a b: places' move: the same node, the same id, somewhere else",
	ln: "ln a b: the node at a placed at b too (one node, two places)",
	tree: "tree [path]: everything under a place",
	stat: "stat path: its id, its entries, its last change: who, when, from where",
	watch: "watch path: a line that stays live",
	run: "run program [path]: start a process (programs lists them)",
	ps: "the processes the shell started",
	kill: "kill path: unplace a process: it ends",
	programs: "what run can start",
	inspect: "inspect path: pick it in the graph tab",
	whoami: "who a write made now would be",
	history: "what you typed",
	clear: "clear the lines",
	date: "the time",
	which: "which command: where it is found, its type, what runs it, what was passed over",
	sh: "sh path: a text's lines run in turn (what runs a text in a bin)",
}
// the types echo gives what it writes: a UTI each, as /ermine/types names them
const TEXT = "public.plain-text"
const JSON_TYPE = "public.json"
const BLURBS = {
	ticker: "counts seconds into its time node",
	lamp: "a lamp: click it, or echo true > /lamp/on",
	bunny: "hops to the carrot: click the field, or echo 90 > /bunny/carrot",
	mirror: "shows whatever is at the path in its path node: echo /ticker/time > /mirror/path",
}

// what the host's extend adds to the api (host.ts says what each is for)
type Item = { at: string[]; id: unknown; node: { path?: readonly string[]; part: string } }
type Metadata = Record<string, unknown>
type Host = API & {
	attrs: (x: unknown, says?: Record<string, unknown>) => Record<string, any>
	which: (name: string, from: string[]) => any
	change: (
		x: unknown,
	) => { time: number; actor: string; metadata: Metadata; external?: any[] } | undefined
	who: () => { actor: string; metadata: Metadata } | undefined
	inspect: (address: string[]) => void
}

export default function shell(
	{
		open,
		read,
		edit,
		list,
		entries,
		info,
		place,
		unplace,
		move,
		remove,
		memo,
		method,
		send,
		start,
		stop,
		teardown,
		PENDING,
		attrs,
		which,
		change,
		who,
		inspect,
	}: Host,
) {
	const style = document.head.appendChild(document.createElement("style"))
	style.textContent = LOOK
	const font = document.head.appendChild(Object.assign(document.createElement("link"), {
		rel: "stylesheet",
		href: "https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap",
	}))
	teardown(() => (style.remove(), font.remove()))

	// the shell's state: saved in its working folder (/var/shell), so a reload finds it as it was
	const put = (x: unknown, v: unknown) => edit(x as never, [{ path: [], value: v }])
	const lines = open("./lines", [
		{ k: "head", t: "🐰 the ermine shell" },
		{
			k: "hint",
			t: "every line here is in /var/shell/lines, every command in /bin. try: help, ls, tree /, run lamp",
		},
	])
	const cwd = open("./cwd", ["home"])
	const history = open("./history", [])
	// the processes the shell started: { name, at, ended? }, and the live ones by place
	const procs = open("./procs", [])
	const running = new Map<string, any>()

	// ---- paths: an address from the root, one node at each name
	const show = (address: string[]) => "/" + address.join("/")
	const pwd = () => show(read(cwd) as string[])
	function abs(path: string) {
		const out = path.startsWith("/") ? [] : [...(read(cwd) as string[])]
		for (const s of path.split("/")) {
			if (!s || s === ".") continue
			if (s === "..") out.pop()
			else out.push(s)
		}
		return out
	}
	// the node at an address: its id, and a handle to read and write it by. none: undefined
	function resolve(address: string[]): Item | undefined {
		const [e] = entries(show(address))
		return e && e.id !== (PENDING as unknown) && !e.refused
			? { at: address, id: e.id, node: open(show(address)) as Item["node"] }
			: undefined
	}
	const here = () => resolve(read(cwd) as string[]) ?? resolve([])!
	const names = (item: Item) => list(item.node)
	const under = (item: Item, name: string) => resolve([...item.at, name])
	// a place to write: its parent is there, and it has a name
	const slotOf = (address: string[]) =>
		address.length && resolve(address.slice(0, -1)) ? address : undefined
	// a node's value (a pending one has none yet; a made-but-empty node holds null)
	function value(item: Item | undefined): any {
		if (!item) return undefined
		try {
			return read(item.node) ?? undefined
		} catch (e) {
			if (e === PENDING) return undefined
			throw e
		}
	}
	const pending = (item: Item) => {
		try {
			read(item.node)
			return false
		} catch (e) {
			if (e === PENDING) return true
			throw e
		}
	}

	// ---- processes: started here, at run time, from /code/<export>
	function spawn(name: string, address: string[]) {
		const p = start(`/code/${name}`, show(address), { args: [show(address)] })
		if ("refused" in p) return p.refused
		running.set(show(address), p)
	}
	const ended = (address: string[]) => {
		const was = running.get(show(address))
		if (was) stop(was)
		running.delete(show(address))
		edit(procs, (d: any[]) => {
			for (const p of d) if (show(p.at) === show(address)) p.ended = true
		})
	}
	// a reload stopped what was started here: they start again, on the new code
	for (const p of read(procs) as any[]) if (!p.ended && !resolve(p.at)) spawn(p.name, p.at)

	// ---- the commands: functions in nodes under /bin, each given the words and a way to say
	const fail = (text: string): never => {
		throw new Error(text)
	}
	const need = (path: string | undefined, what = "path") => path ?? fail(`needs a ${what}`)
	let cleared = false
	const commands: Record<
		string,
		(args: string[], say: (k: string, t: unknown) => void) => unknown
	> = {
		help(args, say) {
			say("head", "commands (each one a node in /bin):")
			for (const [name, doc] of Object.entries(DOCS)) say("out", `  ${name.padEnd(9)}${doc}`)
			say("hint", "a bin/ nearer where you are is looked in first: lookup walks up")
			say("hint", "a text in a bin is run by what takes its type: which <command> says what")
		},
		ls(args, say) {
			const item = args[0] ? resolve(abs(args[0])) : here()
			if (!item) return say("err", `ls: nothing at ${args[0]}`)
			const all = names(item)
			if (!all.length) return say("hint", "(no names here)")
			for (const name of all) {
				const front = under(item, name)!
				const kids = pending(front) ? 0 : names(front).length
				const label = name + (kids ? "/" : "")
				say("out", `${label.padEnd(18)} ${src(front).padEnd(16)} ${preview(value(front))}`)
			}
		},
		cd(args, say) {
			const to = abs(args[0] ?? "/home")
			if (!resolve(to)) return say("err", `cd: nothing at ${show(to)}`)
			put(cwd, to)
		},
		pwd: (args, say) => say("out", pwd()),
		cat(args, say) {
			const item = resolve(abs(need(args[0])))
			if (!item) return say("err", `cat: nothing at ${args[0]}`)
			const v = value(item)
			say("out", typeof v === "string" ? v : pretty(v))
		},
		echo(args, say) {
			const i = args.findIndex((a) => a === ">" || a === ">>")
			const text = (i < 0 ? args : args.slice(0, i)).join(" ")
			if (i < 0) return say("out", text)
			const address = abs(need(args[i + 1]))
			const v = parse(text)
			const item = resolve(address)
			if (item && args[i] === ">>") {
				const was = value(item)
				if (Array.isArray(was)) edit(item.node, (d: unknown[]) => void d.push(v))
				else put(item.node, `${was ?? ""}${text}`)
			} else if (item) put(item.node, v)
			else {
				slotOf(address) ?? fail(`echo: no place ${show(address.slice(0, -1))}`)
				// a new node says what it is: a text, or json (what parsed)
				attrs(open(show(address), v), { type: typeof v === "string" ? TEXT : JSON_TYPE })
			}
			say("ok", `${show(address)} = ${preview(value(resolve(address)))}`)
		},
		mkdir(args, say) {
			const address = abs(need(args[0]))
			slotOf(address) ?? fail(`mkdir: no place ${show(address.slice(0, -1))}`)
			if (resolve(address)) return say("err", `mkdir: ${show(address)} is there already`)
			open(show(address), null)
			say("ok", `made ${show(address)}`)
		},
		rm(args, say) {
			const address = abs(need(args[0]))
			if (!resolve(address)) return say("err", `rm: nothing at ${show(address)}`)
			if (running.has(show(address))) {
				ended(address)
				return say("ok", `${show(address)} was a process: it ends`)
			}
			unplace(show(address))
			say("ok", `unplaced ${show(address)} (its node is still in the store, unreachable)`)
		},
		mv(args, say) {
			const [a, b] = [abs(need(args[0])), abs(need(args[1], "target"))]
			const item = resolve(a)
			if (!item || !a.length) return say("err", `mv: nothing at ${show(a)}`)
			const to = resolve(b) ? [...b, a[a.length - 1]] : b
			if (!slotOf(to)) return say("err", `mv: no place ${show(b.slice(0, -1))}`)
			if (resolve(to)) return say("err", `mv: ${show(to)} is there already`)
			move(show(a), show(to))
			say("ok", `moved ${show(a)} → ${show(b)}: the same node, ${src(item)}`)
		},
		ln(args, say) {
			const [a, b] = [abs(need(args[0])), abs(need(args[1], "target"))]
			const item = resolve(a)
			if (!item) return say("err", `ln: nothing at ${show(a)}`)
			const to = resolve(b) ? [...b, a[a.length - 1]] : b
			if (!slotOf(to)) return say("err", `ln: no place ${show(b.slice(0, -1))}`)
			if (resolve(to)) return say("err", `ln: ${show(to)} is there already`)
			place(show(to), item.node)
			say("ok", `${show(b)} is ${src(item)} too: one node, two places`)
		},
		tree(args, say) {
			const item = args[0] ? resolve(abs(args[0])) : here()
			if (!item) return say("err", `tree: nothing at ${args[0]}`)
			let n = 0
			const walk = (it: Item, indent: string, depth: number) => {
				const all = names(it)
				all.forEach((name, i) => {
					const kid = under(it, name)
					if (!kid || ++n > 140) return
					const last = i === all.length - 1
					// a big folder below the one asked for (the 151 types, say) is one line: tree it
					const many = pending(kid) ? 0 : names(kid).length
					const big = depth > 0 && many > 40
					const said = big ? `(${many} names: tree ${show(kid.at)})` : ""
					say(
						"out",
						`${indent}${last ? "└─ " : "├─ "}${name}  ${said || preview(value(kid), 28)}`,
					)
					if (depth < 5 && !pending(kid) && !big) {
						walk(kid, indent + (last ? "   " : "│  "), depth + 1)
					}
				})
			}
			say("head", args[0] ? show(abs(args[0])) : pwd())
			walk(item, "", 0)
			if (n > 140) say("hint", `… and more (${n} shown)`)
		},
		stat(args, say) {
			const address = abs(need(args[0]))
			const item = resolve(address)
			if (!item) return say("err", `stat: nothing at ${show(address)}`)
			say("head", show(address))
			say("out", `  node     ${String(item.id)}`)
			const c = change(item.node)
			if (!c) return
			say("out", `  changed  ${new Date(c.time * 1000).toLocaleTimeString()} by ${c.actor}`)
			for (const [k, v] of Object.entries(c.metadata ?? {})) {
				say("out", `  ${k.padEnd(9)}${typeof v === "string" ? v : preview(v)}`)
			}
			const site = c.external?.[0]
			if (site) say("out", `  site     ${site.function ?? ""} line ${site.line}`)
		},
		watch(args, say) {
			say("watch", show(abs(need(args[0]))))
		},
		run(args, say) {
			const name = need(args[0], "program")
			if (!(name in BLURBS)) return say("err", `run: no program ${name} (programs lists them)`)
			const address = abs(args[1] ?? "/" + name)
			slotOf(address) ?? fail(`run: no place ${show(address.slice(0, -1))}`)
			if (resolve(address)) {
				return say("err", `run: ${show(address)} is there already: run ${name} /${name}2`)
			}
			const refused = spawn(name, address)
			if (refused) return say("err", `run: ${name} refused: ${refused}`)
			edit(procs, (d: unknown[]) => void d.push({ name, at: address }))
			say("ok", `started ${name} at ${show(address)}`)
		},
		ps(args, say) {
			say("head", "NAME      AT                STATE")
			say("out", `shell     /shell            going`)
			for (const { name, at, ended: gone } of read(procs) as any[]) {
				say(
					"out",
					`${name.padEnd(10)}${show(at).padEnd(18)}${
						!gone && resolve(at) ? "going" : "ended"
					}`,
				)
			}
		},
		kill(args, say) {
			const address = abs(need(args[0]))
			if (!running.has(show(address))) {
				return say(
					"err",
					`kill: ${show(address)} is no process the shell started (rm unplaces anything)`,
				)
			}
			ended(address)
			say("ok", `stopped ${show(address)}: it ends`)
		},
		programs(args, say) {
			for (const [name, blurb] of Object.entries(BLURBS)) {
				say("out", `  ${name.padEnd(8)}${blurb}`)
			}
		},
		inspect(args, say) {
			const address = abs(need(args[0]))
			if (!resolve(address)) return say("err", `inspect: nothing at ${show(address)}`)
			inspect(address)
			say("hint", `picked ${show(address)} in the graph tab`)
		},
		whoami(args, say) {
			const w = who()
			say("out", `${w?.actor}`)
			for (const [k, v] of Object.entries(w?.metadata ?? {})) {
				say("out", `  ${k.padEnd(9)}${typeof v === "string" ? v : preview(v)}`)
			}
		},
		history(args, say) {
			;(read(history) as string[]).forEach((line, i) =>
				say("out", `${String(i + 1).padStart(3)}  ${line}`)
			)
		},
		clear() {
			cleared = true
		},
		date: (args, say) => say("out", new Date().toString()),
		// what runs a text in a bin: handed its path, as #! hands a script to its interpreter
		sh(args, say) {
			const address = abs(need(args[0], "script"))
			const item = resolve(address)
			if (!item) return say("err", `sh: nothing at ${show(address)}`)
			const v = value(item)
			if (typeof v !== "string") return say("err", `sh: ${show(address)} is no text`)
			for (const part of v.split(/;|\n/)) exec(part.trim(), say)
		},
		which(args, say) {
			const cmd = need(args[0], "command")
			const found = which(command(cmd), here().at)
			if ("refused" in found) return refused(cmd, found, say)
			say("head", show(found.program.at))
			say("out", `  type    ${attrs(itemOf(found.program)!.node).type ?? "none"}`)
			found.chains.forEach((chain: any, i: number) =>
				say("out", `  ${i ? "or     " : "run by "} ${runs(chain)}`)
			)
			for (const w of found.why) say("hint", `  passed over ${passed(w, found)}`)
		},
	}
	for (const [name, fn] of Object.entries(commands)) method(`/bin/${name}`, fn)
	// /bin offers its children to the search for what runs a program (a loaders folder: from
	// anywhere, /bin/sh is a candidate in /bin's place); sh takes a text
	attrs("/bin", { loaders: true })
	attrs("/bin/sh", { takes: [TEXT] })
	// a command this file no longer has goes from /bin
	for (const name of list("/bin")) {
		if (!(name in commands) && typeof read(`/bin/${name}`) === "function") remove(`/bin/${name}`)
	}

	// ---- what runs a command: which (satisfy) finds the program, from where you are, and every
	// chain running it. a word with a / in it is a path (from there, no lookup); a plain word is
	// bin/<word>, looked up: a bin/ nearer you wins
	const command = (word: string) => (word.includes("/") ? word : `bin/${word}`)
	const itemOf = (place: { at: string[] }) => resolve(place.at)
	// a chain, said: each step where it is, and what runs it in turn (none: the host)
	const runs = (chain: any[]): string =>
		chain.length
			? chain.map((step) =>
				`${show(step.at)} (${step.by.length ? `run by ${runs(step.by)}` : "the host runs it"})`
			).join(" → ")
			: "the host: a live function, run as it is"
	// a loader passed over, and why (programs' reasons, in words)
	function passed(w: any, found: any) {
		const takes = attrs(itemOf(w)!.node).takes ?? []
		const said = ({
			"wrong-type": `takes ${takes.join(", ") || "nothing"}, not ${w.type}`,
			"unknown-type": `${w.type} is no type in /ermine/types`,
			needs: `does not give ${w.missing?.join(", ")}`,
			"no-chain": `takes ${w.type}, but nothing runs it`,
			"no-type": `takes ${w.type}, but says no type and holds no function`,
			"in-the-chain": `takes ${w.type}, but is in this chain already`,
			"too-deep": `takes ${w.type}, but is too deep`,
		} as Record<string, string>)[w.why] ?? w.why
		// what it was looked at for: the program, or a step's own run
		const steps = (chain: any[]): any[] => chain.flatMap((x) => [x, ...steps(x.by)])
		const of = w.for === found.program.id ? "" : ` (for ${
			show(
				found.chains.flatMap(steps).find((x: any) => x.id === w.for)?.at ?? [String(w.for)],
			)
		})`
		return `${show(w.at)}: ${said}${of}`
	}
	// no program, or nothing to run it: said
	function refused(cmd: string, found: any, say: (k: string, t: unknown) => void) {
		if (found.refused === "nothing-there") {
			say(
				"err",
				cmd.includes("/")
					? `${cmd}: not found (nothing at ${found.path} from ${show(found.at)})`
					: `${cmd}: not found (no ${found.path} from ${show(found.at)} up)`,
			)
		} else if (found.refused === "no-type") {
			say("err", `${cmd}: ${show(found.program.at)} says no type and holds no function`)
		} else {
			const type = attrs(itemOf(found.program)!.node).type
			say("err", `${cmd}: nothing here runs ${show(found.program.at)}, a ${type}`)
			for (const w of found.why) say("hint", `  passed over ${passed(w, found)}`)
			if (!found.why.length) say("hint", "  nothing on the way up takes anything")
		}
	}

	// ---- a line typed: what runs the command found from where you are, run, its lines written once
	let depth = 0 // scripts running scripts
	function exec(line: string, say: (k: string, t: unknown) => void) {
		const words = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) =>
			m[1] ?? m[2] ?? m[3]
		)
		if (!words.length) return
		const [cmd, ...args] = words
		if (depth >= 8) return say("err", `${cmd}: too deep (scripts running scripts, 8 down)`)
		const found = which(command(cmd), here().at)
		if ("refused" in found) return refused(cmd, found, say)
		const chain = found.chains[0]
		// none: a live function, run as it is. a runner: handed the program's path, then the words
		// (as #! does). a compiler first, or a runner run by another: more than this shell runs
		const last = chain[chain.length - 1]
		if (chain.length > 1 || last?.by.length) {
			return say("err", `${cmd}: run by ${runs(chain)}: more than this shell runs`)
		}
		const fn = value(itemOf(last ?? found.program))
		if (typeof fn !== "function") return say("err", `${cmd}: not a command`)
		depth++
		try {
			return last ? fn([show(found.program.at), ...args], say) : fn(args, say)
		} finally {
			depth--
		}
	}
	method("on/run", (line: string) => {
		const out: { k: string; t: string }[] = []
		const say = (k: string, text: unknown) => out.push({ k, t: String(text) })
		const prompt = pwd()
		cleared = false
		try {
			exec(line, say)
		} catch (e) {
			say("err", (e as Error).message)
		}
		if (line.trim()) {
			edit(history, (d: string[]) => {
				if (d[d.length - 1] !== line) d.push(line)
				if (d.length > 60) d.shift()
			})
		}
		if (cleared) return put(lines, [])
		edit(lines, (d: unknown[]) => {
			d.push({ k: "in", t: line, at: prompt }, ...out)
			if (d.length > 500) d.splice(0, d.length - 500)
		})
	})
	// another process's word for the shell's lines (an ended process says so)
	method(
		"on/print",
		(text: string) => edit(lines, (d: unknown[]) => void d.push({ k: "hint", t: text })),
	)

	// ---- the view: jsx bound to the shell's nodes (cwd, lines, the windows); the input's typing
	// (history, completion) is the shell's own, and enter calls run
	// the windows: one per process started that is still placed
	memo(
		"windows",
		() =>
			(read(procs) as any[]).filter((p) => !p.ended && resolve(p.at)).map((p) => ({
				name: p.name,
				path: show(p.at),
			})),
	)
	const win = (w: { name: string; path: string }) => (
		<div class="win" key={w.path}>
			<div class="bar">
				<button title="kill" onClick={handler("on/run", [`kill ${w.path}`])} />
				<b>
					{w.name}
					<small>{w.path}</small>
				</b>
			</div>
			{/* its view is its node's value: the process's own box */}
			<div class="body">
				{bind(w.path, (v) => (v instanceof Node ? v : <i>(no view)</i>))}
			</div>
		</div>
	)

	// a line of the shell's lines. a watch line is bound to the path it watches: live, as a binding
	const draw = (line: any) =>
		line.k === "in"
			? (
				<div class="in">
					<span class="ps">{`🐰 ${line.at} › `}</span>
					{line.t}
				</div>
			)
			: line.k === "watch"
			? (
				<div class="watch">
					<span class="tag">👀 {line.t}</span>
					<span class="v" ref={fresh}>{bind(line.t, (v) => preview(v, 60))}</span>
				</div>
			)
			: <div class={line.k}>{line.t}</div>
	// a watched value that changed lights up for a moment (ermine-h says "ermine:change" on it)
	const told = new WeakSet<Element>()
	function fresh(v: Element) {
		if (told.has(v)) return
		told.add(v)
		v.addEventListener("ermine:change", () => {
			v.classList.add("fresh")
			requestAnimationFrame(() => v.classList.remove("fresh"))
		})
	}
	// the lines stay scrolled to the end: after they change (their own change, not a watch's)
	function bottom(box: Element) {
		requestAnimationFrame(() => (box.scrollTop = box.scrollHeight))
		if (told.has(box)) return
		told.add(box)
		box.addEventListener("ermine:change", (e) => {
			if (e.target === box) box.scrollTop = box.scrollHeight
		})
	}

	// typing: enter runs, up and down walk the history, tab completes a command or a name
	let input: HTMLInputElement
	let complete: HTMLElement
	let back = 0
	const keys = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			const line = input.value
			input.value = ""
			back = 0
			complete.textContent = ""
			return [line]
		} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault()
			const h = read(history) as string[]
			back = Math.max(0, Math.min(h.length, back + (e.key === "ArrowUp" ? 1 : -1)))
			input.value = back ? h[h.length - back] : ""
		} else if (e.key === "Tab") {
			e.preventDefault()
			const words = input.value.split(" ")
			const word = words[words.length - 1]
			let options: string[]
			if (words.length === 1) {
				options = list("/bin").filter((n) => n.startsWith(word))
			} else {
				const cut = word.lastIndexOf("/") + 1
				const dir = word.slice(0, cut)
				const item = dir ? resolve(abs(dir)) : here()
				options = item
					? names(item).filter((n) => n.startsWith(word.slice(cut))).map((n) => dir + n)
					: []
			}
			if (!options.length) return
			let common = options[0]
			for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1)
			words[words.length - 1] = options.length === 1
				? common + (words.length === 1 ? " " : "")
				: common
			input.value = words.join(" ")
			complete.textContent = options.length > 1 ? options.join("   ") : ""
		}
	}
	// a click anywhere that is not a button, a window or the lines: the input has the keys
	const focus = (e: MouseEvent) => {
		if (
			!(e.target as HTMLElement).closest("button,input,.win,.lines") &&
			!getSelection()?.toString()
		) input.focus()
	}
	queueMicrotask(() => input.focus())

	return (
		<div class="app" onClick={focus}>
			<section class="term">
				<div class="bar">
					<button title="clear" onClick={handler("on/run", ["clear"])} />
					<b>shell</b>
				</div>
				<div class="lines" ref={bottom}>
					{bind("/var/shell/lines", (list: unknown[]) => list.map(draw))}
				</div>
				<label class="prompt">
					<span class="ps">
						{bind("/var/shell/cwd", (at: string[]) => `🐰 /${at.join("/")} ›`)}
					</span>
					<input
						spellcheck={false}
						autocomplete="off"
						ref={(e) => (input = e)}
						onKeyDown={handler("on/run", keys)}
					/>
				</label>
				<div class="complete" ref={(e) => (complete = e as HTMLElement)} />
			</section>
			<section class="screen">
				{bind("windows", (ws: { name: string; path: string }[]) =>
					ws.length ? ws.map(win) : (
						<div class="empty">
							processes you start show here. try <code>run lamp</code>,{" "}
							<code>run bunny</code>, <code>run ticker</code>, then <code>run mirror</code>
							{" "}
							and <code>echo /ticker/time &gt; /mirror/path</code>
						</div>
					))}
			</section>
		</div>
	)
}

// ---- the programs `run` can start: each is given the api and its own place (args[0]) ----

// a process saying something in the shell: when it ends, not when it is replaced
const print = (send: API["send"], text: string) => {
	try {
		send("/shell/on/print", text)
	} catch { /* the shell is gone too */ }
}

// counts seconds into its time node
export function ticker({ open, edit, method, send, teardown, args }: API) {
	const time = open("time", 0)
	method("on/tick", () => edit(time, (n: number) => n + 1))
	const every = setInterval(() => send("on/tick"), 1000)
	teardown((why) => {
		clearInterval(every)
		if (why === "ended") print(send, `${args[0]} ended: its timer stopped`)
	})
	return <div class="ticker">{bind("time", (v) => String(v).padStart(4, "0"))}</div>
}

// a lamp: click it, or write true to its on node from anywhere
export function lamp({ open, edit, method, send, teardown, args }: API) {
	const on = open("on", false)
	method("do/toggle", () => edit(on, (v: boolean) => !v))
	teardown((why) => why === "ended" && print(send, `${args[0]} ended: the lamp is out`))
	const lit = (v: unknown) => v === true
	return (
		<div class={bind("on", (v) => (lit(v) ? "lamp on" : "lamp"))} onClick={handler("do/toggle")}>
			<div class="bulb" />
			<span class="say">
				{args[0]}/on = {bind("on", (v) =>
					String(lit(v)))}
			</span>
		</div>
	)
}

// hops toward the carrot, a few steps a second
export function bunny({ open, read, edit, method, send, effect, teardown }: API) {
	const x = open("x", 10)
	const carrot = open("carrot", 80)
	method("on/hop", () => {
		const [at, goal] = [read(x) as number, Number(read(carrot)) || 0]
		if (Math.abs(goal - at) > 1) {
			edit(x, () => at + Math.sign(goal - at) * Math.min(7, Math.abs(goal - at)))
		}
	})
	method("on/carrot", (to: number) => edit(carrot, () => to))
	const every = setInterval(() => send("on/hop"), 320)
	teardown(() => clearInterval(every))
	const left = (v: unknown) => `left: ${Math.max(4, Math.min(96, Number(v) || 0))}%`
	// a click on the field: the carrot goes where it was
	const where = (e: MouseEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
		return [Math.round(((e.clientX - r.left) / r.width) * 100)]
	}
	// a hop: which way it faces and the little jump are the hop's, not a node's
	let b: HTMLElement | undefined
	effect("hop", () => read(x) as number, (v, was) => {
		if (!b) return
		const it = b
		it.classList.toggle("left", was !== undefined && v < was)
		it.classList.add("hop")
		setTimeout(() => it.classList.remove("hop"), 140)
	})
	return (
		<div class="field" onClick={handler("on/carrot", where)}>
			<span class="carrot" style={bind("carrot", left)}>🥕</span>
			<span class="bunny" style={bind("x", left)} ref={(e) => (b = e as HTMLElement)}>🐇</span>
		</div>
	)
}

// shows what is at the path its path node holds: change the path and it reads somewhere else
export function mirror({ open, read, entries, memo }: API) {
	const path = open("path", "/home/readme")
	memo("seen", () => {
		const at = "/" + String(read(path)).split("/").filter(Boolean).join("/")
		return entries(at).length ? pretty(read(at)) : "(nothing there)"
	})
	return (
		<div class="mirror">
			<div class="path">🪞 {bind("path")}</div>
			<pre>{bind("seen")}</pre>
		</div>
	)
}

// ---- little words ----
const src = (item) => String(item.id).slice(0, 8)
function parse(text) {
	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}
function pretty(v) {
	if (typeof v === "function") return `ƒ ${v.name || "(a function)"}`
	if (v instanceof Node) return `<${v.nodeName.toLowerCase()}>`
	if (v === undefined) return "(no value)"
	try {
		return JSON.stringify(v, null, 2) ?? String(v)
	} catch {
		return String(v)
	}
}
function preview(v, n = 34) {
	if (v === undefined) return ""
	const s = typeof v === "string"
		? JSON.stringify(v)
		: typeof v === "function"
		? "ƒ"
		: v instanceof Node
		? `<${v.nodeName.toLowerCase()}>`
		: pretty(v).replace(/\s+/g, " ")
	return s.length > n ? s.slice(0, n - 1) + "…" : s
}
