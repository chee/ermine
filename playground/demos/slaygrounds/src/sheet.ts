/// <reference lib="dom" />
// a property sheet: one row a key, the value laid out by its kind, for the detail column (a
// node's attributes, a value that reads well as one, a change's pairs). by kind:
//   a list of strings   small skewed lemon tags
//   a string            plain text; a number tabular; a boolean a mint or cherry pill
//   an address          a path from the root, an entry, a node's id: a link that picks the node
//   a map               an indented sheet of its own, folded by its arrow
//   anything else       the console's expandable value, inline (functions, bytes, typed arrays)
// the values live in the program's frame (another realm): kinds are told without instanceof
import { h, render } from "./values.ts"

// what an address-like value links to: its text, and the pick; not one: undefined
export type Link = (v: unknown) => { text: string; go: () => void } | undefined

const plain = (v: unknown): v is Record<string, unknown> => {
	if (typeof v !== "object" || v === null || Array.isArray(v) || ArrayBuffer.isView(v)) {
		return false
	}
	const p = Object.getPrototypeOf(v)
	return p === null || Object.getPrototypeOf(p) === null
}
const primitive = (v: unknown) =>
	v === null || ["string", "number", "boolean", "bigint", "undefined"].includes(typeof v)

// a value that reads well as a sheet: a small map, or a small list of plain values
export function readsWell(v: unknown, depth = 0): boolean {
	if (depth > 3) return false
	if (Array.isArray(v)) return v.length <= 32 && v.every(primitive)
	if (!plain(v)) return false
	const keys = Object.keys(v)
	return keys.length > 0 && keys.length <= 24 &&
		keys.every((k) => primitive(v[k]) || readsWell(v[k], depth + 1) || !plain(v[k]))
}

// rows of [key, value]: a key may come twice (a change's pairs: each scope says its own)
export function sheet(
	pairs: readonly (readonly [string, unknown])[],
	link?: Link,
	depth = 0,
): HTMLElement {
	const out = h("div", "sheet")
	for (const [k, v] of pairs) {
		const row = out.appendChild(h("div", "srow"))
		row.append(h("span", "sk", k))
		const cell = row.appendChild(h("span", "sv"))
		cell.append(value(v, link, depth + 1))
		if (plain(v) && Object.keys(v).length) fold(row, Object.keys(v).length)
	}
	return out
}

// a map in a row: its arrow folds its sheet. the row is found from the click (it may be one laid
// over: values.ts patch), and a fresh row over a shut one is shut too
type Folding = HTMLElement & { $n?: number; $adopt?: (fresh: Element, old: Element) => void }
function fold(row: Folding, n: number) {
	const arrow = h("button", "sfold", "▾")
	arrow.title = `${n} ${n === 1 ? "key" : "keys"}`
	row.firstElementChild!.prepend(arrow)
	row.$n = n
	row.$adopt = (fresh, old) => old.classList.contains("shut") && shut(fresh as Folding, true)
	arrow.onclick = (e) => {
		const r = (e.currentTarget as Element).closest(".srow") as Folding
		shut(r, !r.classList.contains("shut"))
	}
}
function shut(row: Folding, on: boolean) {
	const cell = row.querySelector<HTMLElement>(":scope > .sv")!
	cell.hidden = on
	row.querySelector(":scope > .sk > .sfold")!.textContent = on ? "▸" : "▾"
	row.classList.toggle("shut", on)
	row.querySelector(":scope > .smore")?.remove()
	if (on) row.append(h("span", "smore", `{ ${row.$n} }`))
}

// one value, by its kind
export function value(v: unknown, link?: Link, depth = 0): Node {
	const to = link?.(v)
	if (to) {
		const a = h("button", "slink", "↗ " + to.text)
		a.title = "pick this node"
		a.onclick = to.go
		return a
	}
	if (Array.isArray(v) && v.every(primitive) && v.length <= 32) {
		if (!v.length) return h("span", "snone", "empty list")
		const tags = h("span", "stags")
		for (const x of v) {
			const t = tags.appendChild(h("span", "stag", typeof x === "string" ? x : String(x)))
			const go = link?.(x)
			if (go) (t.classList.add("go"), t.onclick = go.go, t.title = "pick " + go.text)
		}
		return tags
	}
	switch (typeof v) {
		case "string":
			return v ? h("span", "sstr", v) : h("span", "snone", "empty string")
		case "number":
		case "bigint":
			return h("span", "snum", typeof v === "bigint" ? v + "n" : String(v))
		case "boolean":
			return h("span", "spill " + (v ? "yes" : "no"), String(v))
		case "undefined":
			return h("span", "snone", "none")
	}
	if (v === null) return h("span", "snone", "null")
	if (plain(v) && depth < 4 && Object.keys(v).length <= 24) {
		const keys = Object.keys(v)
		if (!keys.length) return h("span", "snone", "empty map")
		return sheet(keys.map((k) => [k, v[k]]), link, depth)
	}
	// the rest as the console shows it, opened by its arrow
	return render(v)
}
