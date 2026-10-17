// /programs/desk: the desk's icons, as the Mac shows ~/Desktop: each node in /home/desktop, live,
// and the Trash (/home/Trash) bottom right; drawn and opened as My Computer does.
// layer /dev/display/layers/desk: the screen, z -950 (over the root, under the windows and the
// ermine's -900), clear where clear; owned, drags: true. wmii still tells the policy a RootClick
// and sends it keys while no window has focus.
//
// click selects, shift-click toggles, a drag on the empty desk a rectangle; double-click, Return or
// cmd-o opens. a drag moves the selection, no snapping; onto a folder, the Trash or a My Computer
// window, into it (on/drop, icons.dropped). option-cmd links instead; cmd-l makes "<name> link".
// Clean Up (world menu, on/menu clean) puts each on the grid. arrows select the nearest, typing by
// name, cmd-Backspace Trash, Escape none.
//
// positions: /apps/computer/layout/<id> (icons.layout.at), {<node id>: [x, y]} from the screen's
// top left; none: a column from the top right. a drag fronts the layout, written once on drop; a
// new node gets the first free place. selection: <its node>/view, {chosen: [ids]}.
import { effect, front, handler, idAt, make, val, whole } from "ermine:kit"
import { here } from "ermine:os"
import { blitter, font } from "ermine:draw"
import * as icons from "ermine:icons"

export default (given) => {
	const { api, self } = given
	// this process's own node: the layer's owner, whose on/pointer and on/key the window manager calls
	const me = here(self)
	const DESKTOP = ["home", "desktop"], TRASH = ["home", "Trash"]
	const LAYER = ["/", "dev", "display", "layers", "desk"]
	const WINDOWS = ["/", "dev", "display", "windows"]
	const blit = blitter(api)
	const FONT = ["/", "dev", "font", "text"]
	const face = (v) => (v ? font(v) : undefined)
	// the look, from /etc/theme, as My Computer's
	const C = {}
	const colours = (T = {}) =>
		Object.assign(C, {
			paper: T.paper ?? 0xfdf8ea,
			line: T.line ?? 0x1c1a17,
			ink: T.ink ?? 0x2a2228,
			dim: T.ink3 ?? 0xa89aa2,
			lemon: T.lemon ?? 0xffff88,
			cherry: T.cherry ?? 0xd2244a,
			desk: T.desk ?? 0xf3ead2,
			select: T.select ?? T.lemon ?? 0xffff88,
			pick: T.pick ?? T.line ?? 0x1c1a17,
			pickInk: T.pickInk ?? T.paper ?? 0xfdf8ea,
			// what is chosen on a pill (catclock's) or in a box (System 7's, Windows 98's); a name not chosen on the desk
			// itself in deskInk where the theme has one (Windows 98's white on teal), else on a box of paper
			pill: T.selection?.shape === "pill",
			deskInk: T.deskInk,
			icons: T.icons ?? null,
		})
	colours(val(api, ["/", "etc", "theme"]))
	const style = { u: 1, colours: C }
	const I = icons.make(blit, style)
	let F
	make(api, ["/", "home"], "desktop", null)

	// what is selected, by id (a rename keeps it), and a rectangle being dragged out: <its node>/view
	const VIEW = [...me, "view"]
	const s = { chosen: val(api, VIEW)?.chosen ?? [] }
	let viewed = null
	const keep = (api) => {
		const text = JSON.stringify({ chosen: s.chosen })
		if (text === viewed) return
		if (idAt(api, VIEW)) api.write(VIEW, whole(JSON.parse(text)))
		else make(api, me, "view", JSON.parse(text), { ephemeral: true })
		viewed = text
	}

	// --- the room: the screen between the bars, in pixels; a cell, an icon and its name under it
	let r = { W: 0, H: 0, top: 0, bottom: 0, u: 1, hidden: false }
	const cell = () => ({
		w: 104 * r.u,
		h: I.size() * r.u + 10 * r.u + 2 * blit.height(F) + 8 * r.u,
	})
	// the grid: down from the top right, a column, then the next to its left
	const slot = (i) => {
		const c = cell(),
			down = Math.max(1, Math.floor((r.bottom - r.top - 8 * r.u) / c.h)),
			col = Math.floor(i / down)
		const x = r.W - 8 * r.u - (col + 1) * c.w
		return x < 0 ? null : [x, r.top + 8 * r.u + (i % down) * c.h]
	}

	// --- the graph, as the desk sees it: its entries, the Trash last; their layout
	let shown = { entries: [], spots: new Map(), id: null, layout: null }
	const look = (api) => {
		const listing = (() => {
			try {
				return api.children(["/", ...DESKTOP])
			} catch {
				return []
			}
		})()
		const entries = listing.map((n) =>
			I.entry(api, DESKTOP, n, api.children(["/", ...DESKTOP], n))
		)
		const trash = api.children(["/", ...TRASH.slice(0, -1)], TRASH.at(-1))
		if (trash.length) entries.push(I.entry(api, TRASH.slice(0, -1), TRASH.at(-1), trash))
		const id = icons.folder(api, DESKTOP)
		const layout = id ? val(api, icons.layout.at(id)) ?? null : null
		return { entries: icons.keyed(entries), id, layout }
	}
	const key = (e) => e.key
	// each entry's spot, in pixels: as the layout says, the Trash at the bottom right, the rest the next free
	const place = (v) => {
		const u = r.u, saved = {}
		for (const [id, p] of Object.entries(v.layout?.desk ?? {})) {
			if (Array.isArray(p)) saved[id] = [Math.round(p[0] * u), Math.round(p[1] * u)]
		}
		const t = v.entries.find((e) => e.kind === "trash")
		if (t && !saved[key(t)]) saved[key(t)] = [r.W - 8 * u - cell().w, r.bottom - cell().h - 4 * u]
		return icons.spots(v.entries.map(key), saved, slot, cell())
	}
	// where a spot's icon and name are, for a click: the icon's square and the name's lines (one box round them),
	// and each line, centred under the icon
	const boxes = (e, [x, y]) => {
		const c = cell(), u = r.u, lh = blit.height(F), N = I.size() * u, y0 = y + N + 5 * u
		const lines = wrapped(e.name, c.w - 4 * u).map((text, i) => {
			const lw = blit.measure(text, F)
			const pad = (C.pill ? 8 : 3) * u
			return {
				text,
				x: x + Math.floor((c.w - lw) / 2) - pad,
				y: y0 + i * lh,
				w: lw + 2 * pad,
				h: lh + 2 * u,
			}
		})
		const nx = Math.min(...lines.map((l) => l.x)),
			nw = Math.max(...lines.map((l) => l.x + l.w)) - nx
		return {
			icon: { x: x + Math.floor((c.w - N) / 2), y, w: N, h: N },
			name: { x: nx, y: y0, w: nw, h: lines.length * lh + 2 * u },
			lines,
		}
	}
	const inside = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
	const hit = (x, y) => {
		for (const e of [...shown.entries].reverse()) {
			const b = boxes(e, shown.spots.get(key(e)))
			if (inside(b.icon, x, y) || inside(b.name, x, y)) return e
		}
		return null
	}
	const fitted = (text, w) => {
		const n = blit.fit(text, w, F)
		return n >= text.length ? text : text.slice(0, Math.max(0, n - 1)) + "…"
	}
	// a name in at most two lines of w, as the Finder's: broken after the last space that fits, else where it
	// fills the line; the rest cut with … if it is longer still
	const wrapped = (text, w) => {
		const n = blit.fit(text, w, F)
		if (n >= text.length) return [text]
		const space = text.lastIndexOf(" ", n)
		const at = space > 0 ? space + 1 : Math.max(1, n)
		return [text.slice(0, at).trimEnd(), fitted(text.slice(at).trimStart(), w)]
	}

	// --- drawing: icons, their names on the desk (a rose pill, white, when selected, as catclock's), the
	// rectangle being dragged out
	let band = null // {x0, y0, x1, y1, had}: a rectangle dragged out on the empty desk, and what was selected before
	let press = null // {id, x, y, from: Map(id → spot), moved}: an icon held
	const draw = (v) => {
		const f = blit.list(r.W, r.H), u = r.u, access = []
		for (const e of v.entries) {
			const p = v.spots.get(key(e)), on = s.chosen.includes(key(e)), b = boxes(e, p)
			I.icon(f, e, b.icon.x, b.icon.y, on, true)
			for (const l of b.lines) {
				if (on && C.pill) {
					const rr = Math.floor((l.h - 1) / 2)
					blit.fill(f, l.x + rr, l.y, l.w - 2 * rr, l.h, C.pick)
					blit.fillellipse(f, l.x + rr, l.y + rr, rr, rr, C.pick)
					blit.fillellipse(f, l.x + l.w - rr - 1, l.y + rr, rr, rr, C.pick)
				} else if (on || (!C.pill && C.deskInk === undefined)) {
					blit.fill(f, l.x, l.y, l.w, l.h, on ? C.pick : C.paper)
				}
				const ink = on
					? C.pickInk
					: e.kind === "pending"
					? C.dim
					: !C.pill && C.deskInk !== undefined
					? C.deskInk
					: C.ink
				blit.text(f, l.x + (C.pill ? 8 : 3) * u, l.y + u, l.text, ink, undefined, undefined, F)
			}
			access.push({
				role: "button",
				label: `${e.name}, ${I.describe(e)}${on ? ", selected" : ""}`,
				x: b.icon.x,
				y: b.icon.y,
				w: b.icon.w,
				h: b.name.y + b.name.h - b.icon.y,
			})
		}
		if (band) {
			const x = Math.min(band.x0, band.x1), y = Math.min(band.y0, band.y1)
			blit.frame(
				f,
				x,
				y,
				Math.abs(band.x1 - band.x0) + 1,
				Math.abs(band.y1 - band.y0) + 1,
				C.line,
			)
		}
		return {
			ops: f.ops,
			access: [{ role: "group", label: "Desk", x: 0, y: 0, w: r.W, h: r.H, children: access }],
		}
	}
	const paint = (api) => {
		if (!r.W) return
		shown = { ...look(api) }
		shown.spots = place(shown)
		s.chosen = s.chosen.filter((id) => shown.entries.some((e) => key(e) === id))
		// a folder arranged: one come since gets its place, written, so another going does not move it
		if (shown.layout?.desk && !press) {
			const fresh = shown.entries.filter((e) => !shown.layout.desk[key(e)] && e.kind !== "trash")
			if (fresh.length) {
				save(api, Object.fromEntries(fresh.map((e) => [key(e), shown.spots.get(key(e))])))
			}
		}
		const d = draw(shown)
		const value = {
			x: 0,
			y: 0,
			w: r.W,
			h: r.H,
			z: -950,
			over: true,
			drags: true,
			owner: me,
			hidden: r.hidden,
			draw: d.ops,
			access: d.access,
		}
		if (idAt(api, LAYER)) api.write(LAYER, whole(value))
		else make(api, LAYER.slice(0, -1), LAYER.at(-1), value, { ephemeral: true })
		keep(api)
	}
	// --- the layout: points in the document; while a drag moves, in front of it (the slot trick)
	const points = (p) => [Math.round(p[0] / r.u), Math.round(p[1] / r.u)]
	const value = (spots) => ({
		...(shown.layout ?? {}),
		desk: {
			...(shown.layout?.desk ?? {}),
			...Object.fromEntries([...spots].map(([id, p]) => [id, points(p)])),
		},
	})
	let held = null
	const slotted = (api) => {
		if (!shown.id) return null
		if (held?.id !== shown.id) held = { id: shown.id, front: front(icons.layout.at(shown.id)) }
		icons.layout.ready(api)
		return held.front
	}
	// spots (a map of id to spot, or an object) written once, with the rest as they are shown
	const save = (api, spots) => {
		const all = new Map(shown.spots)
		for (const [id, p] of spots instanceof Map ? spots : Object.entries(spots)) all.set(id, p)
		slotted(api)?.done(api, value(all))
		shown.layout = value(all)
	}
	// a spot kept whole on the room, between the bars: an icon let go lands in sight, not under a bar
	const fit = ([x, y]) => {
		const c = cell()
		return [Math.max(0, Math.min(r.W - c.w, x)), Math.max(r.top, Math.min(r.bottom - c.h, y))]
	}

	// --- doing
	// part: what the part running was given (icons start and call through it)
	const open = (part, e) => {
		if (!e) return
		const path = e.kind === "trash" ? TRASH : [...DESKTOP, e.name]
		I.open(part, path, e)
	}
	// the selected ones into a folder (a path; the Trash): each at a name not used there, moved, or linked (option-cmd)
	const into = (api, at, linked = false) => {
		for (
			const e of shown.entries.filter((x) =>
				s.chosen.includes(key(x)) && !same([...x.at, x.name], at) && x.kind !== "trash"
			)
		) {
			try {
				I.into(api, e, at, linked && !same(at, TRASH))
			} catch {
				// refused: it stays
			}
		}
		if (!linked) s.chosen = []
	}
	const same = (a, b) => a.join("/") === b.join("/")
	const pathOf = (e) => (e.kind === "trash" ? TRASH : [...DESKTOP, e.name])
	// Make Link (cmd-l): each selected placed again beside itself, "<name> link", the same node
	const link = (api) => {
		for (
			const e of shown.entries.filter((x) => s.chosen.includes(key(x)) && x.kind !== "trash")
		) {
			try {
				I.link(api, e, ["/", ...DESKTOP], I.free(api, DESKTOP, `${e.name} link`))
			} catch {
				// refused (an ephemeral node has one slot)
			}
		}
	}
	const clean = (api) => save(api, icons.clean(shown.spots, slot, cell()))

	// --- the pointer: from wmii, the desk's clicks, and while a button is down every move and the up
	let click = { id: null, t: 0 }
	handler(given, "pointer", (part) => {
		const { api } = part, [recs] = part.args
		for (const p of recs) {
			const shift = p.mods?.includes("shift")
			if (p.event === "down") {
				const e = hit(p.x, p.y)
				if (!e) {
					if (!shift) s.chosen = []
					band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, had: [...s.chosen] }
					continue
				}
				const id = key(e), now = Date.now(), twice = click.id === id && now - click.t < 500
				click = { id, t: twice ? 0 : now }
				if (shift) {
					s.chosen = s.chosen.includes(id)
						? s.chosen.filter((x) => x !== id)
						: [...s.chosen, id]
				} else if (!s.chosen.includes(id)) s.chosen = [id]
				if (twice) open(part, e)
				else if (s.chosen.includes(id)) {
					press = {
						id,
						x: p.x,
						y: p.y,
						mods: p.mods,
						from: new Map(s.chosen.map((c) => [c, shown.spots.get(c)])),
						moved: false,
					}
				}
			} else if (p.event === "move" && press) {
				const dx = p.x - press.x, dy = p.y - press.y
				// a drag, not a shaky click: four points from where it began
				if (!press.moved && Math.hypot(dx, dy) < 4 * r.u) continue
				press.moved = true
				const moved = new Map([...press.from].map(([id, [x, y]]) => [id, [x + dx, y + dy]]))
				const all = new Map(shown.spots)
				for (const [id, q] of moved) all.set(id, q)
				slotted(api)?.put(api, value(all))
			} else if (p.event === "move" && band) {
				Object.assign(band, { x1: p.x, y1: p.y })
				const x = Math.min(band.x0, band.x1),
					y = Math.min(band.y0, band.y1),
					w = Math.abs(band.x1 - band.x0),
					h = Math.abs(band.y1 - band.y0)
				const over = (b) => b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y
				const caught = shown.entries.filter((e) => {
					const b = boxes(e, shown.spots.get(key(e)))
					return over(b.icon) || over(b.name)
				}).map(key)
				s.chosen = [...new Set([...band.had, ...caught])]
			} else if (p.event === "up") {
				band = null
				if (!press) continue
				const was = press
				press = null
				if (!was.moved) continue
				// a drag is no click: the next on it is a first, not a double click that opens it
				click = { id: null, t: 0 }
				// let go over a folder or the Trash, not one of those moved: into it; else where it was let go
				const to = shown.entries.find((e) =>
					!was.from.has(key(e)) && (e.kind === "folder" || e.kind === "trash") && (() => {
						const b = boxes(e, shown.spots.get(key(e)))
						return inside(b.icon, p.x, p.y) || inside(b.name, p.x, p.y)
					})()
				)
				const dx = p.x - was.x, dy = p.y - was.y
				// option-cmd: a link there, not the node moved
				const linked = ["alt", "cmd"].every((m) => p.mods?.includes(m) || was.mods?.includes(m))
				// over a window (in front of the desk's icons): one that takes drops (a My Computer's) takes them, its on/drop
				// (icons.dropped), into its folder or the folder under the hand there; one that takes none, they go back
				const under = icons.dropped(api, p.x, p.y)
				if (under && under.layer !== "desk") {
					slotted(api)?.done(api)
					// each with where the hand held it, from its icon's top left
					const items = shown.entries.filter((e) => was.from.has(key(e)) && e.kind !== "trash")
						.map((e) => {
							const b = boxes(e, was.from.get(key(e)))
							return {
								at: e.at,
								name: e.name,
								id: e.ids[0],
								grip: [was.x - b.icon.x, was.y - b.icon.y],
							}
						})
					if (under.drop && items.length) {
						part.call(under.drop, [{ items, x: p.x, y: p.y, linked }])
						if (!linked) s.chosen = []
					}
				} else if (to) {
					slotted(api)?.done(api)
					into(api, pathOf(to), linked)
				} else {
					// where they were let go, all moved alike, as far as keeps each whole on the room (fit)
					const c = cell(), from = [...was.from.values()]
					const most = (f) => Math.max(...from.map(f)), least = (f) => Math.min(...from.map(f))
					const mx = Math.max(most(([x]) => -x), Math.min(least(([x]) => r.W - c.w - x), dx))
					const my = Math.max(
						most(([, y]) => r.top - y),
						Math.min(least(([, y]) => r.bottom - c.h - y), dy),
					)
					save(api, new Map([...was.from].map(([id, [x, y]]) => [id, fit([x + mx, y + my])])))
				}
			}
		}
		paint(api)
	})

	// --- icons dropped on the desk from a My Computer window (icons.dropped): [{items, x, y, linked}], x, y on the screen,
	// each item {at, name, id, grip}. Over a folder or the Trash, into it; else into /home/desktop, each where it was let
	// go, the hand on it where it held it. Linked (option-cmd), a link there
	handler(given, "drop", (part) => {
		const { api } = part, [d] = part.args
		const to = hit(d.x, d.y)
		const folder = to && (to.kind === "folder" || to.kind === "trash") ? to : null
		const at = folder ? pathOf(folder) : DESKTOP
		const went = I.land(api, d.items, at, !!d.linked && !same(at, TRASH)).filter((w) =>
			w.to !== undefined
		)
		if (!folder && went.length && r.W) {
			// each where it was let go, kept whole on the room (fit)
			const v = look(api), c = cell(), g = (w) => w.grip ?? [16 * r.u, 16 * r.u], spots = {}
			for (const w of went) {
				const e = v.entries.find((e) =>
					e.name === w.to && e.ids[0] === w.id && same(e.at, DESKTOP)
				)
				if (e) {
					spots[key(e)] = fit([
						d.x - g(w)[0] - Math.floor((c.w - I.size() * r.u) / 2),
						d.y - g(w)[1],
					])
				}
			}
			save(api, spots)
			s.chosen = Object.keys(spots)
		}
		paint(api)
	})

	// --- keys, while no window has the focus: arrows, typing a name, Return or cmd-o opens
	let typed = "", typedAt = 0
	const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
	handler(given, "key", (part) => {
		const { api } = part, [recs] = part.args
		for (const k of recs) {
			if (!k.down) continue
			const cmd = k.mods?.includes("cmd"), last = s.chosen.at(-1) ?? null
			const chosen = () => shown.entries.filter((e) => s.chosen.includes(key(e)))
			if (k.key === "Enter" || (cmd && (k.key === "o" || k.key === "ArrowDown"))) {
				chosen().forEach((e) => open(part, e))
			} else if (cmd && (k.key === "Backspace" || k.key === "Delete")) {
				const t = shown.entries.find((e) => e.kind === "trash")
				if (t) into(api, TRASH)
			} else if (cmd && k.key === "l") link(api)
			else if (cmd) continue
			else if (ARROWS[k.key]) {
				const to = icons.nearest(shown.spots, last, ...ARROWS[k.key])
				if (to) s.chosen = [to]
			} else if (k.key === "Escape") s.chosen = []
			else if (k.text && k.text >= " " && !/[\uf700-\uf8ff]/.test(k.text)) {
				// type to select, as the Finder does: the letters typed within a second, the first name they start
				const now = Date.now()
				typed = (now - typedAt < 1000 ? typed : "") + k.text.toLowerCase()
				typedAt = now
				const e = [...shown.entries].sort((a, b) => a.name.localeCompare(b.name)).find((e) =>
					e.name.toLowerCase().startsWith(typed)
				)
				if (e) s.chosen = [key(e)]
			}
		}
		paint(api)
	})

	// the world menu's Clean Up Desktop: /apps/desk/desk/on/menu clean
	handler(given, "menu", ({ api, args: [what] }) => {
		if (what === "clean") clean(api)
		paint(api)
	})

	// --- following: the room, the folder's names, the Trash, the layout, the look
	effect(given, "room", ({ api }) => {
		const m = val(api, ["/", "dev", "display", "mode"]) ?? {},
			bar = val(api, [...WINDOWS, "bar"]),
			task = val(api, [...WINDOWS, "task"])
		const u = Math.max(1, Math.round(m.unit ?? 1))
		return {
			W: m.w ?? 0,
			H: m.h ?? 0,
			u,
			hidden: !!m.windows,
			top: bar && !bar.hidden ? bar.y + bar.h : 0,
			bottom: task && !task.hidden ? task.y : m.h ?? 0,
			font: String(face(val(api, FONT)) ?? "rom"),
		}
	}, ({ value: room, api }) => {
		r = room
		style.u = room.u
		F = face(val(api, FONT))
		paint(api)
	})
	effect(given, "follow", ({ api }) => {
		const names = (() => {
			try {
				return api.children(["/", ...DESKTOP]).map((
					n,
				) => [n, api.children(["/", ...DESKTOP], n).map((i) => `${i.id}${i.node ? "" : "…"}`)])
			} catch {
				return null
			}
		})()
		const id = icons.folder(api, DESKTOP)
		return {
			names,
			id,
			layout: id ? val(api, icons.layout.at(id)) ?? null : null,
			trash: (() => {
				try {
					return api.children(["/", ...TRASH]).length
				} catch {
					return 0
				}
			})(),
			theme: val(api, ["/", "etc", "theme"]) ?? null,
		}
	}, ({ value: v, api }) => {
		if (v.theme) colours(v.theme)
		paint(api)
	})
}
