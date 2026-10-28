/// <reference lib="dom" />
// the graph inspector: the program's world, read from globalThis.ermine in its iframe
// ({ table, places, s, parts, moments }). a tree from the root by the children read through places, a
// detail for the picked node from the table, and the scheduler's moments in words.
// reads are the host's own (the table read directly, so nothing is tracked), so nothing here is asked of
// protect: an item a guard refused would show as REFUSED, and this demo has no rules
import { h, patch, render } from "./values.ts"
import { edit } from "./edit.ts"
import {
	createEffect,
	createMemo,
	createRenderEffect,
	createRoot,
	createSignal,
	mapArray,
} from "@solidjs/signals"
import { insert } from "@solidjs/web"
import { feed, moments, type Reads, type Tree, tree } from "./solid-ermine.ts"
import { createMap, preview as cardPreview } from "./map.ts"
import type { Card, Ephemeral } from "./solid-ermine.ts"
import { allParts } from "./allparts.ts"
import { runSection } from "./runs.ts"
import { createFinder } from "./finder.ts"
import { type Link, readsWell, sheet, value as shown } from "./sheet.ts"
import type { Said } from "./inspect.ts"

// deno-lint-ignore no-explicit-any
type Any = any
// an effect's return is its cleanup: a binding that assigns says nothing back; and a binding
// writes only when what it reads is a new value
const bind = <T>(read: () => T, apply: (v: T) => void) => {
	// the memo is what keeps a write off the page when the value did not change
	const m = createMemo(read)
	createRenderEffect(m, (v) => void apply(v))
}
const REFUSED = Symbol.for("ermine.refused")
// the id at names from the root, the table read untouched (nothing here is tracked)
function peek(w: Any, names: string[]): unknown {
	let id: unknown = w.places.root
	// a process running at a path is there in place of what is saved (the root's process rows)
	let rows = w.table.get("process", w.places.root)?.value
	for (const name of names) {
		const v = w.table.get("children", id)?.value
		rows = rows && typeof rows === "object" && Object.hasOwn(rows, name) ? rows[name] : undefined
		// the process at this path: a leaf, or a level's own under "" (a process with processes under it)
		const own = typeof rows === "string"
			? rows
			: rows && typeof rows === "object" && typeof rows[""] === "string"
			? rows[""]
			: undefined
		const k = own ?? (v && Object.hasOwn(v, name) ? v[name] : undefined)
		if (typeof k !== "string" && typeof k !== "symbol") return undefined
		id = k
	}
	return id
}
const short = (id: unknown) => (typeof id === "string" ? id.slice(0, 8) : String(id))
// who a signer key is: what the presence rows at the node say of that key (a name, a colour), read
// untracked; none: the key cut short
function whoIs(w: Any, id: unknown, key: unknown): { name: string; colour?: string } {
	const row = typeof key === "string" ? w?.table.get("presence", id)?.value?.[key] : undefined
	const v = row?.value
	return {
		name: typeof v?.name === "string" ? v.name : short(key),
		colour: typeof v?.colour === "string" ? v.colour : undefined,
	}
}
// the commits on top, the one shown first
const onTop = (e: Ephemeral | undefined) =>
	Array.isArray(e?.on) && e.on.length ? [...e.on].reverse() : undefined

export function createInspector(
	root: HTMLElement,
	target: () => Window | undefined,
	// told each call's result or error, for the console
	log: (level: string, args: unknown[]) => void = () => {},
	hooks: {
		// a node picked: its path from the root, and its value
		picked?: (path: string | undefined, value: unknown, id?: unknown) => void
		// a file's line asked for: "program.ts:12"
		goto?: (where: string) => void
		// an example's file by the url it ran from ("host.ts", "program.ts"); none: undefined
		fileOf?: (url: string) => string | undefined
	} = {},
) {
	const bar = h("div", "ibar")
	const search = h("input")
	search.placeholder = "search names"
	const refresh = h("button", "", "refresh")
	// the map's own controls: shown with the map
	const mapTools = h("span", "maptools")
	mapTools.hidden = true
	const depth = h("input")
	depth.type = "number"
	depth.value = "2"
	depth.min = "0"
	depth.title = "fold the cards at this depth"
	const foldBtn = h("button", "", "fold")
	const unfoldBtn = h("button", "", "unfold")
	const tidyBtn = h("button", "", "tidy")
	tidyBtn.title = "put every moved card back"
	mapTools.append(depth, foldBtn, unfoldBtn, tidyBtn)
	// the map wants room: this gives the bottom pane most of the right column, and back
	const grow = h("button", "", "grow")
	grow.hidden = true
	let before: string | undefined
	grow.onclick = () => {
		const main = document.querySelector("main") as HTMLElement
		if (before === undefined) {
			before = main.style.getPropertyValue("--down")
			main.style.setProperty("--down", "16%")
			grow.textContent = "shrink"
		} else {
			main.style.setProperty("--down", before)
			before = undefined
			grow.textContent = "grow"
		}
		setTimeout(() => map.fit(), 60)
	}
	bar.append(search, refresh, grow, mapTools)
	const treeBox = h("div", "tree")
	const mapBox = h("div", "mapbox")
	mapBox.hidden = true
	const finderBox = h("div", "finder")
	finderBox.hidden = true
	const detail = h("div", "detail")
	const momentsBox = h("div", "moments")
	const body = h("div", "ibody")
	const left = h("div", "col")
	left.append(bar, treeBox, mapBox, finderBox)
	body.append(left, detail, momentsBox)
	root.append(body)

	// ---- state: signals, so the views follow them and nothing is rebuilt by hand ----
	const [worldSig, setWorldSig] = createSignal<Any>(undefined)
	// is the inspector on show, and which mode: a hidden one does not recompute (nothing is drawn)
	const [visible, setVisible] = createSignal(false)
	const [modeSig, setModeSig] = createSignal<"graph" | "map" | "files">("graph")
	const [openSig, setOpenSig] = createSignal(new Set<string>(["root"]), { equals: false })
	const open = {
		has: (k: string) => openSig().has(k),
		add: (k: string) => setOpenSig((s) => (s.add(k), s)),
		delete: (k: string) => setOpenSig((s) => (s.delete(k), s)),
		reset: () => setOpenSig(() => new Set(["root"])),
	}
	const [pickedSig, setPickedSig] = createSignal<string | undefined>(undefined)
	const [searchSig, setSearchSig] = createSignal("")
	const [elementSig, setElementSig] = createSignal<Said | undefined>(undefined)
	const [model, setModel] = createSignal<(() => Tree | undefined) | undefined>(undefined)
	const [readsOf, setReadsOf] = createSignal<(() => Reads | undefined) | undefined>(undefined)
	const [momentsOf, setMomentsOf] = createSignal<(() => number) | undefined>(undefined)
	const treeNow = createMemo(() => model()?.())
	// a read that goes quiet while it is not wanted: hidden, nothing recomputes and nothing is drawn
	function gate<T>(on: () => boolean, read: () => T) {
		let last: T | undefined
		return createMemo(() => (on() ? (last = read()) : last))
	}
	const treeShown = gate(() => visible() && modeSig() === "graph", () => treeNow())
	const treeAny = gate(() => visible(), () => treeNow())
	const world = (): Any => (target() as Any)?.ermine
	const cardOf = (key: string | undefined) =>
		key ? treeNow()?.cards.find((c) => c.key === key) : undefined

	function nodeOf(w: Any, part: string, id: unknown) {
		return w.table.get(part, id)
	}

	// ---- the tree: rows from the tree signal, a stable element per key, each field its own binding ----
	type Flat = {
		key: string
		name: string
		depth: number
		card: Card
		alias: boolean
		nkids: number
		open: boolean
	}
	const flat = createMemo<Flat[]>(() => {
		const t = treeShown()
		if (!t?.cards.length) return []
		const kids = new Map<Card, { to: Card; name: string; mount: boolean }[]>()
		for (const e of t.edges) {
			const l = kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!
			l.push({ to: e.to, name: e.name, mount: e.mount })
		}
		const q = searchSig().trim().toLowerCase()
		const opened = openSig()
		const text = (c: Card, name: string) =>
			`${name} ${short(c.item.id)} ${cardPreview(c.value)}`.toLowerCase()
		const walk = (c: Card, name: string, key: string, depth: number, alias: boolean): Flat[] => {
			const ks = alias ? [] : kids.get(c) ?? []
			const sub: Flat[] = []
			// a folded item is not walked, unless a search wants what is under it
			if (!alias && (opened.has(key) || q)) {
				for (const k of ks) {
					sub.push(
						...walk(
							k.to,
							k.name,
							k.mount ? `${key}/${k.name}@mount` : k.to.key,
							depth + 1,
							k.mount,
						),
					)
				}
			}
			const row = { key, name, depth, card: c, alias, nkids: ks.length, open: opened.has(key) }
			return !q || text(c, name).includes(q) || sub.length ? [row, ...sub] : []
		}
		return walk(t.cards[0], "/", "root", 0, false)
	})
	// a row is built once; what it shows is bound to what the row says, and only what changed is written
	function buildRow(item: () => Flat) {
		const el = h("div", "trow")
		const arrow = h("span", "arrow")
		const name = h("span", "name")
		const pend = h("span", "tag pending", "pending")
		const refd = h("span", "tag refused", "REFUSED")
		// a stored node with ephemeral commits on top: whose shows
		const eph = h("span", "tag ephemeral")
		const src = h("span", "src")
		const pv = h("span", "pv")
		el.append(arrow, name, pend, refd, eph, src, pv)
		bind(
			() =>
				`trow d${item().depth % 4}` +
				(!item().alias && pickedSig() === item().card.key ? " picked" : "") +
				(item().card.refused ? " refused" : ""),
			(v) => (el.className = v),
		)
		bind(() => 6 + item().depth * 14 + "px", (v) => (el.style.paddingLeft = v))
		bind(
			() => (item().nkids ? (item().open ? "▾" : "▸") : "·"),
			(v) => (arrow.textContent = v),
		)
		bind(
			() => item().name + (item().alias ? " ↪" : ""),
			(v) => (name.textContent = v),
		)
		bind(() => item().card.pending, (v) => (pend.hidden = !v))
		bind(() => item().card.refused, (v) => (refd.hidden = !v))
		bind(() => {
			const on = onTop(item().card.ephemeral)
			if (!on) return ""
			const who = whoIs(worldSig(), item().card.item.id, on[0].by)
			return JSON.stringify([
				`ephemeral on top: ${who.name}${on.length > 1 ? ` +${on.length - 1}` : ""}`,
				who.colour ?? "",
			])
		}, (j) => {
			eph.hidden = !j
			if (!j) return
			const [text, colour] = JSON.parse(j)
			eph.textContent = text
			eph.style.setProperty("--who", colour || null)
			eph.title =
				"a stored node with ephemeral commits on top: what shows is theirs and is stored nowhere; the stored value is underneath (pick the node to see both)"
		})
		bind(
			() => (item().card.refused ? "" : short(item().card.item.id)),
			(v) => ((src.textContent = v), (src.hidden = !v)),
		)
		bind(
			() => (item().card.refused || item().card.value === undefined
				? ""
				: cardPreview(item().card.value)),
			(v) => ((pv.textContent = v), (pv.hidden = !v)),
		)
		el.onclick = (e) => {
			const r = item()
			if (e.target === arrow && r.nkids) r.open ? open.delete(r.key) : open.add(r.key)
			else choose(r.card.key)
		}
		return el
	}
	{
		const waiting = h("p", "empty", "waiting for the program to set globalThis.ermine")
		const end = document.createComment("")
		treeBox.append(waiting, end)
		bind(() => !!worldSig(), (v) => (waiting.hidden = v))
		insert(treeBox, mapArray(flat, buildRow, { keyed: (r) => r.key }), end)
	}

	const preview = cardPreview

	// ---- calling a handler: the example's own call (definer's scope, caller, trusted) when its
	// host gives one, else the function run in a scope under the host saying so ----
	type Outcome = { args: string; how: string; ok: boolean; value: unknown }
	const lastCall = new Map<string, Outcome>()
	function callBox(
		w: Any,
		into: HTMLElement,
		item: Any,
		key: string,
		names: () => string[],
		fnOf: () => (...a: unknown[]) => unknown,
	) {
		into.append(h("h3", "", "call"))
		const own = !!(w.call && w.defined?.has(item.id))
		const prev = lastCall.get(key)
		const box = into.appendChild(h("div", "callbox"))
		const args = h("input")
		args.placeholder = "arguments as JSON, e.g. [6, 4]"
		args.value = prev?.args ?? ""
		const go = h("button", "", "call")
		box.append(args, go)
		into.append(
			h(
				"div",
				"empty",
				own
					? `through the example's call: owned by its definer, caller "inspector"; untrusted: not a person's event in the program`
					: `this host has no call: run in a scope under the host (via inspector, caller inspector, trusted)`,
			),
		)
		const out = into.appendChild(h("div", "callout"))
		const show = (o: Outcome) => {
			out.replaceChildren(
				h("div", o.ok ? "ok" : "bad", `${o.ok ? "returned" : "threw"} (${o.how})`),
				render(o.value, undefined, true),
			)
		}
		if (prev) show(prev)
		const run = async () => {
			let list: unknown[]
			try {
				list = args.value.trim() ? JSON.parse(args.value) : []
				if (!Array.isArray(list)) throw new Error("arguments are a JSON list")
			} catch (e) {
				return show({ args: args.value, how: "arguments", ok: false, value: e })
			}
			const how = own ? "example's call" : "inspector scope"
			let o: Outcome
			try {
				let r: unknown
				// the host decides trusted from the event being dispatched in its own window: none here
				if (own) r = w.call(names(), list, "inspector")
				else {
					const scope = w.s.createScope({
						via: "inspector",
						caller: "inspector",
						"trusted-event": true,
					}, w.host)
					try {
						r = w.s.runWithScope(scope, () => fnOf()(...list))
					} finally {
						w.s.teardown(scope)
						w.s.pulse()
					}
				}
				if (r && typeof (r as Any).then === "function") r = await r
				o = { args: args.value, how, ok: true, value: r }
			} catch (e) {
				o = { args: args.value, how, ok: false, value: e }
			}
			lastCall.set(key, o)
			show(o)
			log(o.ok ? "log" : "error", [
				`call ${names().join("/")}`,
				...(list ? list : []),
				o.ok ? "→" : "threw",
				o.value,
			])
		}
		go.onclick = run
		args.onkeydown = (e) => {
			if (e.key === "Enter") (e.preventDefault(), run())
		}
	}

	// ---- an element picked in the render (inspect element): what it says, above the node ----
	function elementSection(into: HTMLElement, link: Link) {
		const s = elementSig()!
		const head = into.appendChild(h("h3", "elhead", `element <${s.tag}>`))
		const close = head.appendChild(h("button", "", "×"))
		close.title = "put the element away"
		close.onclick = () => setElementSig(undefined)
		const rows: [string, unknown][] = []
		if (s.process) rows.push(["process", s.process])
		for (const [what, path] of s.binds) rows.push([`🔗 ${what}`, path])
		for (const [event, path] of s.ons) rows.push([`🪝 ${event}`, path])
		if (s.key !== undefined) rows.push(["🔑 key", s.key])
		if (s.waiting) rows.push(["waiting", true])
		if (s.source) rows.push(["made at", s.source])
		if (!rows.length) rows.push(["says", "nothing: not drawn by @ermine/render"])
		const mine: Link = (v) => {
			if (v === s.source && s.source) {
				return {
					text: s.source,
					go: () => hooks.goto?.(s.source!),
				}
			}
			if (v === s.process) {
				const card = processCard(s)
				return card && { text: s.process!, go: () => choose(card.key, true) }
			}
			if (typeof v === "string" && v.startsWith("/")) {
				return { text: shortId(v), go: () => pickPath(v, true) }
			}
			return link(v)
		}
		into.append(sheet(rows, mine))
	}
	// the process an element is drawn by: the node whose value is its root
	function processCard(s: Said) {
		const root = s.el.closest("[data-ermine-process]")
		const cards = model()?.()?.cards ?? []
		return cards.find((c) => c.value === root) ??
			cards.find((c) => c.depth === 1 && c.name === s.process)
	}
	// a value that names a node: a path from the root, an entry, a node's id
	function linker(w: Any): Link {
		const cards = model()?.()?.cards ?? []
		const named = (c: Any) => {
			const names: string[] = []
			for (let u = c; u?.up; u = u.up) names.unshift(u.name)
			return "/" + names.join("/")
		}
		return (v) => {
			if (typeof v === "string" && v.length > 1 && v.startsWith("/")) {
				const names = v.split("/").filter(Boolean)
				try {
					if (peek(w, names) !== undefined) {
						return { text: v, go: () => pickAddress(names) }
					}
				} catch { /* not an address */ }
			}
			const c = typeof v === "string" && v.length >= 8
				? cards.find((c) => c.item.id === v)
				: undefined
			return c && { text: named(c), go: () => choose(c.key) }
		}
	}

	// ---- the detail: built once per picked node; each cell is bound to what it shows, so a node that
	// ticks rewrites its value and change cells and nothing else ----
	// a cell: an element whose children are made again only when what it reads changes, and laid
	// over what is there (values.ts patch), so what stays the same stays put
	function cell<T>(
		into: HTMLElement,
		read: () => T,
		make: (v: T) => (Node | string)[] | Node | string | undefined,
	) {
		bind(read, (v) => {
			const out = make(v)
			patch(into, Array.isArray(out) ? out : out === undefined ? [] : [out])
		})
		return into
	}
	// the ephemeral part of a node: who is on top (the one shown first), and for each table it covers
	// the value stored underneath and the value that shows now
	function ephemeralSection(w: Any, id: unknown, e: Ephemeral | undefined, link: Link) {
		const on = onTop(e)
		if (!on) return []
		const out: Node[] = [h("h3", "", "ephemeral on top")]
		const first = whoIs(w, id, on[0].by)
		out.push(h("p", "ephnote", `${first.name}'s commit shows; it is stored nowhere`))
		const list = h("div", "ephon")
		on.forEach((c, i) => {
			const who = whoIs(w, id, c.by)
			const row = list.appendChild(h("div", "ephrow" + (i === 0 ? " shows" : "")))
			const dot = row.appendChild(h("span", "ephdot"))
			if (who.colour) dot.style.background = who.colour
			const name = row.appendChild(h("span", "ephwho", who.name))
			name.title = `signer key ${c.by ?? "unknown"}`
			if (who.name !== short(c.by)) row.append(h("span", "ephkey", short(c.by)))
			row.append(
				h("span", "ephwhat", (c.tables ?? []).join(", ")),
				h("span", "ephkey", c.lamport === undefined ? "" : `lamport ${c.lamport}`),
				h("span", "ephkey", c.name ? `commit ${String(c.name).slice(0, 8)}` : ""),
				h("span", "ephshows", i === 0 ? "shows" : "under it"),
			)
		})
		out.push(list)
		const tables = [
			...new Set([...Object.keys(e?.under ?? {}), ...on.flatMap((c) => c.tables ?? [])]),
		]
		// each table: what is stored underneath, and what shows on top now
		const pairs: [string, unknown][] = []
		for (const t of tables) {
			const one = tables.length === 1 && t === "value"
			pairs.push([one ? "stored" : `${t} stored`, e?.under?.[t]])
			pairs.push([one ? "on top" : `${t} on top`, w.table.get(t, id)?.value])
		}
		out.push(sheet(pairs, link))
		return out
	}
	function detailFor(
		w: Any,
		into: HTMLElement,
		keyOf: () => string | undefined,
		editable: boolean,
	) {
		let stop: (() => void) | undefined
		// the skeleton changes with the key (and with whether that node is there yet)
		bind(() => `${keyOf()}\u0001${!!cardOf(keyOf())}`, () => {
			stop?.()
			into.replaceChildren()
			stop = createRoot((dispose) => {
				build(w, into, keyOf(), editable)
				return dispose
			})
		})
	}
	function build(w: Any, into: HTMLElement, key: string | undefined, editable: boolean) {
		const link = linker(w)
		const at = () => (key ? treeAny()?.cards.find((c) => c.key === key) : undefined)
		if (editable) {
			const el = into.appendChild(h("div"))
			cell(el, () => elementSig(), (s) => {
				if (!s) return []
				const box = h("div")
				elementSection(box, link)
				return [...box.childNodes]
			})
		}
		const first = at()
		if (!first) return void into.append(h("p", "empty", "pick a node"))
		if (first.refused) {
			return void into.append(h("p", "empty", "REFUSED: the rules did not let this be read"))
		}
		const item = first.item
		const section = (title: string) => into.appendChild(h("h3", "", title))
		const field = (k: string, v: () => string) => {
			const r = into.appendChild(h("div", "field"))
			const val = h("span", "v")
			bind(v, (t) => ((val.textContent = t), (r.hidden = !t)))
			r.append(h("span", "k", k), val)
			return r
		}
		const pathOf = createMemo(() => {
			const names: string[] = []
			for (let u = at(); u?.up; u = u.up) names.unshift(u.name)
			return names
		})
		const head = section("")
		bind(() => "/" + pathOf().join("/"), (t) => (head.textContent = t))
		field("id", () => String(item.id))
		// where else it is placed: every mount of the same id
		field("also at", () => {
			const t = treeAny()
			return (t?.edges ?? [])
				.filter((e) => e.mount && e.to.item.id === item.id)
				.map((e) => placeOf(e.from.item.id) + "/" + e.name)
				.join("\n")
		})
		// the other parts of the node, tracked by ermine: attributes, and the children's change
		const extra = feed(w, () => ({
			attrs: (w.places.readValue("attributes", item.id), nodeOf(w, "attributes", item.id)),
			kidsChange: w.places.readChange("children", item.id),
		}))
		let editing: string | undefined
		let valueH3!: HTMLElement
		const block = (title: string, part: string, node: () => Any, whole: boolean) => {
			const h3 = section(title)
			if (part === "value") valueH3 = h3
			const slot = into.appendChild(h("div"))
			// a value that reads well as a sheet, a plain value, or as the console shows it
			const draw = (n: Any) => {
				const v = n?.value
				return v === undefined
					? h("p", "empty", n ? "none" : "no node")
					: readsWell(v) && !Array.isArray(v)
					? sheet(Object.entries(v as object), link)
					: readsWell(v) || v === null || typeof v !== "object" && typeof v !== "function"
					? shown(v, link)
					: render(v, undefined, whole)
			}
			// not while the value is being edited: the editor holds the slot
			bind(() => node(), (n) => {
				if (editing === part) return
				patch(slot, [draw(n)])
			})
			if (editable && !first.pending) {
				const b = h3.appendChild(h("button", "", "edit"))
				bind(() => node()?.value !== undefined, (v) => (b.hidden = !v))
				b.onclick = () => {
					editing = part
					b.hidden = true
					edit(slot, w, { id: item.id, part }, () => {
						editing = undefined
						b.hidden = false
						slot.replaceChildren(draw(node()))
					}, (url) => (target() as Any).__import(url))
				}
			}
		}
		// ephemeral commits on top: who, and per table what is stored underneath and what shows
		const ephBox = into.appendChild(h("div"))
		cell(ephBox, () => {
			const e = at()?.ephemeral
			const on = onTop(e)
			if (!on) return ""
			const tables = [
				...new Set([...Object.keys(e?.under ?? {}), ...on.flatMap((c) => c.tables ?? [])]),
			]
			return JSON.stringify(tables) + "\u0001" + JSON.stringify(on)
		}, () => ephemeralSection(w, item.id, at()?.ephemeral, link))
		const valueNode = createMemo(() => ({ value: at()?.value, change: at()?.change }))
		block("value", "value", () => valueNode(), true)
		{
			const tag = h("span", "tag ephemeral", "ephemeral on top")
			tag.title = "what shows here is the ephemeral commit on top; the stored value is above"
			valueH3.append(tag)
			bind(
				() => !!onTop(at()?.ephemeral)?.some((c) => (c.tables ?? ["value"]).includes("value")),
				(v) => (tag.hidden = !v),
			)
		}
		// a computer's or a process's status, latest run, reads and writes, sites, args, folder, pin
		runSection(w, into.appendChild(h("div")), item.id, {
			link,
			pick: (id) => {
				const c = (model()?.()?.cards ?? []).find((x) => x.item.id === id)
				return c && (() => choose(c.key))
			},
			name: (id) => {
				const c = (model()?.()?.cards ?? []).some((x) => x.item.id === id)
				return c ? rooted(placeOf(id)) : String(id).slice(0, 13)
			},
			goto: hooks.goto,
			fileOf: hooks.fileOf,
		})
		block("attributes", "attributes", () => extra()?.attrs, false)
		// a handler can be called: the host knows which nodes are (its defined map)
		const isHandler = typeof at()?.value === "function" &&
			(w.defined ? w.defined.has(item.id) : at()?.up?.name === "on")
		if (editable && isHandler) {
			callBox(w, into, item, key!, pathOf, () => at()!.value as (...a: unknown[]) => unknown)
		}
		// the children's names as tags, each picking its child
		section("children")
		const namesHere = createMemo(() => {
			const t = treeAny(), c = at()
			return JSON.stringify((t?.edges ?? []).filter((e) => e.from === c).map((e) => e.name))
		})
		cell(into.appendChild(h("div")), () => namesHere(), (j) => {
			const names = JSON.parse(j) as string[]
			return names.length
				? shown(
					names,
					(v) =>
						typeof v === "string" && names.includes(v)
							? { text: v, go: () => pickAddress([...pathOf(), v]) }
							: undefined,
				)
				: h("p", "empty", "none")
		})
		// the children node's latest edit: a place, an unplace, a move or an order shows here
		const kidsBox = into.appendChild(h("div"))
		cell(kidsBox, () => extra()?.kidsChange, (kids: Any) => {
			if (!kids?.op?.patches) return []
			const out: Node[] = [h("h3", "", "children's last edit")]
			const rows = h("div")
			const f = (k: string, v: string) => {
				const r = rows.appendChild(h("div", "field"))
				r.append(h("span", "k", k), h("span", "v", v))
			}
			const by = Object.entries(kids.metadata ?? {}).filter(([k]) =>
				k === "caller" || k === "travel"
			)
			if (by.length) f(by.map(([k]: Any) => k).join(", "), by.map(([, v]: Any) => v).join(", "))
			const where = (t: Any) => t.path.join("/") + (t.range ? `[${t.range.join(",")}]` : "")
			for (const p of kids.op.patches as Any[]) {
				f(
					p.move ? "move" : "value" in p ? "put" : "remove",
					where(p) +
						(p.move
							? ` ← ${where(p.move)}`
							: "value" in p
							? ` = ${cardPreview(p.value)}`
							: ""),
				)
			}
			return [...out, rows]
		})
		// the change: who, when, its metadata (the scopes it was made in, merged); then the patches
		const changeBox = into.appendChild(h("div"))
		cell(changeBox, () => at()?.change, (c: Any) => {
			const out: Node[] = [h("h3", "", "change")]
			if (!c) return [...out, h("p", "empty", "none")]
			// its sites, oldest first: the nearest three
			const site = (c.external ?? []).slice(-3)
			out.push(sheet([
				["who", c.actor],
				...(c.reader !== undefined ? [["reader", c.reader] as [string, unknown]] : []),
				["time", new Date(c.time * 1000).toLocaleTimeString()],
				...Object.entries(c.metadata ?? {}),
				[
					"site",
					site.length
						? site.map((s: Any) => `${s.function ?? ""} ${s.file}:${s.line}`.trim()).join(
							"\n",
						)
						: undefined,
				],
			], link))
			if (c.op?.patches) {
				out.push(h("h3", "", "last edit"))
				const edits = h("div", "sheet")
				const where = (t: Any) =>
					"/" + (t.path ?? []).join("/") + (t.range ? `[${t.range.join(",")}]` : "")
				for (const p of c.op.patches as Any[]) {
					const row = edits.appendChild(h("div", "srow"))
					const cellv = h("span", "sv")
					cellv.append(h("span", "spath", where(p)))
					if (p.move) {
						cellv.append(h("span", "sarrow", " ← "), h("span", "spath", where(p.move)))
					} else if ("value" in p) {
						cellv.append(h("span", "sarrow", " = "), shown(p.value, link))
					}
					row.append(h("span", "sk", p.move ? "move" : "value" in p ? "put" : "remove"), cellv)
				}
				out.push(edits)
			}
			return out
		})
		// every table entry at the id, whatever its part
		allParts(w, into, item.id, link)
		// who reads this node: the parts whose latest run read it
		const readersBox = into.appendChild(h("div"))
		cell(readersBox, () => {
			const r = readsOf()?.()
			return JSON.stringify(
				[...(r?.values() ?? [])]
					.filter((x) => x.entry.id !== item.id && x.reads.some((q) => q.id === item.id))
					.map((x) => rooted(placeOf(x.entry.id))),
			)
		}, (j) => {
			const names = [...new Set(JSON.parse(j) as string[])]
			return names.length ? [h("h3", "", "read by"), shown(names, link)] : []
		})
		// a part of the program is a computation: say which, and how its runs ended
		const compBox = into.appendChild(h("div"))
		cell(compBox, () => {
			momentsOf()?.()
			for (const [comp, part] of w.parts as Map<Any, Any>) {
				if (part.entry.id !== item.id) continue
				const mine = readsOf()?.()?.get(comp)
				const last = [...w.moments].reverse().find((m: Any) => m.ends === comp)
				return JSON.stringify([
					comp.kind,
					comp.runs,
					last && `${last.run} ${last.ended}${last.equal ? " (same value)" : ""}`,
					mine?.reads.map((r) =>
						`${rooted(placeOf(r.id))}${
							r.part === "children" ? " (names)" : r.part === "change" ? " (change)" : ""
						}`
					),
				])
			}
			return ""
		}, (j) => {
			if (!j) return []
			const [kind, runs, last, where] = JSON.parse(j) as [
				string,
				number,
				string | null,
				string[] | null,
			]
			const out: Node[] = [h("h3", "", "computation")]
			const f = (k: string, v: string) => {
				const r = h("div", "field")
				r.append(h("span", "k", k), h("span", "v", v))
				out.push(r)
			}
			f("kind", kind)
			f("runs", String(runs))
			if (where) {
				const reads = h("div", "srow")
				reads.append(
					h("span", "sk", "reads"),
					where.length
						? shown([...new Set(where)], (v) => {
							const to = link(
								typeof v === "string" ? v.replace(/ \((names|change)\)$/, "") : v,
							)
							return to && { text: String(v), go: to.go }
						})
						: h("span", "snone", "nothing"),
				)
				out.push(reads)
			}
			if (last) f("last run", last)
			return out
		})
	}

	// ---- the scheduler, in words ----
	function say(w: Any, m: Any): [string, string] {
		// a part by its name, a binding by what it binds (the host's binds map)
		const name = (c: Any) => w.parts.get(c)?.at[1] ?? w.binds?.get(c) ?? `an ${c.kind}`
		if (m.starts) return ["start", `${name(m.starts)} runs (run ${m.run}, rank ${m.rank})`]
		if (m.ends) {
			const why = m.ended === "failed"
				? `: ${m.error?.message ?? m.error}`
				: m.equal
				? ", same value"
				: ""
			return [m.ended, `${name(m.ends)} ended ${m.ended}${why} (run ${m.run})`]
		}
		if (m.acts) {
			return ["acts", `${name(m.acts)} acted (run ${m.run})${m.error ? ": " + m.error : ""}`]
		}
		return [
			"due",
			`${name(m.due)} is due${m.by ? ", by " + name(m.by) : ""} (tick ${m.tick})`,
		]
	}
	// the scheduler's moments: the newest few, each a div made once (the list is keyed by the moment)
	{
		const recent = gate(
			() => visible() && modeSig() === "graph",
			() => {
				momentsOf()?.()
				const w = worldSig()
				return w ? (w.moments as Any[]).slice(-24).reverse() : []
			},
		)
		momentsBox.append(h("h3", "", "scheduler"))
		const end = document.createComment("")
		momentsBox.append(end)
		insert(
			momentsBox,
			mapArray(() => recent() ?? [], (m: Any) => {
				const [kind, text] = say(worldSig(), m)
				return h("div", "moment " + kind, text)
			}),
			end,
		)
	}

	// a pick from anywhere but the element puts the element away; the render rings what is bound
	const choose = (key: string | undefined, keep = false) => {
		if (!keep) setElementSig(undefined)
		setPickedSig(() => key)
		const card = cardOf(key)
		const item = card?.item
		const names: string[] = []
		for (let u = card; u?.up; u = u.up) names.unshift(u.name)
		const w = world()
		hooks.picked?.(
			item ? "/" + names.join("/") : undefined,
			item && w ? nodeOf(w, "value", item.id)?.value : undefined,
			item?.id,
		)
	}
	// the reads, as card keys: the part's node is a card, so is each node its keys were on
	function readCards() {
		const cards = model()?.()?.cards ?? []
		const r = readsOf()?.() ?? new Map()
		const byId = new Map<string, string>()
		for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, c.key)
		const out: { from: string; to: string }[] = []
		for (const { entry, reads } of r.values()) {
			const from = byId.get(String(entry.id))
			if (!from) continue
			const seen = new Set<string>()
			for (const w of reads) {
				const to = byId.get(String(w.id))
				if (to && to !== from && !seen.has(to)) (seen.add(to), out.push({ from, to }))
			}
		}
		return out
	}
	// a place as a path from the root: the root is "/"
	const rooted = (place: string) => (place === "/" ? "/" : "/" + place)
	// the names from the root to a node, for saying where a read was
	function placeOf(id: unknown) {
		const c = (model()?.()?.cards ?? []).find((x) => x.item.id === id)
		const names: string[] = []
		for (let u = c; u?.up; u = u.up) names.unshift(u.name)
		return names.length ? names.join("/") : c ? "/" : String(id).slice(0, 6)
	}
	let detailStop: (() => void) | undefined
	const map = createMap(mapBox, {
		tree: () => (modeSig() === "map" && visible() ? model()?.() : undefined),
		picked: pickedSig,
		pick: choose,
		// read arrows: each part's card to the cards of what its latest run read
		reads: () => readCards(),
	})
	foldBtn.onclick = () => map.foldAt(Number(depth.value) || 0)
	unfoldBtn.onclick = () => map.unfoldAll()
	tidyBtn.onclick = () => map.tidy()
	// ---- the modes: the same pane shows the tree (graph), the map, or the files; the detail
	// column and the pick are shared ----
	const finder = createFinder(finderBox, {
		tree: () => (modeSig() === "files" && visible() ? model()?.() : undefined),
		picked: pickedSig,
		pick: choose,
		world: () => world(),
		info: (key, into) => detailFor(world(), into, () => key, false),
		say: (t) => finder.setStatus(t),
	})
	function setMode(next: "graph" | "map" | "files") {
		setModeSig(next)
		setVisible(true)
		treeBox.hidden = next !== "graph"
		mapBox.hidden = next !== "map"
		finderBox.hidden = next !== "files"
		search.hidden = next !== "graph"
		body.classList.toggle("map", next === "map")
		body.classList.toggle("files", next === "files")
		grow.hidden = next === "graph"
		mapTools.hidden = next !== "map"
		if (next === "map") requestAnimationFrame(() => map.fit())
	}

	// ---- the world: its tree and moments as signals ----
	let stop: (() => void) | undefined
	function setWorld(w: Any) {
		stop?.()
		stop = undefined
		// a new world: nothing folded, nothing moved. a reload is the same world, so they hold
		map.reset()
		open.reset()
		setPickedSig(undefined)
		setElementSig(undefined)
		setWorldSig(() => w)
		if (!w) {
			setModel(undefined)
			setReadsOf(undefined)
			setMomentsOf(undefined)
			return
		}
		stop = createRoot((dispose) => {
			const t = tree(w)
			const n = moments(w)
			setModel(() => t)
			setReadsOf(() => n.reads)
			setMomentsOf(() => n.tick)
			return dispose
		})
	}
	// the detail column, for whatever is picked
	bind(() => worldSig(), (w) => {
		detailStop?.()
		detail.replaceChildren()
		if (w) {
			detailStop = createRoot((
				dispose,
			) => (detailFor(w, detail, () => pickedSig(), true), dispose))
		}
	})

	// pick by names from the root: the folds above it open. keep: the element stays shown
	function pickAddress(names: string[], keep = false) {
		const w = world()
		if (!w || peek(w, names) === undefined) return
		const keys = names.map((n) => `/${n}`)
		let key = "root"
		open.add(key)
		for (const k of keys.slice(0, -1)) open.add(key += k)
		choose(key + keys[keys.length - 1], keep)
	}

	// a path an element says ("/a/b", or "/a/b#<id>" for one node of several at that place):
	// the node with that id, nearest the path, else the node at the path
	function pickPath(path: string, keep = false) {
		const [at, id] = path.split("#")
		const names = at.split("/").filter(Boolean)
		if (id === undefined) return pickAddress(names, keep)
		const cards = (model()?.()?.cards ?? []).filter((c) => String(c.item.id) === id)
		const named = (c: Any) => {
			const out: string[] = []
			for (let u = c; u?.up; u = u.up) out.unshift(u.name)
			return out.join("/")
		}
		const card = cards.find((c) => named(c) === names.join("/")) ?? cards[0]
		if (!card) return pickAddress(names, keep)
		let key = ""
		for (const step of card.key.split("/").slice(0, -1)) {
			open.add(key = key ? `${key}/${step}` : step)
		}
		choose(card.key, keep)
	}
	// a path with an id, the id cut short for reading
	const shortId = (v: string) => v.replace(/#(.{6}).+$/, "#$1")

	// an element picked in the render: shown above, and the node it is bound to picked (a binding,
	// else a handler, else the process that draws it)
	function showElement(s: Said) {
		setElementSig(() => s)
		const path = s.binds[0]?.[1] ?? s.ons[0]?.[1]
		if (path) return pickPath(path, true)
		const card = processCard(s)
		if (card) return choose(card.key, true)
	}

	search.oninput = () => setSearchSig(search.value)
	refresh.onclick = () => {}
	return { pickAddress, pickPath, setWorld, setMode, setVisible, finder, showElement, placeOf }
}
