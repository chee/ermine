/// <reference lib="dom" />
// every table entry a node has: each part under the id (value, attributes, children, process,
// presence, patch ...), its value and its change. live: ermine tracks each part's value and change
// (places.readValue/readChange), and the table's own events say a part came or went (the world's
// places.onTableChange, wrapped once: the table calls it by name)
import {
	createMemo,
	createRenderEffect,
	createRoot,
	createSignal,
	onCleanup,
} from "@solidjs/signals"
import { h, patch, preview, render } from "./values.ts"
import { feed } from "./solid-ermine.ts"
import { sheet, value as shown } from "./sheet.ts"
import type { Link } from "./sheet.ts"

// deno-lint-ignore no-explicit-any
type Any = any

// the table events, as a signal per world: bumped on any part added, replaced or taken out
const events = new WeakMap<object, () => number>()
function eventsOf(w: Any): () => number {
	let get = events.get(w.places)
	if (get) return get
	const [n, set] = createSignal(0)
	const was = w.places.onTableChange
	w.places.onTableChange = (part: unknown, id: unknown) => {
		was(part, id)
		set((x) => x + 1)
	}
	events.set(w.places, get = n)
	return get
}

const tagOf = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1)
// what a value says in a line: bytes and typed arrays as a size, the rest as the console does
function brief(v: unknown): string {
	if (v instanceof ArrayBuffer || tagOf(v) === "ArrayBuffer") {
		return `ArrayBuffer(${(v as ArrayBuffer).byteLength} bytes)`
	}
	if (ArrayBuffer.isView(v)) return `${tagOf(v)}(${v.byteLength} bytes)`
	if (typeof v === "symbol") return String(v)
	// as the row's body and the rest of the inspector say it
	if (v === undefined) return "none"
	return preview(v)
}
const bytesy = (v: unknown) => ArrayBuffer.isView(v) || tagOf(v) === "ArrayBuffer"

const where = (t: Any) => "/" + (t.path ?? []).join("/") + (t.range ? `[${t.range.join(",")}]` : "")

function changeOf(c: Any, link: Link): HTMLElement {
	const box = h("div", "apchange")
	if (!c) return (box.append(h("p", "empty", "no change")), box)
	const site = (c.external ?? []).slice(0, 3)
	box.append(sheet([
		["who", c.actor],
		...(c.reader !== undefined ? [["reader", c.reader] as [string, unknown]] : []),
		["when", c.time === undefined ? undefined : new Date(c.time * 1000).toLocaleTimeString()],
		...(c.metadata ?? []),
		[
			"site",
			site.length
				? site.map((s: Any) => `${s.function ?? ""} ${s.file}:${s.line}`.trim()).join("\n")
				: undefined,
		],
	], link))
	const patches = c.op?.patches as Any[] | undefined
	if (patches?.length) {
		const edits = h("div", "sheet")
		for (const p of patches) {
			const row = edits.appendChild(h("div", "srow"))
			const v = h("span", "sv")
			v.append(h("span", "spath", where(p)))
			if (p.move) v.append(h("span", "sarrow", " ← "), h("span", "spath", where(p.move)))
			else if ("value" in p) v.append(h("span", "sarrow", " = "), shown(p.value, link))
			row.append(h("span", "sk", p.move ? "move" : "value" in p ? "put" : "remove"), v)
		}
		const fold = h("details", "appatch")
		fold.append(
			h("summary", "", `last op: ${patches.length} patch${patches.length === 1 ? "" : "es"}`),
		)
		fold.append(edits)
		box.append(fold)
	}
	return box
}

// the section for the node at id, into an element; call inside a Solid root. a row a part, kept
// by its name while the part is there: a part coming or going puts in or takes out its own row,
// and a part that changes lays its new line (and its body, when open) over what is there
export function allParts(w: Any, into: HTMLElement, id: unknown, link: Link) {
	const bump = eventsOf(w)
	const opened = new Set<string>()
	const head = h("h3", "", "all parts")
	const slot = h("div", "allparts")
	const none = h("p", "empty", "no entries in the table")
	into.append(head, slot)
	// the parts there are now: told by the table's events
	const names = createMemo(() => (bump(), JSON.stringify(w.table.get(id).map(([p]: Any) => p))))
	const rows = new Map<string, { row: HTMLElement; draw: () => void }>()
	function make(part: string) {
		const row = h("div", "apart")
		const top = row.appendChild(h("div", "aphead"))
		const arrow = top.appendChild(h("span", "arrow", opened.has(part) ? "▾" : "▸"))
		top.append(h("span", "apname", part))
		const pv = top.appendChild(h("span", "pv"))
		const body = row.appendChild(h("div", "apbody"))
		body.hidden = !opened.has(part)
		const draw = () => {
			const e = w.table.get(part, id)
			const line = e ? brief(e.value) : "taken out"
			if (pv.textContent !== line) pv.textContent = line
			if (body.hidden) return
			if (!e) return void body.replaceChildren()
			const v = e.value
			patch(body, [
				h("div", "apk", "value"),
				bytesy(v)
					? h("span", "p-string", brief(v))
					: v === undefined
					? h("span", "snone", "none")
					: render(v, undefined, true),
				h("div", "apk", "change"),
				changeOf(e.change, link),
			])
		}
		top.onclick = () => {
			const open = body.hidden
			body.hidden = !open
			arrow.textContent = open ? "▾" : "▸"
			open ? opened.add(part) : opened.delete(part)
			draw()
		}
		return { row, draw }
	}
	let stop: (() => void) | undefined
	createRenderEffect(names, (j: string) => {
		const parts = JSON.parse(j) as string[]
		head.textContent = `all parts (${parts.length})`
		for (const [part, r] of rows) if (!parts.includes(part)) (r.row.remove(), rows.delete(part))
		const list = parts.map((p) => {
			let r = rows.get(p)
			if (!r) rows.set(p, r = make(p)), r.draw()
			return r.row
		})
		if (!parts.length) list.push(none)
		// in the table's order; a row already in its place is not moved
		list.forEach((row, i) =>
			slot.children[i] !== row && slot.insertBefore(row, slot.children[i] ?? null)
		)
		for (let i = slot.children.length - 1; i >= list.length; i--) slot.children[i].remove()
		// ermine tracks every part's value and change; the entry is read fresh when it says
		stop?.()
		stop = createRoot((dispose) => {
			const read = feed(w, () =>
				parts.map((p) => {
					w.places.readValue(p, id)
					return [p, w.places.readChange(p, id)]
				}))
			createRenderEffect(() => (read(), 0), () => {
				for (const r of rows.values()) r.draw()
			})
			return dispose
		})
	})
	onCleanup(() => stop?.())
}
