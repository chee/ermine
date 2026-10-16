/// <reference lib="dom" />
// the examples menu: a button naming the current example, a panel with the examples in groups
// that fly out as submenus, a search across all of them, and the ones opened lately at the top.
// groups come from the name prefixes in examples/index.json, so a new example lands in its group
// (or in "more") with no change here
import { h } from "./values.ts"

export type Example = { name: string; title: string; description?: string }

// group -> its emoji, how its members are told, in the order the menu lists them
const GROUPS: { id: string; label: string; emoji: string; has: (name: string) => boolean }[] = [
	{
		id: "basics",
		label: "basics",
		emoji: "🌱",
		has: (n) =>
			["counter", "todos", "clock", "async", "rules", "call", "trust", "talk"].includes(n),
	},
	{ id: "toys", label: "toys", emoji: "🧸", has: (n) => n.startsWith("toy-") },
	{ id: "lab", label: "lab", emoji: "🧪", has: (n) => n.startsWith("lab-") },
	{ id: "big", label: "big ones", emoji: "🏔️", has: (n) => n.startsWith("big-") },
	{ id: "fancy", label: "fancy", emoji: "✨", has: (n) => n.startsWith("fancy-") },
	{
		id: "programs",
		label: "programs",
		emoji: "🛠️",
		has: (n) => n.startsWith("prog-") || n === "desk",
	},
	{ id: "friends", label: "friends", emoji: "🫂", has: (n) => n.startsWith("friends-") },
	{ id: "live", label: "live", emoji: "📹", has: (n) => n.startsWith("live-") },
	{ id: "nn", label: "nn", emoji: "🧠", has: (n) => n === "nn" },
	{ id: "pieces", label: "new pieces", emoji: "🧩", has: (n) => n.startsWith("piece-") },
]
const MORE = { id: "more", label: "more", emoji: "📦" }

type Item = {
	ex: Example
	group: { id: string; label: string; emoji: string }
	// after the colon, and the tag (jsx) in the title's last parentheses
	title: string
	tag?: string
	haystack: string
}

function describe(ex: Example, group: Item["group"]): Item {
	let t = ex.title
	const tag = /\s\(([\w -]+)\)\s*$/.exec(t)
	if (tag) t = t.slice(0, tag.index)
	const i = t.indexOf(":")
	const title = i >= 0 && i < 24 ? t.slice(i + 1).trim() : t.trim()
	return {
		ex,
		group,
		title,
		tag: tag?.[1],
		haystack: `${ex.name} ${title} ${ex.description ?? ""} ${group.label}`.toLowerCase(),
	}
}

const RECENT = "slaygrounds:recent"
const recents = (): string[] => {
	try {
		const v = JSON.parse(localStorage.getItem(RECENT) ?? "[]")
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
	} catch {
		return []
	}
}
const remember = (name: string) => {
	try {
		localStorage.setItem(
			RECENT,
			JSON.stringify([name, ...recents().filter((n) => n !== name)].slice(0, 5)),
		)
	} catch { /* private window, blocked storage: the menu works without it */ }
}

// text with the query's matches marked
function marked(el: HTMLElement, text: string, q: string) {
	const i = q ? text.toLowerCase().indexOf(q) : -1
	if (i < 0) return void (el.textContent = text)
	el.append(
		text.slice(0, i),
		Object.assign(h("mark"), { textContent: text.slice(i, i + q.length) }),
		text.slice(i + q.length),
	)
}

export function createMenu(root: HTMLElement, examples: Example[], open: (name: string) => void) {
	const items: Item[] = examples.map((ex) => {
		const g = GROUPS.find((x) => x.has(ex.name)) ?? MORE
		return describe(ex, g)
	})
	const groups = [...GROUPS, MORE].map((g) => ({
		...g,
		items: items.filter((i) => i.group.id === g.id),
	})).filter((g) => g.items.length)
	const byName = new Map(items.map((i) => [i.ex.name, i]))

	const button = h("button", "menubtn")
	const panel = h("div", "menupanel")
	panel.hidden = true
	const search = h("input", "menusearch")
	search.placeholder = "search the examples (cmd-k)"
	const list = h("div", "menulist")
	const fly = h("div", "menufly")
	fly.hidden = true
	panel.append(search, list, fly)
	root.append(button, panel)

	let current = ""
	// what the keys move among: the rows of the level shown, and which is lit
	let level: 0 | 1 = 0
	let rows: HTMLElement[] = []
	let at = 0
	let openGroup: string | undefined
	let q = ""

	const setCurrent = (name: string) => {
		current = name
		button.replaceChildren(h("span", "", "📂"), h("b", "", name), h("span", "caret", "▾"))
		if (!panel.hidden) render()
	}

	function choose(name: string) {
		remember(name)
		close()
		setCurrent(name)
		open(name)
	}

	function itemRow(it: Item, withGroup = false) {
		const row = h("div", "menuitem" + (it.ex.name === current ? " current" : ""))
		row.setAttribute("role", "menuitem")
		const tick = h("span", "tick", it.ex.name === current ? "✓" : "")
		const text = h("div", "mtext")
		const name = h("b")
		marked(name, it.ex.name, q)
		const sub = h("span", "msub")
		marked(sub, it.title, q)
		text.append(name, sub)
		if (it.ex.description) {
			const d = h("span", "mdesc")
			marked(d, it.ex.description, q)
			text.append(d)
		}
		row.append(tick, text)
		if (withGroup) row.append(h("span", "mtag grp", `${it.group.emoji} ${it.group.label}`))
		if (it.tag) row.append(h("span", "mtag", it.tag))
		row.onclick = () => choose(it.ex.name)
		row.onmouseenter = () => light(row)
		return row
	}

	function light(row: HTMLElement) {
		const i = rows.indexOf(row)
		if (i < 0) return
		const was = level
		at = i
		paint()
		// a group row flies its items out on hover
		if (rows[at].dataset.group && !q) showFly(rows[at].dataset.group!, false)
		else if (was === 0 && !q) hideFly()
	}
	function paint() {
		rows.forEach((r, i) => r.classList.toggle("lit", i === at))
		rows[at]?.scrollIntoView({ block: "nearest" })
	}

	function showFly(id: string, focus: boolean) {
		const g = groups.find((x) => x.id === id)
		if (!g) return
		openGroup = id
		fly.hidden = false
		fly.replaceChildren(...g.items.map((i) => itemRow(i)))
		const row = list.querySelector<HTMLElement>(`[data-group="${id}"]`)
		// beside the group row, kept inside the panel
		const top = row ? row.offsetTop - list.scrollTop + list.offsetTop : 0
		fly.style.top = Math.max(0, Math.min(top, panel.clientHeight - fly.offsetHeight - 4)) + "px"
		list.querySelectorAll(".menugroup").forEach((r) =>
			r.classList.toggle("open", (r as HTMLElement).dataset.group === id)
		)
		if (focus) {
			level = 1
			rows = [...fly.children] as HTMLElement[]
			at = Math.max(0, g.items.findIndex((i) => i.ex.name === current))
			paint()
		}
	}
	function hideFly() {
		fly.hidden = true
		openGroup = undefined
		list.querySelectorAll(".menugroup.open").forEach((r) => r.classList.remove("open"))
	}

	function render() {
		q = search.value.trim().toLowerCase()
		list.replaceChildren()
		hideFly()
		level = 0
		if (q) {
			// a search: every match from every group, in one list
			const hits = items.filter((i) => i.haystack.includes(q))
			for (const it of hits) list.append(itemRow(it, true))
			if (!hits.length) list.append(h("div", "menuempty", "nothing matches"))
			rows = [...list.querySelectorAll<HTMLElement>(".menuitem")]
		} else {
			const lately = recents().map((n) => byName.get(n)).filter((x): x is Item => !!x)
			if (lately.length) {
				list.append(h("div", "menuhead", "recently opened"))
				for (const it of lately) list.append(itemRow(it, true))
			}
			list.append(h("div", "menuhead", "examples"))
			for (const g of groups) {
				const row = h("div", "menugroup")
				row.dataset.group = g.id
				row.append(
					h("span", "gemoji", g.emoji),
					h("span", "glabel", g.label),
					h("span", "gcount", String(g.items.length)),
					h("span", "garrow", "▸"),
				)
				row.onclick = () => showFly(g.id, true)
				row.onmouseenter = () => light(row)
				list.append(row)
			}
			rows = [...list.querySelectorAll<HTMLElement>(".menuitem, .menugroup")]
		}
		at = 0
		paint()
	}

	function show() {
		panel.hidden = false
		button.setAttribute("aria-expanded", "true")
		search.value = ""
		render()
		search.focus()
	}
	function close() {
		panel.hidden = true
		button.setAttribute("aria-expanded", "false")
		hideFly()
	}

	button.onclick = () => (panel.hidden ? show() : close())
	search.oninput = render
	panel.onkeydown = (e) => {
		if (e.key === "Escape") return (e.preventDefault(), close(), button.focus())
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault()
			if (!rows.length) return
			at = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length
			paint()
			if (level === 0 && !q && rows[at].dataset.group) showFly(rows[at].dataset.group!, false)
			return
		}
		if (e.key === "ArrowRight" && level === 0 && rows[at]?.dataset.group) {
			e.preventDefault()
			return showFly(rows[at].dataset.group!, true)
		}
		if (e.key === "ArrowLeft" && level === 1) {
			e.preventDefault()
			const id = openGroup
			level = 0
			rows = [...list.querySelectorAll<HTMLElement>(".menuitem, .menugroup")]
			at = Math.max(0, rows.findIndex((r) => r.dataset.group === id))
			paint()
			return
		}
		if (e.key === "Enter") {
			e.preventDefault()
			const row = rows[at]
			if (!row) return
			if (row.dataset.group) showFly(row.dataset.group, true)
			else row.click()
		}
	}
	// clicking outside closes
	document.addEventListener("pointerdown", (e) => {
		if (!panel.hidden && !root.contains(e.target as Node)) close()
	})
	// cmd-k, or / outside a text field, opens with the search focused
	document.addEventListener("keydown", (e) => {
		const t = e.target as HTMLElement
		const typing = t.matches?.("input, textarea, [contenteditable=true]") ||
			t.closest?.(".cm-editor")
		if (
			((e.metaKey || e.ctrlKey) && e.key === "k") ||
			(e.key === "/" && !typing && !e.metaKey && !e.ctrlKey)
		) {
			e.preventDefault()
			if (panel.hidden) show()
			else search.focus()
		}
	})
	return { setCurrent }
}
