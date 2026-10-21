/// <reference lib="dom" />
// the finder: this page's tree from /, a column a level, as places reads it (lib's members: every
// contributor's names, each with the contributor that gave it: children, processes, away). a
// folder opens in the next column; a leaf's column is its preview: its attributes, and its value.
// drawn by a computer of the host's: every read tracked, so anything arriving redraws it (the
// selection is a key it tracks too)
//
//   const finder = createFinder(host, el, { pick: (path, id) => ..., drag: (path, id) => ... })
//   finder.select(["work", "keys"])
import { level, type Path } from "@ermine/places"
import { get, list, members } from "@ermine/places/lib"
import { NAME } from "@ermine/dens"
import type { Host } from "./host.ts"

export type Row = {
	readonly name: string
	readonly id: string | undefined
	readonly from?: string
	readonly folder: boolean
	readonly out?: unknown
}
export type Column = { readonly path: Path; readonly rows: Row[] }
export type Leaf = {
	readonly path: Path
	readonly id: string
	attributes?: unknown
	value?: unknown
}
export type Finder = {
	select: (path: Path) => void
	selected: () => Path
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag)
	if (cls) e.className = cls
	if (text !== undefined) e.textContent = text
	return e
}

// a value, short, as the finder shows it
export function brief(v: unknown, room = 60): string {
	if (typeof v === "function") return "a live function (this den's alone)"
	if (typeof v === "symbol") return String(v.description ?? "a symbol")
	if (v instanceof Error) return `failed: ${v.message}`
	let s: string
	try {
		s = JSON.stringify(
			v,
			(_, x) => typeof x === "function" ? "<function>" : typeof x === "symbol" ? "<pending>" : x,
		)
	} catch {
		s = String(v)
	}
	if (s === undefined) s = String(v)
	return s.length > room ? s.slice(0, room - 1) + "…" : s
}

export function createFinder(
	host: Host,
	el: HTMLElement,
	on: {
		// a row clicked: its path, and its id
		pick: (path: Path, id: string | undefined) => void
		// what this page calls a thing's id (a row that is one is draggable onto an in-port)
		isThing: (id: string) => boolean
	},
): Finder {
	const { s, places, hosted } = host
	let path: Path = ["system", "dens"]
	const key = {}

	// the columns: the root's, and each selected folder's; the leaf selected, if one is
	function read(): { columns: Column[]; leaf?: Leaf } {
		s.track(key)
		const columns: Column[] = []
		let leaf: Leaf | undefined
		for (let i = 0; i <= path.length; i++) {
			const here = path.slice(0, i)
			const rows = members(places, here).map((m): Row => {
				const id = m.id === level ? undefined : String(m.id)
				const at = [...here, m.name]
				const folder = !list(places, at).next().done
				const attrs = id === undefined ? undefined : places.readValue("attributes", id)
				return {
					name: m.name,
					id,
					from: m.from,
					folder,
					out: isMap(attrs) ? attrs["thing.out"] : undefined,
				}
			}).sort((a, b) => a.name < b.name ? -1 : 1)
			columns.push({ path: here, rows })
			const next = path[i]
			if (next === undefined) break
			const row = rows.find((r) => r.name === next)
			if (row === undefined) {
				path = here
				break
			}
			if (!row.folder && row.id !== undefined) {
				leaf = {
					path: path.slice(0, i + 1),
					id: row.id,
					attributes: places.readValue("attributes", row.id),
					value: places.readValue("value", row.id),
				}
				break
			}
		}
		return leaf ? { columns, leaf } : { columns }
	}

	const cols = h("div", "finder-cols")
	el.append(cols)

	function draw(view: { columns: Column[]; leaf?: Leaf }) {
		const scroll = cols.scrollLeft
		cols.replaceChildren()
		for (const [i, c] of view.columns.entries()) {
			const col = h("div", "finder-col")
			for (const r of c.rows) {
				const at = [...c.path, r.name]
				const row = h("div", "finder-row")
				if (path[i] === r.name) row.classList.add("on")
				if (r.folder) row.classList.add("folder")
				row.title = `/${at.join("/")}${r.id ? `  (${r.id})` : ""}`
				row.append(h("span", "finder-name", r.name))
				// a node away mirrors here (a level of its trie is no node: no badge)
				if (r.from === "away" && r.id !== undefined) {
					row.append(h("span", "finder-badge", "away"))
				}
				if (r.out !== undefined) row.append(h("span", "finder-out", brief(r.out, 18)))
				if (r.folder) row.append(h("span", "finder-arrow", "›"))
				row.onclick = () => {
					select(at)
					on.pick(at, r.id)
				}
				if (r.id !== undefined && on.isThing(r.id)) {
					row.draggable = true
					row.classList.add("thing")
					row.ondragstart = (e) => {
						e.dataTransfer!.setData("text/x-ermine-path", `/${at.join("/")}`)
						e.dataTransfer!.setData("text/x-ermine-id", r.id!)
						e.dataTransfer!.setData("text/plain", `/${at.join("/")}`)
						e.dataTransfer!.effectAllowed = "link"
					}
				}
				col.append(row)
			}
			if (c.rows.length === 0) col.append(h("div", "finder-empty", "empty"))
			cols.append(col)
		}
		if (view.leaf) {
			const p = h("div", "finder-col finder-preview")
			p.append(h("div", "finder-path", `/${view.leaf.path.join("/")}`))
			p.append(h("div", "finder-id", view.leaf.id))
			const attrs = view.leaf.attributes
			if (isMap(attrs)) {
				const dl = h("dl")
				for (const [k, v] of Object.entries(attrs).sort(([a], [b]) => a < b ? -1 : 1)) {
					const dt = h("dt", k === "thing.out" ? "out" : "", k)
					dl.append(dt, shown(k, v))
				}
				p.append(h("div", "finder-label", "attributes"), dl)
			}
			if (view.leaf.value !== undefined) {
				p.append(
					h("div", "finder-label", "value"),
					h("pre", "finder-value", brief(view.leaf.value, 400)),
				)
			}
			cols.append(p)
		}
		cols.scrollLeft = Math.max(scroll, cols.scrollWidth)
		crumb.textContent = `/${path.join("/")}`
	}

	// a path, as a chip: click it and the finder goes there
	// a long key's hex is cut to its start; the whole path is the chip's title
	const short = (at: Path) =>
		`/${at.map((x) => /^[0-9a-f]{20,}$/.test(x) ? x.slice(0, 6) + "…" : x).join("/")}`
	// a den's own name, from its row at /system/dens/<id>
	const denName = (den: string) => {
		const id = places.peep(() => get(places, ["system", "dens", den]))
		const attrs = typeof id === "string"
			? places.peep(() => places.readValue("attributes", id))
			: undefined
		return isMap(attrs) && typeof attrs[NAME] === "string" ? attrs[NAME] : den
	}
	function chip(at: Path, note?: string) {
		const c = h("button", "finder-chip", short(at))
		c.title = `go to /${at.join("/")}`
		c.onclick = () => {
			select(at)
			const id = places.peep(() => get(places, at))
			on.pick(at, typeof id === "string" ? id : undefined)
		}
		if (note === undefined) return c
		const w = h("span", "finder-chips")
		w.append(c, h("span", "finder-note", note))
		return w
	}
	const isPath = (v: unknown): v is Path =>
		Array.isArray(v) && v.every((x) => typeof x === "string")
	const split = (p: string): Path => p.split("/").filter((x) => x !== "")

	// an attribute's value: what points somewhere is a chip there; the rest, short
	function shown(k: string, v: unknown): HTMLElement {
		const dd = h("dd", k === "thing.out" ? "out" : "")
		// a pointer to a node: { id, at, hash? }
		if (isMap(v) && isPath(v.at)) {
			dd.append(chip(v.at))
			return dd
		}
		// a folder, as a path
		if (k === "ermine.process.cwd" && isPath(v)) {
			dd.append(chip(v))
			return dd
		}
		// a wire: [input, den, path] triples, each "input ← path"
		if (
			k === "ermine.process.args" && isPath(v) && v.length > 0 && v.length % 3 === 0 &&
			v.every((x, i) => i % 3 !== 2 || x.startsWith("/"))
		) {
			for (let i = 0; i < v.length; i += 3) {
				const line = h("span", "finder-wire")
				line.append(
					h("span", "finder-note", `${v[i]} ←`),
					chip(split(v[i + 2]), `on ${denName(v[i + 1])}`),
				)
				dd.append(line)
			}
			return dd
		}
		dd.textContent = brief(v)
		return dd
	}

	const crumb = h("span", "finder-crumb")
	el.querySelector(".finder-bar")?.prepend(crumb)

	hosted(() => s.createEffect(read, draw, () => false))

	function select(p: Path) {
		path = [...p]
		s.mark([key])
		host.soon()
	}
	return { select, selected: () => path }
}
