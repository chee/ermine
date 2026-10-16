/// <reference lib="dom" />
// a Finder for the graph: Miller columns, a list, or icons of the tree from the root, rendered with
// Solid 2 from the tree signal (solid-ermine.ts): a stable element per key, each field of it a
// binding, so a node that ticks rewrites its own text and nothing else. a folder is a node with
// children; a mount is an alias (italic, with an arrow) to the card it mounts; the same id placed
// in more than one place says "also at".
//   get info    a small purple window for a card: the detail column's fields, in a window
//   drag        moves a card into a folder (places.move); alt-drag mounts it (places.place);
//               delete unplaces it, after asking. each is written as a change in an inspector scope
import {
	createMemo,
	createRenderEffect,
	createRoot,
	createSignal,
	mapArray,
} from "@solidjs/signals"
import { insert } from "@solidjs/web"
import { act, type Card, type Tree } from "./solid-ermine.ts"
import { preview } from "./map.ts"
import { h } from "./values.ts"

// deno-lint-ignore no-explicit-any
type Any = any
// an effect's return is its cleanup: a binding that assigns says nothing back; and a binding
// writes only when what it reads is a new value
const bind = <T>(read: () => T, apply: (v: T) => void) => {
	// the memo is what keeps a write off the page when the value did not change
	const m = createMemo(read)
	createRenderEffect(m, (v) => void apply(v))
}
export type FinderOptions = {
	tree: () => Tree | undefined
	picked: () => string | undefined
	pick: (key: string) => void
	world: () => Any
	// fill an element with the detail of a card (the detail column's own), in the owner it is called in
	info: (key: string, into: HTMLElement) => void
	say: (text: string) => void
}

type Row = { card: Card; name: string; alias: boolean }
const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1)

export function createFinder(box: HTMLElement, o: FinderOptions) {
	const tool = h("div", "ftool")
	const cols = h("div", "fcols")
	const path = h("div", "fpath")
	box.append(tool, cols, path)
	box.tabIndex = 0

	// the view, as Finder's buttons: columns, list, icons (a per-session choice, in memory)
	type View = "columns" | "list" | "icons"
	const [view, setView] = createSignal<View>("columns")
	// the folder the list and icon views show: opened by double-click, "..", the path bar
	const [cwd, setCwd] = createSignal<string | undefined>(undefined)
	const columnsBtn = h("button", "", "columns")
	const listBtn = h("button", "", "list")
	const iconsBtn = h("button", "", "icons")
	const infoBtn = h("button", "", "get info")
	const delBtn = h("button", "", "delete")
	infoBtn.title = "cmd-i"
	delBtn.title = "unplace the picked node (it asks first)"
	const status = h("span", "fstatus")
	tool.append(columnsBtn, listBtn, iconsBtn, infoBtn, delBtn, status)
	columnsBtn.onclick = () => setView("columns")
	listBtn.onclick = () => setView("list")
	iconsBtn.onclick = () => setView("icons")

	// ---- what the tree says: rows per folder, cards by key, the places a card is mounted ----
	let rows = new Map<Card, Row[]>()
	let byKey = new Map<string, Card>()
	let alsoAt = new Map<Card, Card[]>()
	let last: Tree | undefined
	// the tree as last seen: hidden, the signal is quiet and the views keep what they show
	const idx = createMemo(() => {
		const t = o.tree() ?? last
		last = t
		rows = new Map()
		byKey = new Map()
		alsoAt = new Map()
		if (!t) return undefined
		for (const c of t.cards) byKey.set(c.key, c)
		for (const e of t.edges) {
			const r = rows.get(e.from) ?? rows.set(e.from, []).get(e.from)!
			r.push({ card: e.to, name: e.name, alias: e.mount })
			if (e.mount) (alsoAt.get(e.to) ?? alsoAt.set(e.to, []).get(e.to)!).push(e.from)
		}
		return t
	})
	const nameOf = (c: Card) => {
		const names: string[] = []
		for (let u: Card | undefined = c; u?.up; u = u.up) names.unshift(u.name)
		return "/" + names.join("/")
	}

	// what a value is, as an icon
	function valueKind(c: Card, kids: number): { icon: string; label: string } {
		const v = c.value
		if (kids) return { icon: "📁", label: "folder" }
		if (typeof v === "number") return { icon: "🔢", label: "number" }
		if (typeof v === "string") return { icon: "🔤", label: "string" }
		if (typeof v === "boolean") return { icon: "☑️", label: "boolean" }
		if (typeof v === "function") return { icon: "ƒ", label: "function" }
		if (Array.isArray(v)) return { icon: "📋", label: "list" }
		if (tag(v) === "Uint8Array") return { icon: "💾", label: "bytes" }
		if (ArrayBuffer.isView(v)) return { icon: "🧮", label: "typed array" }
		if (v && typeof v === "object" && "nodeType" in v) return { icon: "🧱", label: "element" }
		if (v && typeof v === "object") return { icon: "🗂️", label: "map" }
		return { icon: "📄", label: "empty" }
	}
	// the kind of a card: what it does if it does something (a process, a part, a handler), else
	// what it holds. base: what it would be without the role, for the big icons
	function kind(
		c: Card,
	): { icon: string; label: string; spin?: boolean; role?: string; base: string } {
		idx()
		const w = o.world()
		const kids = rows.get(c)?.length ?? 0
		const base = valueKind(c, kids)
		const role = (icon: string, label: string, spin = false) => ({
			icon,
			label,
			spin,
			role: icon,
			base: base.icon,
		})
		if (c.refused) return role("🚫", "REFUSED")
		if (c.pending) return role("⏳", "pending", true)
		for (const [comp, rec] of (w?.parts ?? new Map()) as Map<Any, Any>) {
			if (rec.entry.id === c.item.id) {
				return comp.kind === "effect" ? role("⚡", "effect part") : role("🧩", "compute part")
			}
			if (rec.at[0].id === c.item.id) return role("⚙️", "process")
		}
		if (typeof c.value === "function" && c.up?.name === "on") return role("🪝", "handler")
		return { ...base, base: base.icon }
	}

	// a picture of the value itself, when it is one: a colour, a pixel pad (a list of colours, a
	// string of digits, a byte image). cheap: at most a few thousand pixels, drawn once per card
	const TONES = ["#fffbe6", "#111", "#ff2284", "#fff27a"]
	function thumb(c: Card): HTMLElement | undefined {
		const v = c.value
		const square = (n: number, per = 1) => {
			const side = Math.sqrt(n / per)
			return Number.isInteger(side) && side >= 4 && side <= 64 ? side : 0
		}
		const paint = (side: number, at: (i: number) => string) => {
			const cv = h("canvas", "fthumb")
			cv.width = cv.height = side
			const g = cv.getContext("2d")!
			for (let i = 0; i < side * side; i++) {
				;(g.fillStyle = at(i), g.fillRect(i % side, Math.floor(i / side), 1, 1))
			}
			return cv
		}
		if (typeof v === "string") {
			if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) || /^(rgb|hsl)a?\(/.test(v)) {
				const sw = h("span", "fthumb swatch")
				sw.style.background = v
				return sw
			}
			const side = /^[0-3]+$/.test(v) ? square(v.length) : 0
			if (side) return paint(side, (i) => TONES[+v[i]])
		}
		if (Array.isArray(v) && v.length <= 4096 && v.every((x) => typeof x === "string")) {
			const side = square(v.length)
			if (side) return paint(side, (i) => v[i])
		}
		if (tag(v) === "Uint8Array") {
			const b = v as Uint8Array
			const gray = square(b.length), rgba = square(b.length, 4)
			if (rgba) {
				return paint(
					rgba,
					(i) => `rgba(${b[i * 4]},${b[i * 4 + 1]},${b[i * 4 + 2]},${b[i * 4 + 3] / 255})`,
				)
			}
			if (gray) return paint(gray, (i) => `rgb(${b[i]},${b[i]},${b[i]})`)
		}
	}

	// ---- the rows: an element per row, made once; each field is a binding on the row's card ----
	let drag: Card | undefined
	const flashNow = (el: HTMLElement) => {
		// a flash in progress is let finish: a clock writing forty times a second is not forty flashes
		if (el.classList.contains("flash")) return
		el.classList.add("flash")
		el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true })
	}
	// a flash when the card's change is a new one
	const flashOn = (el: HTMLElement, change: () => unknown) => {
		let was: unknown
		bind(change, (c) => {
			if (was !== undefined && c !== was) flashNow(el)
			was = c
		})
	}
	const dragFrom = (el: HTMLElement, item: () => Row) => {
		el.ondragstart = (e) => {
			drag = item().card
			e.dataTransfer!.effectAllowed = "copyMove"
			e.dataTransfer!.setData("text/plain", drag.key)
		}
		el.ondragend = () => (drag = undefined)
		bind(() => !item().alias && !!item().card.up, (d) => (el.draggable = d))
	}
	const enter = (item: () => Row) => () => {
		const c = item().card
		if (rows.get(c)?.length) setCwd(c.key)
		o.pick(c.key)
	}
	const rowKey = (r: Row) => r.card.key + ":" + r.alias
	// selected: the row is on the chain from the root to the pick (columns), or is the pick itself
	function buildRow(item: () => Row, extra: boolean, selected: (c: Card) => boolean) {
		const el = h("div", "frow")
		const icon = h("span", "ficon")
		const name = h("span", "fname")
		const also = h("span", "falso")
		const kindEl = h("span", "fkind")
		const val = h("span", "fval")
		const tagc = h("span", "ftagc")
		const chev = h("span", "fchev", "▸")
		el.append(icon, name, also, kindEl, val, tagc, chev)
		const k = createMemo(() => kind(item().card))
		const kids = createMemo(() => (idx(), (rows.get(item().card)?.length ?? 0) > 0))
		bind(() => k().icon, (v) => (icon.textContent = v))
		bind(() => k().spin, (v) => icon.classList.toggle("spin", !!v))
		bind(() => item().name + (item().alias ? " ↪" : ""), (v) => (name.textContent = v))
		bind(() => {
			const a = idx() && alsoAt.get(item().card)
			return a && !item().alias ? "also at " + a.map((x) => nameOf(x)).join(", ") : ""
		}, (v) => ((also.textContent = v), (also.hidden = !v)))
		kindEl.hidden = !extra
		tagc.hidden = !extra
		bind(
			() => (item().alias ? `alias of ${nameOf(item().card)}` : k().label),
			(v) => (kindEl.textContent = v),
		)
		bind(() => {
			const c = item().card
			return c.refused ? "REFUSED" : String(c.item.id).slice(0, 6)
		}, (v) => (tagc.textContent = v))
		// a value shows in the list always, in columns only on a leaf
		bind(() => {
			const c = item().card
			if (c.refused || c.value === undefined) return ""
			return extra || !kids() ? preview(c.value) : ""
		}, (v) => ((val.textContent = v), (val.hidden = !v)))
		bind(() => !extra && kids(), (v) => (chev.hidden = !v))
		bind(() => selected(item().card), (v) => el.classList.toggle("sel", v))
		bind(() => item().alias, (v) => el.classList.toggle("alias", v))
		bind(() => item().card.key, (v) => (el.dataset.key = v))
		flashOn(el, () => item().card.change)
		el.onclick = () => o.pick(item().card.key)
		el.ondblclick = enter(item)
		dragFrom(el, item)
		dropOn(el, () => item().card)
		return el
	}

	// what a value looks like, cheaply, for telling if a thumbnail must be drawn again
	const valSig = (v: unknown) =>
		typeof v === "string"
			? v.slice(0, 5000)
			: Array.isArray(v) && v.length <= 4096
			? v.join()
			: tag(v) === "Uint8Array"
			? "bytes" + (v as Uint8Array).length + String((v as Uint8Array)[0])
			: preview(v)
	// an icon: big, by kind (or a thumbnail of the value), the name below, small badges
	function buildTile(item: () => Row) {
		const el = h("div", "ftile")
		const pic = h("span", "fbig")
		const badges = h("span", "fbadges")
		const nameEl = h("span", "ftname")
		el.append(pic, nameEl)
		const k = createMemo(() => kind(item().card))
		// the picture changes only when the kind or what the value looks like does
		bind(
			() =>
				`${k().icon}|${k().base}|${k().spin}|${item().card.refused}|${
					valSig(item().card.value)
				}`,
			() => {
				const c = item().card
				const th = thumb(c)
				pic.replaceChildren(
					th ?? h("span", k().spin ? "spin" : "", c.refused || k().spin ? k().icon : k().base),
					badges,
				)
			},
		)
		bind(() => `${k().role ?? ""}|${k().spin}|${item().alias}|${item().card.refused}`, () => {
			badges.replaceChildren()
			if (k().role && !item().card.refused) {
				badges.append(h("span", "fbadge" + (k().spin ? " spin" : ""), k().role))
			}
			if (item().alias) badges.append(h("span", "fbadge arrow", "↪"))
		})
		bind(() => item().name, (v) => (nameEl.textContent = v))
		bind(
			() =>
				`${item().name}${
					item().alias ? ` (alias of ${nameOf(item().card)})` : ""
				} · ${k().label}`,
			(v) => (el.title = v),
		)
		bind(() => selectedOne(item().card), (v) => el.classList.toggle("sel", v))
		bind(() => item().alias, (v) => el.classList.toggle("alias", v))
		bind(() => item().card.refused, (v) => el.classList.toggle("refused", v))
		bind(() => item().card.key, (v) => (el.dataset.key = v))
		flashOn(el, () => item().card.change)
		el.onclick = () => o.pick(item().card.key)
		el.ondblclick = enter(item)
		dragFrom(el, item)
		dropOn(el, () => item().card)
		return el
	}

	// drop onto a card (it becomes the folder) or onto a column background (its folder)
	function dropOn(el: HTMLElement, target: () => Card) {
		el.ondragover = (e) => {
			if (!drag || drag === target()) return
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer!.dropEffect = e.altKey ? "copy" : "move"
			el.classList.add("over")
		}
		el.ondragleave = () => el.classList.remove("over")
		el.ondrop = (e) => {
			el.classList.remove("over")
			e.preventDefault()
			e.stopPropagation()
			const src = drag
			drag = undefined
			if (src && src !== target()) put(src, target(), e.altKey)
		}
	}
	function put(src: Card, target: Card, mount: boolean) {
		const w = o.world()
		if (!src.up) return o.say("the root cannot be moved")
		for (let u: Card | undefined = target; u; u = u.up) {
			if (u === src) return o.say("a node cannot go into itself")
		}
		const taken = new Set((rows.get(target) ?? []).map((r) => r.name))
		let name = src.item.name!
		while (taken.has(name)) name += " 2"
		try {
			act(
				w,
				(w, header) =>
					mount ? w.place(w.entry(target.item.id), name, src.item.id, header) : w.move(
						[w.entry(src.up!.item.id), src.item.name!],
						[w.entry(target.item.id), name],
						header,
					),
			)
			o.say(
				`${mount ? "mounted" : "moved"} ${src.item.name} ${mount ? "in" : "to"} ${
					nameOf(target)
				}`,
			)
		} catch (e) {
			o.say((e as Error).message)
		}
	}
	function remove(c: Card | undefined) {
		if (!c?.up) return o.say("nothing to delete")
		if (
			!confirm(
				`Unplace "${c.item.name}" from ${nameOf(c.up)}?\n(the node itself stays in the store)`,
			)
		) return
		try {
			act(
				o.world(),
				(w, header) => w.unplace(w.entry(c.up!.item.id), c.item.name!, header),
			)
			o.say(`unplaced ${c.item.name}`)
		} catch (e) {
			o.say((e as Error).message)
		}
	}

	// ---- the view: what the pick and the folder are, then the three layouts, each bound to them ----
	const selKey = createMemo(() => {
		const t = idx()
		return (o.picked() && byKey.get(o.picked()!)?.key) || t?.cards[0]?.key || ""
	})
	const selectedOne = (c: Card) => c.key === selKey()
	// the keys from the root to the pick, as a string so only a real change of path is a change
	const chainStr = createMemo(() => {
		idx()
		const chain: string[] = []
		for (let c = byKey.get(selKey()); c; c = c.up) chain.unshift(c.key)
		return chain.join("\n")
	})
	const chain = createMemo(() => (chainStr() ? chainStr().split("\n") : []))
	// the folder the list and icons show: stays put while the pick is in it, else follows the pick
	const folderKey = createMemo(() => {
		idx()
		const root = byKey.get("root")
		const sel = byKey.get(selKey())
		if (!sel || !root) return "root"
		let folder = byKey.get(cwd() ?? "") ?? root
		if (sel.key !== folder.key && sel.up?.key !== folder.key) {
			folder = rows.get(sel)?.length && view() !== "icons" ? sel : sel.up ?? sel
		}
		return folder.key
	})
	// a read that goes quiet while its layout is not the one shown
	const live = <T>(m: View, read: () => T) => {
		let was: T | undefined
		return createMemo(() => (view() === m ? (was = read()) : was))
	}
	const rowsOf = (key: string) => (idx(), rows.get(byKey.get(key)!) ?? [])
	const empty = () => h("div", "fempty", "empty")

	// columns: one per folder on the chain (and the pick's own when it has children)
	const colsView = h("div", "fcolsview")
	const listView = h("div", "flistview")
	const gridHost = h("div", "fgridhost")
	cols.append(colsView, listView, gridHost)
	bind(() => view(), (v) => {
		colsView.hidden = v !== "columns"
		listView.hidden = v !== "list"
		gridHost.hidden = v !== "icons"
		cols.classList.toggle("list", v === "list")
		cols.classList.toggle("icons", v === "icons")
		columnsBtn.classList.toggle("on", v === "columns")
		listBtn.classList.toggle("on", v === "list")
		iconsBtn.classList.toggle("on", v === "icons")
	})
	const colKeys = createMemo(() => {
		idx()
		const c = chain()
		const sel = byKey.get(selKey())
		const folders = sel && rows.get(sel)?.length ? c : c.slice(0, -1)
		return (folders.length ? folders : ["root"]).join("\n").split("\n")
	})
	{
		const onChain = (c: Card) => chain().includes(c.key)
		const col = (key: () => string) => {
			const el = h("div", "fcol") as HTMLElement & { _f?: string }
			dropOn(el, () => byKey.get(el._f!)!)
			bind(key, (k) => (el._f = k))
			const empt = empty()
			const mine = live("columns", () => rowsOf(key()))
			bind(() => (mine() ?? []).length === 0, (v) => (empt.hidden = !v))
			el.append(empt)
			insert(
				el,
				mapArray(() => mine() ?? [], (r) => buildRow(() => r(), false, onChain), {
					keyed: (r: Row) => rowKey(r),
				}),
				empt,
			)
			return el
		}
		insert(colsView, mapArray(colKeys, (key) => col(() => key)))
		// a new column scrolls into view, once; the user's own scrolling is left alone
		bind(() => colKeys().join("|"), () => (cols.scrollLeft = cols.scrollWidth))
	}
	// list: a header, a ".." row, the rows of the folder with kind, value and id
	{
		const head = h("div", "frow fhead")
		head.append(
			h("span", "ficon"),
			h("span", "fname", "name"),
			h("span", "fkind", "kind"),
			h("span", "fval", "value"),
			h("span", "ftagc", "id"),
		)
		const up = h("div", "frow fup")
		up.append(h("span", "ficon", "⬆️"), h("span", "fname", ".."))
		up.onclick = () => {
			const f = byKey.get(folderKey())
			if (f?.up) (setCwd(f.up.key), o.pick(f.up.key))
		}
		bind(() => !(idx() && byKey.get(folderKey())?.up), (v) => (up.hidden = v))
		const col = h("div", "fcol listcol") as HTMLElement
		dropOn(col, () => byKey.get(folderKey())!)
		const empt = empty()
		const mine = live("list", () => rowsOf(folderKey()))
		bind(() => (mine() ?? []).length === 0, (v) => (empt.hidden = !v))
		col.append(up, empt)
		insert(
			col,
			mapArray(() => mine() ?? [], (r) => buildRow(() => r(), true, selectedOne), {
				keyed: (r: Row) => rowKey(r),
			}),
			empt,
		)
		listView.append(head, col)
	}
	// icons
	{
		const grid = h("div", "fgrid") as HTMLElement
		dropOn(grid, () => byKey.get(folderKey())!)
		const up = h("div", "ftile")
		up.append(h("span", "fbig", "⬆️"), h("span", "ftname", ".."))
		up.onclick = up.ondblclick = () => {
			const f = byKey.get(folderKey())
			if (f?.up) (setCwd(f.up.key), o.pick(f.up.key))
		}
		bind(() => !(idx() && byKey.get(folderKey())?.up), (v) => (up.hidden = v))
		const empt = empty()
		const mine = live("icons", () => rowsOf(folderKey()))
		bind(() => (mine() ?? []).length === 0, (v) => (empt.hidden = !v))
		grid.append(up, empt)
		insert(
			grid,
			mapArray(() => mine() ?? [], (r) => buildTile(() => r()), {
				keyed: (r: Row) => rowKey(r),
			}),
			empt,
		)
		gridHost.append(grid)
	}
	// the path bar: a crumb per key on the chain
	{
		const end = document.createComment("")
		path.append(end)
		insert(
			path,
			mapArray(chain, (key, i) => {
				const b = h("span", "fcrumb")
				const sep = h("span", "fsep", "›")
				const label = h("span")
				b.append(sep, label)
				bind(() => i() > 0, (v) => (sep.hidden = !v))
				bind(
					() => (idx() && byKey.get(key)?.up ? byKey.get(key)!.name : "/"),
					(v) => (label.textContent = v),
				)
				label.onclick = () => (setCwd(key), o.pick(key))
				return b
			}),
			end,
		)
	}

	// keys: up and down within the column, right into a folder, left out
	box.onkeydown = (e) => {
		const sel = byKey.get(o.picked() ?? "")
		if (!sel) return
		if ((e.metaKey || e.ctrlKey) && e.key === "i") return (e.preventDefault(), openInfo())
		if (e.key === "Backspace" || e.key === "Delete") return (e.preventDefault(), remove(sel))
		const sibs = sel.up ? (rows.get(sel.up) ?? []).filter((r) => !r.alias) : []
		const at = sibs.findIndex((r) => r.card === sel)
		const to = e.key === "ArrowDown"
			? sibs[at + 1]?.card
			: e.key === "ArrowUp"
			? sibs[at - 1]?.card
			: e.key === "ArrowLeft"
			? sel.up
			: e.key === "ArrowRight"
			? rows.get(sel)?.[0]?.card
			: undefined
		if (to) (e.preventDefault(), o.pick(to.key))
	}

	// ---- get info: a small purple window per card, its own owner; its detail is bound like the column's ----
	const wins = new Map<string, HTMLElement & { _dispose?: () => void }>()
	function openInfo(key = o.picked()) {
		if (!key) return
		const have = wins.get(key)
		if (have) return void box.ownerDocument.body.append(have)
		const win = h("div", "infowin") as HTMLElement & { _dispose?: () => void }
		const bar = h("div", "iwbar")
		const close = h("span", "iwclose")
		const title = h("span", "iwtitle")
		const body = h("div", "iwbody")
		bar.append(close, title)
		win.append(bar, body)
		const n = wins.size
		win.style.left = 120 + n * 26 + "px"
		win.style.top = 90 + n * 26 + "px"
		close.onclick = () => (win._dispose?.(), wins.delete(key), win.remove())
		// the title bar drags the window
		bar.onpointerdown = (e) => {
			if (e.target === close) return
			bar.setPointerCapture(e.pointerId)
			const x = e.clientX - win.offsetLeft, y = e.clientY - win.offsetTop
			bar.onpointermove = (
				m,
			) => ((win.style.left = m.clientX - x + "px"), (win.style.top = m.clientY - y + "px"))
			bar.onpointerup = () => (bar.onpointermove = bar.onpointerup = null)
			document.body.append(win)
		}
		wins.set(key, win)
		document.body.append(win)
		win._dispose = createRoot((dispose) => {
			const c = () => (idx(), byKey.get(key))
			const head = h("div", "iwhead")
			const icon = h("span", "iwicon")
			const who = h("div")
			const nm = h("b")
			const kd = h("div", "iwkind")
			who.append(nm, kd)
			head.append(icon, who)
			const inner = h("div", "detail")
			body.append(head, inner)
			const k = createMemo(() => (c() ? kind(c()!) : undefined))
			bind(
				() => (c() ? (c()!.up ? c()!.name : "/") : "gone"),
				(
					v,
				) => ((nm.textContent = v), (title.textContent = v === "gone" ? "gone" : `${v} info`)),
			)
			bind(() => k()?.icon ?? "", (v) => (icon.textContent = v))
			bind(() => {
				const cc = c()
				return cc && k()
					? `${k()!.label} · ${cc.refused ? "REFUSED" : String(cc.item.id).slice(0, 8)}`
					: ""
			}, (v) => (kd.textContent = v))
			o.info(key, inner)
			return dispose
		})
	}
	// cmd-i anywhere while the finder is showing
	const onkey = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "i" && box.offsetParent) {
			;(e.preventDefault(), openInfo())
		}
	}
	document.addEventListener("keydown", onkey)
	infoBtn.onclick = () => openInfo()
	delBtn.onclick = () => remove(byKey.get(o.picked() ?? ""))

	return {
		info: openInfo,
		setStatus: (t: string) => (status.textContent = t),
		dispose: () => document.removeEventListener("keydown", onkey),
	}
}
