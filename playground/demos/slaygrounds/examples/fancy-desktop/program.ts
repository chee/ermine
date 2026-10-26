/** @jsxImportSource ermine-h */
import type { API } from "@ermine/programs/api"
import type { Extra } from "./host.ts"
import { bind, handler, under } from "ermine-h"

// fancy-desktop: a tiny desktop on the graph.
//   a window is a process placed in /desktop (/desktop/<app>-<n>), started by the shell. what it
//   shows and where it sits are kept in /windows/<app>-<n>, its working folder: doc and keys/<name>
//   (mounts of what it was handed), pos, folded, info. drag its title bar and it writes pos; the
//   close box takes the window's record away (the shell stops the process, its teardown runs, a
//   line lands in /system/log); the box on the right, or a double-click on the title, folds it
//   an app is a node in /apps: a function, typed javascript, with the types it opens in its
//   attributes. every thing says its type (a UTI; the types are nodes at /ermine/types).
//   double-click a thing and the host asks openwith, from where it was reached up to the root: the
//   nearest app opening a type the thing's conforms to opens it (in one folder, shorter names
//   first: canonical CBOR's order). a sketch opens in paint (placed in /home/sketches too, so
//   nearer), a picture in view, the dock's doodle in view (the way up from /dock never passes
//   /home/sketches)
//   two windows on one thing are two mounts of one node: type in either, both change
//   a clock in /home/clocks opens as a catclock (placed there too, so nearer); the dock's london
//   is the same node and opens as the plain clock. File → open with… offers both

const addr = (path: string) => ["/", ...path.split("/").filter(Boolean)]
const TYPE = "ermine.type"
// how a thing of a type is drawn: its picture's look (none: a plain node)
const KIND: Record<string, string> = {
	"public.plain-text": "text",
	"public.folder": "folder",
	"party.chee.ermine.picture": "image",
	"party.chee.ermine.list": "list",
	"party.chee.ermine.clock": "clock",
}
const kind = (type: string | undefined) => (type && KIND[type]) ?? null
const pad = (n: number) => String(n).padStart(2, "0")

// a whole value put on a node
const put = (api: API, x: Parameters<API["edit"]>[0], value: unknown) =>
	api.edit(x, [{ path: [], value }])

// ---- a picture: palette indices, w by h, onto a canvas ----
type Picture = { w: number; h: number; px: number[] }
function pixels(c: HTMLCanvasElement, img: Picture, pal: string[]) {
	if (!img || !Array.isArray(img.px) || !Array.isArray(pal)) return
	if (c.width !== img.w) c.width = img.w
	if (c.height !== img.h) c.height = img.h
	const ctx = c.getContext("2d")!
	const data = ctx.createImageData(img.w, img.h)
	img.px.forEach((k, i) => {
		const hex = pal[k] ?? "#000000"
		data.data.set(
			[1, 3, 5].map((j) => parseInt(hex.slice(j, j + 2), 16)).concat(255),
			i * 4,
		)
	})
	ctx.putImageData(data, 0, 0)
}

// a line in /system/log (the log is a node: the shell shows its last line)
function say(api: API, text: string) {
	api.edit("/system/log", (l: string[]) => {
		l.push(text)
		if (l.length > 30) l.shift()
	})
}

// the window's own folder: it is started with its name as its argument, its working folder
// /windows/<name>. what it was handed is under it
const folder = (api: API) => `/windows/${api.args[0]}`

// the other windows open on the same node as this one: a memo, so it follows /windows
function twins(api: API) {
	const mine = api.args[0]
	api.memo("twins", () => {
		const doc = api.entries(`/windows/${mine}/doc`)[0]?.id
		return api.list("/windows").filter((w) =>
			w !== mine && doc !== undefined && api.entries(`/windows/${w}/doc`)[0]?.id === doc
		)
	})
}
const Twins = () => (
	<span class="twins">
		{bind(
			"twins",
			(l: string[]) =>
				l.length ? `⧉ one node, also open in ${l.join(", ")}` : "one node, open here only",
		)}
	</span>
)

// a thing's picture: a folder, a page, a list, a clock face, or the picture itself
const Pic = (props: { is: string | null; id: string; pal?: string[] }) =>
	props.is === "image"
		? (
			<span class="pic image">
				{bind({ id: props.id }, (img: Picture) => (
					<canvas
						width={img.w}
						height={img.h}
						ref={(c) => pixels(c as HTMLCanvasElement, img, props.pal ?? [])}
					/>
				))}
			</span>
		)
		: <span class={`pic ${props.is ?? "node"}`} />

// =================================================================================================
// the shell: the menu bar, the desktop's icons (/home), the windows' frames (/windows), the dock
// =================================================================================================
type Thing = { name: string; path: string; id: string; is: string | null; pal: string[] }
// openwith's answer for the thing selected, as data: type is its UTI; others every way to open it,
// nearest first; not what was looked at and not taken, and why
type Plan = {
	path: string
	name?: string
	type?: string | null
	app?: string | null
	from?: string | null
	others?: { name: string; from: string; id: string }[]
	not?: string
	why?: string | null
}

const toPath = (address: string[]) => "/" + address.filter((x) => x !== "/").join("/")
// the folder a node was found in, from its names: "/home" for ["home", "hello"]
const folderOf = (names: readonly string[]) => "/" + names.slice(0, -1).join("/")
// what was looked at and not taken, one line: "clock, files: wrong-type"
function notTaken(why: { why: string; at: readonly string[] }[]) {
	const by = new Map<string, string[]>()
	for (const w of why) by.set(w.why, [...(by.get(w.why) ?? []), w.at.at(-1)!])
	return [...by].map(([reason, names]) => `${names.join(", ")}: ${reason}`).join("; ")
}

export function shell(api: API & Extra) {
	const {
		open,
		read,
		edit,
		entries,
		list,
		place,
		unplace,
		remove,
		memo,
		effect,
		method,
		send,
		start,
		stop,
		info,
		up,
		opening,
	} = api
	// the shell's own state is saved under ./ (the root): a reload finds it as it was
	const selected = open("./selected", "")
	const menu = open("./menu", "")
	const drag = open("./drag", null)
	const counts = open("./counts", {} as Record<string, number>)
	const typeOf = (id: unknown) =>
		read({ id: id as string, part: "attributes" }, [TYPE]) as string | undefined

	// the things in a folder: what each is, and the palette their pictures are drawn in
	const things = (path: string) => (): Thing[] => {
		const pal = read("/system/palette") as string[]
		return list(path).flatMap((name) => {
			const m = entries(`${path}/${name}`)[0]
			return m ? [{ name, path: `${path}/${name}`, id: m.id, is: kind(typeOf(m.id)), pal }] : []
		})
	}
	memo("icons", things("/home"))
	memo("docked", things("/dock"))

	// what opens a thing: the walk and the chain, as data (the host's opening, tracked: a new app
	// nearer, an attribute edited, and it is worked out again)
	function plan(address: string[]): Plan {
		const o = opening(address)
		const path = toPath(address)
		if ("missing" in o) return { path, why: o.missing }
		const type = typeOf(o.id) ?? null
		const said = { path, name: o.name, type }
		if ("refused" in o.found) {
			return {
				...said,
				app: null,
				others: [],
				not: "",
				why: "it says no type: nothing opens it",
			}
		}
		const ways = o.found.ways
		const first = ways[0]
		return {
			...said,
			app: first ? first.program.at.at(-1)! : null,
			from: first ? folderOf(first.program.at) : null,
			others: ways.map((w) => ({
				name: w.program.at.at(-1)!,
				from: folderOf(w.program.at),
				id: w.program.id,
			})),
			not: notTaken(o.found.why),
			why: first ? null : `nothing from ${toPath(["/", ...o.from])} up opens ${type}`,
		}
	}
	// what opens the thing selected, as data
	memo("opens", () => {
		const path = read(selected) as string
		return path ? plan(addr(path)) : ""
	})

	// the windows: a record each in /windows (what it shows, where it sits), a process each at
	// /desktop/<name>
	const pos = (name: string) => `/windows/${name}/pos`
	// the window in front: the highest z (read at z only: a drag does not rerun this)
	const front = memo("front", () => {
		let front = "", top = -Infinity
		for (const w of list("/windows")) {
			const z = (read(pos(w), ["z"]) as number | undefined) ?? 0
			if (z > top) (top = z, front = w)
		}
		return front
	})
	function raise(name: string) {
		let top = 0, mine = 0
		for (const w of list("/windows")) {
			const z = (read(pos(w), ["z"]) as number | undefined) ?? 0
			if (w === name) mine = z
			else top = Math.max(top, z)
		}
		if (mine <= top) edit(pos(name), (p: { z: number }) => void (p.z = top + 1))
	}

	// a window opened on the thing at the address: by the first app openwith finds, or the app
	// given. its record is written (mounts of the app, the thing and the keys the app wants, each
	// the nearest /system/<name> from the thing's folder up), and the effect below starts it
	function openWindow(address: string[], using?: string, where?: { x: number; y: number }) {
		const o = opening(address)
		if ("missing" in o) return say(api, `✗ ${o.missing}`)
		if ("refused" in o.found) return say(api, `✗ ${o.name} says no type: nothing opens it`)
		const way = using ? o.found.ways.find((w) => w.program.id === using) : o.found.ways[0]
		if (!way) {
			return say(
				api,
				`✗ nothing from ${toPath(["/", ...o.from])} up opens ${o.name} (${
					notTaken(o.found.why)
				})`,
			)
		}
		const a = (read({ id: way.program.id, part: "attributes" }) ?? {}) as Record<string, any>
		const app = {
			id: way.program.id,
			name: way.program.at.at(-1)!,
			from: folderOf(way.program.at),
			size: a.size,
		}
		const keys = (Array.isArray(a.keys) ? a.keys : []).map((need: string) => {
			const got = up(["system", need], o.from)
			return [need, got] as const
		})
		const lost = keys.filter(([, got]) => !got).map(([need]) => need)
		if (lost.length) {
			return say(api, `✗ ${app.name} wants ${lost.join(", ")}: no system/<name> from here up`)
		}
		const n = ((read(counts) as Record<string, number>)[app.name] ?? 0) + 1
		edit(counts, (c: Record<string, number>) => void (c[app.name] = n))
		const name = `${app.name}-${n}`
		const names = list("/windows")
		const z = Math.max(0, ...names.map((w) => (read(pos(w), ["z"]) as number | undefined) ?? 0)) +
			1
		const [w, h] = Array.isArray(app.size) ? app.size : [300, 240]
		const k = names.length % 8
		const at = `/windows/${name}`
		open(at, null)
		place(`${at}/app`, { id: app.id, part: "value" })
		place(`${at}/doc`, { id: o.id, part: "value" })
		open(`${at}/keys`, null)
		for (const [need, got] of keys) place(`${at}/keys/${need}`, got!)
		open(`${at}/pos`, { x: where?.x ?? 30 + k * 44, y: where?.y ?? 14 + k * 30, w, h, z })
		open(`${at}/folded`, false)
		open(`${at}/info`, {
			title: o.name,
			doc: toPath(address),
			app: app.name,
			from: app.from,
			keys: keys.map(([need, got]) => `${need} from ${folderOf(got!.path!)}`),
		})
		say(api, `opened ${o.name} with ${app.name} (found in ${app.from})`)
		return name
	}
	// a window closed: its record taken away. the mounts are unplaced (what they hold is the
	// thing's, and stays); what the window owns is removed
	function closeWindow(name: string) {
		const at = `/windows/${name}`
		for (const m of ["app", "doc"]) unplace(`${at}/${m}`)
		for (const need of [...list(`${at}/keys`)]) unplace(`${at}/keys/${need}`)
		for (const own of ["keys", "pos", "folded", "info"]) remove(`${at}/${own}`)
		remove(at)
	}

	// a process for each window kept: started on the app it names (a path, so the walk is the one
	// from the app), its name its argument and its working folder its record. a window taken
	// away: its process stopped. the shell stopping (a reload) stops them all, and starts them
	// again here, on what is now at /apps
	const running = new Map<string, ReturnType<typeof start>>()
	effect(
		"windows",
		() =>
			list("/windows").map((name) =>
				`${name}|${(read(`/windows/${name}/info`) as { app?: string } | undefined)?.app}`
			),
		(rows) => {
			const want = new Map(rows.map((r) => r.split("|") as [string, string]))
			for (const [name, p] of running) {
				if (want.has(name)) continue
				if (!("refused" in p)) stop(p)
				running.delete(name)
			}
			for (const [name, app] of want) {
				if (running.has(name)) continue
				const p = start(`/apps/${app}`, `/desktop/${name}`, {
					folder: `/windows/${name}`,
					args: [name],
				})
				if ("refused" in p) say(api, `✗ ${name}: ${p.refused}`)
				else running.set(name, p)
			}
		},
	)

	method("on/select", (path: string) => put(api, selected, path))
	method("on/open", (path: string, using?: string) => {
		put(api, menu, "")
		openWindow(addr(path), using)
	})
	method("on/menu", (which: string) => put(api, menu, read(menu) === which ? "" : which))
	method("on/raise", raise)
	// a drag: where the pointer took the title bar, then the pos node written as it moves
	method("on/grab", (name: string, x: number, y: number) => {
		const p = read(pos(name)) as { x: number; y: number }
		put(api, drag, { name, dx: x - p.x, dy: y - p.y })
	})
	method("on/drag", (name: string, x: number, y: number) => {
		const d = read(drag) as { name: string; dx: number; dy: number } | null
		if (d?.name !== name) return
		edit(pos(name), (p: { x: number; y: number }) => {
			p.x = Math.round(x - d.dx)
			p.y = Math.max(0, Math.round(y - d.dy))
		})
	})
	method("on/drop", () => put(api, drag, null))
	method("on/fold", (name: string) => {
		const f = `/windows/${name}/folded`
		put(api, f, !read(f))
	})
	// closing is taking the window's record away: the process sees it gone and is stopped. none
	// named: the window in front
	method("on/close", (name?: string) => {
		put(api, menu, "")
		name ??= read(front) as string
		if (!name || !entries(`/windows/${name}`).length) return
		closeWindow(name)
		say(api, `closed ${name}: its record taken from /windows, its process from /desktop`)
	})
	method("on/show", (name: string) => {
		put(api, menu, "")
		put(api, `/windows/${name}/folded`, false)
		raise(name)
	})
	method("on/note", () => {
		put(api, menu, "")
		const names = list("/home")
		let n = 1
		while (names.includes(`note-${n}`)) n++
		const path = `/home/note-${n}`
		edit(info(open(path, "")), [{ path: [TYPE], value: "public.plain-text" }])
		put(api, selected, path)
		openWindow(addr(path))
	})
	method("on/clear", () => {
		put(api, menu, "")
		put(api, "/system/log", ["✿ the log, cleared"])
	})

	// the session the desktop starts with: once, then it is what was left
	if (!entries("./booted").length) {
		open("./booted", true)
		openWindow(addr("/home/hello"), undefined, { x: 18, y: 16 })
		openWindow(addr("/home/sketches/doodle"), undefined, { x: 372, y: 34 })
		openWindow(addr("/home/clocks/london"), undefined, { x: 650, y: 40 })
	}

	// the title bar takes the pointer (not its buttons): the drag goes on outside it
	const grab = (name: string) => (e: PointerEvent) => {
		if ((e.target as Element).closest("button")) return undefined
		try {
			;(e.currentTarget as Element).setPointerCapture(e.pointerId)
		} catch { /* a pointer made by a script: no capture, the drag still goes */ }
		return [name, e.clientX, e.clientY]
	}
	const frame = (p: { x: number; y: number; w: number; h: number; z: number }) => ({
		left: `${p.x}px`,
		top: `${p.y}px`,
		width: `${p.w}px`,
		height: `${p.h}px`,
		zIndex: String(p.z),
	})

	const Frame = ({ w }) => {
		const name = w.name
		return (
			<section
				class={bind([w, "folded"], (f) => (f ? "win folded" : "win"))}
				style={bind([w, "pos"], frame)}
				onPointerDown={handler("on/raise", [name])}
			>
				<header
					class={bind("front", (f) => (f === name ? "title on" : "title"))}
					onPointerDown={handler("on/grab", grab(name))}
					onPointerMove={handler(
						"on/drag",
						(e) => (e.buttons ? [name, e.clientX, e.clientY] : undefined),
					)}
					onPointerUp={handler("on/drop")}
					onDblClick={handler("on/fold", [name])}
				>
					<button
						class="close"
						title="close: take its record from /windows"
						onClick={handler("on/close", [name])}
					/>
					<span class="name">{bind([w, "info"], (i) => i.title)}</span>
					<span class="via">{bind([w, "info"], (i) => `${i.app} · ${i.from}`)}</span>
					<button
						class="shade"
						title="fold it (minimise)"
						onClick={handler("on/fold", [name])}
					/>
				</header>
				<div class="body">{bind(`/desktop/${name}`, (el) => el)}</div>
			</section>
		)
	}

	const Icon = ({ x, dock }: { x: Thing; dock?: boolean }) => (
		<button
			class={bind("selected", (s) => (s === x.path ? "icon on" : "icon"))}
			title={`${x.path} · ${x.is ?? "says nothing"}`}
			onClick={handler(dock ? "on/open" : "on/select", [x.path])}
			onDblClick={dock ? undefined : handler("on/open", [x.path])}
		>
			<Pic is={x.is} id={x.id} pal={x.pal} />
			<span class="label">{x.name}</span>
		</button>
	)

	const Opens = (o: Plan | "") =>
		o
			? (
				<span class="opens">
					<b>{o.name}</b> is <i>{o.type ?? "?"}</i> → <b>{o.app ?? "nothing"}</b>{" "}
					<span class="tag">{o.app ? `found in ${o.from}` : o.why}</span>
				</span>
			)
			: <span class="opens dim">select a thing: what opens it is found by lookup</span>

	const menus = {
		cherry: () => (
			<div class="menu about" style={{ left: "6px" }}>
				<b>ermine desktop</b>
				<p>
					a window is a process placed in /desktop. what opens a thing is the nearest app, from
					where it is up to the root, that opens its type (openwith).
				</p>
				<button onClick={handler("on/clear")}>clear the log</button>
			</div>
		),
		file: () => (
			<div class="menu" style={{ left: "40px" }}>
				{bind("opens", (o: Plan | "") =>
					o && o.name
						? [
							<button onClick={handler("on/open", [o.path])}>
								Open {o.name} {o.app ? <span class="tag">{o.app}</span> : ""}
							</button>,
							<div class="sub">open with… (every app opening it, nearest first)</div>,
							...(o.others ?? []).map((x) => (
								<button class="with" onClick={handler("on/open", [o.path, x.id])}>
									{x.name} <span class="tag">{x.from}</span>
								</button>
							)),
							o.not ? <div class="sub not">not taken: {o.not}</div> : "",
						]
						: <div class="sub">select a thing to open it</div>)}
				<hr />
				<button onClick={handler("on/note")}>New note</button>
				<button onClick={handler("on/close")}>
					Close {bind("front", (f) => f || "nothing")}
				</button>
			</div>
		),
		window: () => (
			<div class="menu" style={{ left: "82px" }}>
				<div class="sub">/windows: each a process at /desktop</div>
				{under("/windows", (w) => (
					<button onClick={handler("on/show", [w.name])}>
						{bind([w, "info"], (i) => `${i.title} · ${i.app}`)}{" "}
						<span class="dim">{bind([w, "folded"], (f) => (f ? "folded" : w.name))}</span>
					</button>
				))}
			</div>
		),
	}
	return (
		<div class="os">
			<style>{css}</style>
			<nav class="bar">
				{["cherry", "file", "window"].map((m) => (
					<button
						class={bind("menu", (open) => (open === m ? "m on" : "m"))}
						onClick={handler("on/menu", [m])}
					>
						{m === "cherry" ? "🍒" : m === "file" ? "File" : "Window"}
					</button>
				))}
				<span class="fill" />
				{bind("opens", Opens)}
			</nav>
			<main class="area">
				<div class="card hint">
					<span class="tag">ermine desktop</span>
					<p>
						double-click a thing to open it. drag a title bar, fold a window, close one: each
						is a write to /windows.
					</p>
					<p class="log">
						{bind("/system/log", (l: string[]) => `✿ ${l[l.length - 1] ?? ""}`)}
					</p>
				</div>
				<div class="icons">
					{bind("icons", (list: Thing[]) => list.map((x) => <Icon key={x.path} x={x} />))}
				</div>
				<div class="windows">{under("/windows", (w) => <Frame w={w} />)}</div>
				<footer class="dock">
					{bind(
						"docked",
						(list: Thing[]) => list.map((x) => <Icon key={x.path} x={x} dock />),
					)}
				</footer>
			</main>
			{bind("menu", (m: string) =>
				m
					? [
						<div class="scrim" onPointerDown={handler("on/menu", [""])} />,
						menus[m as keyof typeof menus]?.(),
					]
					: "")}
		</div>
	)
}

// =================================================================================================
// the apps. each is run as the process of a window: its name is its argument, its working folder
// /windows/<name>; what it was handed is under that: doc (the thing, a mount), keys/<name> (each
// key its app needs, a mount), info, pos, folded
// =================================================================================================

// text → window
function editor(api: API & Extra) {
	const { read, method, teardown } = api
	const doc = `${folder(api)}/doc`
	const name = api.args[0]
	const title = (read(`${folder(api)}/info`) as { title?: string } | undefined)?.title
	method("on/type", (text: string) => put(api, doc, text))
	twins(api)
	teardown((why) => {
		if (why === "ended") say(api, `${name}: cleanup ran, let go of ${title}`)
	})
	return (
		<div class="app editor">
			<textarea
				spellcheck={false}
				value={bind(doc)}
				onInput={handler("on/type", (e) => [e.target.value])}
			/>
			<footer>
				{bind(doc, (v: string) =>
					`${[...String(v)].length} characters · ${String(v).split("\n").length} lines`)}
				<Twins />
			</footer>
		</div>
	)
}

// image + palette → window: the picture, never changed here
function viewer(api: API & Extra) {
	const { read, effect, teardown } = api
	const f = folder(api)
	const name = api.args[0]
	const canvas = document.createElement("canvas")
	effect(
		"draw",
		() => ({ img: read(`${f}/doc`), pal: read(`${f}/keys/palette`) }),
		(v) => pixels(canvas, v.img as Picture, v.pal as string[]),
	)
	twins(api)
	teardown((why) => {
		if (why === "ended") say(api, `${name}: cleanup ran, put the picture down`)
	})
	return (
		<div class="app viewer">
			<div class="frame">{canvas}</div>
			<p>
				{bind(
					`${f}/doc`,
					(img: Picture) => `${img.w} × ${img.h} · ${new Set(img.px).size} colours`,
				)} <span class="tag">{bind(`${f}/info`, (i) => i.keys.join(", "))}</span>
			</p>
			<Twins />
		</div>
	)
}

// image + palette → window: a dab writes one pixel, a patch at px/<i>
function paint(api: API & Extra) {
	const { open, read, edit, effect, method, teardown } = api
	const f = folder(api)
	const doc = `${f}/doc`, pal = `${f}/keys/palette`
	const name = api.args[0]
	const ink = open("ink", 3)
	const canvas = document.createElement("canvas")
	effect(
		"draw",
		() => ({ img: read(doc), pal: read(pal) }),
		(v) => pixels(canvas, v.img as Picture, v.pal as string[]),
	)
	twins(api)
	method("on/dab", (i: number) => {
		const k = read(ink)
		if (read(doc, ["px", i]) !== k) edit(doc, (d: Picture) => void (d.px[i] = k as number))
	})
	method("on/ink", (k: number) => put(api, ink, k))
	method("on/wipe", () => edit(doc, (d: Picture) => void d.px.fill(0)))
	teardown((why) => {
		if (why === "ended") say(api, `${name}: cleanup ran, put the brush down`)
	})
	// the pixel under the pointer (the picture is fitted into the canvas's box, centred)
	const cell = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect()
		const k = Math.min(r.width / canvas.width, r.height / canvas.height)
		const left = r.left + (r.width - k * canvas.width) / 2
		const top = r.top + (r.height - k * canvas.height) / 2
		const x = Math.floor((e.clientX - left) / k)
		const y = Math.floor((e.clientY - top) / k)
		if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return undefined
		return [y * canvas.width + x]
	}
	return (
		<div class="app paint">
			<div
				class="frame"
				onPointerDown={handler("on/dab", (e) => {
					try {
						e.currentTarget.setPointerCapture(e.pointerId)
					} catch { /* a script's pointer */ }
					return cell(e)
				})}
				onPointerMove={handler("on/dab", (e) => (e.buttons ? cell(e) : undefined))}
			>
				{canvas}
			</div>
			<div class="inks">
				{bind(pal, (cols: string[]) =>
					cols.map((c, i) => (
						<button
							key={String(i)}
							class={bind("ink", (k) => (k === i ? "ink on" : "ink"))}
							style={{ background: c }}
							title={c}
							onClick={handler("on/ink", [i])}
						/>
					)))}
				<button class="wipe" onClick={handler("on/wipe")}>wipe</button>
			</div>
			<Twins />
		</div>
	)
}

// list → window: a checklist, each tick a patch at <i>/done
function lists(api: API & Extra) {
	const { edit, method } = api
	const doc = `${folder(api)}/doc`
	method("on/toggle", (i: number) => edit(doc, (d: Item[]) => void (d[i].done = !d[i].done)))
	method("on/add", (text: string) => edit(doc, (d: Item[]) => void d.push({ text, done: false })))
	method("on/drop", (i: number) => edit(doc, (d: Item[]) => void d.splice(i, 1)))
	twins(api)
	let input: HTMLInputElement
	const typed = () => {
		const text = input.value.trim()
		input.value = ""
		return text ? [text] : undefined
	}
	return (
		<div class="app lists">
			<ul>
				{bind(doc, (list: Item[]) =>
					list.map((x, i) => (
						<li key={String(i)} class={x.done ? "done" : ""}>
							<button class="tick" onClick={handler("on/toggle", [i])}>
								{x.done ? "✓" : ""}
							</button>
							<span>{x.text}</span>
							<button class="x" title="take it out" onClick={handler("on/drop", [i])}>
								×
							</button>
						</li>
					)))}
			</ul>
			<input
				ref={(e) =>
					void (input = e)}
				placeholder="a new thing, then enter"
				onKeyDown={handler("on/add", (e) => (e.key === "Enter" ? typed() : undefined))}
			/>
			<Twins />
		</div>
	)
}
type Item = { text: string; done: boolean }

// folder → window: a browser of the graph. any node can be gone into; a thing that says what it
// is (and is not a folder) is opened in a window of its own
function files(api: API & Extra) {
	const { open, read, entries, list, memo, method, send } = api
	const typeOf = (id: unknown) =>
		read({ id: id as string, part: "attributes" }, [TYPE]) as string | undefined
	// where it starts: the path the thing was opened from
	const from = (read(`${folder(api)}/info`) as { doc?: string } | undefined)?.doc ?? "/"
	const at = open("at", from)
	memo("listing", () => {
		const path = read(at) as string
		const pal = read("/system/palette") as string[]
		if (!entries(path).length) return { path, items: [] }
		return {
			path,
			items: list(path).flatMap((name) => {
				const there = `${path === "/" ? "" : path}/${name}`
				const m = entries(there)[0]
				if (!m) return []
				const v = m.value
				return [{
					name,
					path: there,
					id: m.id,
					is: kind(typeOf(m.id)) ??
						(typeof v === "function" ? "app" : list(there).length ? "node" : "leaf"),
					peek: peek(v),
					pal,
				}]
			}),
		}
	})
	method("on/go", (path: string) => {
		const x = entries(path)[0]
		const is = x && kind(typeOf(x.id))
		if (is && is !== "folder") send("/shell/on/open", path)
		else api.edit(at, [{ path: [], value: path }])
	})
	method("on/up", () => {
		const path = read(at) as string
		api.edit(at, [{ path: [], value: path.split("/").slice(0, -1).join("/") || "/" }])
	})
	method("on/inspect", () => {
		;(globalThis as unknown as { parent: { __pick?: (a: string[]) => void } }).parent.__pick?.(
			(read(at) as string).split("/").filter(Boolean),
		)
	})
	// a click selects it on the desktop: the shell's own method, sent to across (its menu bar then
	// says what opens it, its File menu what else would)
	method("on/select", (path: string) => send("/shell/on/select", path))
	return (
		<div class="app files">
			<div class="crumbs">
				<button onClick={handler("on/up")} title="up one">↑</button>
				<span class="where">{bind("at")}</span>
				<button onClick={handler("on/inspect")} title="pick this node in the inspector">
					⌖
				</button>
			</div>
			<div class="grid">
				{bind("listing", (l) =>
					l.items.length
						? l.items.map((m) => (
							<button
								key={m.path}
								class={bind("/selected", (s) => (s === m.path ? "file on" : "file"))}
								title={`${m.path}${m.peek ? ` = ${m.peek}` : ""}`}
								onClick={handler("on/select", [m.path])}
								onDblClick={handler("on/go", [m.path])}
							>
								<Pic is={m.is} id={m.id} pal={m.pal} />
								<span class="label">{m.name}</span>
								{m.peek ? <span class="peek">{m.peek}</span> : ""}
							</button>
						))
						: <p class="dim">nothing placed here</p>)}
			</div>
		</div>
	)
}
function peek(v: unknown): string {
	if (v === undefined || v === null) return ""
	if (typeof v === "function") return `ƒ ${v.name || "function"}`
	if (typeof v === "string") {
		return v.length > 16 ? JSON.stringify(v.slice(0, 15) + "…") : JSON.stringify(v)
	}
	if (typeof v !== "object") return String(v)
	if ("nodeType" in (v as object)) return `<${(v as Element).localName}>`
	if (Array.isArray(v)) return `[${v.length}]`
	return `{${Object.keys(v as object).slice(0, 3).join(", ")}}`
}

// clock → window: its own timer writes its now node; the teardown stops it
function clock(api: API & Extra) {
	const { open, read, edit, memo, teardown } = api
	const doc = `${folder(api)}/doc`
	const name = api.args[0]
	const now = open("now", Date.now())
	// a timer writes as the process, with no method in between
	const every = setInterval(() => edit(now, () => Date.now()), 1000)
	teardown((why) => {
		clearInterval(every)
		if (why === "ended") say(api, `${name}: cleanup ran, its second hand stopped`)
	})
	memo("hands", () => {
		const ms = read(now) as number
		const { zone, label } = (read(doc) ?? {}) as { zone?: string; label?: string }
		const [h, m, s] = new Date(ms).toLocaleTimeString("en-GB", { timeZone: zone, hour12: false })
			.split(":").map(Number)
		return {
			h: (h % 12) * 30 + m / 2,
			m: m * 6 + s / 10,
			s: s * 6,
			text: `${pad(h)}:${pad(m)}:${pad(s)}`,
			label: label ?? zone,
		}
	})
	const turn = (k: "h" | "m" | "s") => (x) => ({ transform: `rotate(${x[k]}deg)` })
	return (
		<div class="app clock">
			<div class="face">
				{Array.from(
					{ length: 12 },
					(_, i) => <b style={{ transform: `rotate(${i * 30}deg)` }} />,
				)}
				<i class="hh" style={bind("hands", turn("h"))} />
				<i class="mm" style={bind("hands", turn("m"))} />
				<i class="ss" style={bind("hands", turn("s"))} />
				<u />
			</div>
			<p>
				<span class="tag">{bind("hands", (x) => x.label)}</span> {bind("hands", (x) => x.text)}
			</p>
		</div>
	)
}

// clock → window, as a Kit-Cat Klock: a black cat with a clock on its belly, a tail that swings as
// a pendulum and eyes that follow it. its own timer writes where the tail is (its swing node);
// how fast it swings and its bow tie are a node on the thing (doc/cat), not the window: two cats
// on one clock swing together, and an edit there changes both
type Cat = { swing: number; bow: string }
function catclock(api: API & Extra) {
	const { open, read, edit, effect, teardown } = api
	const f = folder(api)
	const doc = `${f}/doc`
	const name = api.args[0]
	// the thing's own node, made the first time any cat opens it: ./doc is the thing, so this is
	// under the thing, one for every window on it
	const cat = open("./doc/cat", { swing: 1, bow: "#ff2284" })
	const swing = open("swing", { x: 0, at: Date.now() })
	const canvas = document.createElement("canvas")
	// a pendulum: x = sin(π·time / seconds a swing), from the wall clock, so every cat with the
	// same cat node is at the same place in its swing. the timer writes as the process
	const every = setInterval(() => {
		const at = Date.now()
		const { swing: secs = 1 } = (read(cat) ?? {}) as Partial<Cat>
		const x = Math.sin((Math.PI * at) / (Math.max(0.2, Number(secs) || 1) * 1000))
		edit(swing, () => ({ x: Math.round(x * 1000) / 1000, at }))
	}, 50)
	teardown((why) => {
		clearInterval(every)
		if (why === "ended") say(api, `${name}: cleanup ran, its tail stopped swinging`)
	})
	effect(
		"draw",
		() => {
			const { x, at } = read(swing) as { x: number; at: number }
			const { zone } = (read(doc) ?? {}) as { zone?: string }
			const { bow = "#ff2284" } = (read(cat) ?? {}) as Partial<Cat>
			const [h, m] = new Date(at).toLocaleTimeString("en-GB", { timeZone: zone, hour12: false })
				.split(":").map(Number)
			return { x, h, m, bow }
		},
		(v) => kitcat(canvas, v),
	)
	twins(api)
	const where = `${(read(`${f}/info`) as { doc?: string } | undefined)?.doc ?? ""}/cat`
	return (
		<div class="app catclock">
			<div class="cat">{canvas}</div>
			<p>
				<span class="tag">{bind(doc, (d) => d.label ?? d.zone)}</span>
				{bind("draw", (v) => `${pad(v.h)}:${pad(v.m)}`)}
			</p>
			<p class="dim" title="edit it in the graph tab: every cat on this clock changes">
				swing and bow: {where}
			</p>
			<Twins />
		</div>
	)
}

// the cat, on a canvas (160 by 300): tail behind, body, head, ears, eyes, grin, bow tie, the face
function kitcat(c: HTMLCanvasElement, v: { x: number; h: number; m: number; bow: string }) {
	const W = 160, H = 300, dpr = devicePixelRatio || 1
	if (c.width !== W * dpr) c.width = W * dpr
	if (c.height !== H * dpr) c.height = H * dpr
	const g = c.getContext("2d")!
	g.setTransform(dpr, 0, 0, dpr, 0, 0)
	g.clearRect(0, 0, W, H)
	g.lineJoin = "round"
	g.lineCap = "round"
	const shape = (path: () => void, fill: string, stroke = "#000", width = 1.5) => {
		g.beginPath()
		path()
		g.fillStyle = fill
		g.fill()
		if (stroke) {
			g.strokeStyle = stroke
			g.lineWidth = width
			g.stroke()
		}
	}
	const oval = (x: number, y: number, rx: number, ry: number) => () =>
		g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
	// the soft pink glow the desktop's cards have
	g.shadowColor = "#ff228455"
	g.shadowBlur = 14
	// the tail: a pendulum from under the body, ±24°
	g.save()
	g.translate(80, 196)
	g.rotate(-v.x * 0.42)
	shape(() => {
		g.moveTo(-8, 0)
		g.quadraticCurveTo(-11, 52, -5, 86)
		g.quadraticCurveTo(0, 97, 5, 86)
		g.quadraticCurveTo(11, 52, 8, 0)
		g.closePath()
	}, "#000")
	g.restore()
	// the body, and two white paws at its foot
	shape(() => g.roundRect(36, 92, 88, 122, [28, 28, 34, 34]), "#000")
	g.shadowBlur = 0
	shape(oval(58, 210, 14, 8), "#fff")
	shape(oval(102, 210, 14, 8), "#fff")
	// the ears, pink inside
	for (const k of [-1, 1]) {
		shape(() => {
			g.moveTo(80 + k * 38, 52)
			g.lineTo(80 + k * 34, 10)
			g.lineTo(80 + k * 8, 34)
			g.closePath()
		}, "#000")
		shape(
			() => {
				g.moveTo(80 + k * 32, 42)
				g.lineTo(80 + k * 31, 20)
				g.lineTo(80 + k * 16, 34)
				g.closePath()
			},
			"#ffd9ea",
			"",
		)
	}
	// the head
	shape(oval(80, 60, 42, 35), "#000")
	// the eyes: whites, and pupils that look the way the tail swings
	for (const ex of [63, 97]) {
		shape(oval(ex, 52, 12, 15), "#fff")
		shape(oval(ex - v.x * 6, 55, 5, 9), "#000", "")
	}
	// the nose and the grin, the whiskers
	shape(
		() => {
			g.moveTo(75, 70)
			g.lineTo(85, 70)
			g.lineTo(80, 75)
			g.closePath()
		},
		"#ff2284",
		"",
	)
	g.strokeStyle = "#fff"
	g.lineWidth = 2.5
	g.beginPath()
	g.moveTo(62, 76)
	g.quadraticCurveTo(80, 90, 98, 76)
	g.stroke()
	g.lineWidth = 1.2
	for (const k of [-1, 1]) {
		for (const dy of [-3, 3]) {
			g.beginPath()
			g.moveTo(80 + k * 22, 76 + dy / 2)
			g.lineTo(80 + k * 46, 72 + dy * 2)
			g.stroke()
		}
	}
	// the bow tie, in the cat node's colour
	for (const k of [-1, 1]) {
		shape(() => {
			g.moveTo(80, 100)
			g.lineTo(80 + k * 20, 90)
			g.lineTo(80 + k * 20, 112)
			g.closePath()
		}, v.bow)
	}
	shape(oval(80, 101, 5, 6), v.bow)
	// the clock on its belly: white, twelve marks, an hour hand and a minute hand
	shape(oval(80, 150, 31, 31), "#fff")
	g.strokeStyle = "#000"
	for (let i = 0; i < 12; i++) {
		const a = (i * Math.PI) / 6
		g.lineWidth = i % 3 ? 1 : 2
		g.beginPath()
		g.moveTo(80 + Math.sin(a) * 25, 150 - Math.cos(a) * 25)
		g.lineTo(80 + Math.sin(a) * 29, 150 - Math.cos(a) * 29)
		g.stroke()
	}
	const hand = (turn: number, len: number, width: number) => {
		g.lineWidth = width
		g.beginPath()
		g.moveTo(80, 150)
		g.lineTo(80 + Math.sin(turn) * len, 150 - Math.cos(turn) * len)
		g.stroke()
	}
	hand((((v.h % 12) + v.m / 60) * Math.PI) / 6, 15, 3.5)
	hand((v.m * Math.PI) / 30, 23, 2.2)
	shape(oval(80, 150, 3.5, 3.5), "#40dcba", "#000", 1)
}

// the apps, as the host writes them into /apps. opens: the types each opens (a thing's type fits
// when it conforms to one). keys: what the host mounts under its window. two apps opening one type
// in one folder: the shorter name first (canonical CBOR's order), so view before paint, clock
// before catclock
export const apps = {
	editor: { opens: ["public.plain-text"], size: [330, 220], run: editor },
	view: { opens: ["party.chee.ermine.picture"], keys: ["palette"], size: [230, 290], run: viewer },
	paint: { opens: ["party.chee.ermine.picture"], keys: ["palette"], size: [270, 360], run: paint },
	lists: { opens: ["party.chee.ermine.list"], size: [270, 240], run: lists },
	files: { opens: ["public.folder"], size: [390, 260], run: files },
	clock: { opens: ["party.chee.ermine.clock"], size: [190, 238], run: clock },
	catclock: { opens: ["party.chee.ermine.clock"], size: [250, 380], run: catclock },
}

// ---- the look: chee.party (lemon, black 1px lines, white cards with a pink glow, cherry, mint,
// blue, Jost, skewed lemon tags, buttons that lift). one nod to System 7: the pinstriped title bar
// of the window in front ----
const css = `
body{margin:0;overflow:hidden}
.os{position:fixed;inset:0;display:flex;flex-direction:column;background:#ffff88;font:13px Jost,system-ui,sans-serif;color:#000;user-select:none;-webkit-user-select:none}
.os button{font:inherit;color:#000;background:#fff;border:1px solid #000;border-radius:2px;padding:1px 10px;box-shadow:1px 1px 0 #000;cursor:pointer;transition:transform 100ms,box-shadow 100ms}
.os button:hover{transform:translateY(-1px);box-shadow:2px 2px 0 #000}
.os button:active{transform:none;box-shadow:none}
.tag{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 7px;transform:skew(-8deg);font-size:11px;line-height:15px;white-space:nowrap}
.dim{color:#0008}
.card{background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 0 10px 2px #66003322}
.bar{position:relative;z-index:5000;height:26px;flex:none;display:flex;align-items:center;gap:2px;padding:0 6px;background:#fff;border-bottom:1px solid #000}
.bar .m{border:0;box-shadow:none;background:none;padding:1px 10px;border-radius:0;font-weight:500}
.bar .m:hover,.bar .m.on{background:#000;color:#fff;transform:none;box-shadow:none}
.bar .fill{flex:1}
.opens{display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;overflow:hidden}
.opens i{font-style:normal;background:#ffd9ea;padding:0 4px}
.scrim{position:fixed;inset:0;z-index:4000}
.menu{position:fixed;top:25px;z-index:5001;min-width:210px;display:flex;flex-direction:column;gap:3px;padding:6px;background:#fff;border:1px solid #000;box-shadow:0 0 10px 2px #66003322,3px 3px 0 #000}
.menu button{text-align:left;box-shadow:none;border-color:transparent;display:flex;align-items:center;gap:6px}
.menu button:hover{background:#ff2284;color:#fff;border-color:#000;box-shadow:none;transform:none}
.menu .with{padding-left:20px}
.menu .sub{font-size:11px;color:#0009;padding:2px 8px}
.menu .not{max-width:240px;padding-left:20px}
.menu hr{border:0;border-top:1px solid #000;margin:3px 0;width:100%}
.menu.about{max-width:260px}
.menu.about p{margin:4px 2px 8px;font-size:12px}
.area{position:relative;flex:1;overflow:hidden;background:#ffff88 radial-gradient(#0000001a 1px,transparent 1.2px) 0 0/18px 18px}
.hint{position:absolute;left:14px;bottom:14px;width:230px;padding:8px 10px;font-size:12px}
.hint p{margin:6px 0 0}
.icons{position:absolute;right:10px;top:10px;bottom:90px;display:flex;flex-direction:column;flex-wrap:wrap-reverse;align-content:flex-start;gap:4px}
.icon{display:flex;flex-direction:column;align-items:center;gap:3px;width:74px;padding:5px 2px!important;background:none!important;border-color:transparent!important;box-shadow:none!important}
.icon .label{background:#fff;border:1px solid #000;padding:0 5px;font-size:12px;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icon.on .label{background:#000;color:#fff}
.icon.on .pic{outline:2px solid #ff2284;outline-offset:2px}
.pic{display:block;position:relative;width:30px;height:34px;flex:none}
.pic.folder{height:24px;width:36px;margin-top:10px;background:#ffff88;border:1px solid #000;border-radius:1px 2px 2px 2px}
.pic.folder::before{content:"";position:absolute;left:-1px;top:-7px;width:14px;height:6px;background:#ffff88;border:1px solid #000;border-bottom:0;border-radius:2px 2px 0 0}
.pic.text,.pic.list{background:#fff repeating-linear-gradient(#fff 0 6px,#0000002a 6px 7px);background-clip:content-box;padding:6px 4px;border:1px solid #000;clip-path:polygon(0 0,70% 0,100% 22%,100% 100%,0 100%)}
.pic.text::after,.pic.list::after{content:"";position:absolute;right:0;top:0;width:30%;height:22%;background:#ffd9ea;border-left:1px solid #000;border-bottom:1px solid #000}
.pic.list{background:#fff repeating-linear-gradient(#fff 0 7px,#ff2284 7px 8px);background-clip:content-box}
.pic.clock{width:32px;height:32px;border-radius:50%;border:1px solid #000;background:#fff conic-gradient(from 0deg,#40dcba 0 25%,#fff 0)}
.pic.image{width:34px;height:34px;border:1px solid #000;background:#fff;padding:1px}
.pic.image canvas{width:100%;height:100%;image-rendering:pixelated;display:block}
.pic.app{width:30px;height:30px;background:#40dcba;border:1px solid #000;border-radius:6px}
.pic.app::after{content:"ƒ";position:absolute;inset:0;display:grid;place-items:center;font-style:italic;font-size:18px}
.pic.node,.pic.leaf{width:26px;height:26px;border:1px solid #000;background:#fff;border-radius:50%}
.pic.node::after{content:"";position:absolute;inset:6px;background:#2269ff;border-radius:50%}
.pic.leaf::after{content:"";position:absolute;inset:9px;background:#000;border-radius:50%}
.windows{position:absolute;inset:0;pointer-events:none}
.win{position:absolute;pointer-events:auto;display:flex;flex-direction:column;background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 0 10px 2px #66003322,0 6px 24px #ff228422;min-width:150px}
.win.folded{height:auto!important}
.win.folded .body{display:none}
.title{position:relative;height:21px;flex:none;display:flex;align-items:center;gap:6px;padding:0 5px;border-bottom:1px solid #000;cursor:grab;touch-action:none;background:#fff}
.title.on{background:#fff repeating-linear-gradient(#000 0 1px,#fff 1px 3px) 0 4px/100% 12px no-repeat;background-clip:padding-box}
.win.folded .title{border-bottom:0}
.title .close,.title .shade{width:13px;height:13px;padding:0;flex:none;box-shadow:none;border-radius:0}
.title .close:hover{background:#ff2284;transform:none;box-shadow:none}
.title .shade:hover{background:#40dcba;transform:none;box-shadow:none}
.title .shade::after{content:"";display:block;margin:3px 1px 0;border-top:1px solid #000;border-bottom:1px solid #000;height:2px}
.title .name{margin:0 auto;background:#fff;padding:0 8px;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.title .via{background:#ffff88;border:1px solid #000;padding:0 6px;transform:skew(-8deg);font-size:10px;line-height:13px;white-space:nowrap}
.body{flex:1;min-height:0;overflow:auto}
.box{height:100%}
[data-ermine-box^="desktop/"]{position:absolute;left:-9999px}
.hint .log{margin-top:6px;padding-top:5px;border-top:1px dashed #0004;color:#ff2284;font-weight:500}
.dock{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);display:flex;gap:4px;padding:5px 10px 4px;background:#fff;border:1px solid #000;border-radius:2px;box-shadow:0 0 10px 2px #66003322,0 4px 24px #ff228433;z-index:3000}
.dock .icon{width:62px}
.dock .icon:hover .pic{transform:translateY(-3px)}
.dock .pic{transition:transform 120ms}
.app{height:100%;display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box}
.twins{font-size:11px;color:#0009}
.editor textarea{flex:1;resize:none;border:1px solid #000;border-radius:2px;padding:6px 8px;font:14px/1.45 Jost,system-ui,sans-serif;outline:none;user-select:text;-webkit-user-select:text}
.editor textarea:focus{box-shadow:0 0 0 2px #40dcba}
.editor footer{display:flex;justify-content:space-between;gap:8px;font-size:11px}
.frame{flex:1;min-height:0;display:grid;place-items:center;background:#fff repeating-conic-gradient(#ffd9ea 0 25%,#fff 0 50%) 0 0/12px 12px;border:1px solid #000;touch-action:none}
.frame{position:relative}
.frame canvas{position:absolute;inset:6px;width:calc(100% - 12px);height:calc(100% - 12px);object-fit:contain;image-rendering:pixelated;display:block}
.viewer p{margin:0;font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.paint .frame{cursor:crosshair}
.inks{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.inks .ink{width:20px;height:20px;padding:0}
.inks .ink.on{outline:2px solid #ff2284;outline-offset:1px}
.inks .wipe{margin-left:auto;font-size:12px}
.lists ul{list-style:none;margin:0;padding:0;flex:1;overflow:auto}
.lists li{display:flex;align-items:center;gap:8px;padding:3px 2px;border-bottom:1px dashed #0003}
.lists li span{flex:1}
.lists li.done span{text-decoration:line-through #ff2284 2px;color:#0008}
.lists .tick{width:18px;height:18px;padding:0;color:#ff2284;font-weight:600;line-height:14px}
.lists .x{padding:0 6px;border-color:transparent;box-shadow:none;background:none}
.lists input{font:inherit;border:1px solid #000;border-radius:2px;padding:3px 8px}
.files .crumbs{display:flex;gap:6px;align-items:center}
.files .where{flex:1;font-family:Monaco,ui-monospace,monospace;font-size:11px;background:#ffff88;border:1px solid #000;padding:1px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files .grid{flex:1;overflow:auto;display:flex;flex-wrap:wrap;align-content:flex-start;gap:2px;border:1px solid #000;padding:6px;background:#fff}
.file{display:flex;flex-direction:column;align-items:center;gap:2px;width:76px;padding:4px 2px!important;background:none!important;border-color:transparent!important;box-shadow:none!important}
.file:hover .label{background:#ffd9ea}
.file.on .label{background:#000;color:#fff}
.file .label{font-size:12px;padding:0 4px;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file .peek{font-family:Monaco,ui-monospace,monospace;font-size:9px;color:#0008;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clock{align-items:center;justify-content:center}
.face{position:relative;width:132px;height:132px;border-radius:50%;background:#fff;border:1px solid #000;box-shadow:0 0 10px 2px #66003322;flex:none}
.face b{position:absolute;left:50%;top:4px;width:2px;height:9px;margin-left:-1px;background:#000;transform-origin:1px 62px}
.face i{position:absolute;left:50%;bottom:50%;transform-origin:50% 100%;border-radius:2px}
.face .hh{width:5px;height:36px;margin-left:-2.5px;background:#000}
.face .mm{width:3px;height:52px;margin-left:-1.5px;background:#000}
.face .ss{width:1px;height:58px;margin-left:-.5px;background:#ff2284}
.face u{position:absolute;left:50%;top:50%;width:9px;height:9px;margin:-4.5px;border-radius:50%;background:#40dcba;border:1px solid #000}
.clock p{margin:0;font-variant-numeric:tabular-nums;display:flex;gap:8px;align-items:center}
.catclock{align-items:center;gap:4px;background:#fffbe6}
.catclock .cat{flex:1;min-height:0;width:100%;position:relative}
.catclock canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.catclock p{margin:0;font-size:12px;display:flex;gap:6px;align-items:center;font-variant-numeric:tabular-nums;text-align:center}
.catclock p.dim{font-size:10px}
`
